# 操作录制模块（OpRecorder）设计文档

- 日期：2026-08-26
- 状态：评审中
- 前置约束：本模块作为"操作录制"功能模块接入一个既有自动化测试平台；平台读取模块产出的结构化文件并转换为 midscene.js 集成的 Playwright 脚本。

## 1. 背景与目标

录制用户在浏览器中的手动操作，产出结构化文件（JSON/YAML），用自然语言描述操作步骤，供自动化测试平台转换为 midscene.js 的 Playwright 脚本。

**核心链路**：

```
用户浏览器操作 → 保存视频(mp4) → 视觉大模型分析 → 结构化文件(steps.json)
                                                       │
                                         平台读取并转换为 midscene.js 脚本
```

**硬性要求**：
- 不重复造轮子，只组装成熟方案（Playwright / ffmpeg / openai SDK 等）。
- 视觉模型密钥通过 `.env` 文件配置，不读取系统环境变量。
- 模型配置同时兼容多模态模型（图+视频）与纯视觉模型（仅图片）；当前可用模型以多模态为主，纯视觉模型配置项保留但默认注释。

## 2. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 录制环境 | Playwright 托管有头浏览器（测试人员在弹出的浏览器中手动操作），`recordVideo` 原生录屏 |
| 截图备份 | record 阶段同步留存"有效操作"截图（活动监听 + 防抖截图），v1.0 仅落盘不处理；analyze 输入仍只有 mp4 + 配置 |
| VLM 输入策略 | 双模式：默认抽帧（frames），可选原生视频（video），配置开关 |
| 抽帧默认参数 | interval 1s + 帧上限 30；scene 模式保留为开关（阈值 0.3） |
| 输出契约 | 自然语言描述为主 + 可选意图字段（action_type/target/value）+ 必填断言（assertion，可 null）+ start_sec 时间戳 |
| 实现语言 | TypeScript / Node 18+ |
| 交付形态 | CLI 为主（record / analyze / run）+ TS 库入口（同一套函数） |
| 编排方式 | 两阶段：录制与分析分离，视频与 JSON 均落盘，分析可无限重跑 |
| 模型能力 | `VLM_VIDEO_SUPPORTED=auto` 按模型名名单判断，可显式覆盖；video 模式 + 纯视觉模型 → 启动即报错 |

## 3. 技术选型（复用清单）

| 职责 | 组件 | 说明 |
|---|---|---|
| 启动浏览器 + 录屏 | `playwright`（Chromium `recordVideo`） | 官方内置 |
| 视频抽帧 | `ffmpeg` 命令行（child_process 调用） | scene 检测滤镜原生支持 |
| 模型调用 | `openai` SDK（baseURL 可配，覆盖 OpenAI / 通义 / Doubao / GLM / Gemini 兼容端）+ `@anthropic-ai/sdk` | 统一 OpenAI 兼容协议为主 |
| 配置加载 | `dotenv` | 仅读项目 `.env` 文件 |
| CLI | `commander` | record / analyze / run 子命令 |
| 输出校验 | `zod` | schema 唯一事实源（类型 + 校验共用） |
| YAML 输出 | `js-yaml` | 可选格式 |
| 运行时 | Node 18+ | |

## 4. 总体架构与组件划分

自研部分仅三块：CLI 壳、分析管线编排、提示词工程。

```
recorder/
├── src/
│   ├── cli/index.ts           # CLI 入口 (commander)：record / analyze / run
│   ├── record/
│   │   └── recorder.ts        # 阶段1：有头 Chromium + recordVideo + 活动截图；等窗口关闭 → 落盘
│   ├── analyze/
│   │   ├── extractFrames.ts   # 阶段2a：ffmpeg 抽帧（interval / scene）
│   │   ├── vlm.ts             # 阶段2b：VLM 适配层（openai-compatible / anthropic 适配器，可注入 stub）
│   │   ├── prompt.ts          # 阶段2c：提示词组装（帧序列 / 原生视频）
│   │   └── refine.ts          # 阶段2d：zod 校验 + 携带错误重试（≤3 轮）+ 失败出口
│   ├── schema/steps.schema.ts # steps.json 的 zod schema —— 唯一事实源
│   ├── config/env.ts          # .env 加载 + 启动校验（fail fast）
│   └── output/writer.ts       # JSON / YAML 写出
├── prompts/
│   ├── frames.txt             # 抽帧模式提示词模板
│   └── video.txt              # 原生视频模式提示词模板
├── .env.example               # 全部可配项 + 注释
└── package.json
```

**组件边界**：`record` 的产物只有 mp4 + 截图目录；`analyze` 的输入只有 mp4 + 配置，输出只有 steps.json（或 failure.json）。两者无共享可变状态——这是"分析可无限重跑"的根基。平台集成时 stdout 只输出稳定行（产物路径），诊断走 stderr + `--verbose`。

产物目录约定：`<out>/<session-id>/` 下三个平级子目录——`recording/`（原始录像 video.mp4 + 抽帧预览 frames_preview.mp4）、`screenshots/`（页面截图）、`results/`（session.json / steps.json / failure.json）。

## 5. 数据流

### 阶段1 `record`

```
启动有头 Chromium (recordVideo 开)
   │── 打开 target URL
   │── 注入活动监听（click/keydown/wheel/input/change/submit → 置脏标记）
   │     + Node 侧 500ms 轮询：脏且距上次 ≥800ms → page.screenshot() → screenshots/frame_N.png
   │── 等待用户关闭浏览器窗口 / RECORD_MAX_DURATION_MIN 超时自动收尾
   ▼
<out>/<session-id>/
   ├── recording/       ← video.mp4（Playwright 自动最终化后转码）+ frames_preview.mp4（抽帧预览，分析阶段产出）
   ├── screenshots/     ← 备用资产，v1.0 不做任何处理（为后续增量更新预留）
   └── results/         ← session.json / steps.json / failure.json
```

录屏（recordVideo，浏览器端合成）与截图（CDP）互不干扰。`analyze` 只读 video.mp4，截图目录不被分析管线触碰。

### 阶段2 `analyze`

```
video.mp4
   │── ffmpeg 抽帧
   │     ├─ interval 模式: -vf fps=1/FRAME_INTERVAL_SEC（默认每 1s 一帧）
   │     ├─ scene 模式:   -vf "select='gt(scene,FRAME_SCENE_THRESHOLD)'"
   │     └─ 帧上限 FRAME_MAX_COUNT=30（超限均匀抽回）+ 宽度限 FRAME_MAX_WIDTH=1568
   │── 组装提示词（帧序列 base64 / 原生视频 base64，按 VLM_INPUT_MODE）
   │── vlm.ts 调模型（VLM_TEMPERATURE=0.2，强制 JSON 输出）
   │── refine.ts：zod 校验 → 失败带校验错误重试（≤3 轮）
   ▼
steps.json 或 failure.json
```

抽帧参数权衡（设计默认的理由）：
- **interval 1s**：帧为等间距时间序列，模型保有"每步持续多久"的时间感；1s 精度对快速输入/连点较友好；>30s 的录像由帧上限均匀压回 30 帧。
- **scene 0.3**（开关项）：仅画面变化点出帧，适合长而慢的流程；但帧间隔不均、易受动画干扰、时间感弱，故默认关闭。
- **帧上限 30**：token 护栏。主流模型单图约 1k~3k+ tokens（1568px jpg），30 帧 ≈ 3~9 万 token 封顶，防止长录像成本失控和模型注意力稀释。

## 6. 输出契约 `steps.json`

```json
{
  "version": "1.0",
  "meta": {
    "generated_at": "2026-08-26T10:30:00+08:00",
    "target_url": "http://localhost:8080/login",
    "video": "recording/video.mp4",
    "model": "qwen2.5-vl-max",
    "input_mode": "frames",
    "frame_count": 30
  },
  "steps": [
    {
      "id": 1,
      "description": "点击页面右上角的「登录」按钮",
      "action_type": "click",
      "target": "登录按钮",
      "value": null,
      "assertion": "页面跳转并显示登录表单",
      "start_sec": 3.5
    },
    {
      "id": 2,
      "description": "在「用户名」输入框输入 test01",
      "action_type": "input",
      "target": "用户名输入框",
      "value": "test01",
      "assertion": "用户名输入框中显示 test01",
      "start_sec": 6.0
    }
  ]
}
```

- `description`：主体。措辞按"可直接拼进 midscene 智能体指令（ai.click / ai.input 级别）"编写，平台组脚本即用。
- `action_type`：枚举 `goto / click / input / hover / scroll / keypress / select / wait / unknown`；模型不确定必须给 `unknown`，不硬编。
- `target` / `value`：可选；target 为目标元素自然语言指认，value 为 input/select 的输入值。
- `assertion`：必填、可 null。描述执行该操作后页面上视觉可见的变化，作为 midscene `aiAssert` 的断言参数；操作未引起页面元素可见变化时为 `null`（调用方跳过该步断言）。模型输出缺该字段或为空串 → 校验失败 → 自动重试。
- `start_sec`：由帧索引换算的动作起始时间点，供平台回溯核对，也是未来事件对齐的锚点。
- refine 阶段附加处理：连续重复步骤去重、id 重排。
- 默认 JSON 输出；`--format yaml` 可切换，结构同构。

## 7. 配置 `.env`

```bash
# ── 视觉模型（必填项）──
VLM_PROVIDER=openai-compatible      # openai-compatible | anthropic
VLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VLM_API_KEY=sk-xxxx

# ── 模型（默认：多模态，支持图片 + 原生视频输入）──
VLM_MODEL=qwen2.5-vl-max
VLM_VIDEO_SUPPORTED=auto            # auto | true | false
                                    #  auto: 按内置模型名名单正则判断
                                    #  true: 显式声明支持视频（多模态模型）
                                    #  false: 声明仅图片（纯视觉模型）

# ── 纯视觉模型（仅图片输入，如 qwen-vl-max；当前 API 无可用，注释保留）──
# 使用时取消注释并覆盖上面的模型配置：
# VLM_MODEL=qwen-vl-max
# VLM_VIDEO_SUPPORTED=false
# 注意：纯视觉模型时 VLM_INPUT_MODE 必须为 frames，否则启动即报错

# ── 输入模式 ──
VLM_INPUT_MODE=frames               # frames(抽帧，所有模型兼容) | video(原生视频，仅多模态)

# ── 模型请求 ──
VLM_TEMPERATURE=0.2
VLM_MAX_RETRY=3

# ── 抽帧 ──
FRAME_MODE=interval                 # interval | scene
FRAME_INTERVAL_SEC=1
FRAME_SCENE_THRESHOLD=0.3
FRAME_MAX_COUNT=30
FRAME_MAX_WIDTH=1568

# ── 录制 ──
RECORD_MAX_DURATION_MIN=30
DEFAULT_VIEWPORT=1280x800

# ── 输出 ──
OUTPUT_FORMAT=json                  # json | yaml
```

- 密钥只从 `.env` 读取（dotenv），`VLM_API_KEY` 必填，缺失启动即报错（退出码 2）。
- `.env` 入 .gitignore，仓库提交 `.env.example`。
- 优先级：**CLI 参数 > .env > 内置默认值**。
- `auto` 名单（vlm.ts 内一处常量）：正则匹配视频能力模型，如 `qwen2.5-vl*`、`qwen3-vl*`、`gpt-4o*`、`gemini-*-flash|pro`、`glm-4v*`、`doubao-*vision*`；匹配不到按 false 处理（保守，宁错勿烧钱）。

## 8. 提示词工程（prompts/）

- `frames.txt`：角色定义（测试脚本生成助手）→ 任务说明（从操作录像识别步骤，只写视觉可见动作，不推测内部逻辑）→ 严格 JSON 输出约束（字段定义全文）→ 2~3 个 few-shot 正反例（含"描述含糊"负面例）。
- `video.txt`：同构，开头附加视频观看指引。
- 措辞硬约束："每个 description 必须可直接拼进 midscene 智能体指令"。
- refine 循环：zod 精确错误列表追加进提示词，要求重新生成完整 JSON，≤VLM_MAX_RETRY 轮。

## 9. 错误处理

| 层 | 错误 | 行为 |
|---|---|---|
| 配置 | 缺 VLM_API_KEY / 非法 provider / video 模式配纯视觉模型 | 启动即报错，退出码 2，给出修复方案 |
| 录制 | target 不可达 / 浏览器加载失败 | 报错退出码 1，清理临时产物 |
| 录制 | 视频过短（少于 3 帧） | 报错"操作太短，请重新录制" |
| 录制 | 超时 / 浏览器崩溃 | 超时自动收尾；崩溃保留已录片段并明确报警 |
| 环境 | ffmpeg 缺失 | 启动探测 `ffmpeg -version`，缺失给出各平台安装指引后退出 |
| VLM | 429 / 5xx / 网络抖动 | 指数退避重试（≤3 次） |
| 输出 | JSON 解析失败 / zod 校验不过 | 自修正循环 ≤3 轮；仍失败 → `failure.json`（含原始模型输出全文 + 帧数），退出码 1，绝不出半成品 |

**退出码约定**：0 成功；1 一般失败；2 配置错误。

## 10. 测试策略

开发全程不消耗真实 API 调用：

1. **单元**：config 校验（坏配置矩阵）、schema（合法/非法样本表）、时间戳换算、重复步骤去重。
2. **集成**：
   - VLM 适配层为可注入接口 → 本地 stub server（`VLM_BASE_URL` 指向本地，预设合法/非法 JSON），驱动 refine 重试与失败出口。
   - ffmpeg 抽帧用 `testsrc` 滤镜现场生成测试视频（ffmpeg 自带，零资产文件）。
3. **录制实测**：Playwright 起本地静态页 fixture，脚本化模拟用户操作，断言 video.mp4 + screens/ 产物齐全。
4. **E2E 冒烟**：`run` 全流程 + stub VLM，验证端到端产物。
5. **人工验收**（开发后期一次）：真实页面 + 真实模型 key，人工检查描述质量。

## 11. 非目标（v2 候选）

- 截图流参与分析（本 v1.0 截图仅落盘）
- 事件时间戳与视频帧对齐的精确动作定位（方案 C）
- 分段分析 / 长流程分片喂模型
- 浏览器扩展录制真实日常浏览器
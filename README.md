# op-recorder

录制用户在浏览器中的手动操作 → 视觉大模型分析 → 结构化操作步骤（steps.json / steps.yaml），供自动化测试平台转换为 midscene.js 集成的 Playwright 脚本。

## 依赖

- Node ≥ 18
- ffmpeg / ffprobe **已内置**（含 libx264），随 `npm install` 按平台自动下载，无需自行安装
- 首次使用：`npx playwright install chromium`

## 快速开始

```bash
cp .env.example .env   # 填入 VLM_API_KEY 等
npm install

npm run cli -- record --target http://localhost:8080/login
# 弹出有头浏览器 → 手动操作 → 关闭窗口
npm run cli -- analyze --video out/<session>/recording/video.mp4
```

一次性完成：`npm run cli -- run --target http://localhost:8080/login`

## 产物

    out/<session-id>/
    ├── recording/
    │   ├── video.mp4      # 操作视频
    │   └── screens/       # 有效操作截图（v1.0 仅留档，不参与分析）
    ├── steps.json         # 结构化操作步骤（分析成功）
    ├── failure.json       # 分析失败原始输出（失败时）
    └── session.json       # 录制会话元信息 + 分析块（analysis：起止时间、每轮状态/起止时间/时长）

## 配置

全部视觉模型密钥与行为参数通过 `.env` 配置（不读系统环境变量），CLI 参数优先级最高，详见 `.env.example` 与 docs/superpowers/specs/2026-08-26-op-recorder-design.md。

## 屏幕缩放适配（100% / 125% / 150%）

录制启动时用探针窗口读取真实显示器参数（DPI 缩放倍率 + 工作区），自动适配：

- **deviceScaleFactor 对齐显示器真实缩放**：125%/150% 屏幕上录制视频会偶发 1~2 帧的缩放闪烁（合成器在 1.0 与真实缩放间翻转），对齐后该状态消失，任何缩放倍率下画面稳定。
- **视口钳制到工作区**：请求的视口 + 窗口边框超出屏幕可容纳区域时（放大倍率下常见），自动缩小视口（stderr 提示实际尺寸），避免窗口被 Windows 裁剪导致的尺寸抖动。
- 100% 缩放下完全保持原行为（1280x800 等请求尺寸原样使用）。

## 退出码

0 成功 / 1 一般失败 / 2 配置错误。stdout 输出稳定行（`output:` / `video:` / `screenshots:` / `steps:` / `failure:`）；**stderr 默认打印分析分步进度日志**（抽帧预处理 → 提示词组装 → 模型分析 → 结果校验与装配，每步「开始 / 完成」都带实际 .env 配置回显，`VLM_API_KEY` 只显示打码），无需 `--verbose`；模型每轮思考时终端同步计时并每秒刷新（`⏱ 第 N/M 轮思考中：已用时 Xs`），每轮结束时打印该轮耗时；`--verbose` 仅追加额外调试信息。

## 开发

```bash
npm test          # vitest（含录制/抽帧的本地集成测试）
npm run build     # tsc 产出 dist/
```

## 手动验收清单（真实模型，人工执行）

按顺序执行并记录结果：

1. `cp .env.example .env`，填入真实可用 key 与模型（多模态，如 qwen2.5-vl-max）。
2. `npm run cli -- record --target https://example.com`，在弹出浏览器中完成：点击链接 → 表单输入 → 停留 2 秒 → 关闭窗口。检查：`video.mp4` 存在；`screens/` 有截图；`session.json` 有 target_url。
3. `npm run cli -- analyze --video <上一步的 mp4>`。检查：`steps.json` 生成；`description` 措辞可直接拼进 midscene 指令；`action_type` 枚举合法。
4. 再跑一次 `analyze --format yaml`，结构同构。
5. 验证失败路径：`analyze` 时临时将 `.env` 的 `VLM_API_KEY` 改错 → 退出码 1 / failure 或模型错误清晰报出。
6. 验证配置守卫：`.env` 设 `VLM_INPUT_MODE=video` + `VLM_VIDEO_SUPPORTED=false` → 退出码 2，提示切换 frames。
7. 从 `steps.json` 手工构造一段 midscene 脚本（`ai.action('点击页面右上角的「登录」按钮')` 级别），确认可用。
8. `npm run cli -- run --target https://example.com` 全链路（录制→分析→steps.json）用真实模型走一遍，注意 CLI 等待关窗期间窗口保持可用。

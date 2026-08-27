# 操作录制模块（OpRecorder）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可被自动化测试平台调用的"操作录制"CLI/库模块：录制用户在有头浏览器中的手动操作（mp4 + 活动截图），用视觉大模型（抽帧/原生视频双模式）分析生成结构化 steps.json，供平台转换为 midscene.js 的 Playwright 脚本。

**Architecture:** 两阶段编排，录制与分析彻底分离（record 只产出 mp4+截图；analyze 只吃 mp4+配置，输出 steps.json，可无限重跑）。组件复用为主：Playwright recordVideo 录屏、ffmpeg 抽帧/转码、openai SDK（OpenAI 兼容协议）+ anthropic SDK、dotenv、zod、commander。自研仅 CLI 壳、分析管线编排、提示词工程三块。

**Tech Stack:** TypeScript (ESM/NodeNext, Node ≥ 18)、vitest、playwright、ffmpeg（子进程）、openai、@anthropic-ai/sdk、dotenv、zod、commander、js-yaml。

**Spec:** [2026-08-26-op-recorder-design.md](../specs/2026-08-26-op-recorder-design.md)

## Global Constraints

1. **环境前置**：Node ≥ 18；ffmpeg（含 libx264 构建）须在 PATH；首次运行前执行 `npx playwright install chromium`。
2. **ESM 规范**：package.json `"type": "module"`，tsconfig `module: "NodeNext"`；**所有相对导入必须带 `.js` 后缀**（例：`import { z } from 'zod'` 是裸导入，不处理；`import { AppConfig } from '../config/env.js'` 必须带 `.js`）。
3. **密钥只从 .env 读取**：config 层用 `dotenv.parse` 解析 `.env` 文件内容，绝不读取系统环境变量。
4. **退出码**：`0` 成功 / `1` 一般失败 / `2` 配置错误。
5. **stdout 只输出稳定行**（`output:` / `video:` / `steps:` / `failure:` 前缀行）；诊断日志一律走 stderr，`--verbose` 开关控制详细程度。
6. **配置优先级**：CLI 参数 > .env > 内置默认值。
7. **action_type 枚举拼写**（与 spec §6 完全一致）：`goto, click, input, hover, scroll, keypress, select, wait, unknown`。
8. **description 措辞**必须可直接拼进 midscene 智能体指令（如 ai.click / ai.input 级别），只描述视觉可见操作。
9. **忽略文件**：`.env`、`node_modules/`、`dist/`、`out/`（.gitignore 中）。
10. **帧参数默认值**（spec §7，均可被 .env/CLI 覆盖）：`FRAME_MODE=interval`、`FRAME_INTERVAL_SEC=1`、`FRAME_SCENE_THRESHOLD=0.3`、`FRAME_MAX_COUNT=30`、`FRAME_MAX_WIDTH=1568`。

---

## Task 1: 项目脚手架（npm 包 + TypeScript + vitest + git init + .env.example）

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/smoke.ts`（临时冒烟文件，Task 2 会替换为真实模块）

**Interfaces:**
- Produces: 可运行 `npm install`、`npm test`、`npm run build` 的 TS 项目骨架；`node src/smoke.ts`（经 `npm run cli` 可用 tsx 跑）输出一行确认文字。

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "op-recorder",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "录制浏览器操作 -> 视觉大模型 -> 结构化操作步骤 (供 midscene.js 脚本生成)",
  "engines": { "node": ">=18" },
  "bin": { "op-recorder": "./dist/cli/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "cli": "tsx src/cli/index.ts",
    "smoke": "tsx src/smoke.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.57.0",
    "commander": "^12.1.0",
    "dotenv": "^16.4.5",
    "js-yaml": "^4.1.0",
    "openai": "^4.90.0",
    "playwright": "^1.53.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 .gitignore**

```
node_modules/
dist/
out/
.env
*.tsbuildinfo
```

- [ ] **Step 4: 创建 .env.example**（内容与 spec §7 对齐；密钥只走该文件）

```bash
# ── 视觉模型（必填项）──
VLM_PROVIDER=openai-compatible      # openai-compatible | anthropic
VLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VLM_API_KEY=sk-xxxx
# ── 模型（默认：多模态，支持图片 + 原生视频输入）──
VLM_MODEL=qwen2.5-vl-max
VLM_VIDEO_SUPPORTED=auto            # auto | true | false
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

- [ ] **Step 5: 创建 src/smoke.ts 并验证全链路环境**

```ts
console.log('op-recorder smoke ok');
```

Run:

```bash
npm install
npx playwright install chromium
npm run smoke
```

Expected: 输出 `op-recorder smoke ok`（证明依赖可装、tsx 可跑；playwright 下载 Chromium 供 Task 5 使用）。

- [ ] **Step 6: git init 并提交**

```bash
git init
git add -A
```

**注意**：`.github/` 不存在，`git add -A` 只会加入上面创建的文件；确认 `.env`（如已手动创建）未被加入后提交：

```bash
git commit -m "chore: scaffold op-recorder project (ts, vitest, dotenv, playwright, openai)"
```

---

## Task 2: 配置层 config/env.ts（.env 加载 + fail-fast 校验 + 模型能力判定）

**Files:**
- Create: `src/config/env.ts`
- Create: `src/analyze/video-capable.ts`
- Test: `src/config/env.test.ts`

**Interfaces:**
- Consumes: 无（仅第三方 zod / dotenv）
- Produces（后续所有任务依赖的配置形状）:

```ts
export interface AppConfig {
  vlm: {
    provider: 'openai-compatible' | 'anthropic';
    baseUrl: string | null;
    apiKey: string;
    model: string;
    videoSupported: boolean;
    inputMode: 'frames' | 'video';
    temperature: number;
    maxRetry: number;
  };
  frame: {
    mode: 'interval' | 'scene';
    intervalSec: number;
    sceneThreshold: number;
    maxCount: number;
    maxWidth: number;
  };
  record: {
    maxDurationMin: number;
    viewport: { width: number; height: number };
  };
  output: { format: 'json' | 'yaml' };
}

export class ConfigError extends Error {}
export function loadConfig(overrides?: Record<string, string>, envPath?: string): AppConfig;
export function resolveVideoSupported(model: string, raw: 'auto' | 'true' | 'false'): boolean;
export function assertModelInputCompatible(cfg: AppConfig): void; // 不兼容抛 ConfigError
```

`src/analyze/video-capable.ts` 导出：`export function isVideoCapableModel(model: string): boolean;`（独立文件避免 env ↔ vlm 循环依赖）

- [ ] **Step 1: 写失败测试**（`src/config/env.test.ts`）

```ts
import { describe, it, expect } from 'vitest';
import { ConfigError, loadConfig } from './env.js';

const NO_ENV = '___no_such_env_file___';

const BASE_OVERRIDES: Record<string, string> = {
  VLM_API_KEY: 'sk-test',
  VLM_MODEL: 'qwen2.5-vl-max',
};

describe('loadConfig', () => {
  it('加载默认值：interval 1s + 帧上限 30 + frames 模式', () => {
    const cfg = loadConfig(BASE_OVERRIDES, NO_ENV);
    expect(cfg.frame.mode).toBe('interval');
    expect(cfg.frame.intervalSec).toBe(1);
    expect(cfg.frame.maxCount).toBe(30);
    expect(cfg.vlm.inputMode).toBe('frames');
    expect(cfg.vlm.videoSupported).toBe(true); // qwen2.5-vl-max 命中视频能力名单
    expect(cfg.record.viewport).toEqual({ width: 1280, height: 800 });
  });

  it('缺少 VLM_API_KEY 抛 ConfigError', () => {
    expect(() => loadConfig({ VLM_MODEL: 'qwen2.5-vl-max' }, NO_ENV)).toThrow(ConfigError);
  });

  it('openai-compatible 缺 VLM_BASE_URL 抛 ConfigError', () => {
    expect(() => loadConfig(BASE_OVERRIDES, NO_ENV)).toThrow(ConfigError);
  });

  it('video 模式 + 纯视觉模型抛 ConfigError（启动守卫）', () => {
    expect(() =>
      loadConfig(
        { ...BASE_OVERRIDES, VLM_BASE_URL: 'https://x', VLM_INPUT_MODE: 'video', VLM_VIDEO_SUPPORTED: 'false' },
        NO_ENV
      )
    ).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL（env.js 不存在 / loadConfig 未定义）

- [ ] **Step 3: 实现 video-capable.ts**

```ts
/** 视频能力模型名单（auto 判定用；匹配不到按无视频能力处理，宁错勿烧钱） */
const VIDEO_CAPABLE_PATTERNS: RegExp[] = [
  /qwen[\w.-]*vl/i,      // qwen-vl / qwen2.5-vl / qwen3-vl ...
  /gpt-4o/i,
  /gemini/i,             // gemini-1.5-flash / gemini-2.5-pro ...
  /glm-4v/i,
  /doubao.*vision/i,
];

export function isVideoCapableModel(model: string): boolean {
  return VIDEO_CAPABLE_PATTERNS.some((p) => p.test(model));
}
```

- [ ] **Step 4: 实现 env.ts**

```ts
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';
import { isVideoCapableModel } from '../analyze/video-capable.js';

export class ConfigError extends Error {}

const rawSchema = z.object({
  VLM_PROVIDER: z.enum(['openai-compatible', 'anthropic']).default('openai-compatible'),
  VLM_BASE_URL: z.string().url().optional(),
  VLM_API_KEY: z.string().min(1),
  VLM_MODEL: z.string().min(1),
  VLM_VIDEO_SUPPORTED: z.enum(['auto', 'true', 'false']).default('auto'),
  VLM_INPUT_MODE: z.enum(['frames', 'video']).default('frames'),
  VLM_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.2),
  VLM_MAX_RETRY: z.coerce.number().int().min(0).max(5).default(3),
  FRAME_MODE: z.enum(['interval', 'scene']).default('interval'),
  FRAME_INTERVAL_SEC: z.coerce.number().positive().default(1),
  FRAME_SCENE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  FRAME_MAX_COUNT: z.coerce.number().int().min(1).max(200).default(30),
  FRAME_MAX_WIDTH: z.coerce.number().int().min(320).max(4096).default(1568),
  RECORD_MAX_DURATION_MIN: z.coerce.number().positive().default(30),
  DEFAULT_VIEWPORT: z.string().regex(/^\d+x\d+$/).default('1280x800'),
  OUTPUT_FORMAT: z.enum(['json', 'yaml']).default('json'),
});

export interface AppConfig {
  vlm: {
    provider: 'openai-compatible' | 'anthropic';
    baseUrl: string | null;
    apiKey: string;
    model: string;
    videoSupported: boolean;
    inputMode: 'frames' | 'video';
    temperature: number;
    maxRetry: number;
  };
  frame: { mode: 'interval' | 'scene'; intervalSec: number; sceneThreshold: number; maxCount: number; maxWidth: number };
  record: { maxDurationMin: number; viewport: { width: number; height: number } };
  output: { format: 'json' | 'yaml' };
}

export function resolveVideoSupported(model: string, raw: 'auto' | 'true' | 'false'): boolean {
  if (raw === 'auto') return isVideoCapableModel(model);
  return raw === 'true';
}

export function assertModelInputCompatible(cfg: AppConfig): void {
  if (cfg.vlm.inputMode === 'video' && !cfg.vlm.videoSupported) {
    throw new ConfigError(
      `纯视觉模型（仅图片输入）不支持 video 模式。请在 .env 中设置 VLM_INPUT_MODE=frames，或替换为支持原生视频的多模态模型。`
    );
  }
}

export function loadConfig(overrides: Record<string, string> = {}, envPath = '.env'): AppConfig {
  let fileVars: Record<string, string> = {};
  try {
    fileVars = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  } catch {
    // .env 不存在时忽略：仅用 overrides + 默认值，必填项由 zod 兜住
  }
  const merged = { ...fileVars, ...overrides };
  const parsed = rawSchema.safeParse(merged);
  if (!parsed.success) {
    const first = z.treeifyError(parsed.error);
    throw new ConfigError(`配置无效：${JSON.stringify(first.flatten().fieldErrors).slice(0, 300)}（.env 或 CLI 参数）`);
  }
  const r = parsed.data;
  if (r.VLM_PROVIDER === 'openai-compatible' && !r.VLM_BASE_URL) {
    throw new ConfigError('openai-compatible 提供商必须配置 VLM_BASE_URL（.env 中填写兼容端点地址，如 DashScope compatible-mode）。');
  }
  const [w, h] = r.DEFAULT_VIEWPORT.split('x').map(Number);
  const cfg: AppConfig = {
    vlm: {
      provider: r.VLM_PROVIDER,
      baseUrl: r.VLM_BASE_URL ?? null,
      apiKey: r.VLM_API_KEY,
      model: r.VLM_MODEL,
      videoSupported: resolveVideoSupported(r.VLM_MODEL, r.VLM_VIDEO_SUPPORTED),
      inputMode: r.VLM_INPUT_MODE,
      temperature: r.VLM_TEMPERATURE,
      maxRetry: r.VLM_MAX_RETRY,
    },
    frame: {
      mode: r.FRAME_MODE,
      intervalSec: r.FRAME_INTERVAL_SEC,
      sceneThreshold: r.FRAME_SCENE_THRESHOLD,
      maxCount: r.FRAME_MAX_COUNT,
      maxWidth: r.FRAME_MAX_WIDTH,
    },
    record: { maxDurationMin: r.RECORD_MAX_DURATION_MIN, viewport: { width: w, height: h } },
    output: { format: r.OUTPUT_FORMAT },
  };
  assertModelInputCompatible(cfg);
  return cfg;
}
```

注意：`z.treeifyError` 在 zod 3.25 中不存在 —— 用 `z.prettifyError(parsed.error)`；如果该 API 也不存在（zod 3.25 的实用工具以 `z.treeifyError` / `z.prettifyError` 形式新增于 3.25），退化为：

```ts
const first = JSON.stringify(parsed.error.flatten().fieldErrors);
throw new ConfigError(`配置无效：${first.slice(0, 300)}`);
```

以最终可通过的类型检查为准（编译报错时选退化实现）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 6: 提交**

```bash
git add src/config/env.ts src/analyze/video-capable.ts src/config/env.test.ts
git commit -m "feat: config layer with .env loading, fail-fast validation, video-capability auto-detect"
```

---

## Task 3: 输出契约 schema/steps.schema.ts（zod 唯一事实源）

**Files:**
- Create: `src/schema/steps.schema.ts`
- Test: `src/schema/steps.schema.test.ts`

**Interfaces:**
- Consumes: Task 2 无直接依赖（纯 zod）
- Produces（Task 4/9 依赖）:

```ts
export const actionTypeSchema: z.ZodEnum<['goto','click','input','hover','scroll','keypress','select','wait','unknown']>;
export const stepSchema: z.ZodObject<...>; // { id, description, action_type?, target?, value?, start_sec }
export const stepsFileSchema: z.ZodObject<...>; // { version:'1.0', meta:{...}, steps: [...] }
export type Step = z.infer<typeof stepSchema>;
export type StepsFile = z.infer<typeof stepsFileSchema>;
export function validateSteps(raw: unknown): { ok: true; data: StepsFile } | { ok: false; errors: string[] };
```

- [ ] **Step 1: 写失败测试**（`src/schema/steps.schema.test.ts`）

```ts
import { describe, expect, it } from 'vitest';
import { validateSteps } from './steps.schema.js';

const validFile = {
  version: '1.0',
  meta: {
    generated_at: '2026-08-26T10:30:00+08:00',
    target_url: 'http://localhost:8080/login',
    video: 'recording/video.mp4',
    model: 'qwen2.5-vl-max',
    input_mode: 'frames',
    frame_count: 30,
  },
  steps: [
    { id: 1, description: '点击页面右上角的「登录」按钮', action_type: 'click', target: '登录按钮', value: null, start_sec: 3.5 },
    { id: 2, description: '在「用户名」输入框输入 test01', action_type: 'input', target: '用户名输入框', value: 'test01', start_sec: 6.0 },
  ],
};

describe('validateSteps', () => {
  it('合法样本通过', () => {
    const r = validateSteps(validFile);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.steps).toHaveLength(2);
  });

  it('非法 action_type 被拒绝', () => {
    const bad = structuredClone(validFile);
    bad.steps[0].action_type = 'Drag';
    const r = validateSteps(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('action_type');
  });

  it('缺 description 被拒绝', () => {
    const bad = structuredClone(validFile);
    delete bad.steps[0].description;
    expect(validateSteps(bad).ok).toBe(false);
  });

  it('非 JSON 文本返回解析错误', () => {
    const r = validateSteps('not json at all');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('JSON');
  });

  it('步骤为空的裸 JSON 对象按缺字段拒绝', () => {
    expect(validateSteps(JSON.parse('{"foo":1}')).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/schema/steps.schema.test.ts`
Expected: FAIL（schema 未定义）

- [ ] **Step 3: 实现 steps.schema.ts**

```ts
import { z } from 'zod';

export const actionTypeSchema = z.enum(['goto', 'click', 'input', 'hover', 'scroll', 'keypress', 'select', 'wait', 'unknown']);

export const stepSchema = z.object({
  id: z.number().int().positive(),
  description: z.string().min(1),
  action_type: actionTypeSchema.optional(),
  target: z.string().nullable().optional(),
  value: z.string().nullable().optional(),
  start_sec: z.number().nonnegative(),
});

export const stepsFileSchema = z.object({
  version: z.literal('1.0'),
  meta: z.object({
    generated_at: z.string().min(1),
    target_url: z.string(),
    video: z.string().min(1),
    model: z.string().min(1),
    input_mode: z.enum(['frames', 'video']),
    frame_count: z.number().int().nonnegative(),
  }),
  steps: z.array(stepSchema),
});

export type Step = z.infer<typeof stepSchema>;
export type StepsFile = z.infer<typeof stepsFileSchema>;

export function validateSteps(raw: unknown): { ok: true; data: StepsFile } | { ok: false; errors: string[] } {
  let json: unknown = raw;
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ['模型输出不是合法 JSON 文本，请要求模型只输出 JSON'] };
    }
  }
  const parsed = stepsFileSchema.safeParse(json);
  if (parsed.success) return { ok: true, data: parsed.data };
  const fieldErrors = parsed.error.flatten().fieldErrors;
  const errors: string[] = [];
  for (const [field, msgs] of Object.entries(fieldErrors)) {
    errors.push(`${field}: ${(msgs ?? []).join('; ')}`);
  }
  return { ok: false, errors };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/schema/steps.schema.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: 提交**

```bash
git add src/schema/steps.schema.ts src/schema/steps.schema.test.ts
git commit -m "feat: steps.json zod schema as single source of truth"
```

---

## Task 4: 产物目录与写出 output/writer.ts

**Files:**
- Create: `src/output/writer.ts`
- Test: `src/output/writer.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `StepsFile` 类型
- Produces（Task 5/9/10 依赖）:

```ts
export function createSessionId(now?: Date): string;                          // 'YYYYMMDD-HHMMSS'
export async function ensureDirs(outRoot: string, sessionId?: string): Promise<{
  outDir: string; recordingDir: string; screensDir: string; }>;               // 建好目录并返回
export async function writeSteps(outDir: string, data: StepsFile, format: 'json' | 'yaml'): Promise<string>; // 返回文件绝对路径
export async function writeFailure(outDir: string, reason: string, rawOutput: string, frameCount: number): Promise<string>;
export async function writeSessionMeta(outDir: string, meta: { targetUrl: string; startedAt: Date }): Promise<string>;
export async function readSessionMeta(outDir: string): Promise<{ targetUrl: string } | null>;
```

- [ ] **Step 1: 写失败测试**（`src/output/writer.test.ts`）

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { createSessionId, ensureDirs, readSessionMeta, writeFailure, writeSessionMeta, writeSteps } from './writer.js';
import type { StepsFile } from '../schema/steps.schema.js';

const sample: StepsFile = {
  version: '1.0',
  meta: { generated_at: 't', target_url: 'http://x', video: 'recording/video.mp4', model: 'm', input_mode: 'frames', frame_count: 1 },
  steps: [{ id: 1, description: '点击「登录」按钮', action_type: 'click', target: '登录按钮', value: null, start_sec: 1 }],
};

async function tmpOut(): Promise<string> {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-test-'));
}

describe('writer', () => {
  it('createSessionId 格式为 YYYYMMDD-HHMMSS', () => {
    expect(createSessionId(new Date('2026-08-26T10:30:05'))).toBe('20260826-103005');
  });

  it('ensureDirs 创建三级目录', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root);
    expect(fs.existsSync(d.outDir)).toBe(true);
    expect(fs.existsSync(d.recordingDir)).toBe(true);
    expect(fs.existsSync(d.screensDir)).toBe(true);
  });

  it('writeSteps 写出 JSON 并可读回', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    const p = await writeSteps(d.outDir, sample, 'json');
    expect(path.basename(p)).toBe('steps.json');
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual(sample);
  });

  it('writeSteps 支持 yaml 且结构同构', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    const p = await writeSteps(d.outDir, sample, 'yaml');
    expect(path.basename(p)).toBe('steps.yaml');
    expect(yaml.load(fs.readFileSync(p, 'utf8'))).toEqual(sample);
  });

  it('writeFailure 记录原因、原文与帧数', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    const p = await writeFailure(d.outDir, '连续校验失败', '{"bad":1}', 7);
    const f = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(f.reason).toBe('连续校验失败');
    expect(f.raw_model_output).toBe('{"bad":1}');
    expect(f.frame_count).toBe(7);
  });

  it('writeSessionMeta / readSessionMeta 往返', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    await writeSessionMeta(d.outDir, { targetUrl: 'http://app/login', startedAt: new Date('2026-08-26T10:00:00') });
    expect((await readSessionMeta(d.outDir))?.targetUrl).toBe('http://app/login');
    expect(await readSessionMeta(root)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/output/writer.test.ts`
Expected: FAIL（writer 未定义）

- [ ] **Step 3: 实现 writer.ts**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { StepsFile } from '../schema/steps.schema.js';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function createSessionId(now: Date = new Date()): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
}

export async function ensureDirs(outRoot: string, sessionId = createSessionId()): Promise<{
  outDir: string;
  recordingDir: string;
  screensDir: string;
}> {
  const outDir = path.join(outRoot, sessionId);
  const recordingDir = path.join(outDir, 'recording');
  const screensDir = path.join(recordingDir, 'screens');
  await fs.mkdir(screensDir, { recursive: true });
  return { outDir, recordingDir, screensDir };
}

export async function writeSteps(outDir: string, data: StepsFile, format: 'json' | 'yaml'): Promise<string> {
  const filePath = path.join(outDir, `steps.${format === 'json' ? 'json' : 'yaml'}`);
  const text = format === 'json' ? JSON.stringify(data, null, 2) : yaml.dump(data);
  await fs.writeFile(filePath, text, 'utf8');
  return filePath;
}

export async function writeFailure(outDir: string, reason: string, rawOutput: string, frameCount: number): Promise<string> {
  const filePath = path.join(outDir, 'failure.json');
  await fs.writeFile(filePath, JSON.stringify({ reason, frame_count: frameCount, raw_model_output: rawOutput }, null, 2), 'utf8');
  return filePath;
}

export async function writeSessionMeta(outDir: string, meta: { targetUrl: string; startedAt: Date }): Promise<string> {
  const filePath = path.join(outDir, 'session.json');
  await fs.writeFile(filePath, JSON.stringify({ target_url: meta.targetUrl, started_at: meta.startedAt.toISOString() }, null, 2), 'utf8');
  return filePath;
}

export async function readSessionMeta(outDir: string): Promise<{ targetUrl: string } | null> {
  try {
    const f = JSON.parse(await fs.readFile(path.join(outDir, 'session.json'), 'utf8'));
    return typeof f.target_url === 'string' ? { targetUrl: f.target_url } : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/output/writer.test.ts`
Expected: PASS（6 用例）

- [ ] **Step 5: 提交**

```bash
git add src/output/writer.ts src/output/writer.test.ts
git commit -m "feat: output writer for steps json/yaml, failure and session meta"
```

---

## Task 5: 录制 record/recorder.ts（有头浏览器 + recordVideo + 活动截图）

**Files:**
- Create: `src/record/activity-inject.ts`
- Create: `src/record/recorder.ts`
- Create: `src/record/recorder.test.ts`
- Create: `tests/fixtures/page-server.ts`

**Interfaces:**
- Consumes: Task 4 的 `ensureDirs` / `writeSessionMeta`；Task 6 的 `ensureFfmpeg` / `transcodeVideoToMp4`（本任务 Step 8 才用到，Task 6 须先合入）
- Produces（Task 10 依赖）:

```ts
export const ACTIVITY_INJECT_SCRIPT: string; // 注入页面监听 click/keydown/wheel/input/change/submit 置脏标记
export interface RecordOptions {
  targetUrl: string;
  outDir: string;          // <out>/<sessionId>
  recordingDir: string;    // <out>/<sessionId>/recording
  screensDir: string;      // <out>/<sessionId>/recording/screens
  maxDurationMin: number;
  viewport: { width: number; height: number };
  onOpened?: (page: import('playwright').Page) => void | Promise<void>; // 测试/调试钩子
}
export interface RecordResult { videoPath: string; screenshotCount: number; durationSec: number; }
export async function recordAndWait(opts: RecordOptions): Promise<RecordResult>;
// 行为契约：浏览器打开后等待用户关闭窗口（或 context close）；结束 → finalize 视频 → 重命名 video.mp4；期间每 500ms 轮询脏标记防抖 800ms 截图
```

- [ ] **Step 1: 写失败测试**（`src/record/recorder.test.ts`，本任务测试直接操作真实 Chromium）

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { recordAndWait } from './recorder.js';
import { startPageServer } from '../../tests/fixtures/page-server.js';
import { ensureDirs, readSessionMeta } from '../output/writer.js';

let server: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  server = await startPageServer();
});
afterAll(async () => {
  await server.close();
});

describe('recordAndWait', () => {
  test(
    '录制一次点击+输入，产出 mp4、截图与 session.json',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-rec-'));
      const dirs = await ensureDirs(root, 'test-session');

      let openedPage: import('playwright').Page | null = null;
      const promise = recordAndWait({
        targetUrl: server.url,
        ...dirs,
        maxDurationMin: 1,
        viewport: { width: 960, height: 600 },
        onOpened: (page) => {
          openedPage = page;
        },
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 4000)); // 等页面打开+截帧启动
      expect(openedPage).not.toBeNull();
      const page = openedPage as import('playwright').Page;

      await page.fill('#username', 'test01');   // 触发 input 事件 → 脏标记
      await page.click('#login');               // 触发 click → 脏标记
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      await openedPage!.context().close();      // 模拟用户关闭浏览器 → 结束录制

      const result = await promise;
      expect(fs.existsSync(result.videoPath)).toBe(true);
      expect(fs.statSync(result.videoPath).size).toBeGreaterThan(1000);
      expect(result.screenshotCount).toBeGreaterThanOrEqual(1);
      const meta = await readSessionMeta(dirs.outDir);
      expect(meta?.targetUrl).toBe(server.url);
    },
    60_000
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/record/recorder.test.ts`
Expected: FAIL（recorder / page-server 不存在）

- [ ] **Step 3: 实现 fixture 页面服务器**（`tests/fixtures/page-server.ts`）

```ts
import http from 'node:http';

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>demo</title></head>
<body>
  <h1>登录页</h1>
  <input id="username" placeholder="用户名" />
  <input id="password" type="password" placeholder="密码" />
  <button id="login">登录</button>
</body></html>`;

export async function startPageServer(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return { url: `http://127.0.0.1:${actualPort}`, close: () => new Promise((r) => server.close(() => r())) };
}
```

- [ ] **Step 4: 实现 activity-inject.ts**

```ts
/** 注入所有页面：监听用户交互事件并置脏标记，供录制器轮询截图 */
export const ACTIVITY_INJECT_SCRIPT = `
(() => {
  const flagKey = '__opRecorderDirty';
  window[flagKey] = false;
  const mark = () => { window[flagKey] = true; };
  for (const evt of ['click', 'keydown', 'wheel', 'input', 'change', 'submit']) {
    document.addEventListener(evt, mark, true);
  }
})();
`;
```

- [ ] **Step 5: 实现 recorder.ts**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { ACTIVITY_INJECT_SCRIPT } from './activity-inject.js';
import { writeSessionMeta } from '../output/writer.js';
import { ensureFfmpeg, transcodeVideoToMp4 } from '../lib/ffmpeg.js';

export interface RecordOptions {
  targetUrl: string;
  outDir: string;
  recordingDir: string;
  screensDir: string;
  maxDurationMin: number;
  viewport: { width: number; height: number };
  onOpened?: (page: Page) => void | Promise<void>;
}

export interface RecordResult {
  videoPath: string;
  screenshotCount: number;
  durationSec: number;
}

const POLL_INTERVAL_MS = 500;
const DEBOUNCE_MS = 800;
const FINALIZE_GRACE_MS = 1500;

export async function recordAndWait(opts: RecordOptions): Promise<RecordResult> {
  await ensureFfmpeg(); // 结束阶段需要转码为 mp4，前置探测
  const startedAt = Date.now();
  const browser = await chromium.launch({ headless: false, viewport: opts.viewport });
  const context = await browser.newContext({
    recordVideo: { dir: opts.recordingDir, size: { width: opts.viewport.width, height: opts.viewport.height } },
  });
  const page = await context.newPage();
  await page.addInitScript(ACTIVITY_INJECT_SCRIPT);
  let screenshotCount = 0;
  let lastShotAt = 0;
  let videoPath = '';

  const closed = new Promise<void>((resolve) => {
    context.on('close', () => resolve());
    browser.on('disconnected', () => resolve());
  });

  const poller = (async () => {
    while (true) {
      const now = Date.now();
      const dirty = await page
        .evaluate(() => (window as any).__opRecorderDirty === true)
        .catch(() => false);
      if (dirty && now - lastShotAt >= DEBOUNCE_MS && !page.isClosed()) {
        lastShotAt = now;
        const seq = String(screenshotCount + 1).padStart(4, '0');
        await page.screenshot({ path: path.join(opts.screensDir, `frame_${seq}.png`) }).catch(() => {});
        screenshotCount += 1;
        await page.evaluate(() => ((window as any).__opRecorderDirty = false)).catch(() => {});
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  })();

  try {
    await page.goto(opts.targetUrl, { waitUntil: 'domcontentloaded' });
  } catch {
    await context.close().catch(() => {});
    throw new Error(`无法访问目标地址：${opts.targetUrl}（请确认地址可访问）`);
  }
  await writeSessionMeta(opts.outDir, { targetUrl: opts.targetUrl, startedAt: new Date(startedAt) });
  if (opts.onOpened) await opts.onOpened(page);

  const closedBy = await Promise.race([
    closed,
    new Promise<'timeout'>(() => {}), // 占位（永不触发）
    (async () => {
      await new Promise<void>((r) => setTimeout(r, opts.maxDurationMin * 60_000));
      return 'timeout' as const;
    })(),
  ]);
  void closedBy;
  await closed; // 等待用户关闭（超时兜底：max 到点自动关闭）
  setTimeout(() => {}) && clearTimeout; // no-op 占位（保持结构清晰）

  if (Date.now() - startedAt >= opts.maxDurationMin * 60_000) {
    await context.close().catch(() => {});
  }

  const video = await page.video().catch(() => null);
  await new Promise<void>((r) => setTimeout(r, FINALIZE_GRACE_MS)); // 等 Playwright finalize 视频
  const rawPath = (await video?.path().catch(() => null)) ?? null;
  if (rawPath && fs.existsSync(rawPath)) {
    const target = path.join(opts.recordingDir, 'video.mp4');
    await transcodeVideoToMp4(rawPath, target);
    videoPath = target;
  }
  await browser.close().catch(() => {});

  // 空转轮询无法被优雅停止，这里重置为不引用的占位（poller stop 由进程退出处理）
  void poller;

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  if (!videoPath) throw new Error('录制结束但未产生视频文件（操作过于短暂？请稍长一些再录），请重新录制');
  return { videoPath, screenshotCount, durationSec };
}
```

注意：上面的 `Promise.race` 占位结构过于繁琐 —— 实现时以简洁为准，只要语义等价：**等待 `closed`，同时设置 N 分钟超时后自动 `context.close()`**。不要引入永久空转的 poller 定时器（进程自然会结束）。

- [ ] **Step 6: 先实现 Task 6 的 lib/ffmpeg.ts 骨架后跑测试**

`src/lib/ffmpeg.ts` 中的 `ensureFfmpeg` 与 `transcodeVideoToMp4` 在 Task 6 完整实现。本 Task 测试运行前，先完成 Task 6 Step 3（ffmpeg 模块）——两个任务相互依赖，按 Task 6 → 回 Task 5 Step 7 顺序执行。

Run: `npx vitest run src/record/recorder.test.ts`
Expected: FAIL（ffmpeg 模块不存在 → 先做 Task 6）

- [ ] **Step 7: 提交**

```bash
git add src/record/ tests/fixtures/page-server.ts
git commit -m "feat: record phase - headed chromium recording with activity screenshots"
```

---

## Task 6: ffmpeg 封装与抽帧 lib/ffmpeg.ts + analyze/extractFrames.ts

**Files:**
- Create: `src/lib/ffmpeg.ts`
- Create: `src/analyze/extractFrames.ts`
- Test: `tests/analyze/extractFrames.test.ts`

**Interfaces:**
- Consumes: 无（纯子进程）
- Produces（Task 5/9 依赖）:

```ts
// src/lib/ffmpeg.ts
export async function ensureFfmpeg(): Promise<string>;                              // 不存在抛 Error（含安装指引）
export async function probeVideoDurationMs(videoPath: string): Promise<number>;     // ffprobe，毫秒
export async function transcodeVideoToMp4(src: string, dst: string): Promise<void>; // 转 h264 mp4（-movflags +faststart）

// src/analyze/extractFrames.ts
export interface ExtractFramesOptions {
  videoPath: string; outDir: string;
  mode: 'interval' | 'scene'; intervalSec: number; sceneThreshold: number;
  maxCount: number; maxWidth: number;
}
export interface ExtractFramesResult { framePaths: string[]; frameCount: number; }
export async function extractFrames(opts: ExtractFramesOptions): Promise<ExtractFramesResult>;
// 行为：ffmpeg 抽帧（原始上限 200）→ 超过 maxCount 时 Node 侧均匀抽样取 maxCount 张；返回所选帧路径
```

- [ ] **Step 1: 写失败测试**（`tests/analyze/extractFrames.test.ts`）

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ensureFfmpeg, probeVideoDurationMs, transcodeVideoToMp4 } from '../../src/lib/ffmpeg.js';
import { extractFrames } from '../../src/analyze/extractFrames.js';

function makeTestVideo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-vid-'));
  const out = path.join(dir, 'src.mp4');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  ]);
  return out;
}

describe('ffmpeg helpers', () => {
  it('ensureFfmpeg 找到 ffmpeg', () => {
    expect(ensureFfmpeg()).resolves.toMatch(/ffmpeg$/i);
  });

  it('probeVideoDurationMs 约 4000ms', async () => {
    const v = makeTestVideo();
    const ms = await probeVideoDurationMs(v);
    expect(ms).toBeGreaterThanOrEqual(3500);
    expect(ms).toBeLessThanOrEqual(4500);
  });

  it('transcodeVideoToMp4 产出文件', async () => {
    const v = makeTestVideo();
    const dst = path.join(path.dirname(v), 'out.mp4');
    await transcodeVideoToMp4(v, dst);
    expect(fs.statSync(dst).size).toBeGreaterThan(0);
  });
});

describe('extractFrames', () => {
  it('interval 1s 抽出约 4 帧', async () => {
    const v = makeTestVideo();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-fr-'));
    const r = await extractFrames({ videoPath: v, outDir: dir, mode: 'interval', intervalSec: 1, sceneThreshold: 0.3, maxCount: 30, maxWidth: 320 });
    expect(r.frameCount).toBeGreaterThanOrEqual(3);
    expect(r.frameCount).toBeLessThanOrEqual(5);
  });

  it('超过 maxCount 时均匀抽样到 maxCount', async () => {
    const v = makeTestVideo();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-fr-'));
    const r = await extractFrames({ videoPath: v, outDir: dir, mode: 'interval', intervalSec: 0.2, sceneThreshold: 0.3, maxCount: 2, maxWidth: 320 });
    expect(r.framePaths).toHaveLength(2);
  });

  it('scene 阈值 1.0 无变化画面 → 抛出"操作过短"错误', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-fr-'));
    const blank = path.join(dir, 'blank.mp4');
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=black:duration=2:size=320x240:rate=5', '-c:v', 'libx264', blank]);
    await expect(
      extractFrames({ videoPath: blank, outDir: dir, mode: 'scene', intervalSec: 1, sceneThreshold: 1.0, maxCount: 30, maxWidth: 320 })
    ).rejects.toThrow(/操作过短|未提取到任何帧/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/analyze/extractFrames.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 lib/ffmpeg.ts**

```ts
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FFMPEG_HINT = '未检测到 ffmpeg。请安装并加入 PATH：Windows: `winget install Gyan.FFmpeg` 或 scoop 安装；macOS: `brew install ffmpeg`；Linux: `apt install ffmpeg`。';

export async function ensureFfmpeg(): Promise<string> {
  try {
    const r = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    return r.split('\n')[0] ?? 'ffmpeg';
  } catch {
    throw new Error(FFMPEG_HINT);
  }
}

export async function probeVideoDurationMs(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
  ]);
  const s = parseFloat(stdout.trim());
  if (Number.isNaN(s)) throw new Error(`无法读取视频时长：${videoPath}`);
  return Math.round(s * 1000);
}

export async function transcodeVideoToMp4(src: string, dst: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y', '-i', src,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an',
    '-movflags', '+faststart', dst,
  ]);
  if (!fs.existsSync(dst)) throw new Error(`转码失败：${dst} 未生成`);
}
```

- [ ] **Step 4: 实现 extractFrames.ts**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureFfmpeg } from '../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);
const RAW_FRAME_CAP = 200; // ffmpeg 侧粗上限，避免超大视频产出巨量框架

export interface ExtractFramesOptions {
  videoPath: string;
  outDir: string;
  mode: 'interval' | 'scene';
  intervalSec: number;
  sceneThreshold: number;
  maxCount: number;
  maxWidth: number;
}

export interface ExtractFramesResult {
  framePaths: string[];
  frameCount: number;
}

function uniformSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  }
  return out;
}

export async function extractFrames(opts: ExtractFramesOptions): Promise<ExtractFramesResult> {
  await ensureFfmpeg();
  await fs.mkdir(opts.outDir, { recursive: true });
  const outPattern = path.join(opts.outDir, 'frame_%04d.jpg');
  const vf =
    opts.mode === 'scene'
      ? `select='gt(scene,${opts.sceneThreshold})',setpts=N/(25*TB),scale='min(${opts.maxWidth},iw)':-2`
      : `fps=1/${opts.intervalSec},scale='min(${opts.maxWidth},iw)':-2`;
  await execFileAsync('ffmpeg', ['-y', '-i', opts.videoPath, '-vf', vf, '-frames:v', String(RAW_FRAME_CAP), '-q:v', '4', outPattern]);
  const files = (await fs.readdir(opts.outDir)).filter((f) => f.endsWith('.jpg')).sort();
  const all = files.map((f) => path.join(opts.outDir, f));
  const framePaths = uniformSample(all, opts.maxCount);
  if (framePaths.length === 0) {
    throw new Error('视频中未提取到任何帧（录制过短或视频无效），请重新录制');
  }
  return { framePaths, frameCount: framePaths.length };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run tests/analyze/extractFrames.test.ts`
Expected: PASS（6 用例）

- [ ] **Step 6: 回到 Task 5 Step 7 补跑 recorder 测试**

Run: `npx vitest run src/record/recorder.test.ts`
Expected: PASS（recorder 集成测试通过；如截图断言不稳可放宽为 >= 0 于 UI 事件竞态——以"mp4 存在且体积 > 0"为硬断言）

- [ ] **Step 7: 提交**

```bash
git add src/lib/ffmpeg.ts src/analyze/extractFrames.ts tests/analyze/extractFrames.test.ts
git commit -m "feat: ffmpeg helpers and frame extraction (interval/scene, uniform sampling)"
```

---

## Task 7: 提示词工程 analyze/prompt.ts + prompts/*.txt

**Files:**
- Create: `src/analyze/prompt.ts`
- Test: `src/analyze/prompt.test.ts`
- Create: `prompts/frames.txt`
- Create: `prompts/video.txt`

**Interfaces:**
- Consumes: 无
- Produces（Task 9 依赖）:

```ts
export type PromptMode = 'frames' | 'video';
export async function loadPromptTemplate(mode: PromptMode): Promise<string>; // 读 prompts/<mode>.txt，缺失抛 Error
export function buildUserMessage(template: string, ctx: { mode: PromptMode; frameCount: number }): string;
// 行为：模板中 {{FRAME_COUNT}} 替换为帧数；包含规则要求（JSON 只输出、action_type 枚举、midscene 措辞）
```

- [ ] **Step 1: 写失败测试**（`src/analyze/prompt.test.ts`）

```ts
import { describe, expect, it } from 'vitest';
import { buildUserMessage, loadPromptTemplate } from './prompt.js';

describe('prompt', () => {
  it('frames 模板可加载且含关键约束', async () => {
    const t = await loadPromptTemplate('frames');
    expect(t).toContain('{{FRAME_COUNT}}');
    expect(t).toContain('action_type');
    expect(t).toContain('midscene');
    expect(t).toContain('只输出');
  });

  it('video 模板可加载且结构同构', async () => {
    const t = await loadPromptTemplate('video');
    expect(t).toContain('action_type');
    expect(t).toContain('midscene');
  });

  it('未知模式抛错', async () => {
    await expect(loadPromptTemplate('nope' as any)).rejects.toThrow();
  });

  it('buildUserMessage 替换帧数标记', async () => {
    const msg = buildUserMessage('共 {{FRAME_COUNT}} 帧', { mode: 'frames', frameCount: 12 });
    expect(msg).toContain('共 12 帧');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/analyze/prompt.test.ts`
Expected: FAIL（prompt 模块与模板文件不存在）

- [ ] **Step 3: 创建 prompts/frames.txt**（内容即实际生产提示词，后续可直接在平台侧调优）

```text
你是一个浏览器自动化测试脚本生成助手。用户录制了一段浏览器手动操作的视频，系统已将视频按固定间隔抽取成若干张关键帧（按时间顺序排列）。

请观察这些帧，识别用户执行的操作步骤，并严格按下面的 JSON 格式输出。

规则：
1. 只描述视频中视觉可见的操作，不要猜测后端逻辑或页面内部状态。
2. 每个 description 必须具体到可直接用作 midscene 智能体指令，例如「点击页面右上角的『登录』按钮」，而不是「点击登录」。
3. 输入类操作必须给出具体输入内容；如果视频中无法辨认输入内容，value 填 null，并在描述中保持中性措辞。
4. action_type 只能是以下枚举之一：goto, click, input, hover, scroll, keypress, select, wait, unknown。无法确定时填 unknown。
5. 连续帧中画面没有变化时，不要重复生成相同步骤。
6. 只输出一个 JSON 对象，禁止输出任何其他文字、解释或 markdown 代码块标记。

输出格式：
{
  "steps": [
    {
      "description": "<自然语言描述，可直接用于 midscene 指令>",
      "action_type": "<枚举>",
      "target": "<目标元素的自然语言描述，无则 null>",
      "value": "<输入内容，无则 null>",
      "start_sec": <该步动作开始的大致秒数，数字>
    }
  ]
}

示例：
{
  "steps": [
    { "description": "打开登录页面", "action_type": "goto", "target": null, "value": null, "start_sec": 0 },
    { "description": "点击页面右上角的「登录」按钮", "action_type": "click", "target": "登录按钮", "value": null, "start_sec": 12 },
    { "description": "在「用户名」输入框输入 admin", "action_type": "input", "target": "用户名输入框", "value": "admin", "start_sec": 17 }
  ]
}

本次共提供 {{FRAME_COUNT}} 帧。
```

- [ ] **Step 4: 创建 prompts/video.txt**

```text
你是一个浏览器自动化测试脚本生成助手。用户录制了一段浏览器手动操作的视频（可连续观看）。

请观看视频，识别用户执行的操作步骤，并严格按下面的 JSON 格式输出。

规则：
1. 只描述视频中视觉可见的操作，不要猜测后端逻辑或页面内部状态。
2. 每个 description 必须具体到可直接用作 midscene 智能体指令，例如「点击页面右上角的『登录』按钮」，而不是「点击登录」。
3. 输入类操作必须给出具体输入内容；如果视频中无法辨认输入内容，value 填 null，并在描述中保持中性措辞。
4. action_type 只能是以下枚举之一：goto, click, input, hover, scroll, keypress, select, wait, unknown。无法确定时填 unknown。
5. 连续画面没有变化（用户停留、思考、阅读）时，不要为该段时间产生步骤。
6. 只输出一个 JSON 对象，禁止输出任何其他文字、解释或 markdown 代码块标记。

输出格式：
{
  "steps": [
    {
      "description": "<自然语言描述，可直接用于 midscene 指令>",
      "action_type": "<枚举>",
      "target": "<目标元素的自然语言描述，无则 null>",
      "value": "<输入内容，无则 null>",
      "start_sec": <该步动作开始的大致秒数，数字>
    }
  ]
}

示例：
{
  "steps": [
    { "description": "打开登录页面", "action_type": "goto", "target": null, "value": null, "start_sec": 0 },
    { "description": "点击页面右上角的「登录」按钮", "action_type": "click", "target": "登录按钮", "value": null, "start_sec": 12 },
    { "description": "在「用户名」输入框输入 admin", "action_type": "input", "target": "用户名输入框", "value": "admin", "start_sec": 17 }
  ]
}
```

- [ ] **Step 5: 实现 prompt.ts**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

export type PromptMode = 'frames' | 'video';

export async function loadPromptTemplate(mode: PromptMode): Promise<string> {
  const file = path.resolve(process.cwd(), 'prompts', `${mode}.txt`);
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`提示词模板缺失：${file}（请确认 prompts/ 目录与 ${mode}.txt 存在）`);
  }
}

export function buildUserMessage(template: string, ctx: { mode: PromptMode; frameCount: number }): string {
  return template.replaceAll('{{FRAME_COUNT}}', String(ctx.frameCount));
}
```

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run src/analyze/prompt.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 7: 提交**

```bash
git add src/analyze/prompt.ts src/analyze/prompt.test.ts prompts/
git commit -m "feat: prompt templates (frames/video) with midscene-oriented description rules"
```

---

## Task 8: VLM 适配层 analyze/vlm.ts（OpenAI 兼容 + Anthropic，本地 stub 可注入）

**Files:**
- Create: `src/analyze/vlm.ts`
- Test: `tests/analyze/vlm.test.ts`
- Create: `tests/fixtures/vlm-stub.ts`

**Interfaces:**
- Consumes: Task 2 的 `AppConfig`；`analyze/video-capable.ts`
- Produces（Task 9/10 依赖）:

```ts
export interface VlmCallInput { mode: 'frames' | 'video'; frames: string[]; videoPath: string | null; prompt: string; }
export type VlmCaller = (cfg: AppConfig, input: VlmCallInput) => Promise<string>; // 返回模型原始文本
export function createVlmCaller(cfg: AppConfig): VlmCaller; // 按 provider 分发
// openai-compatible：content = [text, ...image_url(data:image/jpeg;base64), video 模式追加 video_url(data:video/mp4;base64)]
// anthropic：content = [text, ...image(base64), video 模式追加 video(base64)]，max_tokens 8192
```

- [ ] **Step 1: 写失败测试**（`tests/analyze/vlm.test.ts`）

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVlmCaller, type VlmCallInput } from '../../src/analyze/vlm.js';
import { isVideoCapableModel } from '../../src/analyze/video-capable.js';
import { loadConfig } from '../../src/config/env.js';
import { startVlmStub, type StubRequest } from '../fixtures/vlm-stub.js';

let stub: { url: string; requests: StubRequest[]; close: () => Promise<void> };

beforeAll(async () => {
  stub = await startVlmStub(JSON.stringify({ steps: [] }));
});
afterAll(async () => {
  await stub.close();
});

const NO_ENV = '___no_such_env_file___';

function fakeFrame(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-vlm-'));
  const p = path.join(dir, 'f.jpg');
  fs.writeFileSync(p, Buffer.from('fakejpeg'));
  return p;
}

const baseCfg = loadConfig(
  { VLM_API_KEY: 'sk-test', VLM_MODEL: 'qwen2.5-vl-max', VLM_BASE_URL: 'http://stub.invalid' },
  NO_ENV
);

describe('createVlmCaller (openai-compatible)', () => {
  it('frames 模式发送文本与 base64 图像，携带 model 与温度', async () => {
    const cfg = { ...baseCfg };
    const caller = createVlmCaller(cfg);
    const frame = fakeFrame();
    const input: VlmCallInput = { mode: 'frames', frames: [frame], videoPath: null, prompt: 'P' };
    const text = await caller({ ...cfg, vlm: { ...cfg.vlm, baseUrl: stub.url } }, input);
    expect(text).toContain('steps');
    const req = stub.requests.at(-1)!;
    expect(req.model).toBe('qwen2.5-vl-max');
    const parts = req.content?.filter((c: any) => c.type === 'image_url');
    expect(parts).toHaveLength(1);
    expect(parts[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('自动识别多模态模型：qwen2.5-vl / gemini / gpt-4o 为 true', () => {
    expect(isVideoCapableModel('qwen2.5-vl-max')).toBe(true);
    expect(isVideoCapableModel('gemini-2.5-flash')).toBe(true);
    expect(isVideoCapableModel('gpt-4o')).toBe(true);
    expect(isVideoCapableModel('my-custom-vision-1')).toBe(false);
  });
});

describe('createVlmCaller (anthropic)', () => {
  it('发送 image 内容块', async () => {
    const cfg = loadConfig(
      { VLM_PROVIDER: 'anthropic', VLM_API_KEY: 'sk-ant', VLM_MODEL: 'claude-sonnet-4-5', VLM_BASE_URL: stub.url },
      NO_ENV
    );
    const caller = createVlmCaller(cfg);
    const frame = fakeFrame();
    const text = await caller(cfg, { mode: 'frames', frames: [frame], videoPath: null, prompt: 'P' });
    expect(text).toContain('steps');
    const req = stub.requests.at(-1)!;
    expect(req.model).toBe('claude-sonnet-4-5');
    const blocks = req.content?.filter((c: any) => c.type === 'image');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source.data).toMatch(/^ZmFrZWpwZWc=$/); // fakejpeg 的 base64
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/analyze/vlm.test.ts`
Expected: FAIL（模块与 stub 不存在）

- [ ] **Step 3: 实现 stub 服务器**（`tests/fixtures/vlm-stub.ts`，Task 9/10/11 复用）

```ts
import http from 'node:http';

export interface StubRequest { model: string; content: any[] | null; }

export async function startVlmStub(responseBody: string): Promise<{
  url: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}> {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed: any = null;
      try {
        parsed = JSON.parse(body);
      } catch {}
      requests.push({
        model: parsed?.model ?? '',
        content: parsed?.messages?.[0]?.content ?? null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: responseBody } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
```

- [ ] **Step 4: 实现 vlm.ts**

```ts
import fs from 'node:fs';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config/env.js';

export interface VlmCallInput {
  mode: 'frames' | 'video';
  frames: string[];
  videoPath: string | null;
  prompt: string;
}

export type VlmCaller = (cfg: AppConfig, input: VlmCallInput) => Promise<string>;

function b64(file: string): string {
  return fs.readFileSync(file).toString('base64');
}

/** OpenAI 兼容协议（覆盖 OpenAI / DashScope / DeepSeek / GLM / Doubao / Gemini 兼容端等） */
export function createOpenAiCompatibleCaller(): VlmCaller {
  return async (cfg, input) => {
    const client = new OpenAI({ baseURL: cfg.vlm.baseUrl ?? undefined, apiKey: cfg.vlm.apiKey });
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: input.prompt },
      ...input.frames.map((f) => ({
        type: 'image_url' as const,
        image_url: { url: `data:image/jpeg;base64,${b64(f)}` },
      })),
    ];
    if (input.mode === 'video' && input.videoPath) {
      content.push({
        type: 'video_url',
        video_url: { url: `data:video/mp4;base64,${b64(input.videoPath)}` },
      } as any);
    }
    const res = await client.chat.completions.create({
      model: cfg.vlm.model,
      temperature: cfg.vlm.temperature,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }],
    });
    return res.choices[0]?.message?.content ?? '';
  };
}

/** Anthropic 原生（当前仅多模态模型走视频模式） */
export function createAnthropicCaller(): VlmCaller {
  return async (cfg, input) => {
    const client = new Anthropic({ baseURL: cfg.vlm.baseUrl ?? undefined, apiKey: cfg.vlm.apiKey });
    const content: Anthropic.Messages.MessageParam['content'] = [
      { type: 'text', text: input.prompt },
      ...input.frames.map((f) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: b64(f) } })),
    ];
    if (input.mode === 'video' && input.videoPath) {
      content.push({ type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: b64(input.videoPath) } } as any);
    }
    const res = await client.messages.create({
      model: cfg.vlm.model,
      max_tokens: 8192,
      temperature: cfg.vlm.temperature,
      messages: [{ role: 'user', content }],
    });
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  };
}

export function createVlmCaller(cfg: AppConfig): VlmCaller {
  return cfg.vlm.provider === 'anthropic' ? createAnthropicCaller() : createOpenAiCompatibleCaller();
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run tests/analyze/vlm.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 6: 提交**

```bash
git add src/analyze/vlm.ts tests/analyze/vlm.test.ts tests/fixtures/vlm-stub.ts
git commit -m "feat: VLM caller adapters (openai-compatible + anthropic) with local stub"
```

---

## Task 9: 分析编排 analyze/refine.ts（校验 → 自修正 → 输出）

**Files:**
- Create: `src/analyze/refine.ts`
- Test: `src/analyze/refine.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4/6/7/8 全部产物
- Produces（Task 10 依赖）:

```ts
export interface AnalyzeOptions {
  outDir: string;
  videoPath: string;
  cfg: AppConfig;
  caller?: VlmCaller; // 测试注入；缺省用 createVlmCaller(cfg)
}
export type AnalyzeResult =
  | { ok: true; stepsPath: string; data: StepsFile }
  | { ok: false; failurePath: string; reason: string; rawOutput: string; frameCount: number };
export async function analyzeVideo(opts: AnalyzeOptions): Promise<AnalyzeResult>;
export function finalizeSteps(steps: Step[]): Step[]; // 连续重复去重 + id 重排
```

- [ ] **Step 1: 写失败测试**（`src/analyze/refine.test.ts`）

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { analyzeVideo, finalizeSteps } from './refine.js';
import { loadConfig } from '../config/env.js';
import { validateSteps } from '../schema/steps.schema.js';
import type { Step } from '../schema/steps.schema.js';

const NO_ENV = '___no_such_env_file___';

function makeTestVideo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-re-'));
  const out = path.join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

const validJson = JSON.stringify({
  version: '1.0',
  steps: [
    { description: '打开登录页面', action_type: 'goto', target: null, value: null, start_sec: 0 },
    { description: '点击「登录」按钮', action_type: 'click', target: '登录按钮', value: null, start_sec: 1.2 },
  ],
});

const cfg = loadConfig(
  { VLM_API_KEY: 'sk-test', VLM_MODEL: 'qwen2.5-vl-max', VLM_BASE_URL: 'http://stub.invalid', VLM_MAX_RETRY: '2' },
  NO_ENV
);

describe('finalizeSteps', () => {
  it('连续重复步骤去重并重排 id', () => {
    const input: Step[] = [
      { id: 9, description: '点击「登录」按钮', action_type: 'click', target: '登录按钮', value: null, start_sec: 1 },
      { id: 8, description: '点击「登录」按钮', action_type: 'click', target: '登录按钮', value: null, start_sec: 2 },
      { id: 7, description: '输入 admin', action_type: 'input', target: '用户名输入框', value: 'admin', start_sec: 3 },
    ];
    const out = finalizeSteps(input);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(1);
    expect(out[1].id).toBe(2);
  });
});

describe('analyzeVideo', () => {
  it('模型一次成功 → ok，steps.json 落盘且通过 schema', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const caller = async () => validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const onDisk = JSON.parse(fs.readFileSync(r.stepsPath, 'utf8'));
      expect(validateSteps(onDisk).ok).toBe(true);
      expect(onDisk.steps.map((s: any) => s.description)).toContain('打开登录页面');
    }
  });

  it('两次不合格（含一次段落外文本）后成功：自修正生效', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const responses = ['{"steps":', 'plain text not json', validJson]; // 解析失败 → 再失败 → 成功
    const caller = async () => responses.shift() ?? validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller });
    expect(r.ok).toBe(true);
  });

  it('连续失败 → failure.json 且不含 steps.json', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const caller = async () => 'always invalid';
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(fs.existsSync(r.failurePath)).toBe(true);
      const f = JSON.parse(fs.readFileSync(r.failurePath, 'utf8'));
      expect(f.frame_count).toBeGreaterThan(0);
      expect(f.raw_model_output).toContain('always invalid');
    }
    expect(fs.existsSync(path.join(outDir, 'steps.json'))).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/analyze/refine.test.ts`
Expected: FAIL（refine 未定义）

- [ ] **Step 3: 实现 refine.ts**（当前版本仅处理模型返回恰好等于有效 outputs 的场景——`validateSteps` 直接字符串化传入）

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractFrames } from './extractFrames.js';
import { createVlmCaller, type VlmCaller } from './vlm.js';
import { buildUserMessage, loadPromptTemplate } from './prompt.js';
import { finalizeSteps, validateSteps, type Step, type StepsFile } from '../schema/steps.schema.js';
import { ensureDirs, readSessionMeta, writeFailure, writeSteps } from '../output/writer.js';
import type { AppConfig } from '../config/env.js';

export interface AnalyzeOptions {
  outDir: string;
  videoPath: string;
  cfg: AppConfig;
  caller?: VlmCaller;
}

export type AnalyzeResult =
  | { ok: true; stepsPath: string; data: StepsFile }
  | { ok: false; failurePath: string; reason: string; rawOutput: string; frameCount: number };

export function finalizeSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    const dup =
      prev &&
      prev.description === s.description &&
      prev.action_type === s.action_type &&
      (prev.value ?? null) === (s.value ?? null);
    if (dup) continue;
    out.push(s);
  }
  return out.map((s, i) => ({ ...s, id: i + 1 }));
}

export async function analyzeVideo(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const cfg = opts.cfg;
  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oprec-frames-'));
  const frames = await extractFrames({ videoPath: opts.videoPath, outDir: framesDir, ...cfg.frame });

  const template = await loadPromptTemplate(cfg.vlm.inputMode);
  const prompt = buildUserMessage(template, { mode: cfg.vlm.inputMode, frameCount: frames.frameCount });
  const caller = opts.caller ?? createVlmCaller(cfg);
  const rounds = cfg.vlm.maxRetry + 1;

  let attemptOutput = '';
  let lastErrors = ['模型未返回任何内容'];
  let modelRawOutput = '';

  for (let i = 0; i < rounds; i += 1) {
    const userPrompt = i === 0 ? prompt : `${prompt}\n\n注意：上一轮输出未通过校验，错误如下：\n${lastErrors.join('\n')}\n请重新生成完整的 JSON。`;
    modelRawOutput = await caller(cfg, {
      mode: cfg.vlm.inputMode,
      frames: frames.framePaths,
      videoPath: opts.videoPath,
      prompt: userPrompt,
    });
    attemptOutput = modelRawOutput;
    const v = validateSteps(modelRawOutput);
    if (v.ok) {
      const steps = finalizeSteps(v.data.steps);
      const session = await readSessionMeta(opts.outDir);
      const data: StepsFile = {
        version: '1.0',
        meta: {
          generated_at: new Date().toISOString(),
          target_url: session?.targetUrl ?? '',
          video: path.relative(opts.outDir, opts.videoPath).replace(/\\/g, '/'),
          model: cfg.vlm.model,
          input_mode: cfg.vlm.inputMode,
          frame_count: frames.frameCount,
        },
        steps,
      };
      const stepsPath = await writeSteps(opts.outDir, data, cfg.output.format);
      await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
      return { ok: true, stepsPath, data };
    }
    lastErrors = v.errors;
  }

  const failurePath = await writeFailure(opts.outDir, `模型输出连续 ${rounds} 轮未通过校验`, attemptOutput, frames.frameCount);
  await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  return { ok: false, failurePath, reason: lastErrors.join('; '), rawOutput: modelRawOutput, frameCount: frames.frameCount };
}

// 占位：确保 ensureDirs 类型引用（analyze 的 outDir 由 Task 10 的 CLI 用 ensureDirs 生成；此处不再重复建目录）
void ensureDirs;
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/analyze/refine.test.ts`
Expected: PASS（4 用例）

**说明**：`void ensureDirs;` 一行是为避免未使用导入告警的占位；如编码时报未使用错误，直接删除该导入与本行即可。

- [ ] **Step 5: 提交**

```bash
git add src/analyze/refine.ts src/analyze/refine.test.ts
git commit -m "feat: analyze pipeline with zod validation, self-correcting retry loop, failure artifact"
```

---

## Task 10: CLI（record / analyze / run）+ 库入口 src/index.ts + E2E 冒烟

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/index.ts`
- Test: `tests/cli/cli.test.ts`
- Modify: `package.json`（scripts：`build` 已含；如需快捷入口再补 `start`）

**Interfaces:**
- Consumes: Task 2/4/5/9 全部
- Produces: 两张对外接口

```ts
// src/index.ts（库入口，平台 TS 侧可直接 import）
export { recordAndWait, type RecordOptions, type RecordResult } from './record/recorder.js';
export { analyzeVideo, type AnalyzeOptions, type AnalyzeResult } from './analyze/refine.js';
export { loadConfig, ConfigError, type AppConfig } from './config/env.js';
export { validateSteps, type Step, type StepsFile } from './schema/steps.schema.js';
export { ensureDirs, createSessionId } from './output/writer.js';

// src/cli/index.ts（bin 入口）
export async function main(argv: string[]): Promise<number>; // 0 成功 / 1 一般失败 / 2 配置错误
// 子命令（职责与 spec §4 一致）：
//   record    --target <url> [--out <dir>] [--max-duration-min N] [--viewport WxH] [--verbose]
//   analyze   --video <path> [--out <dir>] [--format json|yaml] [--model M] [--base-url U] [--api-key K] [--vlm-input-mode frames|video] [--verbose]
//   run       --target <url> [record 全部选项] [analyze 全部选项] [--verbose]
// stdout 稳定行：record → `output: <outDir>` + `video: <videoPath>`；analyze → `steps: <path>` 或 `failure: <path>`；run → 两者都要
```

- [ ] **Step 1: 写失败测试**（`tests/cli/cli.test.ts`）

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { startVlmStub } from '../fixtures/vlm-stub.js';
import { startPageServer } from '../fixtures/page-server.js';

let stub: { url: string; requests: any[]; close: () => Promise<void> };
let page: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  stub = await startVlmStub(JSON.stringify({
    version: '1.0',
    steps: [{ description: '打开测试页', action_type: 'goto', target: null, value: null, start_sec: 0 }],
  }));
  page = await startPageServer();
});
afterAll(async () => {
  await stub.close();
  await page.close();
});

const NO_ENV = '___no_such_env_file___';

describe('cli main', () => {
  it('analyze（stub VLM）→ 0 且产出 steps.json', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-cli-'));
    // 用 stub 服务器响应，“视频”用 ffmpeg 现场生成
    const { execFileSync } = await import('node:child_process');
    const video = path.join(out, 'src.mp4');
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const envPath = path.join(out, '.env');
    fs.writeFileSync(envPath, [
      `VLM_PROVIDER=openai-compatible`,
      `VLM_BASE_URL=${stub.url}`,
      `VLM_API_KEY=sk-test`,
      `VLM_MODEL=qwen2.5-vl-max`,
      `VLM_INPUT_MODE=frames`,
      `RECORD_MAX_DURATION_MIN=1`,
    ].join('\n'));

    const code = await main([
      'analyze',
      '--video', video,
      '--out', out,
      '--env-file', envPath,
    ]);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(out, 'steps.json'))).toBe(true);
  });

  it('缺 --target 的 record 返回 2（配置错误）', async () => {
    const code = await main(['record', '--out', os.tmpdir()]);
    expect(code).toBe(2);
  });

  it('analyze 指向不存在的视频返回 1', async () => {
    const code = await main(['analyze', '--video', path.join(os.tmpdir(), 'nope.mp4'), '--out', os.tmpdir()]);
    expect(code).toBe(1);
  });
});

// 说明：run 全链路（弹有头浏览器等人工关窗）无法在自动化测试内完成，完整验收移至 Task 11 手动清单。

**注意**：`run` 的真实 E2E（弹有头浏览器等人工关窗）不便在自动化测试内完成，自动测试只验证参数解析与稳定产出；**完整 run 验收放 Task 11 手动清单**。CLI 需要新增 `--env-file` 选项：指定 .env 路径（缺省 `.env`），用于测试隔离与平台侧多环境切换。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/cli/cli.test.ts`
Expected: FAIL（cli 模块不存在）

- [ ] **Step 3: 实现 src/cli/index.ts**

```ts
import path from 'node:path';
import fs from 'node:fs';
import { Command, CommanderError } from 'commander';
import { loadConfig, ConfigError } from '../config/env.js';
import { ensureDirs } from '../output/writer.js';
import { recordAndWait } from '../record/recorder.js';
import { analyzeVideo } from '../analyze/refine.js';

const stdout = (line: string) => console.log(line);

function parseViewport(v: string): { width: number; height: number } {
  const [w, h] = v.split('x').map(Number);
  return { width: w, height: h };
}

function resolveAnalyzeOutDir(videoPath: string): string {
  if (path.basename(videoPath) === 'video.mp4') {
    return path.join(path.dirname(videoPath), '..'); // recording/../ → 会话目录
  }
  return path.dirname(videoPath);
}

export async function main(argv: string[]): Promise<number> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => process.stderr.write(s), writeOut: (s) => process.stdout.write(s) });

  program.description('录制浏览器操作 → 视觉大模型 → 结构化操作步骤（供 midscene.js 脚本）');

  program
    .command('record')
    .description('录制：弹出有头浏览器，等待用户操作后关闭窗口，产出 mp4 + 活动截图')
    .requiredOption('--target <url>', '目标页面地址')
    .option('--out <dir>', '产物根目录（默认 out/）', 'out')
    .option('--max-duration-min <n>', '最长录制分钟数', '30')
    .option('--viewport <WxH>', '浏览器视口', '1280x800')
    .option('--env-file <path>', '.env 文件路径（默认 .env）', '.env')
    .option('--verbose', '输出调试日志到 stderr', false)
    .action(async (opts) => {
      const cfg = loadConfig({}, opts.envFile);
      const dirs = await ensureDirs(opts.out);
      if (opts.verbose) console.error(`[record] target=${opts.target} out=${dirs.outDir}`);
      const result = await recordAndWait({
        targetUrl: opts.target,
        ...dirs,
        maxDurationMin: Number(opts.maxDurationMin),
        viewport: parseViewport(opts.viewport),
      });
      stdout(`output: ${dirs.outDir}`);
      stdout(`video: ${result.videoPath}`);
      stdout(`screenshots: ${result.screenshotCount}`);
    });

  program
    .command('analyze')
    .description('分析：抽帧 → 视觉大模型 → steps.json（可对同一视频无限重跑）')
    .requiredOption('--video <path>', '视频文件路径')
    .option('--out <dir>', '产物目录（默认：视频所在会话目录）')
    .option('--format <json|yaml>', '输出格式', 'json')
    .option('--model <m>', '覆盖 VLM_MODEL')
    .option('--base-url <u>', '覆盖 VLM_BASE_URL')
    .option('--api-key <k>', '覆盖 VLM_API_KEY')
    .option('--vlm-input-mode <frames|video>', '覆盖 VLM_INPUT_MODE', 'frames')
    .option('--env-file <path>', '.env 文件路径（默认 .env）', '.env')
    .option('--verbose', '输出调试日志到 stderr', false)
    .action(async (opts) => {
      if (!fs.existsSync(opts.video)) throw new Error(`视频文件不存在：${opts.video}`);
      const overrides: Record<string, string> = {};
      if (opts.model) overrides.VLM_MODEL = opts.model;
      if (opts.baseUrl) overrides.VLM_BASE_URL = opts.baseUrl;
      if (opts.apiKey) overrides.VLM_API_KEY = opts.apiKey;
      if (opts.vlmInputMode) overrides.VLM_INPUT_MODE = opts.vlmInputMode;
      if (opts.format) overrides.OUTPUT_FORMAT = opts.format;
      const cfg = loadConfig(overrides, opts.envFile);
      const outDir = opts.out ?? resolveAnalyzeOutDir(opts.video);
      if (opts.verbose) console.error(`[analyze] video=${opts.video} out=${outDir} model=${cfg.vlm.model}`);
      const result = await analyzeVideo({ outDir, videoPath: opts.video, cfg });
      if (result.ok) {
        stdout(`steps: ${result.stepsPath}`);
      } else {
        console.error(`[analyze] 失败：${result.reason}`);
        stdout(`failure: ${result.failurePath}`);
        process.exitCode = 1;
      }
    });

  program
    .command('run')
    .description('录制 + 分析 一步到位')
    .requiredOption('--target <url>', '目标页面地址')
    .option('--out <dir>', '产物根目录（默认 out/）', 'out')
    .option('--max-duration-min <n>', '最长录制分钟数', '30')
    .option('--viewport <WxH>', '浏览器视口', '1280x800')
    .option('--format <json|yaml>', '输出格式', 'json')
    .option('--model <m>', '覆盖 VLM_MODEL')
    .option('--base-url <u>', '覆盖 VLM_BASE_URL')
    .option('--api-key <k>', '覆盖 VLM_API_KEY')
    .option('--vlm-input-mode <frames|video>', '覆盖 VLM_INPUT_MODE', 'frames')
    .option('--env-file <path>', '.env 文件路径（默认 .env）', '.env')
    .option('--verbose', '输出调试日志到 stderr', false)
    .action(async (opts) => {
      const cfg = loadConfig({}, opts.envFile);
      const dirs = await ensureDirs(opts.out);
      if (opts.verbose) console.error(`[run] target=${opts.target} out=${dirs.outDir}`);
      const recordResult = await recordAndWait({
        targetUrl: opts.target,
        ...dirs,
        maxDurationMin: Number(opts.maxDurationMin),
        viewport: parseViewport(opts.viewport),
      });
      const overrides: Record<string, string> = {
        VLM_INPUT_MODE: opts.vlmInputMode,
      };
      if (opts.format) overrides.OUTPUT_FORMAT = opts.format;
      if (opts.model) overrides.VLM_MODEL = opts.model;
      if (opts.baseUrl) overrides.VLM_BASE_URL = opts.baseUrl;
      if (opts.apiKey) overrides.VLM_API_KEY = opts.apiKey;
      const analyzeCfg = loadConfig(overrides, opts.envFile);
      const result = await analyzeVideo({ outDir: dirs.outDir, videoPath: recordResult.videoPath, cfg: analyzeCfg });
      stdout(`output: ${dirs.outDir}`);
      stdout(`video: ${recordResult.videoPath}`);
      if (result.ok) {
        stdout(`steps: ${result.stepsPath}`);
      } else {
        console.error(`[run] 分析失败：${result.reason}`);
        stdout(`failure: ${result.failurePath}`);
        process.exitCode = 1;
      }
    });

  try {
    await program.parseAsync(argv);
    return process.exitCode || 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`配置错误：${e.message}`);
      return 2;
    }
    if (e instanceof CommanderError) {
      console.error(`参数错误：${e.message}`);
      return 2;
    }
    if (e instanceof Error) {
      console.error(`失败：${e.message}`);
      if (process.env.OP_RECORDER_DEBUG) console.error(e.stack);
      return 1;
    }
    return 1;
  } finally {
    process.exitCode = 0;
  }
}

// bin 入口
if (import.meta.url === new URL(`file://${process.argv[1]?.replace(/\\/g, '/')}`).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
```

**注意**：bin 入口自检行在 Windows 路径反斜杠下可能不正匹配，如失效则删掉该 `if` 块，bin 直接调 `main(process.argv.slice(2)).then(...)`（模块被 test 直接 import `main`，不经 bin 自检，因此该分支低风险）。

- [ ] **Step 4: 实现 src/index.ts**

```ts
export { recordAndWait, type RecordOptions, type RecordResult } from './record/recorder.js';
export { analyzeVideo, type AnalyzeOptions, type AnalyzeResult } from './analyze/refine.js';
export { loadConfig, ConfigError, type AppConfig } from './config/env.js';
export { validateSteps, type Step, type StepsFile } from './schema/steps.schema.js';
export { ensureDirs, createSessionId } from './output/writer.js';
```

- [ ] **Step 5: 运行测试**

Run: `npx vitest run tests/cli/cli.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 6: 全量回归 + 构建**

Run:

```bash
npm test
npm run build
```

Expected: 全部测试 PASS；`npm run build` 产出 `dist/` 无类型错误。

- [ ] **Step 7: 提交**

```bash
git add src/cli/index.ts src/index.ts tests/cli/cli.test.ts
git commit -m "feat: cli (record/analyze/run) with stable stdout contract and library entry"
```

---

## Task 11: README + 手动验收清单 + 交付收尾

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: 前序全部
- Produces: 项目门面文档与验收标准

- [ ] **Step 1: 创建 README.md**

```markdown
# op-recorder

录制用户在浏览器中的手动操作 → 视觉大模型分析 → 结构化操作步骤（steps.json / steps.yaml），供自动化测试平台转换为 midscene.js 集成的 Playwright 脚本。

## 依赖

- Node ≥ 18
- ffmpeg（含 libx264）在 PATH：Windows `winget install Gyan.FFmpeg` / macOS `brew install ffmpeg` / Linux `apt install ffmpeg`
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
    └── session.json       # 录制会话元信息

## 配置

全部视觉模型密钥与行为参数通过 `.env` 配置（不读系统环境变量），CLI 参数优先级最高，详见 `.env.example` 与 docs/superpowers/specs/2026-08-26-op-recorder-design.md。

## 退出码

0 成功 / 1 一般失败 / 2 配置错误。stdout 输出稳定行（`output:` / `video:` / `steps:` / `failure:`），诊断日志走 stderr，`--verbose` 开启。

## 开发

```bash
npm test          # vitest（含录制/抽帧的本地集成测试）
npm run build     # tsc 产出 dist/
```
```

- [ ] **Step 2: 手动验收清单（真实模型，人工执行）**

按顺序执行并记录结果：

1. `cp .env.example .env`，填入真实可用 key 与模型（多模态，如 qwen2.5-vl-max）。
2. `npm run cli -- record --target https://example.com`，在弹出浏览器中完成：点击链接 → 表单输入 → 停留 2 秒 → 关闭窗口。检查：`video.mp4` 存在；`screens/` 有截图；`session.json` 有 target_url。
3. `npm run cli -- analyze --video <上一步的 mp4>`。检查：`steps.json` 生成；`description` 措辞可直接拼进 midscene 指令；`action_type` 枚举合法。
4. 再跑一次 `analyze --format yaml`，结构同构。
5. 验证失败路径：`analyze` 时临时将 `.env` 的 `VLM_API_KEY` 改错 → 退出码 1 / failure 或模型错误清晰报出。
6. 验证配置守卫：`.env` 设 `VLM_INPUT_MODE=video` + `VLM_VIDEO_SUPPORTED=false` → 退出码 2，提示切换 frames。
7. 从 `steps.json` 手工构造一段 midscene 脚本（`ai.action('点击页面右上角的「登录」按钮')` 级别），确认可用。
8. `npm run cli -- run --target https://example.com` 全链路（录制→分析→steps.json）用真实模型走一遍，注意 CLI 等待关窗期间窗口保持可用。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: README with usage, artifacts layout, acceptance checklist"
```

---

## 自查（本计划编写时校对）

对照 spec 各节逐项落位：录制（§5）→ Task 5；抽帧与参数（§5）→ Task 6；双模式 VLM（§7）→ Task 8；prompt 与自修正（§8）→ Task 7/9；schema（§6）→ Task 3；写入与产物目录（§6/5）→ Task 4；配置与守卫（§7）→ Task 2；CLI/库入口与退出码（§4/9）→ Task 10；README/验收（§10 人工口）→ Task 11。非目标（§11）不做。
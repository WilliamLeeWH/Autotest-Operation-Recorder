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
  RECORD_CLICK_HIGHLIGHT: z.enum(['true', 'false']).default('true'),
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
  record: { maxDurationMin: number; viewport: { width: number; height: number }; clickHighlight: boolean };
  output: { format: 'json' | 'yaml' };
}

export function resolveVideoSupported(model: string, raw: 'auto' | 'true' | 'false'): boolean {
  if (raw === 'auto') return isVideoCapableModel(model);
  return raw === 'true';
}

export function assertModelInputCompatible(cfg: AppConfig): void {
  if (cfg.vlm.inputMode === 'video' && !cfg.vlm.videoSupported) {
    throw new ConfigError(
      `纯视觉模型（仅图片输入）不支持 video 模式。请在 .env 中设置 VLM_INPUT_MODE=frames，或替换为支持原生视频的多模态模型。`,
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
    // NOTE: z.treeifyError does not exist in zod ^3.25; use flatten() as fallback
    const first = JSON.stringify(parsed.error.flatten().fieldErrors);
    throw new ConfigError(`配置无效：${first.slice(0, 300)}（.env 或 CLI 参数）`);
  }
  const r = parsed.data;
  if (r.VLM_PROVIDER === 'openai-compatible' && !r.VLM_BASE_URL) {
    throw new ConfigError(
      'openai-compatible 提供商必须配置 VLM_BASE_URL（.env 中填写兼容端点地址，如 DashScope compatible-mode）。',
    );
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
    record: { maxDurationMin: r.RECORD_MAX_DURATION_MIN, viewport: { width: w, height: h }, clickHighlight: r.RECORD_CLICK_HIGHLIGHT === 'true' },
    output: { format: r.OUTPUT_FORMAT },
  };
  assertModelInputCompatible(cfg);
  return cfg;
}

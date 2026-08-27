import { describe, it, expect } from 'vitest';
import { ConfigError, loadConfig } from './env.js';

const NO_ENV = '___no_such_env_file___';

const BASE_OVERRIDES: Record<string, string> = {
  VLM_API_KEY: 'sk-test',
  VLM_MODEL: 'qwen2.5-vl-max',
  VLM_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
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
    // spread BASE_OVERRIDES minus VLM_BASE_URL via explicit merge
    expect(() =>
      loadConfig({ VLM_API_KEY: 'x', VLM_MODEL: 'm', VLM_BASE_URL: '' }, NO_ENV),
    ).toThrow(ConfigError);
  });

  it('video 模式 + 纯视觉模型抛 ConfigError（启动守卫）', () => {
    expect(() =>
      loadConfig(
        { ...BASE_OVERRIDES, VLM_INPUT_MODE: 'video', VLM_VIDEO_SUPPORTED: 'false' },
        NO_ENV,
      ),
    ).toThrow(ConfigError);
  });
});

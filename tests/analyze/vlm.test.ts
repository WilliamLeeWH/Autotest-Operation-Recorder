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
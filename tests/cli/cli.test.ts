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
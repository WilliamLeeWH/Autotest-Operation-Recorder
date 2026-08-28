import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { startVlmStub } from '../fixtures/vlm-stub.js';
import { startPageServer } from '../fixtures/page-server.js';

const require = createRequire(import.meta.url);
// 夹具一律用内置二进制生成：开发者机器上不装 ffmpeg 也能跑完整测试
const FF = require('ffmpeg-static') as string;

function makeTestVideo(outDir: string): string {
  const video = path.join(outDir, 'src.mp4');
  execFileSync(FF, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  return video;
}

let stub: { url: string; requests: any[]; close: () => Promise<void> };
let page: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  stub = await startVlmStub(JSON.stringify({
    version: '1.0',
    steps: [{ description: '打开测试页', action_type: 'goto', target: null, value: null, assertion: '页面显示测试页内容', start_sec: 0 }],
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
    // 用 stub 服务器响应，“视频”用内置 ffmpeg 现场生成
    const video = makeTestVideo(out);
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

  it('.env 设 video 模式 + 非视频模型 → 守卫可达返回 2（CLI 默认值不遮蔽 .env）', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-cli-'));
    const video = makeTestVideo(out);
    const envPath = path.join(out, '.env');
    fs.writeFileSync(envPath, [
      `VLM_PROVIDER=openai-compatible`,
      `VLM_BASE_URL=${stub.url}`,
      `VLM_API_KEY=sk-test`,
      `VLM_MODEL=my-custom-vision-1`,
      `VLM_INPUT_MODE=video`,
    ].join('\n'));

    const code = await main(['analyze', '--video', video, '--out', out, '--env-file', envPath]);
    expect(code).toBe(2);
  });

  it('.env 设 OUTPUT_FORMAT=yaml → 0 且产出 steps.yaml', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-cli-'));
    const video = makeTestVideo(out);
    const envPath = path.join(out, '.env');
    fs.writeFileSync(envPath, [
      `VLM_PROVIDER=openai-compatible`,
      `VLM_BASE_URL=${stub.url}`,
      `VLM_API_KEY=sk-test`,
      `VLM_MODEL=qwen2.5-vl-max`,
      `VLM_INPUT_MODE=frames`,
      `OUTPUT_FORMAT=yaml`,
    ].join('\n'));

    const code = await main(['analyze', '--video', video, '--out', out, '--env-file', envPath]);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(out, 'steps.yaml'))).toBe(true);
  });
});
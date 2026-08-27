import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeVideoDurationMs, transcodeVideoToMp4 } from '../../src/lib/ffmpeg.js';
import { extractFrames } from '../../src/analyze/extractFrames.js';

const require = createRequire(import.meta.url);
const FF = require('ffmpeg-static') as string;

// 夹具一律用内置二进制生成：开发者机器上不装 ffmpeg 也能跑完整测试
function makeTestVideo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-vid-'));
  const out = path.join(dir, 'src.mp4');
  execFileSync(FF, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  ]);
  return out;
}

describe('ffmpeg helpers', () => {
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
  afterEach(() => vi.unstubAllEnvs());

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

  it('maxCount=1 时均匀抽样取 1 帧且非 undefined（n=1 除零回归）', async () => {
    const v = makeTestVideo();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-fr-'));
    const r = await extractFrames({ videoPath: v, outDir: dir, mode: 'interval', intervalSec: 0.2, sceneThreshold: 0.3, maxCount: 1, maxWidth: 320 });
    expect(r.framePaths).toHaveLength(1);
    expect(r.framePaths[0]).toMatch(/\.jpg$/);
    expect(fs.existsSync(r.framePaths[0])).toBe(true);
  });

  it('scene 阈值 1.0 无变化画面 -> 抛出"操作过短"错误', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-fr-'));
    const blank = path.join(dir, 'blank.mp4');
    execFileSync(FF, ['-y', '-f', 'lavfi', '-i', 'color=black:duration=2:size=320x240:rate=5', '-c:v', 'libx264', blank]);
    await expect(
      extractFrames({ videoPath: blank, outDir: dir, mode: 'scene', intervalSec: 1, sceneThreshold: 1.0, maxCount: 30, maxWidth: 320 })
    ).rejects.toThrow(/操作过短|未提取到任何帧/);
  });

  it('PATH 清空（无系统 ffmpeg）时仅靠内置二进制仍能抽帧', async () => {
    const v = makeTestVideo();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-fr-'));
    vi.stubEnv('PATH', '');
    const r = await extractFrames({ videoPath: v, outDir: dir, mode: 'interval', intervalSec: 1, sceneThreshold: 0.3, maxCount: 30, maxWidth: 320 });
    expect(r.frameCount).toBeGreaterThanOrEqual(3);
  });
});
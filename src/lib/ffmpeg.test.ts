import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureFfmpeg, ffmpegPath, ffprobePath, probeVideoDurationMs, transcodeVideoToMp4 } from './ffmpeg.js';

const require = createRequire(import.meta.url);
const ffmpegStatic = require('ffmpeg-static') as string | null;
const ffprobeStatic = require('ffprobe-static') as { path: string };

const FF = ffmpegStatic as string;

function makeTestVideo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-bundled-'));
  const out = path.join(dir, 'src.mp4');
  execFileSync(FF, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  ]);
  return out;
}

describe('ffmpeg 内置二进制解析', () => {
  it('ffmpegPath 解析到 npm 内置二进制（而非系统 PATH）且文件存在', () => {
    const p = ffmpegPath();
    expect(p).toBe(ffmpegStatic);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('ffprobePath 解析到 npm 内置 ffprobe 且文件存在', () => {
    const p = ffprobePath();
    expect(p).toBe(ffprobeStatic.path);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('ensureFfmpeg 返回与 ffmpegPath 一致的解析结果', async () => {
    await expect(ensureFfmpeg()).resolves.toBe(ffmpegPath());
  });
});

describe('无系统 ffmpeg（PATH 清空）时仅靠内置二进制可用', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('probeVideoDurationMs 与 transcodeVideoToMp4 仍工作', async () => {
    const v = makeTestVideo();
    vi.stubEnv('PATH', '');
    const ms = await probeVideoDurationMs(v);
    expect(ms).toBeGreaterThan(0);
    const dst = path.join(path.dirname(v), 'out.mp4');
    await transcodeVideoToMp4(v, dst);
    expect(fs.existsSync(dst)).toBe(true);
  });
});
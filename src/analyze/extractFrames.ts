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
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', opts.videoPath, '-vf', vf, '-frames:v', String(RAW_FRAME_CAP), '-q:v', '4', outPattern], { shell: true });
  } catch (err) {
    // ffmpeg may exit non-zero when no frames are produced (e.g., scene=1.0 on blank video).
    // We rely on file system check below rather than ffmpeg exit code.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('Nothing was written into output file') && !msg.includes('No filtered frames')) {
      throw err;
    }
  }
  const files = (await fs.readdir(opts.outDir)).filter((f) => f.endsWith('.jpg')).sort();
  const all = files.map((f) => path.join(opts.outDir, f));
  const framePaths = uniformSample(all, opts.maxCount);
  if (framePaths.length === 0) {
    throw new Error('视频中未提取到任何帧（录制过短或视频无效），请重新录制');
  }
  return { framePaths, frameCount: framePaths.length };
}

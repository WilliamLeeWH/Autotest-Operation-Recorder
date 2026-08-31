import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureFfmpeg, probeVideoDurationMs } from '../lib/ffmpeg.js';

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
  /** 抽帧预览视频目标路径：把送入模型的帧渲染成 mp4，供对照原录像检查抽样密度是否丢关键操作 */
  previewVideoPath?: string;
}

export interface ExtractFramesResult {
  framePaths: string[];
  frameCount: number;
  /** 按抽帧频率实际抽出的总帧数（maxCount 截断前的完整序列） */
  extractedCount: number;
}

/**
 * 把送入模型的帧子集渲染成预览视频：
 * 每帧停留时长 = 原视频总时长/帧数，预览与原视频等长、可同步进度条对照；
 * 原视频时长探测失败时退化为按 intervalSec 每帧。送入帧在原目录编号不连续，
 * 先复制到一个新临时目录连号命名，再交给 image2 解码器。
 */
async function renderPreviewVideo(opts: ExtractFramesOptions, framePaths: string[], ffmpegBin: string): Promise<void> {
  if (!opts.previewVideoPath) return;
  await fs.mkdir(path.dirname(opts.previewVideoPath), { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oprec-preview-'));
  try {
    await Promise.all(
      framePaths.map((f, i) => fs.copyFile(f, path.join(tmpDir, `f_${String(i + 1).padStart(4, '0')}.jpg`))),
    );
    let perFrameSec = opts.intervalSec;
    try {
      const durationMs = await probeVideoDurationMs(opts.videoPath);
      perFrameSec = Math.max(0.05, (durationMs / 1000) / framePaths.length);
    } catch {
      // 时长探测失败：按配置间隔每帧
    }
    await execFileAsync(ffmpegBin, [
      '-y', '-framerate', `${1 / perFrameSec}`, '-i', path.join(tmpDir, 'f_%04d.jpg'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', opts.previewVideoPath,
    ]);
    if (!(await fs.stat(opts.previewVideoPath).catch(() => null))) {
      throw new Error(`抽帧预览视频生成失败：${opts.previewVideoPath}`);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function uniformSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  // n=1 would divide by zero below (n-1) and yield [undefined]; take the first item.
  if (n <= 1) return items.length > 0 ? [items[0]] : [];
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  }
  return out;
}

export async function extractFrames(opts: ExtractFramesOptions): Promise<ExtractFramesResult> {
  const ffmpegBin = await ensureFfmpeg();
  await fs.mkdir(opts.outDir, { recursive: true });
  const outPattern = path.join(opts.outDir, 'frame_%04d.jpg');
  const vf =
    opts.mode === 'scene'
      ? `select='gt(scene,${opts.sceneThreshold})',setpts=N/(25*TB),scale='min(${opts.maxWidth},iw)':-2`
      : `fps=1/${opts.intervalSec},scale='min(${opts.maxWidth},iw)':-2`;
  try {
    await execFileAsync(ffmpegBin, ['-y', '-i', opts.videoPath, '-vf', vf, '-frames:v', String(RAW_FRAME_CAP), '-q:v', '4', outPattern]);
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
  await renderPreviewVideo(opts, framePaths, ffmpegBin);
  return { framePaths, frameCount: framePaths.length, extractedCount: all.length };
}

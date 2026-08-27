import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
// 两个包都是 CJS 且无可靠 ES 类型声明（ffmpeg-static 的 d.ts 与 NodeNext 解析不兼容），
// 统一用 require 直取运行时导出并显式声明类型。
const ffmpegStatic = require('ffmpeg-static') as string | null;
const ffprobeStatic = require('ffprobe-static') as { path: string };

const execFileAsync = promisify(execFile);
const BINARY_HINT = '未找到 ffmpeg/ffprobe。请重新执行 npm install 以恢复内置二进制（node_modules 应包含 ffmpeg-static / ffprobe-static）。';

/**
 * 解析 ffmpeg/ffprobe 可执行文件：
 * 优先 npm 内置二进制（ffmpeg-static / ffprobe-static，随依赖自动下载），
 * 失败时回退系统 PATH（开发机可能已有本地安装），都没有则抛清晰错误。
 */
function resolveCommand(bundledPath: string | null | undefined, command: 'ffmpeg' | 'ffprobe'): string {
  if (bundledPath && fs.existsSync(bundledPath)) {
    return bundledPath;
  }
  try {
    execFileSync(command, ['-version'], { encoding: 'utf8', stdio: 'ignore' });
    return command;
  } catch {
    throw new Error(BINARY_HINT);
  }
}

export function ffmpegPath(): string {
  return resolveCommand(ffmpegStatic, 'ffmpeg');
}

export function ffprobePath(): string {
  return resolveCommand(ffprobeStatic.path, 'ffprobe');
}

export async function ensureFfmpeg(): Promise<string> {
  return ffmpegPath();
}

export async function probeVideoDurationMs(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync(ffprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
  ]);
  const s = parseFloat(stdout.trim());
  if (Number.isNaN(s)) throw new Error(`无法读取视频时长：${videoPath}`);
  return Math.round(s * 1000);
}

export async function transcodeVideoToMp4(src: string, dst: string): Promise<void> {
  await execFileAsync(ffmpegPath(), [
    '-y', '-i', src,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an',
    '-movflags', '+faststart', dst,
  ]);
  if (!fs.existsSync(dst)) throw new Error(`转码失败：${dst} 未生成`);
}
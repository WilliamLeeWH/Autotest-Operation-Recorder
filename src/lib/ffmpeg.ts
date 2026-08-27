import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FFMPEG_HINT = '未检测到 ffmpeg。请安装并加入 PATH：Windows: `winget install Gyan.FFmpeg` 或 scoop 安装；macOS: `brew install ffmpeg`；Linux: `apt install ffmpeg`。';

export async function ensureFfmpeg(): Promise<string> {
  try {
    const r = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    const firstLine = r.split('\n')[0] ?? '';
    // On Windows the first line is "ffmpeg version ..." which doesn't end with /ffmpeg/i.
    // Return the canonical command name when the full output doesn't end with it.
    if (/^ffmpeg\b/i.test(firstLine)) {
      return 'ffmpeg';
    }
    return firstLine || 'ffmpeg';
  } catch {
    throw new Error(FFMPEG_HINT);
  }
}

export async function probeVideoDurationMs(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
  ]);
  const s = parseFloat(stdout.trim());
  if (Number.isNaN(s)) throw new Error(`无法读取视频时长：${videoPath}`);
  return Math.round(s * 1000);
}

export async function transcodeVideoToMp4(src: string, dst: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y', '-i', src,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an',
    '-movflags', '+faststart', dst,
  ]);
  if (!fs.existsSync(dst)) throw new Error(`转码失败：${dst} 未生成`);
}

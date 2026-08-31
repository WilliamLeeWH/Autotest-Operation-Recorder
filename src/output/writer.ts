import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { StepsFile } from '../schema/steps.schema.js';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function createSessionId(now: Date = new Date()): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function ensureDirs(outRoot: string, sessionId = createSessionId()): Promise<{
  outDir: string;
  recordingDir: string;
  screenshotsDir: string;
  resultsDir: string;
}> {
  const outDir = path.join(outRoot, sessionId);
  // 会话目录下三个平级子目录：recording（原始录像+抽帧预览）、screenshots（页面截图）、results（结果 json）
  const recordingDir = path.join(outDir, 'recording');
  const screenshotsDir = path.join(outDir, 'screenshots');
  const resultsDir = path.join(outDir, 'results');
  await fs.mkdir(recordingDir, { recursive: true });
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(resultsDir, { recursive: true });
  return { outDir, recordingDir, screenshotsDir, resultsDir };
}

/** 结果 json 一律落在 results/ 下；目录可按需创建（analyze 直接对任意视频目录执行时亦是如此） */
async function resultsFile(outDir: string, file: string): Promise<string> {
  const dir = path.join(outDir, 'results');
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, file);
}

export async function writeSteps(outDir: string, data: StepsFile, format: 'json' | 'yaml'): Promise<string> {
  const filePath = await resultsFile(outDir, `steps.${format === 'json' ? 'json' : 'yaml'}`);
  const text = format === 'json' ? JSON.stringify(data, null, 2) : yaml.dump(data);
  await fs.writeFile(filePath, text, 'utf8');
  return filePath;
}

/** failure.json 的一个 epoch：失败轮带原因与模型原始输出；成功轮只带 is_success 与轮次（其余缺省） */
export type FailureEpoch =
  | { is_success: true; round: number }
  | { is_success: false; round: number; reason: string; raw_model_output: string };

/** 每轮分析结果入 epochs，帧数置顶层；任何一轮失败（无论最终成败）都应写盘，供排查模型输出 */
export async function writeFailure(outDir: string, frameCount: number, epochs: FailureEpoch[]): Promise<string> {
  const filePath = await resultsFile(outDir, 'failure.json');
  await fs.writeFile(filePath, JSON.stringify({ frame_count: frameCount, epochs }, null, 2), 'utf8');
  return filePath;
}

export async function writeSessionMeta(outDir: string, meta: { targetUrl: string; startedAt: Date }): Promise<string> {
  const filePath = await resultsFile(outDir, 'session.json');
  await fs.writeFile(filePath, JSON.stringify({ target_url: meta.targetUrl, started_at: meta.startedAt.toISOString() }, null, 2), 'utf8');
  return filePath;
}

export interface AnalysisRoundInfo {
  round: number;
  status: 'ok' | 'invalid' | 'error';
  started_at: string;
  ended_at: string;
  duration_ms: number;
}

export interface AnalysisInfo {
  started_at: string;
  ended_at: string;
  result: 'ok' | 'failed' | 'error';
  rounds: AnalysisRoundInfo[];
}

/** 把分析块合并进 session.json：保留录制阶段的 target_url / started_at；文件缺失时直接新建 */
export async function updateSessionAnalysis(outDir: string, analysis: AnalysisInfo): Promise<string> {
  const filePath = await resultsFile(outDir, 'session.json');
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    // session.json 缺失（如直接 analyze 无录制会话）：仅写分析块
  }
  await fs.writeFile(filePath, JSON.stringify({ ...base, analysis }, null, 2), 'utf8');
  return filePath;
}

export async function readSessionMeta(outDir: string): Promise<{ targetUrl: string } | null> {
  try {
    const f = JSON.parse(await fs.readFile(path.join(outDir, 'results', 'session.json'), 'utf8'));
    return typeof f.target_url === 'string' ? { targetUrl: f.target_url } : null;
  } catch {
    return null;
  }
}

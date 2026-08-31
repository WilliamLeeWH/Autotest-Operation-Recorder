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
  screensDir: string;
}> {
  const outDir = path.join(outRoot, sessionId);
  const recordingDir = path.join(outDir, 'recording');
  const screensDir = path.join(recordingDir, 'screens');
  await fs.mkdir(screensDir, { recursive: true });
  return { outDir, recordingDir, screensDir };
}

export async function writeSteps(outDir: string, data: StepsFile, format: 'json' | 'yaml'): Promise<string> {
  const filePath = path.join(outDir, `steps.${format === 'json' ? 'json' : 'yaml'}`);
  const text = format === 'json' ? JSON.stringify(data, null, 2) : yaml.dump(data);
  await fs.writeFile(filePath, text, 'utf8');
  return filePath;
}

export async function writeFailure(outDir: string, reason: string, rawOutput: string, frameCount: number): Promise<string> {
  const filePath = path.join(outDir, 'failure.json');
  await fs.writeFile(filePath, JSON.stringify({ reason, frame_count: frameCount, raw_model_output: rawOutput }, null, 2), 'utf8');
  return filePath;
}

export async function writeSessionMeta(outDir: string, meta: { targetUrl: string; startedAt: Date }): Promise<string> {
  const filePath = path.join(outDir, 'session.json');
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
  const filePath = path.join(outDir, 'session.json');
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
    const f = JSON.parse(await fs.readFile(path.join(outDir, 'session.json'), 'utf8'));
    return typeof f.target_url === 'string' ? { targetUrl: f.target_url } : null;
  } catch {
    return null;
  }
}

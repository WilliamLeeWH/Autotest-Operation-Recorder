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

export async function readSessionMeta(outDir: string): Promise<{ targetUrl: string } | null> {
  try {
    const f = JSON.parse(await fs.readFile(path.join(outDir, 'session.json'), 'utf8'));
    return typeof f.target_url === 'string' ? { targetUrl: f.target_url } : null;
  } catch {
    return null;
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { createSessionId, ensureDirs, readSessionMeta, updateSessionAnalysis, writeFailure, writeSessionMeta, writeSteps } from './writer.js';
import type { AnalysisInfo } from './writer.js';
import type { StepsFile } from '../schema/steps.schema.js';

const sample: StepsFile = {
  version: '1.0',
  meta: { generated_at: 't', target_url: 'http://x', video: 'recording/video.mp4', model: 'm', input_mode: 'frames', frame_count: 1 },
  steps: [{ id: 1, description: '点击「登录」按钮', action_type: 'click', target: '登录按钮', value: null, start_sec: 1 }],
};

async function tmpOut(): Promise<string> {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-test-'));
}

describe('writer', () => {
  it('createSessionId 格式为 YYYYMMDD-HHMMSS', () => {
    expect(createSessionId(new Date('2026-08-26T10:30:05'))).toBe('20260826-103005');
  });

  it('ensureDirs 创建三级目录', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root);
    expect(fs.existsSync(d.outDir)).toBe(true);
    expect(fs.existsSync(d.recordingDir)).toBe(true);
    expect(fs.existsSync(d.screensDir)).toBe(true);
  });

  it('writeSteps 写出 JSON 并可读回', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    const p = await writeSteps(d.outDir, sample, 'json');
    expect(path.basename(p)).toBe('steps.json');
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual(sample);
  });

  it('writeSteps 支持 yaml 且结构同构', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    const p = await writeSteps(d.outDir, sample, 'yaml');
    expect(path.basename(p)).toBe('steps.yaml');
    expect(yaml.load(fs.readFileSync(p, 'utf8'))).toEqual(sample);
  });

  it('writeFailure 记录原因、原文与帧数', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    const p = await writeFailure(d.outDir, '连续校验失败', '{"bad":1}', 7);
    const f = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(f.reason).toBe('连续校验失败');
    expect(f.raw_model_output).toBe('{"bad":1}');
    expect(f.frame_count).toBe(7);
  });

  it('writeSessionMeta / readSessionMeta 往返', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    await writeSessionMeta(d.outDir, { targetUrl: 'http://app/login', startedAt: new Date('2026-08-26T10:00:00') });
    expect((await readSessionMeta(d.outDir))?.targetUrl).toBe('http://app/login');
    expect(await readSessionMeta(root)).toBeNull();
  });

  it('updateSessionAnalysis 合并分析块：保留原有 target_url 与 started_at', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    const startedAt = new Date('2026-08-26T10:00:00');
    await writeSessionMeta(d.outDir, { targetUrl: 'http://app/login', startedAt });
    const analysis: AnalysisInfo = {
      started_at: 't0',
      ended_at: 't1',
      result: 'ok',
      rounds: [{ round: 1, status: 'ok', started_at: 't0', ended_at: 't0', duration_ms: 12 }],
    };
    const p = await updateSessionAnalysis(d.outDir, analysis);
    expect(path.basename(p)).toBe('session.json');
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(onDisk.target_url).toBe('http://app/login');
    expect(onDisk.started_at).toBe(startedAt.toISOString());
    expect(onDisk.analysis).toEqual(analysis);
  });

  it('updateSessionAnalysis 在 session.json 缺失时新建并写入分析块', async () => {
    const root = await tmpOut();
    const analysis: AnalysisInfo = { started_at: 't0', ended_at: 't1', result: 'failed', rounds: [] };
    await updateSessionAnalysis(root, analysis);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'session.json'), 'utf8'));
    expect(onDisk.analysis.result).toBe('failed');
    expect(onDisk.target_url).toBeUndefined();
  });
});

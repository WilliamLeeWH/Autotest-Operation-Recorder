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

  it('ensureDirs 创建 recording/screenshots/results 三个平级目录', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root);
    expect(fs.existsSync(d.outDir)).toBe(true);
    expect(fs.existsSync(d.recordingDir)).toBe(true);
    expect(fs.existsSync(d.screenshotsDir)).toBe(true);
    expect(fs.existsSync(d.resultsDir)).toBe(true);
    // 三个子目录平级且都直接挂在会话目录下
    expect(path.dirname(d.recordingDir)).toBe(d.outDir);
    expect(path.dirname(d.screenshotsDir)).toBe(d.outDir);
    expect(path.dirname(d.resultsDir)).toBe(d.outDir);
  });

  it('writeSteps 写出 JSON 到 results/ 下并可读回', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    const p = await writeSteps(d.outDir, sample, 'json');
    expect(path.dirname(p)).toBe(d.resultsDir);
    expect(path.basename(p)).toBe('steps.json');
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual(sample);
    expect(fs.existsSync(path.join(d.outDir, 'steps.json'))).toBe(false); // 不再落在会话根目录
  });

  it('writeSteps 支持 yaml 且结构同构', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    const p = await writeSteps(d.outDir, sample, 'yaml');
    expect(path.dirname(p)).toBe(d.resultsDir);
    expect(path.basename(p)).toBe('steps.yaml');
    expect(yaml.load(fs.readFileSync(p, 'utf8'))).toEqual(sample);
  });

  it('writeFailure 顶层只有 frame_count，epochs 逐轮记录：失败轮含原因与原文，成功轮只留 is_success+round', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    const p = await writeFailure(d.outDir, 7, [
      { is_success: false, round: 1, reason: '缺 steps 数组', raw_model_output: '{"nope":1}' },
      { is_success: false, round: 2, reason: '不是合法 JSON', raw_model_output: 'plain text' },
      { is_success: true, round: 3 },
    ]);
    expect(path.dirname(p)).toBe(d.resultsDir);
    const f = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(Object.keys(f)).toEqual(['frame_count', 'epochs']); // 顶层无 reason / raw_model_output
    expect(f.frame_count).toBe(7);
    // 失败轮：is_success 在首位，四字段齐全
    expect(Object.keys(f.epochs[0])).toEqual(['is_success', 'round', 'reason', 'raw_model_output']);
    expect(f.epochs[0]).toEqual({ is_success: false, round: 1, reason: '缺 steps 数组', raw_model_output: '{"nope":1}' });
    // 成功轮：只留 is_success + round
    expect(Object.keys(f.epochs[2])).toEqual(['is_success', 'round']);
    expect(f.epochs[2]).toEqual({ is_success: true, round: 3 });
  });

  it('writeSessionMeta / readSessionMeta 往返（results/ 下）', async () => {
    const root = await tmpOut();
    const d = await ensureDirs(root, 'sess1');
    await writeSessionMeta(d.outDir, { targetUrl: 'http://app/login', startedAt: new Date('2026-08-26T10:00:00') });
    expect((await readSessionMeta(d.outDir))?.targetUrl).toBe('http://app/login');
    expect(await readSessionMeta(root)).toBeNull();
  });

  it('updateSessionAnalysis 合并分析块：保留原有 target_url 与 started_at（results/ 下）', async () => {
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
    expect(path.dirname(p)).toBe(d.resultsDir);
    expect(path.basename(p)).toBe('session.json');
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(onDisk.target_url).toBe('http://app/login');
    expect(onDisk.started_at).toBe(startedAt.toISOString());
    expect(onDisk.analysis).toEqual(analysis);
  });

  it('updateSessionAnalysis 在 session.json 缺失时于 results/ 下新建并写入分析块', async () => {
    const root = await tmpOut();
    const analysis: AnalysisInfo = { started_at: 't0', ended_at: 't1', result: 'failed', rounds: [] };
    const p = await updateSessionAnalysis(root, analysis);
    expect(path.dirname(p)).toBe(path.join(root, 'results'));
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(onDisk.analysis.result).toBe('failed');
    expect(onDisk.target_url).toBeUndefined();
  });
});

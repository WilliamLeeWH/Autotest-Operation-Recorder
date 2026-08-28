import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { analyzeVideo, finalizeSteps } from './refine.js';
import { loadConfig } from '../config/env.js';
import { validateSteps } from '../schema/steps.schema.js';
import type { Step } from '../schema/steps.schema.js';

const NO_ENV = '___no_such_env_file___';

const require = createRequire(import.meta.url);
// 夹具一律用内置二进制生成：开发者机器上不装 ffmpeg 也能跑完整测试
const FF = require('ffmpeg-static') as string;

function makeTestVideo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-re-'));
  const out = path.join(dir, 'src.mp4');
  execFileSync(FF, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  return out;
}

const validJson = JSON.stringify({
  version: '1.0',
  steps: [
    { description: '打开登录页面', action_type: 'goto', target: null, value: null, assertion: '页面显示登录表单', start_sec: 0 },
    { description: '点击「登录」按钮', action_type: 'click', target: '登录按钮', value: null, assertion: '页面跳转到主界面', start_sec: 1.2 },
  ],
});

const cfg = loadConfig(
  { VLM_API_KEY: 'sk-test', VLM_MODEL: 'qwen2.5-vl-max', VLM_BASE_URL: 'http://stub.invalid', VLM_MAX_RETRY: '2' },
  NO_ENV
);

describe('finalizeSteps', () => {
  it('连续重复步骤去重并重排 id', () => {
    const input: Step[] = [
      { id: 9, description: '点击「登录」按钮', action_type: 'click', target: '登录按钮', value: null, assertion: '页面跳转到主界面', start_sec: 1 },
      { id: 8, description: '点击「登录」按钮', action_type: 'click', target: '登录按钮', value: null, assertion: '页面跳转到主界面', start_sec: 2 },
      { id: 7, description: '输入 admin', action_type: 'input', target: '用户名输入框', value: 'admin', assertion: '用户名输入框中显示 admin', start_sec: 3 },
    ];
    const out = finalizeSteps(input);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(1);
    expect(out[1].id).toBe(2);
  });
});

describe('analyzeVideo', () => {
  it('模型一次成功 → ok，steps.json 落盘且通过 schema', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const caller = async () => validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const onDisk = JSON.parse(fs.readFileSync(r.stepsPath, 'utf8'));
      expect(validateSteps(onDisk).ok).toBe(true);
      expect(onDisk.steps.map((s: any) => s.description)).toContain('打开登录页面');
      expect(onDisk.steps.find((s: any) => s.description === '打开登录页面').assertion).toBe('页面显示登录表单');
    }
  });

  it('两次不合格（含一次段落外文本）后成功：自修正生效', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const responses = ['{"steps":', 'plain text not json', validJson]; // 解析失败 → 再失败 → 成功
    const caller = async () => responses.shift() ?? validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller });
    expect(r.ok).toBe(true);
  });

  it('连续失败 → failure.json 且不含 steps.json', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const caller = async () => 'always invalid';
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(fs.existsSync(r.failurePath)).toBe(true);
      const f = JSON.parse(fs.readFileSync(r.failurePath, 'utf8'));
      expect(f.frame_count).toBeGreaterThan(0);
      expect(f.raw_model_output).toContain('always invalid');
    }
    expect(fs.existsSync(path.join(outDir, 'steps.json'))).toBe(false);
  });

  it('模型调用抛错时清理临时帧目录', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const prefixCount = () =>
      fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('oprec-frames-')).length;
    const before = prefixCount();
    const caller = async () => { throw new Error('network down'); };
    await expect(analyzeVideo({ outDir, videoPath: video, cfg, caller })).rejects.toThrow('network down');
    // 并发测试文件可能同时创建同前缀目录（各自 finally 自行清理），轮询直至收敛到 before 数量；
    // 真实泄漏永远不会自清 → 轮询超时失败，断言仍能抓住泄漏
    await expect.poll(prefixCount, { timeout: 3000 }).toBeLessThanOrEqual(before);
  });
});
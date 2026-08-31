import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { analyzeVideo, finalizeSteps } from './refine.js';
import { writeSessionMeta } from '../output/writer.js';
import { loadConfig } from '../config/env.js';
import { validateSteps } from '../schema/steps.schema.js';
import type { Step } from '../schema/steps.schema.js';
import type { ProgressEvent, ProgressPrinter } from './progress.js';

const quiet: ProgressPrinter = () => {};

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
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const onDisk = JSON.parse(fs.readFileSync(r.stepsPath, 'utf8'));
      expect(validateSteps(onDisk).ok).toBe(true);
      expect(onDisk.steps.map((s: any) => s.description)).toContain('打开登录页面');
      expect(onDisk.steps.find((s: any) => s.description === '打开登录页面').assertion).toBe('页面显示登录表单');
    }
  });

  it('成功路径产出抽帧预览视频：recording/frames_preview.mp4 非空', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const caller = async () => validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet });
    expect(r.ok).toBe(true);
    const preview = path.join(outDir, 'recording', 'frames_preview.mp4');
    expect(fs.existsSync(preview)).toBe(true);
    expect(fs.statSync(preview).size).toBeGreaterThan(1000);
  });

  it('两次不合格（含一次段落外文本）后成功：自修正生效', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const responses = ['{"steps":', 'plain text not json', validJson]; // 解析失败 → 再失败 → 成功
    const caller = async () => responses.shift() ?? validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet });
    expect(r.ok).toBe(true);
  });

  it('模型输出带 markdown 围栏与前后缀文本 → 修复脚本截取首尾大括号，第 1 轮即成功', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const events: ProgressEvent[] = [];
    const fenced = `好的，以下是分析结果：\n\`\`\`json\n${validJson}\n\`\`\`\n希望对你有所帮助`;
    const responses = [fenced, validJson];
    const caller = async () => responses.shift() ?? validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: (e) => events.push(e) });
    expect(r.ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'steps.json'), 'utf8'));
    expect(onDisk.steps.map((s: any) => s.description)).toContain('打开登录页面');
    // 解析中间过程上报成对的「开始 / 完成」事件，且该轮以 ok 收尾（只调用了 1 次模型，无失败轮）
    expect(events.some((e) => e.kind === 'stepStart' && e.phase === '模型原始输出解析')).toBe(true);
    expect(events.some((e) => e.kind === 'stepOk' && e.phase === '模型原始输出解析')).toBe(true);
    expect(events.filter((e) => e.kind === 'stepOk' && e.phase === '模型分析')).toHaveLength(1);
    expect(fs.existsSync(path.join(outDir, 'results', 'failure.json'))).toBe(false);
    const session = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'session.json'), 'utf8'));
    expect(session.analysis.rounds.map((x: { status: string }) => x.status)).toEqual(['ok']);
  });

  it('修复脚本成功但提取的 JSON 结构缺失 steps → 本轮仍计失败，进入下一轮', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const responses = ['带噪声的输出 {{ 开头', validJson];
    const caller = async () => responses.shift() ?? validJson;
    const r = await analyzeVideo({
      outDir,
      videoPath: video,
      cfg,
      caller,
      onProgress: quiet,
      repairJsonOutput: async () => '{"status":"ok"}',
    });
    expect(r.ok).toBe(true);
    const session = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'session.json'), 'utf8'));
    expect(session.analysis.rounds.map((x: { status: string }) => x.status)).toEqual(['invalid', 'ok']);
    const f = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'failure.json'), 'utf8'));
    expect(f.epochs[0]).toMatchObject({ is_success: false, round: 1, raw_model_output: '带噪声的输出 {{ 开头' });
    expect(f.epochs[0].reason).toContain('steps');
  });

  it('修复脚本失败 → 本轮失败进入下一轮，failure.json 保留原始输出', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const events: ProgressEvent[] = [];
    const responses = ['前置文本 {"steps":', validJson];
    const caller = async () => responses.shift() ?? validJson;
    const r = await analyzeVideo({
      outDir,
      videoPath: video,
      cfg,
      caller,
      onProgress: (e) => events.push(e),
      repairJsonOutput: async () => null,
    });
    expect(r.ok).toBe(true);
    const session = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'session.json'), 'utf8'));
    expect(session.analysis.rounds.map((x: { status: string }) => x.status)).toEqual(['invalid', 'ok']);
    expect(events.some((e) => e.kind === 'stepFail' && e.phase === '模型原始输出解析')).toBe(true);
    const f = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'failure.json'), 'utf8'));
    expect(f.epochs[0]).toMatchObject({ is_success: false, round: 1, raw_model_output: '前置文本 {"steps":' });
  });

  it('修复持续失败：全部轮次 invalid，failure.json 记录每轮原始输出', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const caller = async () => '~~~ {"steps":';
    const r = await analyzeVideo({
      outDir,
      videoPath: video,
      cfg,
      caller,
      onProgress: quiet,
      repairJsonOutput: async () => null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const f = JSON.parse(fs.readFileSync(r.failurePath, 'utf8'));
      expect(f.epochs).toHaveLength(3);
      for (const e of f.epochs) expect(e.reason).toContain('JSON');
    }
  });

  it('前两轮失败、第三轮成功：仍写 failure.json，失败轮带完整信息、成功轮只留 is_success+round', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const responses = ['{"steps":', 'plain text not json', validJson];
    const caller = async () => responses.shift() ?? validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet });
    expect(r.ok).toBe(true); // 最终模型成功完成
    const f = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'failure.json'), 'utf8'));
    expect(f.frame_count).toBeGreaterThan(0);
    expect(f.epochs).toHaveLength(3);
    expect(f.epochs[0]).toMatchObject({ is_success: false, round: 1, raw_model_output: '{"steps":' });
    expect(f.epochs[1]).toMatchObject({ is_success: false, round: 2, raw_model_output: 'plain text not json' });
    expect(Object.keys(f.epochs[2])).toEqual(['is_success', 'round']);
    expect(f.epochs[2]).toEqual({ is_success: true, round: 3 });
  });

  it('连续失败 → failure.json（帧数置顶层、epochs 逐轮记录）且不含 steps.json', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const caller = async () => 'always invalid';
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(fs.existsSync(r.failurePath)).toBe(true);
      const f = JSON.parse(fs.readFileSync(r.failurePath, 'utf8'));
      expect(Object.keys(f)).toEqual(['frame_count', 'epochs']); // frame_count 在顶层，无顶层 reason
      expect(f.frame_count).toBeGreaterThan(0);
      expect(f.epochs).toHaveLength(3); // maxRetry=2 → 共 3 轮
      for (let i = 0; i < f.epochs.length; i += 1) {
        const e = f.epochs[i];
        expect(Object.keys(e)).toEqual(['is_success', 'round', 'reason', 'raw_model_output']); // is_success 在首位
        expect(e).toMatchObject({ is_success: false, round: i + 1, raw_model_output: 'always invalid' });
        expect(e.reason).toContain('JSON');
      }
    }
    expect(fs.existsSync(path.join(outDir, 'results', 'steps.json'))).toBe(false);
  });

  it('成功路径：session.json 写入 analysis 块，保留 target_url，核算 1 轮 ok', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const startedAt = new Date('2026-08-26T10:00:00');
    await writeSessionMeta(outDir, { targetUrl: 'http://app/login', startedAt });
    const caller = async () => validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet });
    expect(r.ok).toBe(true);
    const session = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'session.json'), 'utf8'));
    expect(session.target_url).toBe('http://app/login');
    expect(session.started_at).toBe(startedAt.toISOString());
    const a = session.analysis;
    expect(a.result).toBe('ok');
    expect(a.rounds).toHaveLength(1);
    const round = a.rounds[0];
    expect(round.round).toBe(1);
    expect(round.status).toBe('ok');
    expect(round.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Date.parse(round.ended_at)).toBeGreaterThanOrEqual(Date.parse(round.started_at));
    expect(Date.parse(a.ended_at)).toBeGreaterThanOrEqual(Date.parse(a.started_at));
  });

  it('自修正路径在失败轮写入失败信息：首轮 invalid 次轮 ok，每轮各自结束时间', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const responses = ['{"steps":', validJson];
    const caller = async () => responses.shift() ?? validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet });
    expect(r.ok).toBe(true);
    const session = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'session.json'), 'utf8'));
    const rounds = session.analysis.rounds as { round: number; status: string; ended_at: string }[];
    expect(rounds.map((x) => x.status)).toEqual(['invalid', 'ok']);
    expect(rounds[0].ended_at).toBeTruthy();
    expect(Date.parse(rounds[1].ended_at)).toBeGreaterThanOrEqual(Date.parse(rounds[0].ended_at));
  });

  it('全部轮次失败 → result=failed，每轮 status=invalid', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const caller = async () => 'always invalid';
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet });
    expect(r.ok).toBe(false);
    const session = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'session.json'), 'utf8'));
    expect(session.analysis.result).toBe('failed');
    expect(session.analysis.rounds.map((x: { status: string }) => x.status)).toEqual(['invalid', 'invalid', 'invalid']);
  });

  it('模型调用抛错 → analyzeVideo 抛出但 analysis 仍落盘，result=error', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const caller = async () => { throw new Error('network down'); };
    await expect(analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet })).rejects.toThrow('network down');
    const session = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'session.json'), 'utf8'));
    expect(session.analysis.result).toBe('error');
    expect(session.analysis.rounds.map((x: { status: string }) => x.status)).toEqual(['error']);
  });

  it('成功路径：按 抽帧→提示词→模型→装配 顺序发进度事件，start 先于 ok，且不打码明文密钥', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const events: ProgressEvent[] = [];
    const caller = async () => validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: (e) => events.push(e) });
    expect(r.ok).toBe(true);
    expect(events.map((e) => `${e.kind}:${e.phase}`)).toEqual([
      'stepStart:视频抽帧预处理',
      'stepOk:视频抽帧预处理',
      'stepStart:提示词组装',
      'stepOk:提示词组装',
      'stepStart:模型分析',
      'stepOk:模型分析',
      'stepStart:结果校验与装配',
      'stepOk:结果校验与装配',
    ]);
    const start0 = events[0];
    if (start0.kind === 'stepStart') {
      expect(start0.detail).toContain('模式=interval'); // 抽帧阶段回显 .env 实际配置
    }
    const stepOk0 = events[1];
    if (stepOk0.kind === 'stepOk') {
      // 抽帧完成的进度带上预览视频路径（相对会话目录），提示可对照原录像检查抽帧是否丢关键操作
      expect(stepOk0.detail).toContain('recording/frames_preview.mp4');
      expect(stepOk0.detail).toContain('送入模型');
    }
    const modelStart = events.find((e) => e.kind === 'stepStart' && e.phase === '模型分析');
    if (modelStart && modelStart.kind === 'stepStart') {
      expect(modelStart.detail).toContain('model=qwen2.5-vl-max');
      expect(modelStart.detail).toContain('最多 3 轮');
      expect(modelStart.detail).not.toMatch(/provider=|baseUrl=|apiKey=|输入模式=|温度=/);
    }
    const all = events
      .flatMap((e) => [e.kind === 'stepFail' ? e.reason : e.kind === 'stepStart' || e.kind === 'stepOk' ? e.detail : ''])
      .join('|');
    expect(all).not.toContain('sk-test');
  });

  it('自修正路径：首轮校验失败发 stepFail，次轮成功发 stepOk', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const events: ProgressEvent[] = [];
    const responses = ['{"steps":', validJson];
    const caller = async () => responses.shift() ?? validJson;
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: (e) => events.push(e) });
    expect(r.ok).toBe(true);
    const modelFails = events.filter((e) => e.kind === 'stepFail' && e.phase === '模型分析');
    expect(modelFails).toHaveLength(1);
    expect(modelFails[0].kind === 'stepFail' && modelFails[0].reason).toContain('第 1/3 轮');
    expect(events.filter((e) => e.kind === 'stepOk' && e.phase === '模型分析')).toHaveLength(1);
  });

  it('全部轮次失败：每轮发 stepFail，装配阶段输出 failure.json', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const events: ProgressEvent[] = [];
    const caller = async () => 'always invalid';
    const r = await analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: (e) => events.push(e) });
    expect(r.ok).toBe(false);
    expect(events.filter((e) => e.kind === 'stepFail' && e.phase === '模型分析')).toHaveLength(3);
    const assembleOk = events.find((e) => e.kind === 'stepOk' && e.phase === '结果校验与装配');
    expect(assembleOk && assembleOk.kind === 'stepOk' && assembleOk.detail).toContain('failure.json');
  });

  it('模型调用抛错时清理临时帧目录', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const prefixCount = () =>
      fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('oprec-frames-')).length;
    const before = prefixCount();
    const caller = async () => { throw new Error('network down'); };
    await expect(analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet })).rejects.toThrow('network down');
    // 并发测试文件可能同时创建同前缀目录（各自 finally 自行清理），轮询直至收敛到 before 数量；
    // 真实泄漏永远不会自清 → 轮询超时失败，断言仍能抓住泄漏
    await expect.poll(prefixCount, { timeout: 3000 }).toBeLessThanOrEqual(before);
  });

  it('第 1 轮输出无效、第 2 轮抛异常：先写盘已收集失败轮再抛错', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    let calls = 0;
    const caller = async () => {
      calls += 1;
      if (calls === 1) return 'always invalid';
      throw new Error('network down');
    };
    await expect(analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet })).rejects.toThrow('network down');
    const f = JSON.parse(fs.readFileSync(path.join(outDir, 'results', 'failure.json'), 'utf8'));
    expect(f.epochs).toHaveLength(1);
    expect(f.epochs[0]).toMatchObject({ is_success: false, round: 1, raw_model_output: 'always invalid' });
  });

  it('第 1 轮即抛异常：无失败轮可写，不产出 failure.json', async () => {
    const video = makeTestVideo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ana-'));
    const caller = async () => { throw new Error('network down'); };
    await expect(analyzeVideo({ outDir, videoPath: video, cfg, caller, onProgress: quiet })).rejects.toThrow('network down');
    expect(fs.existsSync(path.join(outDir, 'results', 'failure.json'))).toBe(false);
  });
});
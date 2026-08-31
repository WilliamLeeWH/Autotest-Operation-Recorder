import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { extractFrames } from './extractFrames.js';
import { createVlmCaller, type VlmCaller } from './vlm.js';
import { buildUserMessage, loadPromptTemplate } from './prompt.js';
import { createStderrProgressPrinter, formatDuration, startRoundTimer, type ProgressPrinter } from './progress.js';
import { validateSteps, stepSchema, type Step, type StepsFile } from '../schema/steps.schema.js';
import { readSessionMeta, updateSessionAnalysis, writeFailure, writeSteps, type AnalysisInfo, type FailureEpoch } from '../output/writer.js';
import type { AppConfig } from '../config/env.js';

export interface AnalyzeOptions {
  outDir: string;
  videoPath: string;
  cfg: AppConfig;
  caller?: VlmCaller; // 测试注入；缺省用 createVlmCaller(cfg)
  repairJsonOutput?: (raw: string) => Promise<string | null>; // 测试注入；缺省调用 scripts/ 下的修复脚本
  onProgress?: ProgressPrinter; // 分步进度事件；缺省写 stderr（默认开启，无需 --verbose）
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 模型整段输出不是合法 JSON 时的修复脚本：截取第一个 { 到最后一个 }（含端）再 JSON.parse，
// 用于模型输出被 markdown 围栏 / 前后缀文本包裹的偶发情况。脚本为 scripts/ 下纯 Node 可运行的 .mjs
// （免编译，dev tsx 与 dist 产物均可以 process.execPath 直接调用）。
const REPAIR_SCRIPT_PATH = fileURLToPath(new URL('../../scripts/extract-json-from-raw-output.mjs', import.meta.url));
const execFileAsync = promisify(execFile);

/**
 * 调用修复脚本从模型原始输出中提取 JSON。成功返回解析后的 JSON 文本（本轮视作合法输出），
 * 失败（截取段仍非法 / 脚本不可用 / 超时）返回 null，由调用方进入下一轮自修正重试。
 */
export async function repairRawJson(raw: string): Promise<string | null> {
  let dir: string;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oprec-repair-'));
  } catch {
    return null;
  }
  try {
    const inFile = path.join(dir, 'raw.txt');
    const outFile = path.join(dir, 'out.json');
    await fs.writeFile(inFile, raw, 'utf8');
    try {
      await execFileAsync(process.execPath, [REPAIR_SCRIPT_PATH, inFile, outFile], { timeout: 30_000 });
    } catch {
      return null; // 退出码非 0：截取或解析失败
    }
    return await fs.readFile(outFile, 'utf8');
  } catch {
    return null; // 写盘/读回失败：视为修复失败，走下一轮
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export type AnalyzeResult =
  | { ok: true; stepsPath: string; data: StepsFile }
  | { ok: false; failurePath: string; reason: string; rawOutput: string; frameCount: number };

export function finalizeSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    const dup =
      prev &&
      prev.description === s.description &&
      prev.action_type === s.action_type &&
      (prev.value ?? null) === (s.value ?? null);
    if (dup) continue;
    out.push(s);
  }
  return out.map((s, i) => ({ ...s, id: i + 1 }));
}

// 模型输出校验采用宽松 steps 校验（控制器裁定）：
// 提示词模板（Task 7）只要求模型输出 {steps:[...]}，每步无 id/version/meta；
// 直接对原始输出跑严格 validateSteps（文件级 schema）会使忠实模型必然失败。
// id 由 finalizeSteps 派生，多余未知字段被 zod 剥离。
const looseStepSchema = stepSchema.extend({ id: z.number().int().positive().optional() });
const looseStepsSchema = z.array(looseStepSchema);

const JSON_PARSE_ERROR = '模型输出不是合法 JSON 文本，请要求模型只输出 JSON';

function parseModelOutput(raw: string): { ok: true; steps: Step[] } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, errors: [JSON_PARSE_ERROR] };
  }
  if (typeof json !== 'object' || json === null) {
    return { ok: false, errors: ['模型输出缺少 steps 数组'] };
  }
  const steps = (json as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) {
    return { ok: false, errors: ['模型输出缺少 steps 数组'] };
  }
  const parsed = looseStepsSchema.safeParse(steps);
  if (parsed.success) {
    // id 在宽松 schema 下可缺省，finalizeSteps 会重排派生 id，故此处安全收窄为 Step[]
    return { ok: true, steps: parsed.data as Step[] };
  }
  return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
}

export async function analyzeVideo(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const cfg = opts.cfg;
  const emit = opts.onProgress ?? createStderrProgressPrinter();
  const analysis: AnalysisInfo = {
    started_at: new Date().toISOString(),
    ended_at: '',
    result: 'error',
    rounds: [],
  };
  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oprec-frames-'));
  try {
    // ── 1. 抽帧预处理 ──
    emit({
      kind: 'stepStart',
      phase: '视频抽帧预处理',
      detail: `模式=${cfg.frame.mode} 间隔=${cfg.frame.intervalSec}s 阈值=${cfg.frame.sceneThreshold} 上限=${cfg.frame.maxCount === null ? `自动(${cfg.frame.maxCountRatio}×总帧数)` : `${cfg.frame.maxCount}帧(手动)`} 最大宽度=${cfg.frame.maxWidth}px`,
    });
    const previewPath = path.join(opts.outDir, 'recording', 'frames_preview.mp4');
    let frames: Awaited<ReturnType<typeof extractFrames>>;
    try {
      frames = await extractFrames({ videoPath: opts.videoPath, outDir: framesDir, previewVideoPath: previewPath, ...cfg.frame });
    } catch (e) {
      emit({ kind: 'stepFail', phase: '视频抽帧预处理', reason: errMsg(e) });
      throw e;
    }
    emit({
      kind: 'stepOk',
      phase: '视频抽帧预处理',
      detail: `提取 ${frames.extractedCount} 帧、送入模型 ${frames.frameCount} 帧，抽帧预览视频 → ${path.relative(opts.outDir, previewPath).replace(/\\/g, '/')}`,
    });

    // ── 2. 提示词组装 ──
    emit({
      kind: 'stepStart',
      phase: '提示词组装',
      detail: `模板=prompts/${cfg.vlm.inputMode}.txt FRAME_COUNT=${frames.frameCount}`,
    });
    let template: string;
    try {
      template = await loadPromptTemplate(cfg.vlm.inputMode);
    } catch (e) {
      emit({ kind: 'stepFail', phase: '提示词组装', reason: errMsg(e) });
      throw e;
    }
    const prompt = buildUserMessage(template, { mode: cfg.vlm.inputMode, frameCount: frames.frameCount });
    emit({ kind: 'stepOk', phase: '提示词组装', detail: `模板 ${template.length} 字符` });

    // ── 3. 模型分析（含自修正重试）──
    const caller = opts.caller ?? createVlmCaller(cfg);
    const repairJson = opts.repairJsonOutput ?? repairRawJson;
    const rounds = cfg.vlm.maxRetry + 1;
    emit({
      kind: 'stepStart',
      phase: '模型分析',
      detail: `model=${cfg.vlm.model} 最多 ${rounds} 轮`,
    });

    let lastErrors = ['模型未返回任何内容'];
    let modelRawOutput = '';
    let parsedSteps: Step[] | null = null;
    // 逐轮收集分析结果；任何一轮失败（无论最终成败）都要把该轮 raw output 留到 failure.json epochs 中
    const epochs: FailureEpoch[] = [];

    for (let i = 0; i < rounds; i += 1) {
      const roundStart = new Date();
      const timer = startRoundTimer({ round: i + 1, rounds });
      const userPrompt = i === 0 ? prompt : `${prompt}\n\n注意：上一轮输出未通过校验，错误如下：\n${lastErrors.join('\n')}\n请重新生成完整的 JSON。`;
      const record = (status: 'ok' | 'invalid' | 'error', elapsedMs: number) => {
        analysis.rounds.push({
          round: i + 1,
          status,
          started_at: roundStart.toISOString(),
          ended_at: new Date().toISOString(),
          duration_ms: elapsedMs,
        });
      };
      try {
        modelRawOutput = await caller(cfg, {
          mode: cfg.vlm.inputMode,
          frames: frames.framePaths,
          videoPath: opts.videoPath,
          prompt: userPrompt,
        });
      } catch (e) {
        const elapsedMs = timer.stop().elapsedMs;
        record('error', elapsedMs);
        emit({ kind: 'stepFail', phase: '模型分析', reason: `第 ${i + 1}/${rounds} 轮调用异常：${errMsg(e)}（用时 ${formatDuration(elapsedMs)}）` });
        // 调用异常本身没有输出可保留，但此前失败轮已收集的信息仍要先落盘（写盘失败不能掩盖原始异常）
        if (epochs.length > 0) await writeFailure(opts.outDir, frames.frameCount, epochs).catch(() => {});
        throw e;
      }
      const elapsedMs = timer.stop().elapsedMs;
      let v = parseModelOutput(modelRawOutput);
      // 模型有输出但整体不是合法 JSON（常见：输出被 markdown 围栏 / 前后缀文本包裹）时，
      // 先调用修复脚本截取首尾大括号再解析：成功则本轮按正常校验流程走（视作成功），失败则进入下一轮自修正
      if (!v.ok && modelRawOutput.trim() !== '' && v.errors.length === 1 && v.errors[0] === JSON_PARSE_ERROR) {
        emit({ kind: 'stepStart', phase: '模型原始输出解析', detail: `第 ${i + 1}/${rounds} 轮输出不是合法 JSON，调用JSON解析工具重试` });
        const repaired = await repairJson(modelRawOutput);
        if (repaired === null) {
          emit({ kind: 'stepFail', phase: '模型原始输出解析', reason: JSON_PARSE_ERROR });
        } else {
          emit({ kind: 'stepOk', phase: '模型原始输出解析', detail: '成功提取模型原始输出中的 JSON' });
          v = parseModelOutput(repaired);
        }
      }
      if (v.ok) {
        record('ok', elapsedMs);
        emit({ kind: 'stepOk', phase: '模型分析', detail: `第 ${i + 1}/${rounds} 轮调用成功（用时 ${formatDuration(elapsedMs)}）` });
        epochs.push({ is_success: true, round: i + 1 });
        parsedSteps = v.steps;
        break;
      }
      record('invalid', elapsedMs);
      epochs.push({ is_success: false, round: i + 1, reason: v.errors.join('; '), raw_model_output: modelRawOutput });
      emit({ kind: 'stepFail', phase: '模型分析', reason: `第 ${i + 1}/${rounds} 轮输出未通过校验：${v.errors.join('；')}（用时 ${formatDuration(elapsedMs)}）` });
      lastErrors = v.errors;
    }

    // ── 4. 结果校验与装配 ──
    emit({ kind: 'stepStart', phase: '结果校验与装配', detail: '' });
    try {
      if (parsedSteps) {
        const steps = finalizeSteps(parsedSteps);
        const session = await readSessionMeta(opts.outDir);
        const data: StepsFile = {
          version: '1.0',
          meta: {
            generated_at: new Date().toISOString(),
            target_url: session?.targetUrl ?? '',
            video: path.relative(opts.outDir, opts.videoPath).replace(/\\/g, '/'),
            model: cfg.vlm.model,
            input_mode: cfg.vlm.inputMode,
            frame_count: frames.frameCount,
          },
          steps,
        };
        // 完整装配后走一遍严格文件级 schema：内部不变式检查，失败说明装配逻辑自身有误
        const strictCheck = validateSteps(data);
        if (!strictCheck.ok) {
          throw new Error(`装配后的 StepsFile 未通过严格校验：${strictCheck.errors.join('; ')}`);
        }
        const stepsPath = await writeSteps(opts.outDir, data, cfg.output.format);
        analysis.result = 'ok';
        emit({ kind: 'stepOk', phase: '结果校验与装配', detail: `steps.json 已写入（${steps.length} 步）` });
        // 曾有过失败轮（自修正重试后成功）也要把 epochs 留档，便于核查失败轮的原始输出
        if (epochs.some((e) => !e.is_success)) {
          await writeFailure(opts.outDir, frames.frameCount, epochs);
        }
        return { ok: true, stepsPath, data };
      }
      const reason = lastErrors.join('; ');
      analysis.result = 'failed';
      const failurePath = await writeFailure(opts.outDir, frames.frameCount, epochs);
      emit({ kind: 'stepOk', phase: '结果校验与装配', detail: `failure.json 已写入（原因：${reason}）` });
      return { ok: false, failurePath, reason, rawOutput: modelRawOutput, frameCount: frames.frameCount };
    } catch (e) {
      emit({ kind: 'stepFail', phase: '结果校验与装配', reason: errMsg(e) });
      throw e;
    }
  } finally {
    // 无论成功、失败还是抛异常，都落盘本次分析的起止时间与每轮计时到 session.json
    analysis.ended_at = new Date().toISOString();
    await updateSessionAnalysis(opts.outDir, analysis).catch(() => {});
    // 无论成功、重试耗尽、还是 extractFrames / 模板 / VLM 调用抛异常，都会清理临时帧目录
    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  }
}
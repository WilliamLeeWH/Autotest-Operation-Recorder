import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { extractFrames } from './extractFrames.js';
import { createVlmCaller, type VlmCaller } from './vlm.js';
import { buildUserMessage, loadPromptTemplate } from './prompt.js';
import { validateSteps, stepSchema, type Step, type StepsFile } from '../schema/steps.schema.js';
import { readSessionMeta, writeFailure, writeSteps } from '../output/writer.js';
import type { AppConfig } from '../config/env.js';

export interface AnalyzeOptions {
  outDir: string;
  videoPath: string;
  cfg: AppConfig;
  caller?: VlmCaller; // 测试注入；缺省用 createVlmCaller(cfg)
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

function parseModelOutput(raw: string): { ok: true; steps: Step[] } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['模型输出不是合法 JSON 文本，请要求模型只输出 JSON'] };
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
  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oprec-frames-'));
  const frames = await extractFrames({ videoPath: opts.videoPath, outDir: framesDir, ...cfg.frame });

  const template = await loadPromptTemplate(cfg.vlm.inputMode);
  const prompt = buildUserMessage(template, { mode: cfg.vlm.inputMode, frameCount: frames.frameCount });
  const caller = opts.caller ?? createVlmCaller(cfg);
  const rounds = cfg.vlm.maxRetry + 1;

  let attemptOutput = '';
  let lastErrors = ['模型未返回任何内容'];
  let modelRawOutput = '';

  for (let i = 0; i < rounds; i += 1) {
    const userPrompt = i === 0 ? prompt : `${prompt}\n\n注意：上一轮输出未通过校验，错误如下：\n${lastErrors.join('\n')}\n请重新生成完整的 JSON。`;
    modelRawOutput = await caller(cfg, {
      mode: cfg.vlm.inputMode,
      frames: frames.framePaths,
      videoPath: opts.videoPath,
      prompt: userPrompt,
    });
    attemptOutput = modelRawOutput;
    const v = parseModelOutput(modelRawOutput);
    if (v.ok) {
      const steps = finalizeSteps(v.steps);
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
      await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
      return { ok: true, stepsPath, data };
    }
    lastErrors = v.errors;
  }

  const failurePath = await writeFailure(opts.outDir, `模型输出连续 ${rounds} 轮未通过校验`, attemptOutput, frames.frameCount);
  await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  return { ok: false, failurePath, reason: lastErrors.join('; '), rawOutput: modelRawOutput, frameCount: frames.frameCount };
}
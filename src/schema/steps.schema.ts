import { z } from 'zod';

export const actionTypeSchema = z.enum(['goto', 'click', 'input', 'hover', 'scroll', 'keypress', 'select', 'wait', 'unknown']);

export const stepSchema = z.object({
  id: z.number().int().positive(),
  description: z.string().min(1),
  action_type: actionTypeSchema.optional(),
  target: z.string().nullable().optional(),
  value: z.string().nullable().optional(),
  start_sec: z.number().nonnegative(),
});

export const stepsFileSchema = z.object({
  version: z.literal('1.0'),
  meta: z.object({
    generated_at: z.string().min(1),
    target_url: z.string(),
    video: z.string().min(1),
    model: z.string().min(1),
    input_mode: z.enum(['frames', 'video']),
    frame_count: z.number().int().nonnegative(),
  }),
  steps: z.array(stepSchema),
});

export type Step = z.infer<typeof stepSchema>;
export type StepsFile = z.infer<typeof stepsFileSchema>;

export function validateSteps(raw: unknown): { ok: true; data: StepsFile } | { ok: false; errors: string[] } {
  let json: unknown = raw;
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ['模型输出不是合法 JSON 文本，请要求模型只输出 JSON'] };
    }
  }
  const parsed = stepsFileSchema.safeParse(json);
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors: string[] = parsed.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, errors };
}

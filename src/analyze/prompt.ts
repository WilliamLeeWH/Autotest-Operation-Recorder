import fs from 'node:fs/promises';
import path from 'node:path';

export type PromptMode = 'frames' | 'video';

export async function loadPromptTemplate(mode: PromptMode): Promise<string> {
  const file = path.resolve(process.cwd(), 'prompts', `${mode}.txt`);
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`提示词模板缺失：${file}（请确认 prompts/ 目录与 ${mode}.txt 存在）`);
  }
}

export function buildUserMessage(template: string, ctx: { mode: PromptMode; frameCount: number }): string {
  return template.replaceAll('{{FRAME_COUNT}}', String(ctx.frameCount));
}

import fs from 'node:fs';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config/env.js';

export interface VlmCallInput {
  mode: 'frames' | 'video';
  frames: string[];
  videoPath: string | null;
  prompt: string;
}

export type VlmCaller = (cfg: AppConfig, input: VlmCallInput) => Promise<string>;

function b64(file: string): string {
  return fs.readFileSync(file).toString('base64');
}

/** OpenAI 兼容协议（覆盖 OpenAI / DashScope / DeepSeek / GLM / Doubao / Gemini 兼容端等） */
export function createOpenAiCompatibleCaller(): VlmCaller {
  return async (cfg, input) => {
    const client = new OpenAI({ baseURL: cfg.vlm.baseUrl ?? undefined, apiKey: cfg.vlm.apiKey });
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: input.prompt },
      ...input.frames.map((f) => ({
        type: 'image_url' as const,
        image_url: { url: `data:image/jpeg;base64,${b64(f)}` },
      })),
    ];
    if (input.mode === 'video' && input.videoPath) {
      content.push({
        type: 'video_url',
        video_url: { url: `data:video/mp4;base64,${b64(input.videoPath)}` },
      } as any);
    }
    const res = await client.chat.completions.create({
      model: cfg.vlm.model,
      temperature: cfg.vlm.temperature,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }],
    });
    return res.choices[0]?.message?.content ?? '';
  };
}

/** Anthropic 原生（当前仅多模态模型走视频模式） */
export function createAnthropicCaller(): VlmCaller {
  return async (cfg, input) => {
    const client = new Anthropic({ baseURL: cfg.vlm.baseUrl ?? undefined, apiKey: cfg.vlm.apiKey });
    const content: Anthropic.Messages.MessageParam['content'] = [
      { type: 'text', text: input.prompt },
      ...input.frames.map((f) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: b64(f) } })),
    ];
    if (input.mode === 'video' && input.videoPath) {
      content.push({ type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: b64(input.videoPath) } } as any);
    }
    const res = await client.messages.create({
      model: cfg.vlm.model,
      max_tokens: 8192,
      temperature: cfg.vlm.temperature,
      messages: [{ role: 'user', content }],
    });
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  };
}

export function createVlmCaller(cfg: AppConfig): VlmCaller {
  return cfg.vlm.provider === 'anthropic' ? createAnthropicCaller() : createOpenAiCompatibleCaller();
}
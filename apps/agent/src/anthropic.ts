import { TOOL_DEFINITIONS, type Block, type Message, type Model } from './loop.js';

export const LIVE_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'] as const;

export type LiveModel = (typeof LIVE_MODELS)[number];

export function isLiveModel(value: string): value is LiveModel {
  return (LIVE_MODELS as readonly string[]).includes(value);
}

export function createAnthropicModel(apiKey: string, model: string, signal?: AbortSignal): Model {
  return async (messages: Message[]) => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(60000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        tools: TOOL_DEFINITIONS,
        messages,
      }),
    });
    if (!response.ok) throw new Error('MODEL_FAILED');
    const body = (await response.json()) as { content?: Block[] };
    if (!Array.isArray(body.content)) throw new Error('MODEL_FAILED');
    return body.content;
  };
}

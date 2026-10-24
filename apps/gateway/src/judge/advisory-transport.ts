// Independent advisory transport; existing judge behavior is unchanged.
import { JudgeError } from './index.js';
import { validateJudgeConfig, MAX_RESPONSE_BYTES, MAX_TOKENS } from './real.js';
import type { JudgeConfig, JudgeDependencies } from './real.js';

async function readBounded(response: Response): Promise<unknown> {
  if (!response.body) throw new JudgeError('JUDGE_INVALID_OUTPUT');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read().catch(() => {
        throw new JudgeError('JUDGE_ERROR');
      });
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new JudgeError('JUDGE_INVALID_OUTPUT');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    // Do not await cancellation: an uncooperative stream must not hold the deadline.
    void reader.cancel().catch(() => undefined);
    if (error instanceof JudgeError) throw error;
    throw new JudgeError('JUDGE_INVALID_OUTPUT');
  } finally {
    reader.releaseLock();
  }
}

function parseMessage(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') throw new JudgeError('JUDGE_INVALID_OUTPUT');
  const message = raw as Record<string, unknown>;
  if (
    message.type !== 'message' ||
    message.role !== 'assistant' ||
    message.stop_reason !== 'end_turn' ||
    !Array.isArray(message.content) ||
    message.content.length !== 1
  ) {
    throw new JudgeError('JUDGE_INVALID_OUTPUT');
  }
  const block = message.content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string')
    throw new JudgeError('JUDGE_INVALID_OUTPUT');
  try {
    return JSON.parse(block.text);
  } catch {
    throw new JudgeError('JUDGE_INVALID_OUTPUT');
  }
}

export function createAdvisoryTransport(config: JudgeConfig, dependencies: JudgeDependencies = {}) {
  validateJudgeConfig(config);
  // Snapshot configuration so later caller mutation cannot change model/key/deadline.
  const { model, apiKey, timeoutMs } = config;
  const transport = dependencies.fetch ?? globalThis.fetch;
  return async (input: unknown, system: string, schema: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new JudgeError('JUDGE_ERROR'));
        controller.abort();
      }, timeoutMs);
    });
    const work = async () => {
      try {
        const response = await transport('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: MAX_TOKENS,
            system,
            messages: [{ role: 'user', content: JSON.stringify(input) }],
            output_config: { format: { type: 'json_schema', schema } },
          }),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new JudgeError('JUDGE_ERROR');
        }
        const output = parseMessage(await readBounded(response));
        if (controller.signal.aborted || performance.now() - started >= timeoutMs)
          throw new JudgeError('JUDGE_ERROR');
        return output;
      } catch (error) {
        if (controller.signal.aborted) throw new JudgeError('JUDGE_ERROR');
        if (error instanceof JudgeError) throw error;
        throw new JudgeError('JUDGE_ERROR');
      }
    };
    try {
      return await Promise.race([timeout, work()]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  };
}

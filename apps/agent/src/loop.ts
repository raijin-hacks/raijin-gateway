import type { Purchase } from './tools.js';
import { createTools } from './tools.js';

export const TOOL_DEFINITIONS = [
  {
    name: 'fetch_url',
    description: 'Read an approved free attacker demo page.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'paid_fetch',
    description:
      'Purchase data through the mandate gateway. Repeating identical arguments retries the same purchase.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST'] },
        expected_price: { type: 'integer' },
        purpose: {
          type: 'string',
          enum: ['fetch_data', 'fetch_report', 'verify_access', 'subscribe', 'other'],
        },
      },
      required: ['url', 'method', 'expected_price', 'purpose'],
      additionalProperties: false,
    },
  },
];
export type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string };
export type Message = { role: 'user' | 'assistant'; content: unknown };
export type Model = (messages: Message[]) => Promise<Block[]>;
export async function runAgent(task: string, tools: ReturnType<typeof createTools>, model: Model) {
  const messages: Message[] = [{ role: 'user', content: task }];
  for (let step = 0; step < 8; step++) {
    const blocks = await model(messages);
    messages.push({ role: 'assistant', content: blocks });
    const calls = blocks.filter((block) => block.type === 'tool_use');
    if (!calls.length) return;
    if (calls.length > 4) throw new Error('TOOL_CALL_LIMIT');
    const results = [];
    for (const call of calls) {
      let content: string;
      try {
        if (call.name === 'fetch_url') {
          const input = call.input as { url: string };
          content = await tools.fetch_url(input.url);
        } else if (call.name === 'paid_fetch') {
          const result = await tools.paid_fetch(call.input as Purchase);
          // Keep gateway payload, purchase data and payment metadata out of the model transcript.
          content = JSON.stringify({ status: result.status });
        } else throw new Error('UNKNOWN_TOOL');
      } catch {
        content = 'Tool failed; retry identical purchase arguments if needed.';
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('AGENT_STEP_LIMIT');
}

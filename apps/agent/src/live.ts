import { boundedText, createTools } from './tools.js';
import { runAgent, TOOL_DEFINITIONS, type Block } from './loop.js';
import { createJournal } from './journal.js';

// Durable purchase intents survive agent restarts (A19). Gitignored; holds no token or secret.
const DEFAULT_JOURNAL = '.agent-state/purchases.json';

// Model credentials belong to the host adapter only; the spending tools receive only the mandate token.
async function main() {
  const { MANDATE_TOKEN, AGENT_TASK, AGENT_MODEL, ANTHROPIC_API_KEY } = process.env;
  if (!MANDATE_TOKEN || !AGENT_TASK || !AGENT_MODEL || !ANTHROPIC_API_KEY)
    throw new Error('AGENT_CONFIGURATION_REQUIRED');
  const tools = createTools({
    gateway: 'http://localhost:4000',
    token: MANDATE_TOKEN,
    trace: console.log,
    journal: createJournal(process.env.AGENT_JOURNAL_PATH || DEFAULT_JOURNAL),
  });
  // Settle anything a previous run started before buying anything new.
  await tools.resume();
  const answer = await runAgent(AGENT_TASK, tools, async (messages) => {
    console.log('agent: model step');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      redirect: 'error',
      // A final answer over several purchases can take longer than 10 s to generate.
      signal: AbortSignal.timeout(60000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: AGENT_MODEL,
        max_tokens: 1024,
        tools: TOOL_DEFINITIONS,
        messages,
      }),
    });
    if (!response.ok) throw new Error('MODEL_FAILED');
    const body = (await response.json()) as { content?: Block[] };
    if (!Array.isArray(body.content)) throw new Error('MODEL_FAILED');
    return body.content;
  });
  console.log('agent: final answer');
  console.log(boundedText(answer, [MANDATE_TOKEN, ANTHROPIC_API_KEY]));
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error && error.message === 'AGENT_STEP_LIMIT'
      ? 'agent: step limit reached; no final answer'
      : 'agent: failed; no final answer (details redacted)',
  );
  process.exitCode = 1;
});

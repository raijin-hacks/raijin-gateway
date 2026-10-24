import { judgeInputSchema, judgeOutputSchema } from '@apf/contracts';
import type { JudgeInput, JudgeModule, JudgeOutput } from '@apf/contracts';

export class JudgeError extends Error {
  constructor(public readonly code: 'JUDGE_ERROR' | 'JUDGE_INVALID_OUTPUT') {
    super(code);
    this.name = 'JudgeError';
  }
}

export function validateOutput(value: unknown): JudgeOutput {
  const parsed = judgeOutputSchema.safeParse(value);
  if (!parsed.success) throw new JudgeError('JUDGE_INVALID_OUTPUT');
  return parsed.data;
}

// The adapter receives only sanitized input. Transport/prompt/deadline arrive in PR 2.
export interface JudgeProvider {
  judge(input: JudgeInput): Promise<unknown>;
}

export function createInjectedJudge(provider: JudgeProvider): JudgeModule {
  return {
    buildInput() {
      // PR 5 owns context projection. Never pass a raw context through as a fallback.
      throw new JudgeError('JUDGE_ERROR');
    },
    async judge(input) {
      const parsed = judgeInputSchema.safeParse(input);
      if (!parsed.success || !parsed.data.payment.merchant.known || !parsed.data.payment.endpoint.known) {
        throw new JudgeError('JUDGE_ERROR');
      }
      let output: unknown;
      try {
        output = await provider.judge(parsed.data);
      } catch {
        throw new JudgeError('JUDGE_ERROR');
      }
      return validateOutput(output);
    },
  };
}

export function createStubJudge(mode: 'stub-escalate' | 'stub-approve'): JudgeModule {
  if (mode !== 'stub-escalate' && mode !== 'stub-approve') throw new JudgeError('JUDGE_ERROR');
  return createInjectedJudge({
    async judge() {
      return {
        decision: mode === 'stub-approve' ? 'approve' : 'escalate',
        reasons: [mode === 'stub-approve' ? 'JUDGE_APPROVED' : 'JUDGE_OVER_SCOPED'],
        explanation: `Explicit ${mode} fixture; no model was called.`,
        injection_suspected: false,
      };
    },
  });
}

import { expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  CONTRACTS_VERSION, JudgeOutputSchema, judgeOutputSchema,
  JudgeInputSchema, judgeInputSchema, JUDGE_CODES,
} from './index';
import type { JudgeInput, JudgeOutput } from './index';

it('uses Chunk 2 schema and reason exports as the single output authority', () => {
  expect(CONTRACTS_VERSION).toBe('1.3');
  expect(judgeOutputSchema).toBe(JudgeOutputSchema);
  expect(judgeInputSchema).toBe(JudgeInputSchema);
  expectTypeOf<z.infer<typeof JudgeOutputSchema>>().toEqualTypeOf<JudgeOutput>();
  expectTypeOf<z.infer<typeof JudgeInputSchema>>().toEqualTypeOf<JudgeInput>();
  for (const reason of JUDGE_CODES) {
    expect(JudgeOutputSchema.safeParse({
      decision: 'deny', reasons: [reason], explanation: '', injection_suspected: false,
    }).success).toBe(true);
  }
});

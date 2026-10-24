import { expect, it } from 'vitest';
import { judgeInputSchema } from '@apf/contracts';
import cases from './cases.json';
import mandates from './mandates.json';
import { paperCaseSchema, validatePaperFixtures } from './index';

it('freezes three mandates and ten legitimate/ten off-task labels', () => {
  expect(Object.keys(mandates)).toEqual(['pricing', 'weather', 'news']);
  expect(Object.values(mandates).map(m => m.subjects.length)).toEqual([5, 4, 3]);
  expect(new Set(cases.map(c => c.id)).size).toBe(20);
  expect(cases.filter(c => c.kind === 'legitimate')).toHaveLength(10);
  expect(cases.filter(c => c.kind === 'off_task')).toHaveLength(10);
  for (const c of cases) {
    if (c.route === 'judge') {
      const input = judgeInputSchema.parse(c.input);
      expect(input.mandate).toEqual(mandates[c.mandate as keyof typeof mandates]);
      expect(input.payment.merchant.known).toBe(true);
      expect(input.payment.endpoint.known).toBe(true);
      expect(c.expected).toBe(c.kind === 'legitimate' ? 'approve' : 'deny_or_escalate');
    } else {
      expect(c.input).toBeUndefined();
      expect(c.expected_provider_calls).toBe(0);
      expect(c.expected).toBe('escalate');
    }
  }
  expect(cases.filter(c => c.route === 'judge')).toHaveLength(18);
  expect(cases.find(c => c.id === 'L10')!.match!.urlShape).toEqual(cases.find(c => c.id === 'M10')!.match!.urlShape);
});


it('validates the complete frozen set through the reusable offline boundary', () => {
  expect(validatePaperFixtures(mandates, cases).cases).toHaveLength(20);
});

it('rejects denominator drift before evaluation', () => {
  const changed = cases.map(c => c.id === 'L1' ? { ...cases.find(c => c.id === 'L10')!, id: 'L1' } : c);
  expect(() => validatePaperFixtures(mandates, changed)).toThrow('nine judge-eligible cases per label');
});

it('rejects corrupted fixtures before evaluation', () => {
  for (const change of [
    { ...cases[0], id: 'M1' },
    { ...cases[0], expected: 'deny_or_escalate' },
    { ...cases[0], extra: 'untrusted' },
    { ...cases[19], expected_provider_calls: 1 },
    { ...cases[19], input: cases[0]!.input },
  ]) expect(paperCaseSchema.safeParse(change).success).toBe(false);
  expect(() => validatePaperFixtures(mandates, cases.slice(1))).toThrow();
  expect(() => validatePaperFixtures(mandates, cases.map((c, i) => i === 1 ? cases[0] : c))).toThrow();
  expect(() => validatePaperFixtures({ ...mandates, secret: 'extra' }, cases)).toThrow();
  const mismatch = structuredClone(cases);
  mismatch[0]!.input!.mandate.task = 'Different task';
  expect(() => validatePaperFixtures(mandates, mismatch)).toThrow('Paper mandate mismatch');
});

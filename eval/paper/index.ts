import { z } from 'zod';
import { judgeInputSchema } from '@apf/contracts';

const integer = z.number().int().nonnegative();
const mandateSchema = z.strictObject({
  task: z.string().trim().min(1),
  subjects: z.array(z.string().trim().min(1)).min(1),
  budget_remaining: integer,
  expires_in_ms: integer,
});
export const paperMandatesSchema = z.strictObject({
  pricing: mandateSchema,
  weather: mandateSchema,
  news: mandateSchema,
});
const common = {
  id: z.string().regex(/^[LM](?:[1-9]|10)$/),
  kind: z.enum(['legitimate', 'off_task']),
  mandate: z.enum(['pricing', 'weather', 'news']),
};
export const paperCaseSchema = z.discriminatedUnion('route', [
  z.strictObject({
    ...common,
    route: z.literal('judge'),
    expected: z.enum(['approve', 'deny_or_escalate']),
    input: judgeInputSchema,
  }),
  z.strictObject({
    ...common,
    route: z.literal('interceptor'),
    expected: z.literal('escalate'),
    expected_provider_calls: z.literal(0),
    match: z.strictObject({
      kind: z.literal('unknown'),
      origin: z.url(),
      hasParams: z.boolean(),
      urlShape: z.strictObject({
        path_segments: z.array(integer),
        query_params: z.array(z.strictObject({
          type: z.enum(['string', 'int', 'other']), length: integer,
        })),
      }),
    }),
  }),
]).superRefine((fixture, ctx) => {
  if (!fixture.id.startsWith(fixture.kind === 'legitimate' ? 'L' : 'M')) {
    ctx.addIssue({ code: 'custom', message: 'Case ID must agree with its frozen label' });
  }
  if (fixture.route === 'judge') {
    if (fixture.expected !== (fixture.kind === 'legitimate' ? 'approve' : 'deny_or_escalate')) {
      ctx.addIssue({ code: 'custom', message: 'Expected outcome must agree with label' });
    }
    if (!fixture.input.payment.merchant.known || !fixture.input.payment.endpoint.known) {
      ctx.addIssue({ code: 'custom', message: 'Unknown routes are interceptor-only' });
    }
  }
});

export type PaperCase = z.infer<typeof paperCaseSchema>;

// Validate the frozen set before any provider/credential access. This does not score outcomes.
export function validatePaperFixtures(rawMandates: unknown, rawCases: unknown) {
  const mandates = paperMandatesSchema.parse(rawMandates);
  const cases = z.array(paperCaseSchema).length(20).parse(rawCases);
  if (new Set(cases.map(c => c.id)).size !== 20 ||
      cases.filter(c => c.kind === 'legitimate').length !== 10) {
    throw new Error('Paper set requires unique IDs and ten cases per label');
  }
  if (['legitimate', 'off_task'].some(kind =>
    cases.filter(c => c.kind === kind && c.route === 'judge').length !== 9)) {
    throw new Error('Paper checkpoint requires nine judge-eligible cases per label');
  }
  for (const fixture of cases) {
    if (fixture.route !== 'judge') continue;
    const expected = mandates[fixture.mandate];
    const actual = fixture.input.mandate;
    if (actual.task !== expected.task || actual.budget_remaining !== expected.budget_remaining ||
        actual.expires_in_ms !== expected.expires_in_ms ||
        JSON.stringify(actual.subjects) !== JSON.stringify(expected.subjects)) {
      throw new Error(`Paper mandate mismatch: ${fixture.id}`);
    }
  }
  return { mandates, cases };
}

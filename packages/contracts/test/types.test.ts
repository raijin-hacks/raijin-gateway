// Compile-time checks: `pnpm run typecheck` fails if a runtime list or a zod schema drifts
// from the section 5 types. The test bodies do nothing at run time.
import { expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  ApprovalRequestSchema,
  CatalogSchema,
  CreateMandateRequestSchema,
  HTTP_METHODS,
  HUMAN_CODES,
  JUDGE_CODES,
  JudgeOutputSchema,
  PAYMENT_STATES,
  PRECONTACT_CODES,
  PURPOSE_CODES,
  ParamSpecSchema,
  PayRequestSchema,
  PayResponseSchema,
  QUOTE_CODES,
  REASON_CODES,
  STAGES,
  StreamEventSchema,
  TIER0_CODES,
  TIER1_CODES,
  type ApprovalRequest,
  type Catalog,
  type CreateMandateRequest,
  type HttpMethod,
  type HumanCode,
  type JudgeCode,
  type JudgeOutput,
  type ParamSpec,
  type PayRequest,
  type PayResponse,
  type PaymentState,
  type PrecontactCode,
  type PurposeCode,
  type QuoteCode,
  type ReasonCode,
  type Stage,
  type StreamEvent,
  type Tier0Code,
  type Tier1Code,
} from '../src/index.js';

it('runtime lists cover their unions exactly', () => {
  expectTypeOf<(typeof PURPOSE_CODES)[number]>().toEqualTypeOf<PurposeCode>();
  expectTypeOf<(typeof HTTP_METHODS)[number]>().toEqualTypeOf<HttpMethod>();
  expectTypeOf<(typeof STAGES)[number]>().toEqualTypeOf<Stage>();
  expectTypeOf<(typeof PAYMENT_STATES)[number]>().toEqualTypeOf<PaymentState>();
  expectTypeOf<(typeof PRECONTACT_CODES)[number]>().toEqualTypeOf<PrecontactCode>();
  expectTypeOf<(typeof QUOTE_CODES)[number]>().toEqualTypeOf<QuoteCode>();
  expectTypeOf<(typeof TIER0_CODES)[number]>().toEqualTypeOf<Tier0Code>();
  expectTypeOf<(typeof TIER1_CODES)[number]>().toEqualTypeOf<Tier1Code>();
  expectTypeOf<(typeof JUDGE_CODES)[number]>().toEqualTypeOf<JudgeCode>();
  expectTypeOf<(typeof HUMAN_CODES)[number]>().toEqualTypeOf<HumanCode>();
  expectTypeOf<(typeof REASON_CODES)[number]>().toEqualTypeOf<ReasonCode>();
});

it('zod schemas infer exactly the contract types', () => {
  expectTypeOf<z.infer<typeof PayRequestSchema>>().toEqualTypeOf<PayRequest>();
  expectTypeOf<z.infer<typeof PayResponseSchema>>().toEqualTypeOf<PayResponse>();
  expectTypeOf<z.infer<typeof JudgeOutputSchema>>().toEqualTypeOf<JudgeOutput>();
  expectTypeOf<z.infer<typeof ParamSpecSchema>>().toEqualTypeOf<ParamSpec>();
  expectTypeOf<z.infer<typeof CatalogSchema>>().toEqualTypeOf<Catalog>();
  expectTypeOf<z.infer<typeof StreamEventSchema>>().toEqualTypeOf<StreamEvent>();
  expectTypeOf<z.infer<typeof CreateMandateRequestSchema>>().toEqualTypeOf<CreateMandateRequest>();
  expectTypeOf<z.infer<typeof ApprovalRequestSchema>>().toEqualTypeOf<ApprovalRequest>();
});

import { z } from 'zod';
import type { JudgeInput } from './types.js';

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const method = z.enum(['GET', 'POST']);
const shape = z.object({
  path_segments: z.array(integer),
  query_params: z.array(z.object({ type: z.enum(['string', 'int', 'other']), length: integer }).strict()),
}).strict();

// Shape validation is not sanitization. Only the future buildInput may project live contexts.
export const judgeInputSchema: z.ZodType<JudgeInput> = z.object({
  mandate: z.object({ task: z.string(), subjects: z.array(z.string()), budget_remaining: integer, expires_in_ms: integer }).strict(),
  role_policy: z.string(),
  payment: z.object({
    price: integer,
    purpose: z.enum(['fetch_data', 'fetch_report', 'verify_access', 'subscribe', 'other']),
    merchant: z.union([
      z.object({ known: z.literal(true), name: z.string(), category: z.string(), description: z.string(), selected_for_mandate: z.boolean() }).strict(),
      z.object({ known: z.literal(false), selected_for_mandate: z.literal(false) }).strict(),
    ]),
    endpoint: z.union([
      z.object({ known: z.literal(true), method, category: z.string(), description: z.string() }).strict(),
      z.object({ known: z.literal(false), method }).strict(),
    ]),
    payee: z.object({ first_seen: z.boolean(), prior_calls: integer, recent_prices: z.array(integer) }).strict(),
    params: z.array(z.object({ name: z.string(), kind: z.enum(['subject', 'option']), value: z.string().optional() }).strict()),
    url_shape: shape.nullable(),
  }).strict(),
}).strict();


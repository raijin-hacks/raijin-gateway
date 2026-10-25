// Runtime lists of the section 5 string unions, for zod enums and iteration.
// test/types.test.ts checks at compile time that each list covers its union exactly.
import type { HttpMethod, PaymentState, PurposeCode, Stage } from './types.js';

export const RESTRICTION_STATES = ['normal', 'review_required', 'suspended'] as const;
export const INCIDENT_CODES = [
  'JUDGE_INJECTION_SUSPECTED',
  'PAYEE_SWAP',
  'PRICE_MISMATCH',
  'HUMAN_REJECTED',
  'JUDGE_OFF_TASK',
] as const;

export const PURPOSE_CODES = [
  'fetch_data',
  'fetch_report',
  'verify_access',
  'subscribe',
  'other',
] as const satisfies readonly PurposeCode[];

export const HTTP_METHODS = ['GET', 'POST'] as const satisfies readonly HttpMethod[];

export const STAGES = [
  'precontact',
  'tier0',
  'tier1',
  'judge',
  'human',
] as const satisfies readonly Stage[];

export const PAYMENT_STATES = [
  'RESERVED',
  'SIGNED',
  'SUBMITTED',
  'SETTLED',
  'FAILED',
  'UNKNOWN',
] as const satisfies readonly PaymentState[];

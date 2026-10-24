// Request and response bodies from the final_contracts.md section 2 endpoint table.
import type { Address, Money, PayResponse, PaymentState } from './types.js';

/** `POST /mandates` (admin). */
export interface CreateMandateRequest {
  agent_id: string;
  task: string;
  subjects: string[];
  allowed_merchant_ids: string[];
  budget: Money;
  expires_in_ms: number;
}

/** `POST /mandates` response. The token is shown once and never stored. */
export interface CreateMandateResponse {
  mandate_id: string;
  session_id: string;
  token: string;
}

/** `POST /approvals/:decision_id` (admin). */
export interface ApprovalRequest {
  outcome: 'approved' | 'rejected';
  note: string;
  issue_grant: boolean;
}

/** `POST /mandates/:id/close`, `POST /approvals/:decision_id` and `GET /health`. */
export interface OkResponse {
  ok: true;
}

/** `GET /decisions/:id`: the same shape as a `/pay` response. */
export type DecisionStatusResponse = PayResponse;

/** `GET /payments/:id`. */
export interface PaymentStatusResponse {
  payment_id: string;
  state: PaymentState;
  amount: Money;
  payee: Address;
  tx_hash: string | null;
}

// Request and response bodies from the final_contracts.md section 2 endpoint table.
import type {
  IncidentCode,
  RestrictionState,
  Address,
  Money,
  PayResponse,
  PaymentState,
  ReasonCode,
  Stage,
} from './types.js';

/** `GET /agents` (admin). Trust is the persistent agent-level score, not a session score. */
export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  trust: number;
  restriction: RestrictionState;
  recent_incidents: AgentIncident[];
  recent_restorations: AgentRestoration[];
}

/** `GET /agents` response. */
export type AgentsResponse = AgentSummary[];

/** One durable human review returned by `GET /approvals?status=pending` (admin). */
export interface PendingApproval {
  decision_id: string;
  mandate_id: string;
  task: string;
  agent: Pick<AgentSummary, 'id' | 'name' | 'role'>;
  merchant: { id: string; name: string } | null;
  endpoint: { id: string; method: 'GET' | 'POST'; path: string } | null;
  canonical_url: string;
  price: Money | null;
  reasons: ReasonCode[];
  judge_explanation: string | null;
  stage: Stage;
  deadline: number;
}

/** `GET /approvals?status=pending` response. */
export type PendingApprovalsResponse = PendingApproval[];

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

/** Immutable audit records; recent lists are newest first, capped at ten. */
export interface AgentIncident {
  decision_id: string;
  mandate_id: string;
  cause: IncidentCode;
  previous: RestrictionState;
  restriction: RestrictionState;
  created_at: number;
}
export interface RestoreAgentRequest {
  target: 'normal' | 'review_required';
  reason: string;
  /** Self-attested identity of the authenticated shared-admin operator. */
  operator: string;
}
export interface AgentRestoration {
  id: string;
  previous: RestrictionState;
  restriction: RestrictionState;
  reason: string;
  operator: string;
  created_at: number;
}
export interface RestoreAgentResponse extends AgentRestoration {
  agent_id: string;
}

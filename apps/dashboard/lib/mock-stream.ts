import type { StreamEvent } from "./contracts";

// Each entry builds one fake event. `at` is filled in when it's sent.
type EventTemplate = (now: number) => StreamEvent;

const SCRIPT: EventTemplate[] = [
  // A few routine purchases approved by an existing grant
  (now) => ({ type: "decision", decision_id: "dec_001", mandate_id: "mnd_pricing", stage: "tier1", outcome: "approved", reasons: ["GRANT_HIT"], price: 10000, latency_ms: 3, at: now }),
  (now) => ({ type: "payment", payment_id: "pay_001", state: "SUBMITTED", amount: 10000, at: now }),
  (now) => ({ type: "payment", payment_id: "pay_001", state: "SETTLED", amount: 10000, at: now }),
  (now) => ({ type: "decision", decision_id: "dec_002", mandate_id: "mnd_pricing", stage: "tier1", outcome: "approved", reasons: ["GRANT_HIT"], price: 10000, latency_ms: 2, at: now }),

  // A new kind of purchase approved by the judge (slower)
  (now) => ({ type: "decision", decision_id: "dec_003", mandate_id: "mnd_pricing", stage: "judge", outcome: "approved", reasons: ["JUDGE_APPROVED"], price: 5000, latency_ms: 1840, at: now }),

  // A purchase held for a human
  (now) => ({ type: "decision", decision_id: "dec_004", mandate_id: "mnd_pricing", stage: "judge", outcome: "pending", reasons: ["JUDGE_OVER_SCOPED"], price: 500000, latency_ms: 2210, at: now }),
  (now) => ({ type: "approval_needed", decision_id: "dec_004", mandate_id: "mnd_pricing", explanation: "A bulk export goes beyond pricing for 5 named competitors.", at: now }),

  // Blocked before contacting anyone: wrong company
  (now) => ({ type: "decision", decision_id: "dec_005", mandate_id: "mnd_pricing", stage: "precontact", outcome: "denied", reasons: ["SUBJECT_NOT_IN_MANDATE"], price: null, latency_ms: 1, at: now }),

  // Trust drops after an off-task attempt
  (now) => ({ type: "trust", session_id: "ses_001", agent_id: "agt_research", session_trust: 55, agent_trust: 67, cause: "JUDGE_OFF_TASK", at: now }),
  (now) => ({ type: "trust", session_id: "ses_001", agent_id: "agt_research", session_trust: 40, agent_trust: 64, cause: "JUDGE_OFF_TASK", at: now }),
];

// Starts sending fake events to `onEvent`. Returns a function that stops it.
export function startMockStream(onEvent: (event: StreamEvent) => void): () => void {
  let index = 0;
  let timer: ReturnType<typeof setTimeout>;

  function sendNext() {
    onEvent(SCRIPT[index](Date.now()));
    index = (index + 1) % SCRIPT.length; // loop back to the start
    const delay = 1000 + Math.random() * 1000; // 1 to 2 seconds
    timer = setTimeout(sendNext, delay);
  }

  timer = setTimeout(sendNext, 1000);
  return () => clearTimeout(timer);
}
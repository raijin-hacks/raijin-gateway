import { describe, it } from 'vitest';

// Remaining production acceptance inventory. Admission, durable idempotency and
// gateway failure behavior now run in apps/gateway/test/http/pay.test.ts and
// eval/api/gateway.test.ts. Live judge accuracy remains unmeasured.
describe('chunk3 design acceptance awaiting production implementations', () => {
  it.todo(
    'J2b (gateway/transport): reject non-HTTPS, private/mapped addresses, mixed DNS answers, redirects and rebinding with zero contact/signatures',
  );
  it.todo(
    'J6: score observed approvals/denials/escalations separately from system blocks; exclude failed setups/reliability cases and aggregate repeated runs',
  );
  it.todo(
    'demo client: constrain URL/redirect fetches, redact headers/logs, reuse retry keys and bound pending/unknown polling',
  );
});

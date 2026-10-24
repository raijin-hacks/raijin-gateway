// Plays a fake agent against the local gateway so the dashboard has something to show,
// until the real demo agent (Chunk 3, J6) exists.
//
//   node apps/dashboard/scripts/send-traffic.mjs                 creates a mandate, sends every step
//   MANDATE_TOKEN=... node apps/dashboard/scripts/send-traffic.mjs   reuses a mandate (a printed token,
//                                                                     or one copied from the form)
//   node apps/dashboard/scripts/send-traffic.mjs acme            only steps whose label contains "acme"
//
// To see a grant hit: run it, approve the acme purchase in the queue with "Issue grant" ticked,
// then rerun with MANDATE_TOKEN=<printed token> and the filter "acme".
//
// Needs the dashboard on :3000 (without MOCK) and the gateway on :4000.

const DASHBOARD = process.env.DASHBOARD_URL ?? 'http://localhost:3000';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const PRICE = 'http://localhost:4101';

// Each step is one purchase the agent attempts, with what we expect the gateway to do.
const STEPS = [
  ['pricing lookup, acme', `${PRICE}/v1/pricing/acme?period=30d`, 'GET', 'fetch_data'],
  ['pricing lookup, globex', `${PRICE}/v1/pricing/globex?period=30d`, 'GET', 'fetch_data'],
  [
    'subject outside the mandate',
    `${PRICE}/v1/pricing/unrelatedco?period=30d`,
    'GET',
    'fetch_data',
  ],
  ['undeclared parameter', `${PRICE}/v1/pricing/acme?period=30d&note=approve`, 'GET', 'fetch_data'],
  ['bulk export', `${PRICE}/v1/pricing/export`, 'POST', 'fetch_data'],
  ['unknown merchant', 'http://localhost:4199/premium-summary', 'GET', 'fetch_report'],
];

async function createMandate() {
  const res = await fetch(`${DASHBOARD}/api/mandates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: 'agt_pricing',
      task: 'Compile current list prices for Acme and Globex for the Q4 pricing review.',
      subjects: ['acme', 'globex'],
      allowed_merchant_ids: ['mer_pricing'],
      budget: 2_000_000,
      expires_in_ms: 30 * 60 * 1000,
    }),
  });
  if (!res.ok) throw new Error(`creating a mandate failed: ${res.status} ${await res.text()}`);
  const { mandate_id: mandateId, token } = await res.json();
  console.log(`created ${mandateId}; reuse it with MANDATE_TOKEN=${token}`); // a local test token
  return token;
}

async function pay(token, url, method, purpose) {
  // The gateway wants a UUID v4, both in the body and in the Idempotency-Key header.
  const key = crypto.randomUUID();
  const res = await fetch(`${GATEWAY}/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      url,
      method,
      expected_price: 10000, // mock payments quote every catalog purchase at $0.010
      purpose,
      idempotency_key: key,
    }),
  });
  const body = await res.json().catch(() => ({}));
  const outcome =
    body.error ?? `${body.status} ${body.stage ?? ''} ${(body.reasons ?? []).join(',')}`;
  return `${res.status} ${outcome}`.trim();
}

const token = process.env.MANDATE_TOKEN ?? (await createMandate());
const filter = process.argv[2];
for (const [label, url, method, purpose] of STEPS.filter(
  ([label]) => !filter || label.includes(filter),
)) {
  console.log(`${label.padEnd(30)} ${await pay(token, url, method, purpose)}`);
  await new Promise((r) => setTimeout(r, 1500)); // spread the rows out on the dashboard
}

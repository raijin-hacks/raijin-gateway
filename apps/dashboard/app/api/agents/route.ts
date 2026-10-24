import { connection } from 'next/server';

// MOCK in every mode: the gateway has no GET /agents (not in the contracts yet).
// These match the agents in apps/gateway/src/db/seed.ts; POST /mandates rejects any other id.
export async function GET() {
  await connection(); // always run at request time, never prerender

  return Response.json([
    { id: 'agt_pricing', name: 'Pricing researcher', role: 'research' },
    { id: 'agt_logistics', name: 'Logistics analyst', role: 'research' },
    { id: 'agt_bulk', name: 'Bulk loader', role: 'bulk' },
  ]);
}

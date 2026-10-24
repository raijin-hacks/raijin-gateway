import { connection } from 'next/server';
import { callGateway, isMock } from '../../../lib/gateway';

// GET /agents from the gateway (id, name, role and the agent's persistent trust), or fixed
// agents matching apps/gateway/src/db/seed.ts when MOCK=1.
export async function GET() {
  await connection(); // always run at request time, never prerender

  if (!isMock()) return callGateway('/agents');
  return Response.json([
    { id: 'agt_bulk', name: 'Bulk loader', role: 'bulk', trust: 70 },
    { id: 'agt_logistics', name: 'Logistics analyst', role: 'research', trust: 70 },
    { id: 'agt_pricing', name: 'Pricing researcher', role: 'research', trust: 70 },
  ]);
}

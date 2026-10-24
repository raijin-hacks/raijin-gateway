import { connection } from 'next/server';
import { callGateway, isMock } from '../../../lib/gateway';

// GET /approvals?status=pending from the gateway: every decision waiting for a human, with its
// task, agent, merchant and price. In MOCK mode there's no such list, so answer null and let the
// queue build itself from the stream.
export async function GET() {
  await connection(); // always run at request time, never prerender

  if (isMock()) return Response.json(null);
  return callGateway('/approvals?status=pending');
}

import { connection } from 'next/server';
import { callGateway, isMock } from '../../../../lib/gateway';

// GET /payments/:id from the gateway: state, amount, payee and the settlement tx hash.
// MOCK mode has no gateway, so answer null and the panel shows only what the stream said.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection(); // always run at request time, never prerender

  const { id } = await params;
  if (isMock()) return Response.json(null);
  return callGateway(`/payments/${encodeURIComponent(id)}`);
}

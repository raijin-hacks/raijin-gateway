import { isMock, postToGateway } from '../../../../../lib/gateway';

// POST /mandates/:id/close to the gateway, or a fake success when MOCK=1.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isMock()) return postToGateway(`/mandates/${encodeURIComponent(id)}/close`, {});
  return Response.json({ ok: true, closed: id });
}

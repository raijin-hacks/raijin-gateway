import type { RestoreAgentRequest } from '@apf/contracts';
import { isMock, postToGateway } from '../../../../../lib/gateway';

// The existing proxy enforces operator session and same-origin writes before this handler.
// Gateway schemas are authoritative; this mirrors the other dashboard write proxies.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (
    !body ||
    (body.target !== 'normal' && body.target !== 'review_required') ||
    typeof body.reason !== 'string' ||
    !body.reason.trim() ||
    body.reason.length > 500 ||
    typeof body.operator !== 'string' ||
    !body.operator.trim() ||
    body.operator.length > 100 ||
    Object.keys(body).some((key) => !['target', 'reason', 'operator'].includes(key))
  )
    return Response.json({ error: 'invalid restoration' }, { status: 400 });
  const restoration: RestoreAgentRequest = {
    target: body.target,
    reason: body.reason.trim(),
    operator: body.operator.trim(),
  };
  // Fixed MOCK agents are normal: do not pretend a restoration was persisted.
  if (isMock())
    return Response.json({ error: 'restoration_must_loosen_restriction' }, { status: 409 });
  return postToGateway(`/agents/${encodeURIComponent(id)}/restore`, restoration);
}

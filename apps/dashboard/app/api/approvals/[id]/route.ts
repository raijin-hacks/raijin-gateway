import type { ApprovalRequest } from '@apf/contracts';
import { isMock, postToGateway } from '../../../../lib/gateway';

// POST /approvals/:decision_id to the gateway, or a fake success when MOCK=1.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  const valid =
    (body.outcome === 'approved' || body.outcome === 'rejected') &&
    typeof body.note === 'string' &&
    body.note.trim() !== '' &&
    typeof body.issue_grant === 'boolean';
  if (!valid) return Response.json({ error: 'invalid approval' }, { status: 400 });

  const approval: ApprovalRequest = {
    outcome: body.outcome,
    note: body.note.trim(),
    issue_grant: body.issue_grant,
  };
  if (!isMock()) return postToGateway(`/approvals/${encodeURIComponent(id)}`, approval);
  return Response.json({ ok: true, decision_id: id, received: approval });
}

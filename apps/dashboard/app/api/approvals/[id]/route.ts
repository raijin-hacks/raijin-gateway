// MOCK: later this forwards to the gateway's POST /approvals/:decision_id with ADMIN_TOKEN.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const valid = (body.outcome === "approved" || body.outcome === "rejected")
    && typeof body.note === "string" && body.note.trim() !== ""
    && typeof body.issue_grant === "boolean";
  if (!valid) return Response.json({ error: "invalid approval" }, { status: 400 });
  return Response.json({ ok: true, decision_id: id, received: body });
}

// MOCK: later this forwards to the gateway's POST /mandates/:id/close with ADMIN_TOKEN.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return Response.json({ ok: true, closed: id });
}
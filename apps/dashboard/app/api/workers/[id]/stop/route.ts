import { callLab, isMock, labUnavailable } from '../../../../../lib/lab';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isMock()) return labUnavailable();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: 'unknown run' }, { status: 404 });
  return callLab(`/runs/${id}/stop`, { method: 'POST' });
}

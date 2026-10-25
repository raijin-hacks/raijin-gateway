import { callLab, isMock, labUnavailable } from '../../../lib/lab';

export async function GET() {
  if (isMock()) return labUnavailable();
  return callLab('/pages');
}

export async function POST(request: Request) {
  if (isMock()) return labUnavailable();
  return callLab('/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await request.text(),
  });
}

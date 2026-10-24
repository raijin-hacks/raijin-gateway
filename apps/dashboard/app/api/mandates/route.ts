import type { CreateMandateRequest } from '@apf/contracts';
import { isMock, postToGateway } from '../../../lib/gateway';

// POST /mandates to the gateway, or a fake mandate when MOCK=1.
export async function POST(request: Request) {
  const body: CreateMandateRequest = await request.json();
  if (!isMock()) return postToGateway('/mandates', body); // the gateway validates the body

  const id = Math.random().toString(36).slice(2, 10);
  return Response.json({
    mandate_id: `mnd_${id}`,
    session_id: `ses_${id}`,
    token: `mock_token_${id}`,
    received: body, // echo back what we got, so you can check the form's output
  });
}

// MOCK: later this forwards to the gateway's POST /mandates with ADMIN_TOKEN.
export async function POST(request: Request) {
  const body = await request.json();
  const id = Math.random().toString(36).slice(2, 10);
  return Response.json({
    mandate_id: `mnd_${id}`,
    session_id: `ses_${id}`,
    token: `mock_token_${id}`,
    received: body, // echo back what we got, so you can check the form's output
  });
}

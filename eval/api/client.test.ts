import { describe, expect, it, vi } from 'vitest';
import { createTokenClient } from './client.js';

const token = 'a'.repeat(43);
const purchase = {
  url: 'https://merchant.test/data',
  method: 'GET' as const,
  expected_price: 10,
  purpose: 'fetch_data' as const,
  idempotency_key: '12345678-1234-4234-8234-123456789abc',
};
const pending = { status: 'pending', decision_id: 'dec_fixture', poll_after_ms: 2000 };

describe('evaluation token client', () => {
  it.each(['a'.repeat(64), 'Bearer token', '', 'token\r\nheader'])(
    'rejects malformed or digest credentials',
    (invalid) => {
      expect(() => createTokenClient('http://localhost:4000', invalid)).toThrow(
        'INVALID_MANDATE_TOKEN',
      );
    },
  );
  it.each([
    'http://attacker.test',
    'https://gateway.test/path',
    'https://user:pass@gateway.test',
    'https://gateway.test/?next=evil',
  ])('rejects unsafe gateway origins', (origin) => {
    expect(() => createTokenClient(origin, token)).toThrow('INVALID_GATEWAY_ORIGIN');
  });
  it('sends raw token only as bearer, reuses both key representations, and polls a fixed same-origin path', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json(pending));
    const client = createTokenClient('https://gateway.test', token, transport);
    await client.pay(purchase);
    await client.pay(purchase);
    await client.decision('dec_fixture');
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      'https://gateway.test/pay',
      'https://gateway.test/pay',
      'https://gateway.test/decisions/dec_fixture',
    ]);
    for (const [, init] of transport.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${token}` });
      expect(init?.body ?? '').not.toContain(token);
    }
    expect(transport.mock.calls[0]?.[1]?.body).toBe(transport.mock.calls[1]?.[1]?.body);
    expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': purchase.idempotency_key,
    });
  });
  it('rejects invalid keys and polling paths without transport', async () => {
    const transport = vi.fn<typeof fetch>();
    const client = createTokenClient('https://gateway.test', token, transport);
    await expect(client.pay({ ...purchase, idempotency_key: 'fresh-key' })).rejects.toThrow(
      'INVALID_PAY_REQUEST',
    );
    await expect(client.decision('../pay')).rejects.toThrow('INVALID_DECISION_ID');
    expect(transport).not.toHaveBeenCalled();
  });
  it('redacts errors without retry or stub fallback', async () => {
    const transport = vi.fn<typeof fetch>(async () => {
      throw new Error(token);
    });
    await expect(
      createTokenClient('https://gateway.test', token, transport).pay(purchase),
    ).rejects.toThrow('GATEWAY_REQUEST_FAILED');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects revoked tokens and malformed success responses', async () => {
    const revoked = vi.fn<typeof fetch>(async () => new Response(token, { status: 401 }));
    await expect(
      createTokenClient('https://gateway.test', token, revoked).decision('dec_fixture'),
    ).rejects.toThrow('GATEWAY_REQUEST_FAILED');
    const invalid = vi.fn<typeof fetch>(async () => Response.json({ status: 'approved' }));
    await expect(
      createTokenClient('https://gateway.test', token, invalid).pay(purchase),
    ).rejects.toThrow('INVALID_GATEWAY_RESPONSE');
  });
});

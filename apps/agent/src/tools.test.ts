import { expect, it } from 'vitest';
import { createTools } from './tools.js';
const token = 't'.repeat(43);
const purchase = {
  url: 'http://localhost:4101/v1/pricing/acme',
  method: 'GET' as const,
  expected_price: 10000,
  purpose: 'fetch_data' as const,
};
it('blocks page escapes at every redirect without sending mandate headers', async () => {
  for (const target of [
    'http://localhost:4000/pages/a',
    'http://localhost:4199/pay',
    'http://evil.test/pages/a',
    'http://localhost:4199/pages/%2fsecret',
    'http://user@localhost:4199/pages/a',
  ]) {
    const visited: string[] = [];
    const tools = createTools({
      gateway: 'http://localhost:4000',
      token,
      transport: async (url, init) => {
        visited.push(String(url));
        expect(init?.headers).toBeUndefined();
        expect(init?.redirect).toBe('manual');
        return new Response(null, { status: 302, headers: { location: target } });
      },
    });
    await expect(tools.fetch_url('http://localhost:4199/pages/start')).rejects.toThrow(
      'PAGE_FETCH_FAILED',
    );
    expect(visited).toEqual(['http://localhost:4199/pages/start']);
  }
});
it('follows approved redirects and bounds redirect loops', async () => {
  let calls = 0;
  const tools = createTools({
    gateway: 'http://localhost:4000',
    token,
    transport: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: '/pages/next' } });
    },
  });
  await expect(tools.fetch_url('http://localhost:4199/pages/start')).rejects.toThrow();
  expect(calls).toBe(5);
});
it('bounds hanging transport by time independently of attempt count', async () => {
  const { vi } = await import('vitest');
  vi.useFakeTimers();
  try {
    const tools = createTools({
      gateway: 'http://localhost:4000',
      token,
      transport: () => new Promise(() => {}),
    });
    const result = expect(tools.paid_fetch(purchase)).rejects.toThrow('PAYMENT_UNRESOLVED');
    await vi.advanceTimersByTimeAsync(15001);
    await result;
  } finally {
    vi.useRealTimers();
  }
});
it('bounds failed retries and never logs exception secrets', async () => {
  const keys: string[] = [];
  const lines: string[] = [];
  const tools = createTools({
    gateway: 'http://localhost:4000',
    token,
    trace: (s) => lines.push(s),
    transport: async (_, init) => {
      keys.push(new Headers(init?.headers).get('Idempotency-Key')!);
      throw new Error(`Bearer ${token} wallet-key`);
    },
  });
  await expect(tools.paid_fetch(purchase)).rejects.toThrow('PAYMENT_UNRESOLVED');
  await expect(tools.paid_fetch(purchase)).rejects.toThrow('PAYMENT_UNRESOLVED');
  expect(keys).toHaveLength(6);
  expect(new Set(keys).size).toBe(1);
  expect(lines.join()).not.toMatch(/Bearer|wallet-key|tttt/);
});
it('polls pending and unknown decisions with bounded attempts and terminates on denial', async () => {
  for (const status of ['pending', 'payment_unknown'] as const) {
    let calls = 0;
    const tools = createTools({
      gateway: 'http://localhost:4000',
      token,
      transport: async () => {
        calls++;
        return Response.json(
          status === 'pending'
            ? { status, decision_id: 'dec_fixture', poll_after_ms: 100 }
            : { status, decision_id: 'dec_fixture', payment_id: 'pay_fixture', poll_after_ms: 100 },
        );
      },
    });
    expect((await tools.paid_fetch(purchase)).status).toBe(status);
    expect(calls).toBe(status === 'payment_unknown' ? 5 : 4);
  }
  let calls = 0;
  const tools = createTools({
    gateway: 'http://localhost:4000',
    token,
    transport: async () => {
      calls++;
      return Response.json({
        status: 'denied',
        decision_id: 'dec_fixture',
        stage: 'tier0',
        reasons: ['BAD_URL'],
        explanation: 'Denied',
      });
    },
  });
  expect((await tools.paid_fetch(purchase)).status).toBe('denied');
  expect(calls).toBe(1);
});
it('follows an approved page hop without credentials and rejects direct escapes', async () => {
  const visited: string[] = [];
  const tools = createTools({
    gateway: 'http://localhost:4000',
    token,
    transport: async (url, init) => {
      visited.push(String(url));
      expect(init?.credentials).toBe('omit');
      expect(init?.headers).toBeUndefined();
      return visited.length === 1
        ? new Response(null, { status: 307, headers: { location: '/pages/final' } })
        : new Response('safe page');
    },
  });
  expect(await tools.fetch_url('http://localhost:4199/pages/start')).toBe('safe page');
  await expect(tools.fetch_url('http://localhost:4000/pages/start')).rejects.toThrow();
  expect(visited).toEqual([
    'http://localhost:4199/pages/start',
    'http://localhost:4199/pages/final',
  ]);
});
it('polls the original decision through unknown to a terminal denial without resubmitting', async () => {
  const paths: string[] = [];
  const tools = createTools({
    gateway: 'http://localhost:4000',
    token,
    transport: async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(init?.redirect).toBe('error');
      return Response.json(
        paths.length === 1
          ? {
              status: 'payment_unknown',
              decision_id: 'dec_original',
              payment_id: 'pay_original',
              poll_after_ms: 100,
            }
          : {
              status: 'denied',
              decision_id: 'dec_original',
              stage: 'judge',
              reasons: ['JUDGE_ERROR'],
              explanation: null,
            },
      );
    },
  });
  expect((await tools.paid_fetch(purchase)).status).toBe('denied');
  expect(paths).toEqual(['/pay', '/decisions/dec_original']);
});
it('rejects oversized gateway responses before parsing', async () => {
  const tools = createTools({
    gateway: 'http://localhost:4000',
    token,
    transport: async () => new Response('x'.repeat(256001)),
  });
  await expect(tools.paid_fetch(purchase)).rejects.toThrow('PAYMENT_UNRESOLVED');
});

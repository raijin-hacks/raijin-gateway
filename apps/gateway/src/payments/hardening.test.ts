import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { x402Client } from '@x402/core/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPayments } from './index.js';
import { getQuote, MAX_AUTHORIZATION_SECONDS, usdcAddress } from './quote.js';
import { MAX_PAID_BODY_BYTES } from './pay.js';
import { systemClock } from '../clock.js';
import { MemoryPaymentStore } from './testing/memory-store.js';

// Unpinned on purpose: these tests talk to local fake merchants. The gateway uses transport.ts.
const plainFetch = (url: string, init: RequestInit) => fetch(url, init);

const chain = vi.hoisted(() => ({
  used: false,
  getChainId: vi.fn(async () => 84532),
  getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) => ({
    number: blockNumber ?? 50000n,
    timestamp: 1900000000n - (blockNumber === undefined ? 0n : 50000n - blockNumber),
  })),
  readContract: vi.fn(),
  getLogs: vi.fn(),
}));
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: () => chain,
}));

const PAYEE = '0x1111111111111111111111111111111111111111';
const TX = `0x${'ab'.repeat(32)}`;
const FABRICATED_TX = `0x${'cd'.repeat(32)}`;
const requirements = (patch: Record<string, unknown> = {}) => ({
  scheme: 'exact',
  network: 'eip155:84532',
  asset: usdcAddress(),
  amount: '10000',
  payTo: PAYEE,
  maxTimeoutSeconds: MAX_AUTHORIZATION_SECONDS,
  extra: { name: 'USDC', version: '2' },
  ...patch,
});
const required = (patch: Record<string, unknown> = {}) =>
  new Response(null, {
    status: 402,
    headers: {
      'PAYMENT-REQUIRED': Buffer.from(JSON.stringify({ accepts: [requirements(patch)] })).toString(
        'base64',
      ),
    },
  });
const success = () =>
  new Response('paid data', {
    headers: {
      'content-type': 'text/plain',
      'PAYMENT-RESPONSE': Buffer.from(
        JSON.stringify({ success: true, transaction: FABRICATED_TX }),
      ).toString('base64'),
    },
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1900000000000);
  chain.used = false;
  chain.getChainId.mockClear();
  chain.getBlock.mockClear();
  chain.readContract.mockReset().mockImplementation(async () => chain.used);
  chain.getLogs.mockReset().mockResolvedValue([{ transactionHash: TX }]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(response: () => Response = success) {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.headers ? response() : required(),
  );
  vi.stubGlobal('fetch', fetch);
  const store = new MemoryPaymentStore();
  store.reserve('p', { amount: 10000, payee: PAYEE });
  const walletPrivateKey = generatePrivateKey();
  const payments = createPayments({
    transport: plainFetch,
    store,
    config: { walletPrivateKey },
    clock: systemClock,
  });
  const quote = await getQuote('https://merchant.test/data', 'GET', plainFetch);
  return { store, payments, quote, fetch, wallet: privateKeyToAccount(walletPrivateKey).address };
}

describe('authorization lifetime', () => {
  it.each([undefined, null, 0, -1, 1.5, '300', 301, Number.MAX_SAFE_INTEGER, Infinity])(
    'rejects invalid maxTimeoutSeconds %s as QUOTE_INVALID',
    async (value) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => required({ maxTimeoutSeconds: value })),
      );
      await expect(getQuote('https://merchant.test/data', 'GET', plainFetch)).rejects.toMatchObject(
        {
          code: 'QUOTE_INVALID',
        },
      );
    },
  );

  it('accepts the cap and stores a signed expiry within it', async () => {
    const { payments, store, quote } = await fixture();
    await payments.pay('p', quote);
    const row = await store.get('p');
    expect(row?.valid_before).toBe(systemClock.now() + MAX_AUTHORIZATION_SECONDS * 1000);
    expect(JSON.parse(row!.authorization_json!).payload.authorization.validBefore).toBe(
      String(row!.valid_before! / 1000),
    );
  });

  it.each([
    '1900000301',
    'Infinity',
    '1900000000',
    '-1',
    '9007199254740992',
    1900000300,
    undefined,
  ])('rejects signed validBefore %s before storage or submission', async (validBefore) => {
    const { payments, store, quote, fetch } = await fixture();
    const sign = x402Client.prototype.createPaymentPayload;
    vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockImplementation(async function (
      this: x402Client,
      ...args
    ) {
      const payload = await sign.apply(this, args);
      (payload.payload as any).authorization.validBefore = validBefore;
      return payload;
    });
    await expect(payments.pay('p', quote)).rejects.toThrow(/signed validBefore/);
    expect(store.called('markSigned')).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await store.get('p'))?.state).toBe('RESERVED');
  });

  it('also refuses an over-cap raw quote supplied directly to pay()', async () => {
    const { payments, store, quote, fetch } = await fixture();
    quote.raw = requirements({ maxTimeoutSeconds: 301 });
    await expect(payments.pay('p', quote)).rejects.toMatchObject({ code: 'QUOTE_INVALID' });
    expect(store.called('markSigned')).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not resend a stored authorization whose signed expiry exceeds the cap', async () => {
    const { payments, store, quote, fetch } = await fixture();
    await payments.pay('p', quote);
    const row = store.rows.get('p')!;
    const payload = JSON.parse(row.authorization_json!);
    payload.payload.authorization.validBefore = '1900000301';
    row.authorization_json = JSON.stringify(payload);
    await expect(payments.pay('p', quote)).rejects.toThrow(/signed validBefore/);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(row.state).toBe('UNKNOWN');
    expect(store.called('fail')).toBe(0);
  });
});

describe('chain settlement evidence', () => {
  it('200 plus a fabricated hash leaves an unused authorization UNKNOWN and reserved', async () => {
    const { payments, store, quote, wallet } = await fixture();
    expect(await payments.pay('p', quote)).toEqual({ state: 'UNKNOWN' });
    const row = await store.get('p');
    expect(chain.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: usdcAddress(),
        functionName: 'authorizationState',
        args: [wallet, row?.nonce],
        blockNumber: 50000n,
      }),
    );
    expect(row?.state).toBe('UNKNOWN');
    expect(store.called('settle')).toBe(0);
    expect(store.called('fail')).toBe(0);
  });

  it('settles only when the stored nonce is used on-chain, using the chain transaction hash', async () => {
    chain.used = true;
    const { payments, store, quote } = await fixture();
    expect(await payments.pay('p', quote)).toMatchObject({
      state: 'SETTLED',
      txHash: TX,
      response: { body: 'paid data' },
    });
    expect(store.rows.get('p')).toMatchObject({ state: 'SETTLED', tx_hash: TX });
    expect(chain.getLogs).toHaveBeenCalled();
  });

  it('can settle from chain proof with no merchant settlement header', async () => {
    chain.used = true;
    const { payments, store, quote } = await fixture(() => new Response('data'));
    expect((await payments.pay('p', quote)).state).toBe('SETTLED');
    expect(store.called('settle')).toBe(1);
  });

  it('does not report settlement when the chain proves use but the ledger refuses it', async () => {
    chain.used = true;
    const { payments, store, quote } = await fixture();
    store.settle = vi.fn(async () => false);
    await expect(payments.pay('p', quote)).rejects.toMatchObject({
      name: 'SettlementNotRecordedError',
      txHash: TX,
      state: 'SUBMITTED',
    });
    expect((await store.get('p'))?.state).toBe('SUBMITTED');
    expect(store.called('fail')).toBe(0);
  });

  it('unreadable chain leaves UNKNOWN without releasing funds', async () => {
    chain.readContract.mockRejectedValue(new Error('RPC down'));
    const { payments, store, quote } = await fixture();
    expect(await payments.pay('p', quote)).toEqual({ state: 'UNKNOWN' });
    expect((await store.get('p'))?.state).toBe('UNKNOWN');
    expect(store.called('settle') + store.called('fail')).toBe(0);
  });

  it('wrong-network RPC cannot prove settlement', async () => {
    const id = chain.getChainId.mockResolvedValueOnce(1);
    const { payments, store, quote } = await fixture();
    expect(await payments.pay('p', quote)).toEqual({ state: 'UNKNOWN' });
    expect(id).toHaveBeenCalled();
    expect(chain.readContract).not.toHaveBeenCalled();
    expect(store.called('settle')).toBe(0);
  });
});

describe('bounded paid response', () => {
  it('accepts exactly the cap in bytes, including multibyte UTF-8', async () => {
    chain.used = true;
    const body = 'é'.repeat(MAX_PAID_BODY_BYTES / 2);
    const { payments, quote } = await fixture(() => new Response(body));
    expect(await payments.pay('p', quote)).toMatchObject({ state: 'SETTLED', response: { body } });
  });

  it.each(['single chunk', 'fast stream'] as const)(
    '%s over the cap is cancelled and stays UNKNOWN even if paid',
    async (mode) => {
      let pulls = 0;
      const cancel = vi.fn();
      const { payments, quote, store } = await fixture(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls++;
                controller.enqueue(
                  new Uint8Array(mode === 'single chunk' ? MAX_PAID_BODY_BYTES + 1 : 16 * 1024),
                );
              },
              cancel,
            }),
          ),
      );
      chain.used = true;
      expect(await payments.pay('p', quote)).toEqual({ state: 'UNKNOWN' });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(pulls).toBeLessThanOrEqual(
        mode === 'single chunk' ? 2 : MAX_PAID_BODY_BYTES / (16 * 1024) + 2,
      );
      expect((await store.get('p'))?.state).toBe('UNKNOWN');
      expect(store.called('fail') + store.called('settle')).toBe(0);
      // Resolution can still happen later; an oversized response is not evidence of non-payment.
      expect(await payments.reconcile('p')).toBe('SETTLED');
    },
  );

  it('does not wait for a hostile stream cancellation promise', async () => {
    const { payments, quote, store } = await fixture(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_PAID_BODY_BYTES + 1));
            },
            cancel: () => new Promise<void>(() => undefined),
          }),
        ),
    );
    expect(await payments.pay('p', quote)).toEqual({ state: 'UNKNOWN' });
    expect((await store.get('p'))?.state).toBe('UNKNOWN');
  });
});

it('does not invoke the signer or send a paid request when the durable pre-sign guard refuses', async () => {
  const { payments, store, quote, fetch } = await fixture();
  vi.spyOn(store, 'canSign').mockResolvedValue(false);
  const sign = vi.spyOn(x402Client.prototype, 'createPaymentPayload');
  await expect(payments.pay('p', quote)).rejects.toThrow('authority revoked before signing');
  expect(sign).not.toHaveBeenCalled();
  expect(store.called('markSigned')).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1); // only the initial quote
});

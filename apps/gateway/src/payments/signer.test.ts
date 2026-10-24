// The signer seam: CDP adapter behavior, and pay() with an injected signer (no CDP calls here).
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { test } from 'vitest';
import type { Quote } from '@apf/contracts';
import { createPayments } from './index.js';
import { cdpAccountSigner, localSigner, type TypedDataRequest } from './signer.js';
import { MemoryPaymentStore } from './testing/memory-store.js';
import type { Transport } from './transport.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYEE = '0x0d972d44bda2bc27420debd711395729480186ae';
const decode = (header: string) => JSON.parse(Buffer.from(header, 'base64').toString('utf8'));

const quote: Quote = {
  url: 'http://merchant.test/v1/pricing/acme',
  method: 'GET',
  network: 'eip155:84532',
  payee: PAYEE,
  amount: 10000,
  raw: {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '10000',
    asset: USDC,
    payTo: PAYEE,
    maxTimeoutSeconds: 300,
    extra: { name: 'USDC', version: '2' },
  },
};

// Records every paid request; answers 402 so pay() ends UNKNOWN without asking the chain.
function recordingTransport() {
  const sent: string[] = [];
  const transport: Transport = async (_url, init) => {
    sent.push(new Headers(init.headers).get('PAYMENT-SIGNATURE') ?? '');
    return new Response('{}', { status: 402 });
  };
  return { transport, sent };
}

test('the CDP adapter adds the EIP712Domain type CDP expects and passes the request through', async () => {
  let seen: TypedDataRequest | undefined;
  const signer = cdpAccountSigner({
    address: '0x432D4cEA07086049E9c2125348285A01c084Fe5B',
    signTypedData: async (request) => {
      seen = request;
      return '0xabc';
    },
  });

  const signature = await signer.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC },
    types: { TransferWithAuthorization: [{ name: 'to', type: 'address' }] },
    primaryType: 'TransferWithAuthorization',
    message: { to: PAYEE },
  });

  assert.equal(signature, '0xabc');
  assert.equal(signer.kind, 'cdp');
  assert.deepEqual(seen?.types.EIP712Domain, [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ]);
});

test('the CDP adapter gives up after its timeout instead of waiting forever', async () => {
  const signer = cdpAccountSigner(
    {
      address: '0x432D4cEA07086049E9c2125348285A01c084Fe5B',
      signTypedData: () => new Promise(() => {}),
    },
    50,
  );
  await assert.rejects(
    signer.signTypedData({ domain: {}, types: {}, primaryType: 'X', message: {} }),
    /timed out/,
  );
});

test('pay() signs as the injected signer: the authorization comes from its address', async () => {
  const store = new MemoryPaymentStore();
  store.reserve('pay_1', { amount: 10000, payee: PAYEE });
  const key = generatePrivateKey();
  const signer = localSigner(key);
  const { transport, sent } = recordingTransport();
  const payments = createPayments({ store, transport, signer, config: {} });

  assert.deepEqual(await payments.pay('pay_1', quote), { state: 'UNKNOWN' });

  assert.equal(sent.length, 1);
  const { authorization } = decode(sent[0]!).payload;
  assert.equal(authorization.from.toLowerCase(), privateKeyToAccount(key).address.toLowerCase());
  assert.equal(authorization.value, '10000');
});

test('a signer refusal (e.g. a CDP policy violation) signs, stores and sends nothing, with no fallback', async () => {
  const store = new MemoryPaymentStore();
  store.reserve('pay_1', { amount: 10000, payee: PAYEE });
  const { transport, sent } = recordingTransport();
  let attempts = 0;
  const refusing = cdpAccountSigner({
    address: '0x432D4cEA07086049E9c2125348285A01c084Fe5B',
    signTypedData: async () => {
      attempts++;
      throw new Error('403 policy_violation');
    },
  });
  // A local key is configured too: it must never be used as a fallback for the injected signer.
  const payments = createPayments({
    store,
    transport,
    signer: refusing,
    config: { walletPrivateKey: generatePrivateKey() },
  });

  await assert.rejects(payments.pay('pay_1', quote), /policy_violation/);

  assert.equal(attempts, 1);
  assert.equal(store.called('markSigned'), 0, 'nothing stored');
  assert.equal(sent.length, 0, 'nothing sent');
  assert.equal((await store.get('pay_1'))?.state, 'RESERVED', 'the pipeline can release the hold');
});

test('createPayments refuses to start without a signer or a key', () => {
  const store = new MemoryPaymentStore();
  assert.throws(
    () => createPayments({ store, transport: recordingTransport().transport, config: {} }),
    /signer or walletPrivateKey/,
  );
});

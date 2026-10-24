// P5 · reconcile(paymentId) and startReconciler, against a fake Base Sepolia JSON-RPC endpoint.
import { afterAll as after, test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeFunctionData, parseAbi, toEventSelector, pad } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPayments, startReconciler } from './index.js';
import { systemClock } from '../clock.js';
import { MemoryPaymentStore } from './testing/memory-store.js';
import type { PaymentState } from '@apf/contracts';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYER = '0x34bed74915ca69fdd99b23e28b949d4afc89a582';
const PAYEE = '0x0d972d44bda2bc27420debd711395729480186ae';
const NONCE = '0x61612c9ae811cda47919773e7ddf1de49f969a4e61f3716a9c502f893012bbe5';
const TX = '0xbcf31d3f420dfd6006701912e015e935078a899bbd0f5bc0aeabedc0a41abb15';
const AUTHORIZATION_USED = toEventSelector(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
);
const usdcAbi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

const LATEST_BLOCK = 50_000_000n;
// Chain time of the latest block, deliberately far behind the local clock: expiry must be judged by the chain.
const NOW_S = 1_700_000_000;
const hex = (n: bigint | number) => `0x${n.toString(16)}`;

const servers: ReturnType<typeof createServer>[] = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

interface ChainState {
  nonceUsed: boolean;
  settledInBlock?: bigint; // emits AuthorizationUsed here, if set
  down?: boolean;
  chainId?: string; // defaults to Base Sepolia, 0x14a34
  finalizedLag?: bigint; // blocks between latest and finalized (1 s blocks), default 0
  usedAtFinalized?: boolean; // nonce state at the finalized block, if it differs from latest (a reorg in between)
}

// Minimal Base Sepolia: latest block, USDC.authorizationState, AuthorizationUsed logs (200-block window, like the public RPC).
async function fakeChain(state: ChainState) {
  const calls: { method: string; params: unknown[] }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(raw);
      calls.push({ method, params });
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      const error = (message: string) =>
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }));
      res.setHeader('Content-Type', 'application/json');
      if (state.down) return error('rpc down');

      switch (method) {
        case 'eth_chainId':
          return reply(state.chainId ?? '0x14a34');
        case 'eth_blockNumber':
          return reply(hex(LATEST_BLOCK));
        case 'eth_getBlockByNumber': {
          // 1 s blocks: deliberately not the 2 s a hard-coded guess would assume (real Base Sepolia is ~0.2 s).
          const [tag] = params as [string];
          const n =
            tag === 'latest'
              ? LATEST_BLOCK
              : tag === 'finalized'
                ? LATEST_BLOCK - (state.finalizedLag ?? 0n)
                : BigInt(tag);
          return reply({
            number: hex(n),
            timestamp: hex(NOW_S - Number(LATEST_BLOCK - n)),
            hash: pad('0x01'),
            parentHash: pad('0x00'),
            transactions: [],
            gasLimit: '0x0',
            gasUsed: '0x0',
            logsBloom: '0x',
            miner: PAYER,
            extraData: '0x',
          });
        }
        case 'eth_call': {
          const [{ to, data }, block] = params as [{ to: string; data: `0x${string}` }, string];
          assert.equal(to.toLowerCase(), USDC.toLowerCase(), 'asks the USDC contract');
          const { functionName } = decodeFunctionData({ abi: usdcAbi, data });
          assert.equal(functionName, 'authorizationState');
          const atFinalized =
            state.finalizedLag !== undefined && BigInt(block) === LATEST_BLOCK - state.finalizedLag;
          const used =
            atFinalized && state.usedAtFinalized !== undefined
              ? state.usedAtFinalized
              : state.nonceUsed;
          return reply(pad(used ? '0x01' : '0x00'));
        }
        case 'eth_getLogs': {
          const [{ fromBlock, toBlock, topics }] = params as [
            { fromBlock: string; toBlock: string; topics: string[] },
          ];
          if (BigInt(toBlock) - BigInt(fromBlock) + 1n > 200n)
            return error('eth_getLogs is limited to a 200 range');
          const b = state.settledInBlock;
          const inRange = b !== undefined && b >= BigInt(fromBlock) && b <= BigInt(toBlock);
          const matches = topics[0] === AUTHORIZATION_USED && topics[2]?.toLowerCase() === NONCE;
          return reply(
            inRange && matches
              ? [
                  {
                    address: USDC,
                    topics: [AUTHORIZATION_USED, pad(PAYER), NONCE],
                    data: '0x',
                    blockNumber: hex(b!),
                    blockHash: pad('0x02'),
                    transactionHash: TX,
                    transactionIndex: '0x0',
                    logIndex: '0x0',
                    removed: false,
                  },
                ]
              : [],
          );
        }
        default:
          return error(`unexpected ${method}`);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

// A payment row as pay() leaves it: nonce, expiry and the full x402 payload stored.
function seed(store: MemoryPaymentStore, id: string, state: PaymentState, validBeforeS: number) {
  store.seed({
    id,
    state,
    amount: 10_000,
    payee: PAYEE,
    nonce: NONCE,
    valid_before: validBeforeS * 1000,
    authorization_json: JSON.stringify({
      x402Version: 2,
      payload: {
        signature: '0x',
        authorization: {
          from: PAYER,
          to: PAYEE,
          value: '10000',
          validAfter: '0',
          validBefore: String(validBeforeS),
          nonce: NONCE,
        },
      },
    }),
  });
}

async function setup(chain: ChainState) {
  const store = new MemoryPaymentStore();
  const rpc = await fakeChain(chain);
  const walletPrivateKey = generatePrivateKey();
  const stuck: { paymentId: string; reason: string }[] = [];
  const payments = createPayments({
    store,
    config: {
      walletPrivateKey,
      rpcUrl: rpc.url,
      onStuck: (paymentId, reason) => stuck.push({ paymentId, reason }),
    },
  });
  return {
    store,
    rpc,
    payments,
    stuck,
    wallet: privateKeyToAccount(walletPrivateKey).address.toLowerCase(),
  };
}

for (const state of ['SUBMITTED', 'UNKNOWN'] as const) {
  test(`${state}, nonce used on-chain: SETTLED with the tx hash from AuthorizationUsed`, async () => {
    const { store, rpc, payments } = await setup({
      nonceUsed: true,
      settledInBlock: LATEST_BLOCK - 150n,
    });
    seed(store, 'pay_1', state, NOW_S + 60);

    assert.equal(await payments.reconcile('pay_1'), 'SETTLED');
    assert.equal((await store.get('pay_1'))?.state, 'SETTLED');
    assert.equal(store.rows.get('pay_1')?.tx_hash, TX);

    const call = rpc.calls.find((c) => c.method === 'eth_call')!;
    const { args } = decodeFunctionData({
      abi: usdcAbi,
      data: (call.params[0] as { data: `0x${string}` }).data,
    });
    assert.equal(
      String(args[0]).toLowerCase(),
      PAYER,
      'authorizer is the payer from the stored authorization',
    );
    assert.equal(args[1], NONCE, 'nonce is the stored one');
  });
}

test('nonce used, settlement found further back than one 200-block window', async () => {
  const { store, payments } = await setup({ nonceUsed: true, settledInBlock: LATEST_BLOCK - 700n });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S + 60);

  assert.equal(await payments.reconcile('pay_1'), 'SETTLED');
  assert.equal(store.rows.get('pay_1')?.tx_hash, TX);
});

test('nonce used long ago: the settlement block is located from the measured block time', async () => {
  // validBefore was 20,000 s (= 20,000 blocks) ago; settled 100 blocks before that.
  const { store, payments } = await setup({
    nonceUsed: true,
    settledInBlock: LATEST_BLOCK - 20_100n,
  });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S - 20_000);

  assert.equal(await payments.reconcile('pay_1'), 'SETTLED');
  assert.equal(store.rows.get('pay_1')?.tx_hash, TX);
});

test('nonce used but no AuthorizationUsed event found: SETTLED with tx hash "unknown"', async () => {
  const { store, payments } = await setup({ nonceUsed: true });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S + 60);

  assert.equal(await payments.reconcile('pay_1'), 'SETTLED');
  assert.equal(store.rows.get('pay_1')?.tx_hash, 'unknown');
});

test('nonce unused and the chain is past validBefore: FAILED (it can never settle)', async () => {
  const { store, payments } = await setup({ nonceUsed: false });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S - 1);

  assert.equal(await payments.reconcile('pay_1'), 'FAILED');
  assert.equal((await store.get('pay_1'))?.state, 'FAILED');
});

// ---------- FAILED only on finalized proof ----------

test('expired at the latest block but not yet at the finalized one: left UNKNOWN (latest can still reorg)', async () => {
  // validBefore passed 100 s ago; the finalized block is 900 s (900 blocks) behind latest, before validBefore.
  const { store, payments } = await setup({ nonceUsed: false, finalizedLag: 900n });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S - 100);

  assert.equal(await payments.reconcile('pay_1'), 'UNKNOWN');
  assert.equal(store.called('fail'), 0);
});

test('finalized block past validBefore with the nonce unused there: FAILED', async () => {
  const { store, rpc, payments } = await setup({ nonceUsed: false, finalizedLag: 900n });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S - 1000);

  assert.equal(await payments.reconcile('pay_1'), 'FAILED');
  const finalizedHex = hex(LATEST_BLOCK - 900n);
  assert.ok(
    rpc.calls.some((c) => c.method === 'eth_call' && c.params[1] === finalizedHex),
    'the deciding nonce read is made at the finalized block',
  );
});

test('reorg: latest says unused, but the settlement is in the finalized chain: SETTLED, never FAILED', async () => {
  const { store, payments } = await setup({
    nonceUsed: false,
    finalizedLag: 900n,
    usedAtFinalized: true,
  });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S - 1000);

  assert.equal(await payments.reconcile('pay_1'), 'SETTLED');
  assert.equal(store.called('fail'), 0);
});

test('nonce unused but still valid: left UNKNOWN, no transition', async () => {
  const { store, payments } = await setup({ nonceUsed: false });
  seed(store, 'pay_1', 'SUBMITTED', NOW_S + 60);

  assert.equal(await payments.reconcile('pay_1'), 'UNKNOWN');
  assert.equal((await store.get('pay_1'))?.state, 'SUBMITTED');
  assert.equal(store.called('fail') + store.called('settle'), 0);
});

test('expiry is judged by chain time, not the local clock', async () => {
  // validBefore is past by the local clock, but the chain has not reached it: the authorization can still settle.
  const { store, payments } = await setup({ nonceUsed: false });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S + 60);
  assert.ok(
    NOW_S + 60 < systemClock.now() / 1000,
    'validBefore is already past by the local clock',
  );

  assert.equal(await payments.reconcile('pay_1'), 'UNKNOWN');
  assert.equal(store.called('fail'), 0);
});

test('RPC unreachable: UNKNOWN, no transition', async () => {
  const { store, payments } = await setup({ nonceUsed: true, down: true });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S - 1000);

  assert.equal(await payments.reconcile('pay_1'), 'UNKNOWN');
  assert.equal(store.called('fail') + store.called('settle'), 0);
});

test('already SETTLED or FAILED: returned as is, chain never asked', async () => {
  const { store, rpc, payments } = await setup({ nonceUsed: false });
  seed(store, 'pay_s', 'SETTLED', NOW_S - 1000);
  seed(store, 'pay_f', 'FAILED', NOW_S - 1000);

  assert.equal(await payments.reconcile('pay_s'), 'SETTLED');
  assert.equal(await payments.reconcile('pay_f'), 'FAILED');
  assert.equal(rpc.calls.length, 0);
});

test('running the reconciler twice changes nothing the second time', async () => {
  const { store, payments } = await setup({ nonceUsed: true, settledInBlock: LATEST_BLOCK - 10n });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S + 60);

  assert.equal(await payments.reconcile('pay_1'), 'SETTLED');
  assert.equal(await payments.reconcile('pay_1'), 'SETTLED');
  assert.deepEqual(
    store.calls.filter((c) => c.method === 'settle').map((c) => c.changed),
    [true],
  );
});

// ---------- never stuck silently, never fooled by the wrong chain ----------

test('RPC on the wrong chain: chain reads are not trusted, nothing is failed', async () => {
  // e.g. BASE_SEPOLIA_RPC_URL pointing at Base mainnet: authorizationState would read false there.
  const { store, payments } = await setup({ nonceUsed: false, chainId: '0x2105' });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S - 1000);

  assert.equal(await payments.reconcile('pay_1'), 'UNKNOWN');
  assert.equal(store.called('fail') + store.called('settle'), 0);
});

test('unreadable stored authorization: falls back to our own wallet as the authorizer and still resolves', async () => {
  const { store, rpc, payments, wallet } = await setup({ nonceUsed: true });
  seed(store, 'pay_1', 'UNKNOWN', NOW_S + 60);
  store.rows.get('pay_1')!.authorization_json = 'not json';

  assert.equal(await payments.reconcile('pay_1'), 'SETTLED');
  const call = rpc.calls.find((c) => c.method === 'eth_call')!;
  const { args } = decodeFunctionData({
    abi: usdcAbi,
    data: (call.params[0] as { data: `0x${string}` }).data,
  });
  assert.equal(String(args[0]).toLowerCase(), wallet);
});

test('RPC down long past expiry: stays UNKNOWN (no proof), reported stuck once', async () => {
  const { store, payments, stuck } = await setup({ nonceUsed: false, down: true });
  seed(store, 'pay_1', 'UNKNOWN', Math.floor(systemClock.now() / 1000) - 3600); // expired an hour ago by the local clock

  assert.equal(await payments.reconcile('pay_1'), 'UNKNOWN');
  assert.equal(await payments.reconcile('pay_1'), 'UNKNOWN');
  assert.equal(store.called('fail'), 0, 'an unreadable chain is never proof of non-settlement');
  assert.deepEqual(
    stuck.map((s) => s.paymentId),
    ['pay_1'],
    'reported once, not on every pass',
  );
  assert.match(stuck[0].reason, /chain/i);
});

test('RPC down but not yet long expired: not reported stuck', async () => {
  const { store, payments, stuck } = await setup({ nonceUsed: false, down: true });
  seed(store, 'pay_1', 'UNKNOWN', Math.floor(systemClock.now() / 1000) + 60);

  assert.equal(await payments.reconcile('pay_1'), 'UNKNOWN');
  assert.equal(stuck.length, 0);
});

test('row missing its nonce: cannot be resolved from the chain, reported stuck', async () => {
  const { store, payments, stuck } = await setup({ nonceUsed: false });
  seed(store, 'pay_1', 'SUBMITTED', NOW_S - 1000);
  store.rows.get('pay_1')!.nonce = null;

  assert.equal(await payments.reconcile('pay_1'), 'UNKNOWN');
  assert.equal(store.called('fail'), 0);
  assert.deepEqual(
    stuck.map((s) => s.paymentId),
    ['pay_1'],
  );
  assert.match(stuck[0].reason, /nonce/);
});

// ---------- startReconciler ----------

test('startReconciler runs once at startup, then every interval, until stopped', async () => {
  const { store, payments } = await setup({ nonceUsed: false });
  seed(store, 'pay_a', 'SIGNED', NOW_S + 60);

  const stop = startReconciler(payments, store, 50);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    (await store.get('pay_a'))?.state,
    'FAILED',
    'startup pass runs immediately, not after the first interval',
  );

  seed(store, 'pay_b', 'SIGNED', NOW_S + 60);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await store.get('pay_b'))?.state, 'FAILED', 'picked up by a later pass');

  stop();
  await new Promise((r) => setTimeout(r, 20));
  seed(store, 'pay_c', 'SIGNED', NOW_S + 60);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await store.get('pay_c'))?.state, 'SIGNED', 'no passes after stop()');
});

test('startReconciler keeps going past a payment it cannot reconcile', async () => {
  const { store, payments } = await setup({ nonceUsed: false });
  seed(store, 'pay_bad', 'UNKNOWN', NOW_S + 60);
  store.rows.get('pay_bad')!.authorization_json = 'not json';
  seed(store, 'pay_ok', 'SIGNED', NOW_S + 60);

  const stop = startReconciler(payments, store, 1_000);
  await new Promise((r) => setTimeout(r, 50));
  stop();

  assert.equal((await store.get('pay_ok'))?.state, 'FAILED');
  assert.equal((await store.get('pay_bad'))?.state, 'UNKNOWN', 'unreadable row is left alone');
});

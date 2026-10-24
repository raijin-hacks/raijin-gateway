// P5 · reconcile(paymentId) and the reconciler loop: resolve SIGNED, SUBMITTED and UNKNOWN payments against the chain.
// USDC on Base Sepolia is EIP-3009: authorizationState(authorizer, nonce) says whether an authorization was used,
// and transferWithAuthorization reverts once block.timestamp >= validBefore. FAILED is decided only on a finalized
// block (Base Sepolia: ~16 min behind latest), since the latest block can be reorged away. Confirmed against the P2 settlement
// (tx 0xbcf31d3f…, nonce 0x61612c9a…): used = true; a random nonce = false.
import { createPublicClient, http, parseAbi, parseAbiItem, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { usdcAddress } from './quote.js';
import type { Clock } from '../clock.js';
import type { PaymentsModule, PaymentStore } from '@apf/contracts';

type Resolution = Awaited<ReturnType<PaymentsModule['reconcile']>>;

const usdcAbi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);
const authorizationUsed = parseAbiItem(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
);

const LOG_WINDOW = 200n; // the public Base Sepolia RPC rejects eth_getLogs over more than 200 blocks
const LOOKBACK_S = 15n * 60n; // search this much chain time before validBefore, then record "unknown"
const RATE_SAMPLE_BLOCKS = 1_000n; // measure block time over this many recent blocks (real Base Sepolia: ~0.2 s, not 2 s)
const MAX_LOG_QUERIES = 50; // hard cap on eth_getLogs calls per lookup
const STUCK_AFTER_MS = 30 * 60_000; // unresolved this long past validBefore (local clock, alerting only): report it.
// Longer than Base Sepolia's ~16 min finality lag, so a payment waiting for its finalized proof isn't reported.
const DEFAULT_INTERVAL_MS = 10_000;

export interface ReconcileOptions {
  rpcUrl?: string;
  wallet: `0x${string}`; // our payer address: the authorizer of every authorization we sign
  // Called once per payment that the reconciler cannot resolve on its own and that needs an operator.
  onStuck?: (paymentId: string, reason: string) => void;
  clock: Clock; // local time, used only to decide when to report a payment stuck
}

export function createReconcile(
  store: PaymentStore,
  { rpcUrl, wallet, onStuck, clock }: ReconcileOptions,
) {
  // Created on first use: payments that need no chain lookup (SIGNED, terminal states) never touch the RPC.
  let client: PublicClient | undefined;
  const chain = () =>
    (client ??= createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl || undefined),
    }) as PublicClient);
  // A wrong-network RPC would read every nonce as unused and fail payments that settled. Verify before trusting it.
  let chainVerified = false;
  const verifiedChain = async () => {
    if (!chainVerified) {
      const id = await chain().getChainId();
      if (id !== baseSepolia.id)
        throw new Error(`RPC is on chain ${id}, expected Base Sepolia (${baseSepolia.id})`);
      chainVerified = true;
    }
    return chain();
  };

  // Unresolved is the safe outcome when there is no proof either way, but it must not be silent.
  const reported = new Set<string>();
  const stuck = (paymentId: string, reason: string) => {
    if (reported.has(paymentId)) return;
    reported.add(paymentId);
    console.error(`[reconciler] STUCK ${paymentId}: ${reason}`);
    onStuck?.(paymentId, reason);
  };
  const longExpired = (validBeforeMs: number | null) =>
    validBeforeMs === null || clock.now() > validBeforeMs + STUCK_AFTER_MS;

  return async function reconcile(paymentId: string): Promise<Resolution> {
    const row = await store.get(paymentId);
    if (!row) throw new Error(`payment ${paymentId} not found`);

    switch (row.state) {
      case 'SETTLED':
      case 'FAILED':
        return row.state;
      case 'RESERVED':
        return 'UNKNOWN'; // not signed yet: nothing to reconcile
      case 'SIGNED':
        // Never sent, so it can't settle. If pay() is mid-flight, its markSubmitted now fails and it sends nothing.
        await store.fail(paymentId);
        return currentState(paymentId);
    }

    // SUBMITTED or UNKNOWN: the merchant may hold the authorization. Only the chain can say what happened.
    if (!row.nonce) {
      stuck(
        paymentId,
        `${row.state} with no stored nonce: the chain cannot be asked, needs an operator`,
      );
      return 'UNKNOWN';
    }
    const nonce = row.nonce as `0x${string}`;
    // The authorizer is the payer that signed. Prefer the stored one; we only ever sign as our own wallet.
    let authorizer: `0x${string}` = wallet;
    try {
      authorizer = JSON.parse(row.authorization_json ?? '').payload.authorization.from ?? wallet;
    } catch (err) {
      console.warn(
        `[reconciler] ${paymentId}: stored authorization is unreadable, using our wallet as authorizer: ${describe(err)}`,
      );
    }

    // Read the nonce at a known block, and judge expiry by that block's timestamp, not the local clock.
    let blockNumber: bigint;
    let blockTimestampS: bigint;
    let used: boolean;
    try {
      const block = await (await verifiedChain()).getBlock({ blockTag: 'latest' });
      blockNumber = block.number;
      blockTimestampS = block.timestamp;
      used = await nonceUsedAt(authorizer, nonce, blockNumber);
    } catch (err) {
      // No proof either way: never fail on an unreadable chain, the merchant may have settled.
      console.warn(
        `[reconciler] ${paymentId}: chain lookup failed, leaving ${row.state}: ${describe(err)}`,
      );
      if (longExpired(row.valid_before))
        stuck(paymentId, `chain unreadable long past validBefore: ${describe(err)}`);
      return 'UNKNOWN';
    }

    // Used at the latest block: settle. If that block is later reorged away we have counted the budget as spent
    // early, which is conservative; the authorization stays valid and is normally re-included.
    if (used)
      return settleFromChain(
        paymentId,
        row.valid_before,
        authorizer,
        nonce,
        blockNumber,
        blockTimestampS,
      );

    if (row.valid_before === null) {
      stuck(
        paymentId,
        `${row.state}, nonce unused, but no stored validBefore: expiry cannot be proven`,
      );
      return 'UNKNOWN';
    }
    if (blockTimestampS * 1000n < BigInt(row.valid_before)) return 'UNKNOWN'; // still valid: the merchant could still settle it

    // Expired and unused at the latest block. That is not yet proof: the latest block can be reorged away, and the
    // canonical chain may hold a settlement before validBefore. Only a finalized block cannot change, so decide there.
    let finalizedNumber: bigint;
    let finalizedTimestampS: bigint;
    let usedAtFinalized: boolean;
    try {
      const finalized = await chain().getBlock({ blockTag: 'finalized' });
      finalizedNumber = finalized.number;
      finalizedTimestampS = finalized.timestamp;
      usedAtFinalized = await nonceUsedAt(authorizer, nonce, finalizedNumber);
    } catch (err) {
      console.warn(
        `[reconciler] ${paymentId}: finalized lookup failed, leaving ${row.state}: ${describe(err)}`,
      );
      if (longExpired(row.valid_before))
        stuck(paymentId, `finalized block unreadable long past validBefore: ${describe(err)}`);
      return 'UNKNOWN';
    }
    if (usedAtFinalized) {
      return settleFromChain(
        paymentId,
        row.valid_before,
        authorizer,
        nonce,
        finalizedNumber,
        finalizedTimestampS,
      );
    }
    // Unused at a finalized block at or past validBefore: USDC rejects it from here on, on a chain that can't change.
    if (finalizedTimestampS * 1000n >= BigInt(row.valid_before)) {
      await store.fail(paymentId);
      return currentState(paymentId);
    }
    return 'UNKNOWN'; // expired at the head, not yet at the finalized block: wait for finality
  };

  function nonceUsedAt(
    authorizer: `0x${string}`,
    nonce: `0x${string}`,
    blockNumber: bigint,
  ): Promise<boolean> {
    return chain().readContract({
      address: usdcAddress() as `0x${string}`,
      abi: usdcAbi,
      functionName: 'authorizationState',
      args: [authorizer, nonce],
      blockNumber,
    });
  }

  async function settleFromChain(
    paymentId: string,
    validBeforeMs: number | null,
    authorizer: `0x${string}`,
    nonce: `0x${string}`,
    atBlock: bigint,
    atTimestampS: bigint,
  ): Promise<Resolution> {
    const validBeforeS =
      validBeforeMs === null ? atTimestampS : BigInt(Math.floor(validBeforeMs / 1000));
    const txHash =
      (await findSettlementTx(authorizer, nonce, atBlock, atTimestampS, validBeforeS)) ?? 'unknown';
    await store.settle(paymentId, txHash);
    return currentState(paymentId);
  }

  // Looks up the AuthorizationUsed event backwards from about validBefore, in RPC-sized windows.
  // Block time is measured from the chain, never assumed: a wrong guess silently searches the wrong blocks.
  async function findSettlementTx(
    authorizer: `0x${string}`,
    nonce: `0x${string}`,
    latest: bigint,
    latestTimestampS: bigint,
    validBeforeS: bigint,
  ): Promise<string | null> {
    try {
      const sampleFrom = latest > RATE_SAMPLE_BLOCKS ? latest - RATE_SAMPLE_BLOCKS : 0n;
      const sample = await chain().getBlock({ blockNumber: sampleFrom });
      const spanS = latestTimestampS - sample.timestamp;
      const spanBlocks = latest - sampleFrom;
      if (spanS <= 0n || spanBlocks <= 0n) return null;
      const blocksFor = (seconds: bigint) => (seconds * spanBlocks) / spanS; // seconds of chain time -> blocks

      // Settlement happened before validBefore: start just past its estimated block, with a margin either way.
      const secondsSince = latestTimestampS > validBeforeS ? latestTimestampS - validBeforeS : 0n;
      const margin = blocksFor(60n) + LOG_WINDOW;
      let to = latest - blocksFor(secondsSince) + margin;
      if (to > latest) to = latest;
      const span = blocksFor(LOOKBACK_S) + 2n * margin;
      const stop = to > span ? to - span : 0n;

      for (let queries = 0; to > stop && queries < MAX_LOG_QUERIES; queries++) {
        const from = to - LOG_WINDOW + 1n > stop ? to - LOG_WINDOW + 1n : stop;
        const logs = await chain().getLogs({
          address: usdcAddress() as `0x${string}`,
          event: authorizationUsed,
          args: { authorizer, nonce },
          fromBlock: from,
          toBlock: to,
        });
        if (logs[0]?.transactionHash) return logs[0].transactionHash;
        to = from - 1n;
      }
    } catch (err) {
      console.warn(
        `[reconciler] AuthorizationUsed lookup failed, recording tx "unknown": ${describe(err)}`,
      );
      return null;
    }
    console.warn(
      `[reconciler] no AuthorizationUsed event found near validBefore, recording tx "unknown"`,
    );
    return null;
  }

  async function currentState(paymentId: string): Promise<Resolution> {
    const state = (await store.get(paymentId))?.state;
    return state === 'SETTLED' || state === 'FAILED' ? state : 'UNKNOWN';
  }
}

// Runs once now, then every intervalMs after the previous pass finishes (passes never overlap). Returns stop().
export function startReconciler(
  payments: PaymentsModule,
  store: PaymentStore,
  intervalMs = DEFAULT_INTERVAL_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pass = async () => {
    let ids: string[];
    try {
      ids = await store.listUnresolved();
    } catch (err) {
      console.error(`[reconciler] listUnresolved failed: ${describe(err)}`);
      return;
    }
    for (const id of ids) {
      if (stopped) return;
      try {
        await payments.reconcile(id);
      } catch (err) {
        console.error(`[reconciler] ${id}: ${describe(err)}`);
      }
    }
  };

  const loop = async () => {
    await pass();
    if (stopped) return;
    timer = setTimeout(loop, intervalMs);
    timer.unref?.();
  };
  void loop();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}

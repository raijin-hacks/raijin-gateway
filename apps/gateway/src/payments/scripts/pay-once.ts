// Throwaway (P2): pays PriceScope once with @x402/fetch and prints the settlement tx hash.
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const key = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) {
  console.error('WALLET_PRIVATE_KEY is not set. Run `pnpm payments:wallets` first.');
  process.exit(1);
}

const url = process.argv[2] || 'http://localhost:4101/v1/pricing/acme?period=30d';
const account = privateKeyToAccount(key);
const client = new x402Client().register('eip155:*', new ExactEvmScheme(account));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log(`payer ${account.address.toLowerCase()} -> GET ${url}`);
const res = await fetchWithPayment(url);
const body = await res.text();
console.log(`status ${res.status}`);
console.log(body);

if (!res.ok) {
  // A 402 after paying carries the rejection reason (e.g. insufficient_funds) in PAYMENT-REQUIRED.
  const required = res.headers.get('PAYMENT-REQUIRED');
  if (required) console.error(`rejected: ${JSON.parse(Buffer.from(required, 'base64').toString()).error}`);
  // A 402 after verify passed means settlement failed; the reason is in PAYMENT-RESPONSE.
  const settleHeader = res.headers.get('PAYMENT-RESPONSE');
  if (settleHeader) console.error(`settlement failed: ${Buffer.from(settleHeader, 'base64').toString()}`);
  process.exit(1);
}

const settle = new x402HTTPClient(client).getPaymentSettleResponse((name) => res.headers.get(name));
console.log(`settlement ${JSON.stringify(settle)}`);
if (!settle?.transaction) {
  console.error('No transaction hash in the settlement header.');
  process.exit(1);
}
console.log(`tx ${settle.transaction}`);
console.log(`https://sepolia.basescan.org/tx/${settle.transaction}`);

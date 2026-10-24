// Chunk 1 CDP feasibility spike: does an attached CDP account policy actually refuse the
// EIP-3009 typed-data signatures we must not produce? Prints redacted results only: no
// credentials, and signatures are shortened. Throwaway evidence tool, not a payment path.
import { randomBytes } from 'node:crypto';
import { CdpClient } from '@coinbase/cdp-sdk';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { systemClock } from '../../clock.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYEE = '0x0d972d44bda2bc27420debd711395729480186ae'; // PriceScope
const ATTACKER = '0xca7c3c3ac945e0febcebae02de1fbe847bcd4d19';
const OTHER_TOKEN = '0x1111111111111111111111111111111111111111';
const MAX = 10000n;

const transferTypes = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

// Runtime credentials (CDP_API_KEY_ID/SECRET + CDP_WALLET_SECRET) only sign. Policy administration
// uses a separate key (CDP_ADMIN_API_KEY_ID/SECRET), so the runtime can't loosen its own policy.
const cdp = new CdpClient();
const admin = new CdpClient({
  apiKeyId: process.env.CDP_ADMIN_API_KEY_ID,
  apiKeySecret: process.env.CDP_ADMIN_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
});
const account = await cdp.evm.getOrCreateAccount({ name: 'apf-spike-payer' });
console.log('account', account.address);

const policy = await admin.policies.createPolicy({
  policy: {
    scope: 'account',
    description: 'APF spike, USDC transfer to PriceScope, max 10000', // [A-Za-z0-9 ,.]{1,50}
    rules: [
      {
        action: 'accept',
        operation: 'signEvmTypedData',
        criteria: [
          { type: 'evmTypedDataVerifyingContract', addresses: [USDC], operator: 'in' },
          {
            type: 'evmTypedDataField',
            types: {
              types: { TransferWithAuthorization: transferTypes.TransferWithAuthorization },
              primaryType: 'TransferWithAuthorization',
            },
            conditions: [
              { addresses: [PAYEE], operator: 'in', path: 'to' },
              { value: MAX.toString(), operator: '<=', path: 'value' },
            ],
          },
        ],
      },
    ],
  },
});
await admin.evm.updateAccount({ address: account.address, update: { accountPolicy: policy.id } });
console.log('policy', policy.id, 'attached to account by the admin key');

function transfer(overrides: { to?: string; value?: bigint; contract?: string } = {}) {
  return {
    domain: {
      name: 'USDC',
      version: '2',
      chainId: 84532,
      verifyingContract: (overrides.contract ?? USDC) as `0x${string}`,
    },
    types: transferTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: overrides.to ?? PAYEE,
      value: (overrides.value ?? MAX).toString(),
      validAfter: '0',
      validBefore: String(Math.floor(systemClock.now() / 1000) + 300),
      nonce: `0x${randomBytes(32).toString('hex')}`,
    },
  } as const;
}

const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-6)}`;
const results: { probe: string; expected: string; outcome: string; detail: string }[] = [];
async function probe(name: string, expected: 'allowed' | 'refused', run: () => Promise<string>) {
  try {
    const signature = await run();
    results.push({ probe: name, expected, outcome: 'signed', detail: short(signature) });
    return signature;
  } catch (err) {
    const e = err as {
      statusCode?: number;
      errorType?: string;
      errorMessage?: string;
      message?: string;
    };
    const detail =
      `${e.statusCode ?? ''} ${e.errorType ?? ''} ${e.errorMessage ?? e.message ?? String(err)}`.trim();
    results.push({ probe: name, expected, outcome: 'refused', detail: detail.slice(0, 160) });
    return null;
  }
}

const allowed = transfer();
const sig = await probe(
  'allowed: 10000 to PriceScope, USDC',
  'allowed',
  async () => (await cdp.evm.signTypedData({ address: account.address, ...allowed })).signature,
);
if (sig) {
  const signer = await recoverTypedDataAddress({
    ...allowed,
    signature: sig as `0x${string}`,
  } as never);
  console.log(
    'allowed signature recovers to account:',
    signer.toLowerCase() === account.address.toLowerCase(),
  );
}
for (const [name, data] of [
  ['amount over cap (10001)', transfer({ value: MAX + 1n })],
  ['payee not PriceScope (attacker)', transfer({ to: ATTACKER })],
  ['different token contract', transfer({ contract: OTHER_TOKEN })],
] as const) {
  await probe(
    name,
    'refused',
    async () => (await cdp.evm.signTypedData({ address: account.address, ...data })).signature,
  );
}
await probe(
  'different primaryType (Permit)',
  'refused',
  async () =>
    (
      await cdp.evm.signTypedData({
        address: account.address,
        domain: allowed.domain,
        types: {
          EIP712Domain: transferTypes.EIP712Domain,
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: {
          owner: account.address,
          spender: ATTACKER,
          value: '1000000000',
          nonce: '0',
          deadline: '9999999999',
        },
      })
    ).signature,
);
// Alternate routes: the same over-cap authorization signed as a raw hash, and a plain message.
const overCapHash = hashTypedData(transfer({ value: 1_000_000n }) as never);
await probe(
  'alternate route: signHash of an over-cap transfer',
  'refused',
  async () => (await cdp.evm.signHash({ address: account.address, hash: overCapHash })).signature,
);
await probe(
  'alternate route: signMessage',
  'refused',
  async () =>
    (await cdp.evm.signMessage({ address: account.address, message: 'apf spike' })).signature,
);

// Separation check: the runtime key must not be able to replace or loosen the policy.
await probe('runtime key edits policies (separation)', 'refused', async () => {
  await cdp.policies.updatePolicy({
    id: policy.id,
    policy: { description: 'loosened by runtime', rules: [] },
  });
  return 'policy updated';
});
await probe('runtime key detaches the account policy (separation)', 'refused', async () => {
  await cdp.evm.updateAccount({ address: account.address, update: { accountPolicy: '' } });
  return 'policy detached';
});

console.table(results);
console.log(JSON.stringify({ account: account.address, policy: policy.id, results }, null, 2));

// Who signs payment authorizations. pay() only ever asks for EIP-712 typed data (EIP-3009
// TransferWithAuthorization); the signer never sees HTTP or plan details.
//   local: a testnet private key held by the gateway (WALLET_PRIVATE_KEY).
//   cdp:   a CDP server account. CDP enforces the account's attached policy on every signature
//          (payee, amount, token, type), independently of this gateway's own checks.
import { CdpClient } from '@coinbase/cdp-sdk';
import { privateKeyToAccount } from 'viem/accounts';

export interface TypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface PaymentSigner {
  readonly kind: 'local' | 'cdp';
  readonly address: `0x${string}`;
  signTypedData(request: TypedDataRequest): Promise<`0x${string}`>;
}

export function localSigner(walletPrivateKey: `0x${string}`): PaymentSigner {
  const account = privateKeyToAccount(walletPrivateKey);
  return {
    kind: 'local',
    address: account.address,
    signTypedData: (request) => account.signTypedData(request as never),
  };
}

// The order EIP-712 defines for domain fields; CDP wants the domain's own type listed.
const DOMAIN_FIELDS: [string, string][] = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
];

export interface CdpSignerOptions {
  address: `0x${string}`; // pinned: the gateway signs only as this CDP account
  timeoutMs?: number;
}

// Uses the runtime CDP credentials from the environment (CDP_API_KEY_ID, CDP_API_KEY_SECRET,
// CDP_WALLET_SECRET). The SDK keeps one HTTP client per process and the last CdpClient constructed
// wins, so the gateway must never construct another CdpClient (in particular not the policy-admin
// one). If CDP refuses or times out, signing fails: there is no fallback to WALLET_PRIVATE_KEY.
export async function createCdpSigner({
  address,
  timeoutMs = 10_000,
}: CdpSignerOptions): Promise<PaymentSigner> {
  const cdp = new CdpClient();
  const account = await cdp.evm.getAccount({ address });
  if (account.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`CDP returned account ${account.address}, expected ${address}`);
  }
  return cdpAccountSigner(account, timeoutMs);
}

// The adapter on its own, so it can be tested without CDP: adds the EIP712Domain type CDP expects
// and bounds how long a signature may take. Any failure (policy refusal, timeout) is thrown as is.
export function cdpAccountSigner(
  account: {
    address: `0x${string}`;
    signTypedData(request: TypedDataRequest): Promise<`0x${string}`>;
  },
  timeoutMs = 10_000,
): PaymentSigner {
  return {
    kind: 'cdp',
    address: account.address,
    async signTypedData(request) {
      const types = { ...request.types };
      if (!('EIP712Domain' in types)) {
        types.EIP712Domain = DOMAIN_FIELDS.filter(
          ([name]) => request.domain[name] !== undefined,
        ).map(([name, type]) => ({ name, type }));
      }
      // A signature CDP produces after we stop waiting is never stored or sent, so it can't be spent.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`CDP signing timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([account.signTypedData({ ...request, types } as never), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

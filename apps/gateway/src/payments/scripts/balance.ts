// Prints the payer's USDC (and ETH) balance on Base Sepolia.
import { createPublicClient, erc20Abi, formatEther, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// Circle's test USDC on Base Sepolia.
const DEFAULT_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const key = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) {
  console.error('WALLET_PRIVATE_KEY is not set. Run `pnpm payments:wallets` first.');
  process.exit(1);
}

const payer = privateKeyToAccount(key).address;
const usdc = (process.env.USDC_ADDRESS || DEFAULT_USDC) as `0x${string}`;
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL || undefined),
});

const [usdcBalance, decimals, symbol, ethBalance] = await Promise.all([
  client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [payer] }),
  client.readContract({ address: usdc, abi: erc20Abi, functionName: 'decimals' }),
  client.readContract({ address: usdc, abi: erc20Abi, functionName: 'symbol' }),
  client.getBalance({ address: payer }),
]);

console.log(`payer   ${payer.toLowerCase()}`);
console.log(`network eip155:${baseSepolia.id}`);
console.log(
  `${symbol}    ${usdcBalance} atomic (${formatUnits(usdcBalance, decimals)} ${symbol}) at ${usdc}`,
);
console.log(`ETH     ${formatEther(ethBalance)}`);

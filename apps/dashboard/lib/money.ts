// Converts integer atomic USDC (1 USDC = 1,000,000) to a display string, e.g. 10000 -> "$0.010".
export function formatMoney(atomic: number): string {
  return "$" + (atomic / 1000000).toFixed(3);
}
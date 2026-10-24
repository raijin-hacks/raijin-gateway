// Copied from contracts §5 until packages/contracts exists.
// TODO: import from @apf/contracts and delete this file.
export type Money = number; // atomic USDC units, integer
export type Address = `0x${string}`; // lowercase
export type HttpMethod = 'GET' | 'POST';
export type QuoteCode = 'QUOTE_FAILED' | 'NOT_402' | 'QUOTE_INVALID';

export interface Quote {
  url: string; // canonical
  method: HttpMethod;
  network: string; // must be 'eip155:84532'
  payee: Address;
  amount: Money;
  raw: unknown; // x402 payment requirements, passed back to pay() unchanged
}

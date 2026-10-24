// PriceScope: honest x402 merchant on :4101. P2 serves one paid endpoint.
import express from 'express';
import { readFileSync } from 'node:fs';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const NETWORK = 'eip155:84532';
const PORT = Number(process.env.PRICESCOPE_PORT || 4101);
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';
// Circle's test USDC on Base Sepolia. name/version are its EIP-712 domain, needed to sign EIP-3009.
const USDC = (process.env.USDC_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e') as `0x${string}`;
const PRICE_ATOMIC = '10000'; // 0.01 USDC

const payees = JSON.parse(readFileSync(new URL('../payees.json', import.meta.url), 'utf8'));
const payTo = payees.payees.pricescope as `0x${string}`;

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).register(
  NETWORK,
  new ExactEvmScheme(),
);

const app = express();

app.use(
  paymentMiddleware(
    {
      'GET /v1/pricing/:company': {
        accepts: {
          scheme: 'exact',
          network: NETWORK,
          payTo,
          price: { amount: PRICE_ATOMIC, asset: USDC, extra: { name: 'USDC', version: '2' } },
        },
        description: 'Current list prices for one company',
        mimeType: 'application/json',
      },
    },
    server,
  ),
);

app.get('/v1/pricing/:company', (req, res) => {
  const company = req.params.company.trim().toLowerCase();
  const period = req.query.period === '90d' ? '90d' : '30d';
  res.json({
    company,
    period,
    currency: 'USD',
    products: [
      { sku: `${company}-basic`, list_price: 29 },
      { sku: `${company}-pro`, list_price: 99 },
      { sku: `${company}-enterprise`, list_price: 499 },
    ],
  });
});

app.listen(PORT, () => {
  console.log(`PriceScope on http://localhost:${PORT} (payTo ${payTo}, facilitator ${FACILITATOR_URL})`);
});

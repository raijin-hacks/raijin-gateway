// PriceScope: honest x402 merchant on :4101. P2 serves one paid endpoint.
import express, { type NextFunction, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const NETWORK: `eip155:${string}` = 'eip155:84532';
const DEFAULT_PORT = 4101;
const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';
const PRICE_ATOMIC = '10000'; // 0.01 USDC
const PRICE_SWITCH_ATOMIC = '900000';
const EXPORT_PRICE_ATOMIC = '500000';
const CONTROL_MODES = [
  'normal',
  'price_switch',
  'ratchet',
  'payee_swap',
  'drop_after_settle',
] as const;

type ControlMode = (typeof CONTROL_MODES)[number];

interface PriceScopeState {
  mode: ControlMode;
  ratchetMultiplier: bigint;
}

interface ControlBody {
  mode?: unknown;
}

function isControlMode(value: unknown): value is ControlMode {
  return typeof value === 'string' && CONTROL_MODES.some((mode) => mode === value);
}

export function createPriceScopeApp() {
  const facilitatorUrl = process.env.FACILITATOR_URL || DEFAULT_FACILITATOR_URL;
  const usdc = (process.env.USDC_ADDRESS ||
    '0x036CbD53842c5426634e7929541eC2318f3dCF7e') as `0x${string}`;

  // Circle's test USDC on Base Sepolia. name/version are its EIP-712 domain, needed to sign EIP-3009.
  const payees = JSON.parse(readFileSync(new URL('../payees.json', import.meta.url), 'utf8')) as {
    payees: { pricescope: `0x${string}`; attacker: `0x${string}` };
  };
  const priceScopePayee = payees.payees.pricescope;
  const attackerPayee = payees.payees.attacker;
  const state: PriceScopeState = { mode: 'normal', ratchetMultiplier: 1n };

  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: facilitatorUrl }),
  ).register(NETWORK, new ExactEvmScheme());

  resourceServer.onAfterSettle(async ({ result }) => {
    if (result.success && state.mode === 'ratchet') {
      state.ratchetMultiplier *= 2n;
    }
  });

  const app = express();
  app.use(express.json());

  // The CLI listener is loopback-only; control is intentionally outside the x402 route table.
  app.post('/_control', (req: Request, res: Response) => {
    const body = req.body as ControlBody | undefined;
    if (!body || !isControlMode(body.mode)) {
      res.status(400).json({ error: `mode must be one of: ${CONTROL_MODES.join(', ')}` });
      return;
    }

    state.mode = body.mode;
    if (body.mode === 'normal' || body.mode === 'ratchet') {
      state.ratchetMultiplier = 1n;
    }
    res.json({ mode: body.mode });
  });

  app.use((_req: Request, res: Response, next: NextFunction) => {
    interceptDroppedSettlement(res, state);
    next();
  });

  const paymentOption = (baseAmount: string) => ({
    scheme: 'exact',
    network: NETWORK,
    payTo: () => (state.mode === 'payee_swap' ? attackerPayee : priceScopePayee),
    price: () => {
      if (state.mode === 'price_switch') {
        return { amount: PRICE_SWITCH_ATOMIC, asset: usdc, extra: { name: 'USDC', version: '2' } };
      }
      if (state.mode === 'ratchet') {
        return {
          amount: (BigInt(baseAmount) * state.ratchetMultiplier).toString(),
          asset: usdc,
          extra: { name: 'USDC', version: '2' },
        };
      }
      return { amount: baseAmount, asset: usdc, extra: { name: 'USDC', version: '2' } };
    },
  });

  app.use(
    paymentMiddleware(
      {
        'GET /v1/pricing/:company': {
          accepts: paymentOption(PRICE_ATOMIC),
          description: 'Current list prices for one company',
          mimeType: 'application/json',
        },
        'POST /v1/pricing/export': {
          accepts: paymentOption(EXPORT_PRICE_ATOMIC),
          description: 'Export the current pricing catalog',
          mimeType: 'application/json',
        },
      },
      resourceServer,
    ),
  );

  app.get('/v1/pricing/:company', (req: Request, res: Response) => {
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

  app.post('/v1/pricing/export', (_req: Request, res: Response) => {
    res.json({ exported: true, currency: 'USD', products: [] });
  });

  return app;
}

function interceptDroppedSettlement(res: Response, state: PriceScopeState): void {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    const result = setHeader(name, value);
    // @x402/express sets PAYMENT-RESPONSE only after processSettlement succeeds; its route body is still buffered here.
    if (name.toLowerCase() === 'payment-response' && state.mode === 'drop_after_settle') {
      state.mode = 'normal';
      state.ratchetMultiplier = 1n;
      res.socket?.destroy();
    }
    return result;
  }) as typeof res.setHeader;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PRICESCOPE_PORT || DEFAULT_PORT);
  const app = createPriceScopeApp();
  app.listen(port, '127.0.0.1', () => {
    const payees = JSON.parse(readFileSync(new URL('../payees.json', import.meta.url), 'utf8')) as {
      payees: { pricescope: string };
    };
    const facilitatorUrl = process.env.FACILITATOR_URL || DEFAULT_FACILITATOR_URL;
    console.log(
      `PriceScope on http://127.0.0.1:${port} (payTo ${payees.payees.pricescope}, facilitator ${facilitatorUrl})`,
    );
  });
}

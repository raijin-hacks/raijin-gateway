import { connection } from 'next/server';
import { callGateway, isMock } from '../../../lib/gateway';

// GET /catalog from the gateway, or fixed merchants when MOCK=1.
export async function GET() {
  await connection(); // always run at request time, never prerender

  if (!isMock()) return callGateway('/catalog');
  return Response.json({
    merchants: [
      { id: 'mer_pricing', name: 'PriceScope', category: 'market data' },
      { id: 'mer_weather', name: 'SkyData', category: 'weather' },
      { id: 'mer_news', name: 'NewsWire', category: 'news' },
    ],
  });
}

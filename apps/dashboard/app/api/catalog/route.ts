// MOCK: later this calls the gateway's GET /catalog with ADMIN_TOKEN.
export async function GET() {
  return Response.json({
    merchants: [
      { id: "mer_pricing", name: "PriceScope", category: "market data" },
      { id: "mer_weather", name: "SkyData", category: "weather" },
      { id: "mer_news", name: "NewsWire", category: "news" },
    ],
  });
}
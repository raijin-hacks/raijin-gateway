// MOCK: shape proposed to Chunk 2 (GET /agents). Not in contracts yet.
export async function GET() {
  return Response.json([
    { id: 'agt_research', name: 'Research agent', role: 'research' },
    { id: 'agt_logistics', name: 'Logistics agent', role: 'research' },
    { id: 'agt_briefing', name: 'Briefing agent', role: 'research' },
  ]);
}

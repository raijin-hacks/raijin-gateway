// Decisions known to have waited for a human, shared between the approval queue (which loads them
// from the gateway's pending list) and the decision feed (which marks their final rows). Lets the
// feed mark a decision even when it went pending before this page loaded.
const reviewed = new Set<string>();

export function markReviewed(decisionId: string) {
  reviewed.add(decisionId);
}

export function wasReviewed(decisionId: string): boolean {
  return reviewed.has(decisionId);
}

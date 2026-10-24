// Chunk 2-owned. Pure pre-network secret detector; inspect decoded URL facts once.
export function containsSecret(value: string): boolean {
  if (
    /sk-|sk_live_|ghp_|xox[abp]-|AKIA[0-9A-Z]{16}|eyJ|[\w.+-]+@[\w.-]+\.[a-z]{2,}|[0-9a-f]{32,}/i.test(
      value,
    )
  )
    return true;
  return (value.match(/[A-Za-z0-9_+/=-]{24,}/g) ?? []).some((token) => {
    const counts = new Map<string, number>();
    for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / token.length;
      entropy -= p * Math.log2(p);
    }
    return entropy > 3.5;
  });
}

export function urlSecretFacts(canonical: { path: string; query: [string, string][] }): string {
  return [...canonical.path.split('/'), ...canonical.query.flat()].join('\0');
}

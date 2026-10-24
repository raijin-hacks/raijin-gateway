// Reads examples and tables straight from final_contracts.md, so the package fails its
// tests when the document and the code drift apart.
import { readFileSync } from 'node:fs';

export const CONTRACTS_DOC = readFileSync(
  new URL('../../../final_contracts.md', import.meta.url),
  'utf8',
);

/** Parses the first ```json block that follows the line `heading`. */
export function jsonExampleAfter(heading: string): unknown {
  const start = CONTRACTS_DOC.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`Heading not found in final_contracts.md: ${heading}`);
  const block = /```json\n([\s\S]*?)\n```/.exec(CONTRACTS_DOC.slice(start))?.[1];
  if (block === undefined) throw new Error(`No json block after: ${heading}`);
  return JSON.parse(block);
}

/** The codes in backticks on each row of the section 2 "Reason codes" table, by row label. */
export function reasonCodeTable(): Map<string, string[]> {
  const start = CONTRACTS_DOC.indexOf('\n### Reason codes\n');
  if (start < 0) throw new Error('Reason codes table not found in final_contracts.md');
  const rows = new Map<string, string[]>();
  const lines = CONTRACTS_DOC.slice(start).split('\n').slice(2);
  for (const line of lines.slice(lines.findIndex((l) => l.startsWith('|')) + 2)) {
    if (!line.startsWith('|')) break;
    const [label = '', codes = ''] = line.split('|').slice(1, 3);
    rows.set(label.trim(), backticked(codes));
  }
  return rows;
}

/** The codes listed in the sentence "Which pre-contact and Tier 0 codes escalate ...". */
export function escalatingCodes(): string[] {
  const line = CONTRACTS_DOC.split('\n').find((l) =>
    l.startsWith('Which pre-contact and Tier 0 codes escalate'),
  );
  if (line === undefined) throw new Error('Escalation sentence not found in final_contracts.md');
  return backticked(line);
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([A-Z0-9_]+)`/g)].map((m) => m[1] ?? '');
}

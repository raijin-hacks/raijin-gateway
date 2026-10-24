// Reads examples, tables and numbers straight from the repo's design documents, so the package
// fails its tests when a document and the code drift apart.
import { readFileSync } from 'node:fs';

const readDoc = (name: string) =>
  readFileSync(new URL(`../../../design-docs/${name}`, import.meta.url), 'utf8');

export const CONTRACTS_DOC = readDoc('final_contracts.md');
export const DESIGN_DOC = readDoc('Design.md');
export const CHUNK2_DOC = readDoc('CHUNK-2-GATEWAY.md');

/** Parses the first ```json block that follows the line `heading` in final_contracts.md. */
export function jsonExampleAfter(heading: string): unknown {
  const start = CONTRACTS_DOC.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`Heading not found in final_contracts.md: ${heading}`);
  const block = /```json\n([\s\S]*?)\n```/.exec(CONTRACTS_DOC.slice(start))?.[1];
  if (block === undefined) throw new Error(`No json block after: ${heading}`);
  return JSON.parse(block);
}

/** The cells of every markdown table row in `text`, trimmed. */
function tableRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

/** The cells of the first table row in `doc` whose first cell is exactly `label`. */
export function tableRow(doc: string, label: string): string[] {
  const row = tableRows(doc).find((cells) => cells[0] === label);
  if (!row) throw new Error(`No table row labelled ${label}`);
  return row;
}

/** Every `backticked` span in `text`. */
export function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
}

/** Every number in `text`, reading U+2212 as a minus sign and 1_000_000 as one number. */
export function numbersIn(text: string): number[] {
  const normalized = text.replace(/−/g, '-').replace(/(\d)_(?=\d)/g, '$1');
  return [...normalized.matchAll(/[-+]?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

/** The first capture group of `pattern` in `doc`, as a number. */
export function captured(doc: string, pattern: RegExp): number {
  const value = pattern.exec(doc)?.[1];
  if (value === undefined) throw new Error(`Pattern not found: ${pattern}`);
  return Number(value.replace(/_/g, ''));
}

/** The codes on each row of the section 2 "Reason codes" table, by row label. */
export function reasonCodeTable(): Map<string, string[]> {
  const start = CONTRACTS_DOC.indexOf('\n### Reason codes\n');
  if (start < 0) throw new Error('Reason codes table not found in final_contracts.md');
  const end = CONTRACTS_DOC.indexOf('\n\n', CONTRACTS_DOC.indexOf('|', start));
  const rows = tableRows(CONTRACTS_DOC.slice(start, end)).slice(2); // skip header and divider
  return new Map(rows.map(([label = '', codes = '']) => [label, backticked(codes)]));
}

/** The codes listed in the sentence "Which pre-contact and Tier 0 codes escalate ...". */
export function escalatingCodes(): string[] {
  const line = CONTRACTS_DOC.split('\n').find((l) =>
    l.startsWith('Which pre-contact and Tier 0 codes escalate'),
  );
  if (line === undefined) throw new Error('Escalation sentence not found in final_contracts.md');
  return backticked(line);
}

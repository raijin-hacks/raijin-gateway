import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CONTRACTS_VERSION } from '../src/index.js';

it('matches the version line in final_contracts.md', () => {
  const doc = readFileSync(
    new URL('../../../design-docs/final_contracts.md', import.meta.url),
    'utf8',
  );
  expect(doc.split('\n', 1)[0]).toBe(`# Agent Payment Firewall: Contracts v${CONTRACTS_VERSION}`);
});

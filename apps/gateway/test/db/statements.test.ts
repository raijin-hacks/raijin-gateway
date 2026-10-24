import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CONTRACT_SQL } from '../../src/db/statements.js';

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const DOC = squash(
  readFileSync(new URL('../../../../design-docs/final_contracts.md', import.meta.url), 'utf8'),
);

it.each(Object.entries(CONTRACT_SQL))('%s is copied verbatim from final_contracts.md', (_, sql) => {
  expect(DOC).toContain(`${squash(sql)};`);
});

import { expect, it } from 'vitest';
import { createCategoryBaseline } from './baseline.js';
import { loadSuite } from './fixtures.js';
import { runCase } from './runner.js';
it('compares a fixed merchant/operation policy through the same gateway', async () => {
  const suite = loadSuite();
  const judge = createCategoryBaseline();
  expect(
    (
      await runCase(
        suite.core.find((c) => c.id === 'M1')!,
        judge,
      )
    ).outcome,
  ).toBe('deny');
  expect((await runCase(suite.core[0]!, judge)).outcome).toBe('approve');
  expect(
    (
      await runCase(
        suite.variants.find((c) => c.id === 'V6')!,
        judge,
      )
    ).outcome,
  ).toBe('deny');
});

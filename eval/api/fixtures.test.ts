import { expect, it } from 'vitest';
import { loadSuite, validateSuite } from './fixtures.js';
it('validates frozen counts, unique metadata and all 17 unchanged variants', () => {
  const suite = loadSuite();
  expect(suite.core).toHaveLength(40);
  expect(suite.variants).toHaveLength(17);
  expect(suite.core.filter((c) => c.kind === 'attack').every((c) => c.canary)).toBe(true);
});
it('refuses incomplete, duplicated, unsupported and mislabeled suites', () => {
  const suite = loadSuite();
  expect(() => validateSuite(suite.core, suite.variants.slice(1))).toThrow('VARIANTS_REQUIRE');
  expect(() => validateSuite(suite.core.slice(1), suite.variants)).toThrow('CORE_REQUIRES');
  expect(() =>
    validateSuite(
      suite.core.map((c, i) => (i === 1 ? { ...c, id: suite.core[0]!.id } : c)),
      suite.variants,
    ),
  ).toThrow('DUPLICATE_CASE_ID');
  expect(() =>
    validateSuite(
      suite.core.map((c, i) => (i === 0 ? { ...c, expected: 'success' } : c)),
      suite.variants,
    ),
  ).toThrow();
  expect(() =>
    validateSuite(
      suite.core.map((c, i) =>
        i === 0 ? { ...c, merchant_mode: { '4101': 'unimplemented' } } : c,
      ),
      suite.variants,
    ),
  ).toThrow();
  expect(() =>
    validateSuite(
      suite.core.map((c, i) => (i === 0 ? { ...c, unexpected: true } : c)),
      suite.variants,
    ),
  ).toThrow();
});

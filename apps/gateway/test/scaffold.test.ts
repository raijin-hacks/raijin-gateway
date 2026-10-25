import { CONTRACTS_VERSION } from '@apf/contracts';
import { expect, it } from 'vitest';

it('resolves the contracts workspace package', () => {
  expect(CONTRACTS_VERSION).toBe('1.4');
});

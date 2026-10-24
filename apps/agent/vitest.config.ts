import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Run tests against the contracts source so they don't need a build first.
      '@apf/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'agent',
    include: ['src/**/*.test.ts'],
  },
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Each package keeps its own vitest.config.ts; this runs them all from the root, plus eval/.
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/*',
      {
        resolve: {
          alias: {
            '@apf/contracts': fileURLToPath(
              new URL('./packages/contracts/src/index.ts', import.meta.url),
            ),
          },
        },
        test: { name: 'eval', include: ['eval/**/*.test.ts'] },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: [
        // Type-only modules have no runtime code to cover.
        'packages/contracts/src/types.ts',
        'packages/contracts/src/api.ts',
        'apps/gateway/src/deps.ts',
        // Tests colocated with the code they test.
        '**/*.test.ts',
      ],
      reporter: ['text', 'html'],
    },
  },
});

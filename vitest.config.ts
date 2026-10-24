import { defineConfig } from 'vitest/config';

// Each project keeps its own vitest.config.ts; this runs them all from the root.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      // Type-only modules have no runtime code to cover.
      exclude: [
        'packages/contracts/src/types.ts',
        'packages/contracts/src/api.ts',
        'apps/gateway/src/deps.ts',
      ],
      reporter: ['text', 'html'],
    },
  },
});

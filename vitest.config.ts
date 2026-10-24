import { defineConfig } from 'vitest/config';

// Each project keeps its own vitest.config.ts; this runs them all from the root.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});

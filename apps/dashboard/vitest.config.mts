import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'dashboard',
    include: ['**/*.test.ts'],
    environment: 'node',
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'evals',
    include: ['src/**/*.test.ts'],
    env: { TRAV_OFFLINE: '1' },
  },
});

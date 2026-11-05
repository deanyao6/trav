import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    include: ['src/**/*.test.ts'],
    env: { TRAV_OFFLINE: '1' },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'simulator',
    include: ['src/**/*.test.ts'],
    env: { TRAV_OFFLINE: '1' },
  },
});

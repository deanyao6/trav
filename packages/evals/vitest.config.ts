import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'evals',
    include: ['src/**/*.test.ts'],
    env: { TRAV_OFFLINE: '1' },
    // Replay tests run a whole chat fixture (201 Barcelona lines) offline: ~1-2s
    // alone, but 6-8s when the full workspace suite runs in parallel, past
    // vitest's 5s default (T-160).
    testTimeout: 30_000,
  },
});

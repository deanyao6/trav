import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    env: { TRAV_OFFLINE: '1' },
    passWithNoTests: true,
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'simulator',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    env: { TRAV_OFFLINE: '1' },
  },
});

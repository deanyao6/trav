/**
 * Vite config for the simulator UI (root: src/ui).
 *
 * `pnpm sim` mounts this in middleware mode inside the API server (one port).
 * `pnpm --filter @trav/simulator dev:ui` runs Vite on its own: it binds
 * 127.0.0.1 and proxies /api (including the SSE stream) to TRAV_SIM_PORT.
 *
 * `node:crypto` alias: the UI imports pure helpers from `@trav/core`
 * (`formatMoney`, `formatClockTime`). Core's root entry also contains the id
 * generator and audit hash chain, which import `node:crypto`; the UI never
 * calls them, so the browser build resolves `node:crypto` to a stub that
 * throws if anything ever does (src/ui/shims/node-crypto.ts).
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = Number(process.env['TRAV_SIM_PORT'] ?? '5179');
const uiPort = Number(process.env['TRAV_SIM_UI_PORT'] ?? '5180');

export default defineConfig({
  root: fileURLToPath(new URL('./src/ui', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      'node:crypto': fileURLToPath(new URL('./src/ui/shims/node-crypto.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: uiPort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: false },
    },
  },
  preview: { host: '127.0.0.1', port: uiPort, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)),
    emptyOutDir: true,
  },
});

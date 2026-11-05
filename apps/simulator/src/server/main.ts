/**
 * `pnpm sim` entry point: one process, one port, 127.0.0.1 only.
 *
 *   node --import tsx src/server/main.ts --dev   API + SSE + Vite dev middleware (HMR)
 *   node --import tsx src/server/main.ts         API + SSE + the built UI from dist/ui
 *
 * Always the real Trav runtime over mock providers (`runtime.ts`), opening on
 * demo state 1 (`seed.ts`).
 *
 * Env: TRAV_SIM_PORT (default 5179), TRAV_OFFLINE (1 = no live model calls; read
 * by the agent runtime), TRAV_SIM_BACKEND (optional, `agent` only; the old
 * `scripted` value is refused, T-021).
 *
 * `--relay[=photon|sendblue]` (`pnpm relay:dev`, T-169): every session runs
 * over the iMessage relay adapter and that vendor's in-process mock relay
 * (`relay.ts`), and a webhook receiver listens on 127.0.0.1:TRAV_RELAY_PORT
 * (default 5181) at /relay/webhook, forwarding to the current session.
 * `--relay-view=phone` shows only what an iPhone shows (no cards, no buttons).
 * Never a real vendor: this path has no live transport (docs/RELAY.md).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { UiHandler } from './http.js';
import { SIM_HOST, createSimServer, listenLocal, parsePort, staticUi } from './http.js';
import { loadBarcelonaScript, withReplay } from './replay.js';
import { backendChoice, selectBackend } from './runtime.js';
import { createRelaySessions, relayArgs } from './relay.js';
import { DEFAULT_RELAY_PORT, createRelayWebhookServer, listenRelayWebhook } from '@trav/adapters';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_UI = join(APP_ROOT, 'dist', 'ui');

async function main(): Promise<void> {
  const dev = process.argv.includes('--dev');
  const port = parsePort(process.env['TRAV_SIM_PORT']);
  const relayChoice = relayArgs(process.argv, process.env);
  const relay =
    relayChoice !== undefined
      ? createRelaySessions({
          vendor: relayChoice.vendor,
          view: relayChoice.view,
          // Content-free notes only (never text, names or keys).
          onDiagnostic: (d) => console.log(`[relay] ${d.type}: ${d.detail}`),
        })
      : undefined;
  // No offline flag here: the agent runtime's model client decides (TRAV_OFFLINE,
  // missing key), and the backend reports that real mode in its state.
  const selected = await selectBackend({
    choice: backendChoice(process.env['TRAV_SIM_BACKEND']),
    seed: true,
    log: (line) => console.log(`[sim] ${line}`),
    ...(relay !== undefined ? { channelFactory: relay.channelFactory } : {}),
  });
  // The top bar's replay button runs fixtures/chats/barcelona.jsonl into this backend.
  const backend = withReplay(selected, loadBarcelonaScript());

  let ui: UiHandler | undefined;
  let attachHmr: ((server: Server) => Promise<void>) | undefined;
  if (dev) {
    attachHmr = async (server) => {
      const { createServer: createVite } = await import('vite');
      const vite = await createVite({
        configFile: join(APP_ROOT, 'vite.config.ts'),
        // HMR websocket shares the API server's port (127.0.0.1 only).
        server: { middlewareMode: true, ws: { server } },
        appType: 'spa',
      });
      ui = (req, res, next) => vite.middlewares(req, res, next);
    };
  } else if (existsSync(join(DIST_UI, 'index.html'))) {
    ui = staticUi(DIST_UI);
  } else {
    console.log(
      '[sim] no built UI in dist/ui; run `pnpm --filter @trav/simulator build` or use --dev',
    );
  }

  const server = createSimServer({
    backend,
    ui: (req, res, next) => (ui ? ui(req, res, next) : next()),
  });
  if (attachHmr) await attachHmr(server);
  const bound = await listenLocal(server, port);
  console.log(
    `[sim] trav simulator on http://${SIM_HOST}:${bound} · backend ${backend.kind}` +
      `${backend.state().offline ? ' · offline' : ' · live model calls'}`,
  );
  let webhook: Server | undefined;
  if (relay !== undefined) {
    webhook = createRelayWebhookServer({
      target: relay.webhookTarget,
      onError: (why) => console.log(`[relay] webhook error: ${why}`),
    });
    const rawRelayPort = process.env['TRAV_RELAY_PORT'] ?? '';
    const relayPort = rawRelayPort === '' ? DEFAULT_RELAY_PORT : parsePort(rawRelayPort);
    const hookPort = await listenRelayWebhook(webhook, relayPort);
    console.log(
      `[relay] mock ${relay.vendor} relay (never a real vendor) · ${relay.view} view · ` +
        `webhooks on http://127.0.0.1:${String(hookPort)}/relay/webhook`,
    );
  }
  const stop = (): void => {
    webhook?.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e: unknown) => {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === 'EPERM' || err?.code === 'EACCES') {
    console.error(
      `[sim] could not bind ${SIM_HOST}: ${err.message} (sandboxed? local port binding is off)`,
    );
  } else {
    console.error('[sim] failed to start:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});

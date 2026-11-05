/**
 * `pnpm server` entry point (T-188, D-056). One process: the webhook
 * endpoint, the runtime over SQLite, the scheduler on the real clock, a health
 * check, JSON logs on stdout.
 *
 *   pnpm server                       the relay line (fake relay unless every TRAV_RELAY_LIVE gate is set)
 *   pnpm server:demo                  Barcelona on the fake relay, its own database, clock from the Razzmatazz moment
 *
 * Env (never logged; `describeServerConfig` / `describeRelayConfig` name what
 * is set, never values): TRAV_RELAY_PORT (default 5181), TRAV_SERVER_DB (a path
 * under a `.trav/` directory), TRAV_SERVER_GROUPS (groups file), TRAV_SERVER_TICK_MS,
 * TRAV_SERVER_PUBLIC_HOSTS, TRAV_SERVER_DEPLOY + TRAV_SERVER_HOST (containers
 * only), plus the relay's and the model's own variables (docs/RELAY.md, .env.example).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeRelayConfig } from '@trav/adapters';
import { BARCELONA_NOW } from '@trav/agent';
import { createShiftedClock, createSystemClock } from './clock.js';
import { demoSqlitePath, describeServerConfig, resolveServerConfig } from './config.js';
import { createLogger, errorKind } from './log.js';
import { readGroupsFile } from './provision.js';
import { createTravServer, serverRelayEnv } from './server.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function main(): Promise<void> {
  const env = process.env;
  const base = resolveServerConfig(env, process.argv);
  const demo = base.demo !== undefined;
  const config = demo ? { ...base, sqlitePath: demoSqlitePath(REPO_ROOT) } : base;
  const clock = demo ? createShiftedClock(BARCELONA_NOW) : createSystemClock();
  const log = createLogger({ clock });
  const groups = config.groupsFile !== undefined ? readGroupsFile(config.groupsFile) : [];
  const server = createTravServer({ config, env, clock, log, groups });
  const bound = await server.listen();
  log.info('server.started', {
    ...describeServerConfig(config),
    port: bound.port,
    mode: server.relayConfig.live ? 'live' : 'mock',
    vendor: server.relayConfig.vendor,
    // Which relay variables are set (names only).
    detail: describeRelayConfig(server.relayConfig, serverRelayEnv(env, demo)).replaceAll(
      ' · ',
      '; ',
    ),
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    log.info('server.stopping');
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e: unknown) => {
  // The error's class only: messages can carry a path or a value.
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  const why = e instanceof Error && /^TRAV_|^--demo|^groups|^the /.test(e.message) ? e.message : '';
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'server.failed',
      kind: errorKind(e),
      code: code ?? null,
      why,
    }),
  );
  process.exit(1);
});

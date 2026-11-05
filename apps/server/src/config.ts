/**
 * Server configuration from the environment (T-188). Pure: takes an env
 * object, returns plain data. Values are never echoed: `describeServerConfig`
 * names what is set, never what it holds (the relay's own line comes from
 * `describeRelayConfig`, which follows the same rule).
 *
 * Binding: 127.0.0.1 unless `TRAV_SERVER_DEPLOY=1` (a container on Fly.io or
 * Render, where the platform's proxy is the only thing in front of the port)
 * *and* `TRAV_SERVER_HOST=0.0.0.0`. Any other host is refused. Requests whose
 * `Host` header is not loopback are refused unless it is one of
 * `TRAV_SERVER_PUBLIC_HOSTS` (the tunnel's or the platform's hostname).
 */
import { join } from 'node:path';
import type { RelayEnv } from '@trav/adapters';
import { DEFAULT_RELAY_PORT, DEFAULT_WEBHOOK_PATH } from '@trav/adapters';

export const LOOPBACK = '127.0.0.1';
export const ANY_HOST = '0.0.0.0';
/** How often the real-clock scheduler checks for due jobs. */
export const DEFAULT_TICK_MS = 30_000;
/** Shortest tick a config may ask for (a tight loop on a laptop helps no one). */
export const MIN_TICK_MS = 1_000;

export type ServerDemo = 'barcelona';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly webhookPath: string;
  /** `.trav/trav.sqlite` under the repo by default; must sit inside a `.trav/` directory. */
  readonly sqlitePath: string | undefined;
  /** Groups to provision at boot (JSON, `provision.ts`). */
  readonly groupsFile: string | undefined;
  readonly tickMs: number;
  /** Extra `Host` header values accepted besides loopback (lower-cased, no port). */
  readonly publicHosts: readonly string[];
  readonly deploy: boolean;
  /** `--demo=barcelona`: seed the flagship group and run its clock from the Razzmatazz moment. */
  readonly demo?: ServerDemo;
}

const nonEmpty = (v: string | undefined): v is string => v !== undefined && v.trim().length > 0;

function parsePort(raw: string | undefined, fallback: number): number {
  if (!nonEmpty(raw)) return fallback;
  if (!/^\d{1,5}$/.test(raw.trim())) throw new Error('TRAV_RELAY_PORT must be a port number');
  const n = Number(raw.trim());
  if (n < 0 || n > 65_535) throw new Error('TRAV_RELAY_PORT must be 0-65535');
  return n;
}

function parseTick(raw: string | undefined): number {
  if (!nonEmpty(raw)) return DEFAULT_TICK_MS;
  if (!/^\d{1,7}$/.test(raw.trim())) throw new Error('TRAV_SERVER_TICK_MS must be milliseconds');
  return Math.max(MIN_TICK_MS, Number(raw.trim()));
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function parsePublicHosts(raw: string | undefined): string[] {
  if (!nonEmpty(raw)) return [];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
    .map((h) => {
      if (!HOSTNAME.test(h) || h.length > 253) {
        throw new Error('TRAV_SERVER_PUBLIC_HOSTS must be comma-separated hostnames, no ports');
      }
      return h;
    });
}

function parseDemo(argv: readonly string[]): ServerDemo | undefined {
  const flag = argv.findLast((a) => a === '--demo' || a.startsWith('--demo='));
  if (flag === undefined) return undefined;
  const value = flag.includes('=') ? flag.slice('--demo='.length) : 'barcelona';
  if (value !== 'barcelona') throw new Error('--demo must be barcelona');
  return value;
}

export function resolveServerConfig(env: RelayEnv, argv: readonly string[] = []): ServerConfig {
  const deploy = env['TRAV_SERVER_DEPLOY'] === '1';
  const wantedHost = nonEmpty(env['TRAV_SERVER_HOST']) ? env['TRAV_SERVER_HOST'].trim() : LOOPBACK;
  if (wantedHost !== LOOPBACK && wantedHost !== ANY_HOST) {
    throw new Error(`TRAV_SERVER_HOST must be ${LOOPBACK} (or ${ANY_HOST} when deployed)`);
  }
  if (wantedHost === ANY_HOST && !deploy) {
    throw new Error(
      `TRAV_SERVER_HOST=${ANY_HOST} needs TRAV_SERVER_DEPLOY=1; dev binds ${LOOPBACK}`,
    );
  }
  const demo = parseDemo(argv);
  if (demo !== undefined && deploy) throw new Error('--demo is for dev, not a deployment');
  return {
    host: wantedHost,
    port: parsePort(env['TRAV_RELAY_PORT'], DEFAULT_RELAY_PORT),
    webhookPath: DEFAULT_WEBHOOK_PATH,
    sqlitePath: nonEmpty(env['TRAV_SERVER_DB']) ? env['TRAV_SERVER_DB'].trim() : undefined,
    groupsFile: nonEmpty(env['TRAV_SERVER_GROUPS']) ? env['TRAV_SERVER_GROUPS'].trim() : undefined,
    tickMs: parseTick(env['TRAV_SERVER_TICK_MS']),
    publicHosts: parsePublicHosts(env['TRAV_SERVER_PUBLIC_HOSTS']),
    deploy,
    ...(demo !== undefined ? { demo } : {}),
  };
}

/** One log-safe status line: mode and which variables are set, never their values. */
export function describeServerConfig(config: ServerConfig): Record<string, string | number> {
  return {
    host: config.host,
    port: config.port,
    db: config.sqlitePath === undefined ? 'default' : 'set',
    groups: config.groupsFile === undefined ? 'unset' : 'set',
    tickMs: config.tickMs,
    publicHosts: config.publicHosts.length,
    deploy: config.deploy ? 'yes' : 'no',
    demo: config.demo ?? 'none',
  };
}

/** Where a dev demo keeps its own database, so it never mixes with a real one. */
export function demoSqlitePath(repoRoot: string): string {
  return join(repoRoot, '.trav', 'server-demo.sqlite');
}

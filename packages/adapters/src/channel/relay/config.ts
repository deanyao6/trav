/**
 * Relay configuration from the environment, and the live-call guard (T-169).
 *
 * The relay is off unless `TRAV_CHANNEL=imessage_relay`. Even then every
 * call goes to the in-process mock relay unless BOTH `TRAV_RELAY_LIVE=1`
 * and the vendor's key (Sendblue: key id and secret) are set. Only then is
 * `fetch` touched at all: `createLiveRelayTransport` is the single place in
 * the codebase that sends a request to a relay vendor, and it refuses any URL
 * outside that vendor's API origin.
 *
 * Values are never printed: `describeRelayConfig` names which variables are
 * set, never what they contain.
 */
import type { Clock } from '../../interfaces/common.js';
import type { RelayChannel, RelayChannelOptions } from './core.js';
import { createRelayChannel } from './core.js';
import { DEFAULT_RELAY_PORT } from './http.js';
import type { RelayAuth, RelayHttpResponse, RelayTransport, RelayVendorId } from './types.js';
import { isRelayVendorId } from './types.js';
import { relayVendor } from './vendors/index.js';

export type RelayEnv = Readonly<Record<string, string | undefined>>;

export interface RelayEnvConfig {
  /** `TRAV_CHANNEL=imessage_relay`. */
  readonly enabled: boolean;
  readonly vendor: RelayVendorId;
  /** True only when enabled, `TRAV_RELAY_LIVE=1` and the key(s) are set. */
  readonly live: boolean;
  /** Why the mode is what it is (no values). */
  readonly reason: string;
  /** Trav's line address (`TRAV_RELAY_LINE`); a fictional number in mock mode. */
  readonly line: string;
  readonly port: number;
}

/** The fictional line the mock relay uses (NANP 555-0100…0199 numbers are reserved for fiction). */
export const MOCK_RELAY_LINE = '+16175550100';
export const MOCK_RELAY_KEY = 'mock-relay-key';
export const MOCK_RELAY_SECRET = 'mock-relay-webhook-secret';

const nonEmpty = (v: string | undefined): boolean => v !== undefined && v.trim().length > 0;

export function relayKeysPresent(vendor: RelayVendorId, env: RelayEnv): boolean {
  if (!nonEmpty(env['TRAV_RELAY_API_KEY'])) return false;
  return vendor === 'sendblue' ? nonEmpty(env['TRAV_RELAY_API_SECRET']) : true;
}

export function resolveRelayConfig(env: RelayEnv): RelayEnvConfig {
  const enabled = env['TRAV_CHANNEL'] === 'imessage_relay';
  const rawVendor = (env['TRAV_RELAY_VENDOR'] ?? '').trim().toLowerCase();
  if (rawVendor !== '' && !isRelayVendorId(rawVendor)) {
    throw new Error(`TRAV_RELAY_VENDOR must be photon or sendblue, got "${rawVendor}"`);
  }
  const vendor: RelayVendorId = rawVendor === '' ? 'photon' : (rawVendor as RelayVendorId);
  const wantsLive = env['TRAV_RELAY_LIVE'] === '1';
  const keys = relayKeysPresent(vendor, env);
  const live = enabled && wantsLive && keys;
  const reason = !enabled
    ? 'relay off (TRAV_CHANNEL is not imessage_relay)'
    : live
      ? `live ${vendor} (TRAV_RELAY_LIVE=1 and key set)`
      : wantsLive
        ? `mock relay: TRAV_RELAY_LIVE=1 but the ${vendor} key is not set`
        : keys
          ? 'mock relay: key set but TRAV_RELAY_LIVE is not 1'
          : 'mock relay (no key, TRAV_RELAY_LIVE unset)';
  const portRaw = env['TRAV_RELAY_PORT'];
  const port =
    portRaw !== undefined && /^\d{2,5}$/.test(portRaw) ? Number(portRaw) : DEFAULT_RELAY_PORT;
  const line =
    live && nonEmpty(env['TRAV_RELAY_LINE']) ? env['TRAV_RELAY_LINE']!.trim() : MOCK_RELAY_LINE;
  return { enabled, vendor, live, reason, line, port };
}

/** One safe status line for logs: mode and which variables are set, never their values. */
export function describeRelayConfig(config: RelayEnvConfig, env: RelayEnv): string {
  const set = (name: string): string => `${name}=${nonEmpty(env[name]) ? 'set' : 'unset'}`;
  return [
    `relay ${config.vendor}: ${config.reason}`,
    set('TRAV_RELAY_API_KEY'),
    ...(config.vendor === 'sendblue' ? [set('TRAV_RELAY_API_SECRET')] : []),
    set('TRAV_RELAY_WEBHOOK_SECRET'),
  ].join(' · ');
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  text(): Promise<string>;
}>;

export interface LiveTransportOptions {
  /** The vendor API origin, e.g. `https://api.photon.codes`. Every request must stay on it. */
  readonly origin: string;
  readonly fetch: FetchLike;
  /** Per-request timeout. Default 10 s. */
  readonly timeoutMs?: number;
}

/**
 * The only code that sends a request to a relay vendor. Built only by
 * `createRelayFromEnv` when live is enabled (or by a test with a fake fetch).
 */
export function createLiveRelayTransport(options: LiveTransportOptions): RelayTransport {
  const origin = new URL(options.origin).origin;
  if (!origin.startsWith('https://'))
    throw new Error('live relay transport requires an https origin');
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== origin) throw new Error(`refusing a relay request outside ${origin}`);
    const res = await options.fetch(url.toString(), {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const out: RelayHttpResponse = { status: res.status, headers, body };
    return out;
  };
}

export interface RelayFromEnvOptions extends Omit<
  RelayChannelOptions,
  'vendor' | 'transport' | 'auth' | 'webhookSecret' | 'line' | 'mode' | 'clock'
> {
  readonly env: RelayEnv;
  readonly clock: Clock;
  /** The mock relay's transport; used whenever live is not enabled. */
  readonly mockTransport: RelayTransport;
  /** Only read when live is enabled. Default `globalThis.fetch`. */
  readonly fetch?: FetchLike;
}

export interface RelayFromEnv {
  readonly config: RelayEnvConfig;
  readonly channel: RelayChannel;
}

/**
 * The relay channel the environment asks for, or undefined when the relay is
 * off. Mock unless `TRAV_RELAY_LIVE=1` and the key are both set.
 */
export function createRelayFromEnv(options: RelayFromEnvOptions): RelayFromEnv | undefined {
  const { env, mockTransport, fetch: injectedFetch, ...rest } = options;
  const config = resolveRelayConfig(env);
  if (!config.enabled) return undefined;
  const vendor = relayVendor(config.vendor);
  let transport: RelayTransport;
  let auth: RelayAuth;
  let webhookSecret: string;
  if (config.live) {
    const f = injectedFetch ?? (globalThis.fetch as unknown as FetchLike);
    transport = createLiveRelayTransport({ origin: vendor.baseUrl, fetch: f });
    auth = {
      apiKey: env['TRAV_RELAY_API_KEY']!.trim(),
      ...(nonEmpty(env['TRAV_RELAY_API_SECRET'])
        ? { apiSecret: env['TRAV_RELAY_API_SECRET']!.trim() }
        : {}),
    };
    // Live with no webhook secret refuses every delivery (fail closed).
    webhookSecret = env['TRAV_RELAY_WEBHOOK_SECRET']?.trim() ?? '';
  } else {
    transport = mockTransport;
    auth = { apiKey: MOCK_RELAY_KEY, apiSecret: MOCK_RELAY_KEY };
    webhookSecret = MOCK_RELAY_SECRET;
  }
  const channel = createRelayChannel({
    ...rest,
    vendor,
    transport,
    auth,
    webhookSecret,
    line: config.line,
    mode: config.live ? 'live' : 'mock',
  });
  return { config, channel };
}

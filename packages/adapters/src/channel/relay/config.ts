/**
 * Relay configuration from the environment, and the live-call guard (T-169).
 *
 * The relay is off unless `TRAV_CHANNEL=imessage_relay`. Even then every
 * call goes to the in-process mock relay unless `TRAV_RELAY_LIVE=1`, the
 * vendor's key (Sendblue: key id and secret) and `TRAV_RELAY_LINE` are all set. Only then is
 * `fetch` touched at all: `createLiveRelayTransport` is the single place in
 * the codebase that sends a request to a relay vendor, and it refuses any URL
 * outside that vendor's API origin.
 *
 * Values are never printed: `describeRelayConfig` names which variables are
 * set, never what they contain.
 */
import type { OutboundMessage } from '@trav/core';
import type { Clock } from '../../interfaces/common.js';
import type { RelayChannel, RelayChannelOptions } from './core.js';
import { RELAY_PART_TRIES, createRelayChannel } from './core.js';
import { DEFAULT_RELAY_PORT } from './http.js';
import { parseContactNames } from './mention.js';
import type {
  RelayAuth,
  RelayForm,
  RelayHttpResponse,
  RelayTransport,
  RelayVendorId,
  RelayVendorSupport,
} from './types.js';
import { isRelayVendorId } from './types.js';
import {
  BLUEBUBBLES_MAX_SENDS_PER_DAY,
  BLUEBUBBLES_MOCK_SERVER_URL,
  blueBubblesServerOrigin,
  createBlueBubblesVendor,
  relayVendor,
} from './vendors/index.js';
import { isLoopbackHttpOrigin } from './vendors/shared.js';

export type RelayEnv = Readonly<Record<string, string | undefined>>;

export interface RelayEnvConfig {
  /** `TRAV_CHANNEL=imessage_relay`. */
  readonly enabled: boolean;
  readonly vendor: RelayVendorId;
  /** True only when enabled, `TRAV_RELAY_LIVE=1`, the key(s), the line and (BlueBubbles) the server URL are set. */
  readonly live: boolean;
  /** Why the mode is what it is (no values). */
  readonly reason: string;
  /** Trav's line address (`TRAV_RELAY_LINE`); a fictional number in mock mode. */
  readonly line: string;
  readonly port: number;
  /** BlueBubbles only, live only: the server origin from `TRAV_BLUEBUBBLES_URL`. */
  readonly serverUrl?: string;
  /** BlueBubbles only: `TRAV_BLUEBUBBLES_PRIVATE_API=1` (tapbacks and inline replies out). */
  readonly privateApi: boolean;
  /** `TRAV_RELAY_CONTACT_NAME`, comma-separated, "Trav" itself left out (mention.ts). */
  readonly contactNames: readonly string[];
}

/** The fictional line the mock relay uses (NANP 555-0100…0199 numbers are reserved for fiction). */
export const MOCK_RELAY_LINE = '+16175550100';
export const MOCK_RELAY_KEY = 'mock-relay-key';
export const MOCK_RELAY_SECRET = 'mock-relay-webhook-secret';

const nonEmpty = (v: string | undefined): boolean => v !== undefined && v.trim().length > 0;

/** Photon: the bearer key. Sendblue: key id and secret. BlueBubbles: the server password. */
export function relayKeysPresent(vendor: RelayVendorId, env: RelayEnv): boolean {
  if (!nonEmpty(env['TRAV_RELAY_API_KEY'])) return false;
  return vendor === 'sendblue' ? nonEmpty(env['TRAV_RELAY_API_SECRET']) : true;
}

/** Characters a webhook secret may use to travel in a URL unchanged (RFC 3986 unreserved). */
export const URL_SAFE_SECRET = /^[A-Za-z0-9._~-]+$/;

/**
 * BlueBubbles' extra live gates (nothing echoed back): a usable server
 * origin, and a webhook secret that survives being a URL query value as
 * typed (a `+`, `&`, `#` or `%` would arrive changed and every delivery fail).
 */
function blueBubblesServer(env: RelayEnv): { origin?: string; problem?: string } {
  const raw = env['TRAV_BLUEBUBBLES_URL'];
  if (!nonEmpty(raw)) return { problem: 'TRAV_BLUEBUBBLES_URL is not set' };
  const secret = env['TRAV_RELAY_WEBHOOK_SECRET']?.trim() ?? '';
  if (secret.length > 0 && !URL_SAFE_SECRET.test(secret)) {
    return {
      problem:
        'TRAV_RELAY_WEBHOOK_SECRET must be URL-safe for bluebubbles (letters, digits, - . _ ~; e.g. openssl rand -hex 32)',
    };
  }
  try {
    return { origin: blueBubblesServerOrigin(raw!) };
  } catch (e) {
    return { problem: e instanceof Error ? e.message : 'TRAV_BLUEBUBBLES_URL is invalid' };
  }
}

export function resolveRelayConfig(env: RelayEnv): RelayEnvConfig {
  const enabled = env['TRAV_CHANNEL'] === 'imessage_relay';
  const rawVendor = (env['TRAV_RELAY_VENDOR'] ?? '').trim().toLowerCase();
  if (rawVendor !== '' && !isRelayVendorId(rawVendor)) {
    throw new Error(
      `TRAV_RELAY_VENDOR must be photon, sendblue or bluebubbles, got "${rawVendor.slice(0, 20)}"`,
    );
  }
  const vendor: RelayVendorId = rawVendor === '' ? 'photon' : (rawVendor as RelayVendorId);
  const wantsLive = env['TRAV_RELAY_LIVE'] === '1';
  const keys = relayKeysPresent(vendor, env);
  // The line's own address is a live gate too: without it Trav can't tell its
  // own echoes from members, and must never send as the fictional mock line.
  const lineSet = nonEmpty(env['TRAV_RELAY_LINE']);
  // A self-hosted line also needs to know where its server is.
  const server = vendor === 'bluebubbles' ? blueBubblesServer(env) : {};
  const serverOk = server.problem === undefined;
  const live = enabled && wantsLive && keys && lineSet && serverOk;
  const reason = !enabled
    ? 'relay off (TRAV_CHANNEL is not imessage_relay)'
    : live
      ? `live ${vendor} (TRAV_RELAY_LIVE=1, key and line set${vendor === 'bluebubbles' ? ', server URL set' : ''})`
      : wantsLive
        ? !keys
          ? `mock relay: TRAV_RELAY_LIVE=1 but the ${vendor} key is not set`
          : !lineSet
            ? 'mock relay: TRAV_RELAY_LIVE=1 but TRAV_RELAY_LINE is not set'
            : `mock relay: TRAV_RELAY_LIVE=1 but ${server.problem ?? 'the server URL is invalid'}`
        : keys
          ? 'mock relay: key set but TRAV_RELAY_LIVE is not 1'
          : 'mock relay (no key, TRAV_RELAY_LIVE unset)';
  const portRaw = env['TRAV_RELAY_PORT'];
  const port =
    portRaw !== undefined && /^\d{2,5}$/.test(portRaw) ? Number(portRaw) : DEFAULT_RELAY_PORT;
  const line = live ? env['TRAV_RELAY_LINE']!.trim() : MOCK_RELAY_LINE;
  return {
    enabled,
    vendor,
    live,
    reason,
    line,
    port,
    ...(live && server.origin !== undefined ? { serverUrl: server.origin } : {}),
    privateApi: vendor === 'bluebubbles' && env['TRAV_BLUEBUBBLES_PRIVATE_API'] === '1',
    contactNames: parseContactNames(env['TRAV_RELAY_CONTACT_NAME']),
  };
}

/** One safe status line for logs: mode and which variables are set, never their values. */
export function describeRelayConfig(config: RelayEnvConfig, env: RelayEnv): string {
  const set = (name: string): string => `${name}=${nonEmpty(env[name]) ? 'set' : 'unset'}`;
  return [
    `relay ${config.vendor}: ${config.reason}`,
    set('TRAV_RELAY_API_KEY'),
    ...(config.vendor === 'sendblue' ? [set('TRAV_RELAY_API_SECRET')] : []),
    ...(config.vendor === 'bluebubbles' ? [set('TRAV_BLUEBUBBLES_URL')] : []),
    set('TRAV_RELAY_WEBHOOK_SECRET'),
    set('TRAV_RELAY_LINE'),
  ].join(' · ');
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
  },
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
  /**
   * Also accept an `http:` origin on 127.0.0.1 / localhost (a self-hosted
   * BlueBubbles server on the same Mac). Default false: https only.
   */
  readonly allowLoopbackHttp?: boolean;
}

/** A `RelayForm` (plain data from a vendor module) → the multipart body fetch sends. */
function formDataOf(form: RelayForm): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(form.fields)) data.append(k, v);
  for (const f of form.files) {
    data.append(
      f.field,
      new Blob([Buffer.from(f.base64, 'base64')], { type: f.mimeType }),
      f.fileName,
    );
  }
  return data;
}

/**
 * The only code that sends a request to a relay vendor. Built only by
 * `createRelayFromEnv` when live is enabled (or by a test with a fake fetch,
 * or against a fake vendor server on 127.0.0.1).
 */
export function createLiveRelayTransport(options: LiveTransportOptions): RelayTransport {
  const origin = new URL(options.origin).origin;
  const httpOk = options.allowLoopbackHttp === true && isLoopbackHttpOrigin(origin);
  if (!origin.startsWith('https://') && !httpOk)
    throw new Error('live relay transport requires an https origin');
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (request) => {
    const url = new URL(request.url);
    if (url.origin !== origin) throw new Error(`refusing a relay request outside ${origin}`);
    if (request.form !== undefined && request.body !== undefined) {
      throw new Error('a relay request has either a JSON body or a form, not both');
    }
    const payload =
      request.form !== undefined
        ? formDataOf(request.form)
        : request.body !== undefined
          ? JSON.stringify(request.body)
          : undefined;
    const res = await options.fetch(url.toString(), {
      method: request.method,
      // fetch sets the multipart content-type (with its boundary) itself.
      headers: { ...request.headers },
      ...(payload !== undefined ? { body: payload } : {}),
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
  /** Unpaced: wrap it with `withOutboundPacing(channel, { clock, ...pacing })` (T-071). */
  readonly channel: RelayChannel;
  /** The vendor's pacing defaults (a self-hosted BlueBubbles line gets a lower daily cap). */
  readonly pacing: RelayPacingDefaults;
}

export interface RelayPacingDefaults {
  readonly maxSendsPerDay?: number;
  /**
   * Pacing tries per message, equal to the core's `RELAY_PART_TRIES`, so the
   * queue's last try on a split send ends degraded, never "never sent" (D-052 §7).
   */
  readonly maxAttempts: number;
  /** Wire messages per outbound message, so the cap counts what the line actually sends. */
  readonly wireSendsOf: (message: OutboundMessage) => number;
}

/**
 * How many vendor sends `createRelayChannel` makes for a message: the text
 * rides with the first images where the vendor allows it; otherwise (BlueBubbles)
 * it goes alone first and every image is its own send. An upper bound: an
 * image the core later skips still counts.
 */
export function relayWireSends(support: RelayVendorSupport, message: OutboundMessage): number {
  const images = (message.images ?? []).length;
  const per = Math.max(1, support.mediaPerMessage);
  const textAlone = !support.textWithMedia && message.text.length > 0 && images > 0 ? 1 : 0;
  return Math.max(1, textAlone + Math.ceil(images / per));
}

/** Per-vendor T-071 pacing: every line counts wire sends; a self-hosted BlueBubbles line gets a lower cap. */
export function relayPacingDefaults(vendor: RelayVendorId): RelayPacingDefaults {
  const support = relayVendor(vendor).support;
  const wireSendsOf = (message: OutboundMessage): number => relayWireSends(support, message);
  return vendor === 'bluebubbles'
    ? { maxSendsPerDay: BLUEBUBBLES_MAX_SENDS_PER_DAY, maxAttempts: RELAY_PART_TRIES, wireSendsOf }
    : { maxAttempts: RELAY_PART_TRIES, wireSendsOf };
}

/**
 * The relay channel the environment asks for, or undefined when the relay is
 * off. Mock unless `TRAV_RELAY_LIVE=1` and the key are both set.
 */
export function createRelayFromEnv(options: RelayFromEnvOptions): RelayFromEnv | undefined {
  const { env, mockTransport, fetch: injectedFetch, ...rest } = options;
  const config = resolveRelayConfig(env);
  if (!config.enabled) return undefined;
  // A live BlueBubbles line talks to its own server; the mock uses the fake one.
  const vendor =
    config.vendor === 'bluebubbles' && config.live && config.serverUrl !== undefined
      ? createBlueBubblesVendor({ serverUrl: config.serverUrl, privateApi: config.privateApi })
      : config.vendor === 'bluebubbles'
        ? createBlueBubblesVendor({
            serverUrl: BLUEBUBBLES_MOCK_SERVER_URL,
            privateApi: config.privateApi,
          })
        : relayVendor(config.vendor);
  let transport: RelayTransport;
  let auth: RelayAuth;
  let webhookSecret: string;
  if (config.live) {
    const f = injectedFetch ?? (globalThis.fetch as unknown as FetchLike);
    transport = createLiveRelayTransport({
      origin: vendor.baseUrl,
      fetch: f,
      // Only a self-hosted server may sit on plain http, and only on loopback.
      allowLoopbackHttp: config.vendor === 'bluebubbles',
    });
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
    ...(config.contactNames.length > 0 && rest.travNames === undefined
      ? { travNames: config.contactNames }
      : {}),
  });
  return { config, channel, pacing: relayPacingDefaults(config.vendor) };
}

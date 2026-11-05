/**
 * The Trav server (T-188, D-056): one long-running process that is Trav on a
 * relay line. It owns
 *
 * - the HTTP endpoint: `POST /relay/webhook` (the vendor's signed delivery,
 *   through `RelayChannel.handleWebhook`), `GET /healthz`, and in the dev demo
 *   only, `POST /dev/say` (a member's line, signed by the mock relay);
 * - the runtime: `createTravRuntime` over SQLite stores (`node:sqlite`, T-185),
 *   the relay channel (`createRelayFromEnv`: the in-process fake relay unless
 *   every TRAV_RELAY_LIVE gate is set) behind T-071 pacing;
 * - the scheduler on the real clock: every `tickMs` it drains due jobs
 *   (Morning After, daily settle-up, digests, card imports, expiries, Wrapped)
 *   through `agent.runScheduled`, and lets the pacing queue drain;
 * - the server-level commands (`commands.ts`): STOP / START and
 *   "@trav delete my data", answered before the agent sees the message;
 * - structured logs (`log.ts`): ids, counts and kinds only.
 *
 * Every inbound event and every scheduled job runs in one serial queue, so a
 * job never interleaves with a turn (the agent's caches are single-writer,
 * D-054 §7).
 *
 * What survives a restart (the SQLite file): groups, members, trips, the
 * ledger, bookings, audit, the agent's runtime state and dedupe keys, the
 * scheduler queue (T-185), the relay's dedupe keys (`seenKeys('relay')`), the
 * vendor id → Trav id map and chat rosters (`relayState.ts`), and the opt-out
 * list. Pacing counters are in memory (a restart resets the day's count).
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type {
  ChannelAdapter,
  ChannelTimers,
  InboundEvent,
  InboundMessage,
  MockRelay,
  PacedChannel,
  RelayChannel,
  RelayEnv,
  RelayEnvConfig,
} from '@trav/adapters';
import {
  createMemoryMediaHost,
  createMockRelay,
  createRelayFromEnv,
  createRelayWebhookHandler,
  createSerialQueue,
  readBody,
  resolveRelayConfig,
  systemChannelTimers,
  withOutboundPacing,
} from '@trav/adapters';
import type { ModelClient, ProviderRegistry, TravRuntime, TurnResult } from '@trav/agent';
import { createTravRuntime, sendTurn } from '@trav/agent';
import type { Clock, Group, IdGenerator, Member, OutboundMessage, Stores } from '@trav/core';
import { createUlidIdGenerator } from '@trav/core';
import { createSqliteStores } from '@trav/core/storage';
import {
  ALREADY_DELETED_TEXT,
  DELETED_TEXT,
  NOTHING_TO_DELETE_TEXT,
  START_TEXT,
  STOP_DM_TEXT,
  STOP_GROUP_TEXT,
  createOptOutList,
  parseCommand,
  senderOf,
  type OptOutList,
  type ServerCommand,
} from './commands.js';
import type { ServerConfig } from './config.js';
import { LOOPBACK } from './config.js';
import { monotonicMs } from './clock.js';
import type { Logger } from './log.js';
import { errorKind } from './log.js';
import type { ProvisionedGroup } from './provision.js';
import { provisionGroups, seedBarcelonaOnRelay } from './provision.js';
import type { RelayState } from './relayState.js';
import { createRelayState, looksLikeAddress } from './relayState.js';

/** Relay dedupe keys kept (the core's own in-memory default). */
export const RELAY_SEEN_CAP = 10_000;
export const DEV_SAY_PATH = '/dev/say';
export const HEALTH_PATH = '/healthz';
/** How long `close()` keeps ticking the pacing queue before it gives up (r1 #6). */
export const CLOSE_DRAIN_MS = 5_000;
const CLOSE_DRAIN_STEP_MS = 100;
/** Relay diagnostics whose detail can hold vendor-supplied text: logged by type only. */
export const VENDOR_TEXT_DIAGNOSTICS: ReadonlySet<string> = new Set(['send_failed', 'send_retry']);

export interface TravServerOptions {
  readonly config: ServerConfig;
  /** The environment (relay gates, model key). Never logged. */
  readonly env: RelayEnv;
  readonly clock: Clock;
  readonly log: Logger;
  /** Default: SQLite at `config.sqlitePath` (`.trav/trav.sqlite`). */
  readonly stores?: Stores;
  readonly ids?: IdGenerator;
  /** Groups to provision at boot (the groups file). */
  readonly groups?: readonly ProvisionedGroup[];
  /** Test seams: the mock providers stand in for systems that outlive the process. */
  readonly providers?: Partial<ProviderRegistry>;
  readonly model?: ModelClient;
  /** Test seam: the fake relay (default: a fresh one over the known chats). */
  readonly mockRelay?: (chats: ReturnType<RelayState['chats']>) => MockRelay;
  /** Pacing timers. Default: real (unref'd) timers; `false` = only `tick()` drains. */
  readonly timers?: ChannelTimers | false;
  /** Relay retry backoff. Default: real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** `strict` in tests; default `log` (a voice slip is logged, not a dropped reply). */
  readonly voice?: 'strict' | 'log';
  /** How long `close()` drains the pacing queue (default `CLOSE_DRAIN_MS`). */
  readonly closeDrainMs?: number;
}

export interface ServerHealth {
  readonly ok: boolean;
  readonly mode: 'live' | 'mock';
  readonly vendor: string;
  readonly model: 'live' | 'offline';
  readonly groups: number;
  readonly jobs: number;
  readonly queued: number;
  readonly uptimeS: number;
}

export interface TravServer {
  readonly config: ServerConfig;
  readonly relayConfig: RelayEnvConfig;
  readonly runtime: TravRuntime;
  readonly stores: Stores;
  readonly relay: RelayChannel;
  readonly paced: PacedChannel;
  /** The fake relay (the transport whenever the line is not live). */
  readonly mock: MockRelay;
  readonly optOuts: OptOutList;
  readonly http: Server;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Binds `config.host:config.port` (127.0.0.1 in dev) and starts the scheduler. */
  listen(): Promise<{ readonly host: string; readonly port: number }>;
  /** One scheduler pass: due jobs, then the pacing queue. */
  tick(): Promise<readonly TurnResult[]>;
  /** Resolves when every queued turn and job so far has finished. */
  idle(): Promise<void>;
  health(): ServerHealth;
  /** Stops the scheduler and the listener, then closes the stores. */
  close(): Promise<void>;
}

/** The relay environment the server runs with. A dev demo is never live. */
export function serverRelayEnv(env: RelayEnv, demo: boolean): RelayEnv {
  const out: Record<string, string | undefined> = { ...env, TRAV_CHANNEL: 'imessage_relay' };
  if (demo) delete out['TRAV_RELAY_LIVE'];
  return out;
}

function isLoopbackName(name: string): boolean {
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/** `Host` header → lower-cased name without the port. */
export function hostName(host: string | undefined): string | undefined {
  if (host === undefined) return undefined;
  return host.replace(/:\d+$/, '').toLowerCase();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** `application/json`, with or without parameters (`; charset=utf-8`). */
export function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json\s*(?:;|$)/i.test(value.trim());
}

/** Known paths by name for logs (anything else is `other`, so a probe's path is never echoed). */
function pathLabel(pathname: string, webhookPath: string): string {
  if (pathname === webhookPath) return 'webhook';
  if (pathname === HEALTH_PATH) return 'health';
  if (pathname === DEV_SAY_PATH) return 'dev_say';
  return 'other';
}

export function createTravServer(options: TravServerOptions): TravServer {
  const { config, clock, log } = options;
  const closeDrainMs = Math.max(0, options.closeDrainMs ?? CLOSE_DRAIN_MS);
  const demo = config.demo !== undefined;
  const bootMs = clock.nowMs();
  const ids = options.ids ?? createUlidIdGenerator(clock);
  const stores =
    options.stores ??
    createSqliteStores({
      clock,
      ids,
      ...(config.sqlitePath !== undefined ? { sqlitePath: config.sqlitePath } : {}),
    });

  // ---- groups the server knows (before the runtime, so it schedules their recaps)
  if (config.demo === 'barcelona') seedBarcelonaOnRelay(stores);
  const created = provisionGroups(stores, options.groups ?? [], clock.now());
  if (created.length > 0) log.info('groups.provisioned', { count: created.length });

  // ---- the line
  const relayState = createRelayState(stores);
  const optOuts = createOptOutList(stores);
  const relayEnv = serverRelayEnv(options.env, demo);
  const mock =
    options.mockRelay?.(relayState.chats()) ??
    createMockRelay({
      vendor: resolveRelayConfig(relayEnv).vendor,
      clock,
      chats: relayState.chats(),
      media: createMemoryMediaHost(),
    });
  const fromEnv = createRelayFromEnv({
    env: relayEnv,
    clock,
    mockTransport: mock.transport,
    chats: relayState.chats(),
    resolveContact: (handle, memberId) => relayState.resolveContact(handle, memberId),
    seen: stores.group.runtime.seenKeys('relay', RELAY_SEEN_CAP),
    media: mock.media,
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    // The fake relay maps a member upload back to its file; a live line hands
    // the agent the vendor URL, which the receipt reader never opens.
    resolveInboundMedia: async (a) => mock.uploadedOriginal(a.uri) ?? a,
    // A send failure's detail is the vendor's own error text (live: not ours to
    // vouch for), so only its type is logged.
    onDiagnostic: (d) =>
      log.info('relay.diagnostic', {
        type: d.type,
        ...(VENDOR_TEXT_DIAGNOSTICS.has(d.type) ? {} : { detail: d.detail }),
      }),
  });
  if (fromEnv === undefined) throw new Error('the relay channel did not start');
  const relay = fromEnv.channel;
  const relayConfig = fromEnv.config;
  if (relayConfig.vendor !== mock.vendor && !relayConfig.live) {
    throw new Error('the fake relay and TRAV_RELAY_VENDOR disagree');
  }

  /** Confirmations that go out to a number that just opted out (sent once, then nothing). */
  const optOutExempt = new Set<string>();
  const guarded = guardChannel(relay, relayState, optOuts, optOutExempt, (why) =>
    log.info('send.refused', { reason: why }),
  );
  const timers = options.timers === false ? undefined : (options.timers ?? systemChannelTimers());
  const paced = withOutboundPacing(guarded, {
    clock,
    maxAttempts: fromEnv.pacing.maxAttempts,
    wireSendsOf: fromEnv.pacing.wireSendsOf,
    ...(fromEnv.pacing.maxSendsPerDay !== undefined
      ? { maxSendsPerDay: fromEnv.pacing.maxSendsPerDay }
      : {}),
    ...(timers !== undefined ? { timers } : {}),
    onFailure: (f) => log.warn('send.lost', { reason: f.reason }),
  });

  // ---- the runtime
  const runtime = createTravRuntime({
    channel: paced,
    clock,
    ids,
    stores,
    seed: 'none',
    // Unknown numbers stay guests (D-056 §5) until the setup DM can reach a
    // pending row through `resolveContact` (T-170 r2 wires that).
    onboarding: false,
    env: options.env,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.providers !== undefined ? { providers: options.providers } : {}),
    voice: options.voice ?? 'log',
    onLintViolation: (_o, violations) => log.warn('voice.violation', { count: violations.length }),
    // r1 #1: an opted-out member has no DM lane for the agent. Their DMs drop
    // with the send path's honest count line, and their tickets are held
    // (the receipt says so) until START. The guard below stays as a backstop.
    dmHold: (memberId) => {
      const m = stores.group.members.get(memberId);
      return m !== undefined && optOuts.has(m.senderId);
    },
  });

  const queue = createSerialQueue();
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(step: () => Promise<T>): Promise<T> => {
    const run = queue(step);
    tail = run.catch(() => undefined);
    return run;
  };

  // ---- inbound
  function groupFor(event: InboundEvent): Group | undefined {
    if (event.lane === 'group') return stores.group.groups.getByConversation(event.conversationId);
    const sender = senderOf(event);
    const groups = stores.group.groups
      .list()
      .filter((g) => stores.group.members.getBySenderId(g.groupId, sender) !== undefined);
    return (
      groups.find((g) => stores.group.trips.current(g.groupId, clock.now()) !== undefined) ??
      groups[0]
    );
  }

  async function saveRoster(conversationId: string): Promise<void> {
    const listed = await relay.listParticipants(conversationId);
    if (!listed.ok) return;
    relayState.saveRoster(
      conversationId,
      listed.value.filter((p) => !p.isTrav && looksLikeAddress(p.handle)).map((p) => p.handle),
    );
  }

  async function reply(
    event: InboundMessage,
    group: Group,
    member: Member | undefined,
    text: string,
    exempt = false,
  ): Promise<void> {
    const dm = event.lane === 'dm';
    if (dm && member === undefined) return; // a guest has no DM lane; nothing to send
    const message: OutboundMessage = {
      id: ids.next('msg'),
      groupId: group.groupId,
      to: dm ? { kind: 'member', memberId: member!.memberId } : { kind: 'group' },
      text,
      ...(dm ? {} : { replyTo: event.messageId }),
      proactive: false,
    };
    if (exempt) optOutExempt.add(message.id);
    const members = stores.group.members.listByGroup(group.groupId);
    await sendTurn([message], {
      channel: paced,
      group,
      members,
      trip: stores.group.trips.current(group.groupId, clock.now()) ?? null,
      consent: (memberId) => stores.private.getConsent(memberId, group.groupId),
      audit: stores.group.audit,
      clock,
      ids,
      handleFor: (memberId) => members.find((m) => m.memberId === memberId)?.senderId,
      voice: options.voice ?? 'log',
    });
  }

  /** Every member row an address is, in every group. */
  function memberRowsOf(address: string): Member[] {
    return stores.group.groups
      .list()
      .map((g) => stores.group.members.getBySenderId(g.groupId, address))
      .filter((m): m is Member => m !== undefined);
  }

  async function runCommand(
    command: ServerCommand,
    event: InboundMessage,
    group: Group | undefined,
  ): Promise<void> {
    const sender = event.sender;
    const member =
      group === undefined ? undefined : stores.group.members.getBySenderId(group.groupId, sender);
    log.info('command', { kind: command.kind, lane: event.lane, groupId: group?.groupId ?? null });
    if (command.kind === 'stop') {
      optOuts.add(sender, clock.now());
      if (group !== undefined) {
        await reply(
          event,
          group,
          member,
          event.lane === 'dm' ? STOP_DM_TEXT : STOP_GROUP_TEXT,
          true,
        );
      }
      return;
    }
    if (command.kind === 'start') {
      optOuts.remove(sender);
      if (group !== undefined) await reply(event, group, member, START_TEXT);
      // r1 #1: the tickets held while opted out, now.
      for (const m of memberRowsOf(sender)) {
        for (const r of await runtime.agent.deliverHeld(m.memberId)) {
          log.info('turn', { note: r.note, groupId: m.groupId, outbound: r.outbound.length });
        }
      }
      return;
    }
    // delete_my_data: every member row this address is, in every group.
    const rows = memberRowsOf(sender);
    let deleted = 0;
    for (const m of rows) {
      const counts = stores.private.deletePartition(m.memberId);
      runtime.agent.forgetRuntimeState({ memberId: m.memberId });
      const n = Object.values(counts).reduce((a, b) => a + b, 0);
      deleted += n;
      // r1 #3: a repeat request deletes nothing, so nothing is audited.
      if (n === 0) continue;
      stores.group.audit.append({
        groupId: m.groupId,
        tripId: null,
        type: 'data.deleted',
        actor: { kind: 'member', id: m.memberId },
        visibility: 'owner',
        ownerId: m.memberId,
        payload: { scope: 'member', request: 'delete_my_data', tables: counts },
      });
    }
    // `tables`: rows deleted across the partitions (a count, never their contents).
    log.info('data.deleted', { count: rows.length, tables: deleted });
    if (group !== undefined) {
      await reply(
        event,
        group,
        member,
        rows.length === 0
          ? NOTHING_TO_DELETE_TEXT
          : deleted > 0
            ? DELETED_TEXT
            : ALREADY_DELETED_TEXT,
      );
    }
  }

  async function processInbound(event: InboundEvent): Promise<void> {
    const group = groupFor(event);
    if (event.lane === 'group' && group === undefined) {
      // A chat nobody provisioned: no answer at all.
      log.info('inbound.ignored', { reason: 'unknown_chat', type: event.type });
      return;
    }
    if (event.lane === 'group') await saveRoster(event.conversationId);
    const sender = senderOf(event);
    const optedOut = optOuts.has(sender);
    if (event.type === 'message') {
      const command = parseCommand(event, optedOut);
      if (command !== undefined) {
        await runCommand(command, event, group);
        return;
      }
    }
    if (optedOut && event.type !== 'member_joined' && event.type !== 'member_left') {
      log.info('inbound.ignored', { reason: 'opted_out', type: event.type });
      return;
    }
    const started = monotonicMs();
    const result = await runtime.agent.handleInbound(relayState.remap(event));
    log.info('turn', {
      type: event.type,
      lane: event.lane,
      groupId: group?.groupId ?? null,
      note: result.note,
      outbound: result.outbound.length,
      ms: Math.round(monotonicMs() - started),
    });
  }

  relay.onEvent((event) =>
    enqueue(async () => {
      try {
        await processInbound(event);
      } catch (e) {
        log.error('turn.failed', { type: event.type, kind: errorKind(e) });
      }
    }),
  );

  // ---- the scheduler on the clock
  async function tick(): Promise<readonly TurnResult[]> {
    const results = await enqueue(async () => {
      try {
        return await runtime.drain();
      } catch (e) {
        log.error('scheduler.failed', { kind: errorKind(e) });
        return [];
      }
    });
    for (const r of results) log.info('job', { note: r.note, outbound: r.outbound.length });
    await paced.tick();
    return results;
  }

  // ---- HTTP
  const webhook = createRelayWebhookHandler({
    target: relay,
    path: config.webhookPath,
    // The Host check is ours (below): loopback plus the configured public hosts.
    loopbackHostOnly: false,
    onError: (why) => log.error('webhook.failed', { kind: why }),
  });
  const allowedHosts = new Set(config.publicHosts);

  function health(): ServerHealth {
    let groups: number;
    try {
      groups = stores.group.groups.list().length;
    } catch {
      groups = -1;
    }
    return {
      ok: groups >= 0,
      mode: relayConfig.live ? 'live' : 'mock',
      vendor: relayConfig.vendor,
      model: runtime.model.mode,
      groups: Math.max(0, groups),
      jobs: groups >= 0 ? runtime.scheduler.list().length : 0,
      queued: paced.queue().length,
      uptimeS: Math.max(0, Math.floor((clock.nowMs() - bootMs) / 1000)),
    };
  }

  async function devSay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, 16_384);
    let body: { from?: unknown; text?: unknown; dm?: unknown };
    try {
      body = raw === 'too_large' ? {} : (JSON.parse(raw) as typeof body);
    } catch {
      body = {};
    }
    const member = typeof body.from === 'string' ? stores.group.members.get(body.from) : undefined;
    const group = member === undefined ? undefined : stores.group.groups.get(member.groupId);
    if (member === undefined || group === undefined || typeof body.text !== 'string') {
      json(res, 400, { error: 'from (a member id) and text are required' });
      return;
    }
    const before = mock.sends().length;
    const signed = await mock.memberMessage({
      chat:
        body.dm === true
          ? { kind: 'dm', address: member.senderId }
          : { kind: 'group', chatId: group.conversationId },
      from: member.senderId,
      text: body.text.slice(0, 2000),
      // The fake relay numbers its ids from 1 each boot; a stored dedupe key
      // from the last boot must not swallow a new line.
      vendorMessageId: ids.next('msg'),
    });
    const outcome = await relay.handleWebhook(signed);
    await outcome.delivered;
    await tail;
    await paced.tick();
    json(res, outcome.status, {
      sent: mock
        .sends()
        .slice(before)
        .map((s) => ({ chat: s.chat.kind, kind: s.kind, text: s.text, images: s.media.length })),
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = monotonicMs();
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    const label = pathLabel(url.pathname, config.webhookPath);
    try {
      const name = hostName(req.headers.host);
      const loopback = name !== undefined && isLoopbackName(name);
      if (!loopback && (name === undefined || !allowedHosts.has(name))) {
        json(res, 403, { error: 'unknown host' });
      } else if (url.pathname === HEALTH_PATH && req.method === 'GET') {
        const h = health();
        json(res, h.ok ? 200 : 503, h);
      } else if (req.headers.origin !== undefined) {
        // r1 #4: browsers send Origin; a vendor's server-to-server webhook and
        // curl don't. So a page in any browser tab can never drive Trav.
        json(res, 403, { error: 'browser requests are refused' });
      } else if (url.pathname === DEV_SAY_PATH) {
        // The dev demo only, loopback only: never on a deployment or behind a tunnel.
        if (!demo || !loopback) json(res, 404, { error: 'not found' });
        else if (req.method !== 'POST') json(res, 405, { error: 'POST only' });
        else if (!isJsonContentType(req.headers['content-type'])) {
          // No CORS "simple request" (text/plain, form) gets this far.
          json(res, 415, { error: 'content-type must be application/json' });
        } else await devSay(req, res);
      } else {
        await webhook(req, res);
      }
    } catch (e) {
      log.error('http.failed', { kind: errorKind(e) });
      json(res, 500, { error: 'internal' });
    }
    log.info('http', {
      kind: req.method ?? 'none',
      note: label,
      status: res.statusCode,
      ms: Math.round(monotonicMs() - started),
    });
  }

  const http = createServer((req, res) => {
    void handle(req, res);
  });
  let interval: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  return {
    config,
    relayConfig,
    runtime,
    stores,
    relay,
    paced,
    mock,
    optOuts,
    http,
    handle,
    tick,
    idle: async () => {
      await tail;
    },
    health,
    async listen() {
      if (config.host !== LOOPBACK && !config.deploy) {
        throw new Error(`dev binds ${LOOPBACK} only`);
      }
      const port = await new Promise<number>((resolve, reject) => {
        http.once('error', reject);
        http.listen(config.port, config.host, () => {
          const addr = http.address();
          resolve(typeof addr === 'object' && addr !== null ? addr.port : config.port);
        });
      });
      // Catch up on whatever came due while the server was down (a stale recap is skipped by the agent).
      void tick();
      interval = setInterval(() => {
        void tick();
      }, config.tickMs);
      interval.unref?.();
      return { host: config.host, port };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (interval !== undefined) clearInterval(interval);
      if (http.listening) {
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections?.();
        });
      }
      await tail;
      // r1 #6: give the pacing queue a bounded chance to go out (queued QR
      // DMs, a recap). Whatever is still queued after the bound is lost; it
      // isn't stored (D-056), and the count is logged.
      const deadline = monotonicMs() + closeDrainMs;
      for (;;) {
        try {
          await paced.tick();
        } catch (e) {
          log.error('close.drain_failed', { kind: errorKind(e) });
          break;
        }
        if (paced.queue().length === 0 || monotonicMs() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, CLOSE_DRAIN_STEP_MS));
      }
      const left = paced.queue().length;
      if (left > 0) log.warn('send.lost_on_close', { count: left });
      log.info('server.closed', { count: left });
      runtime.close();
    },
  };
}

/**
 * The relay channel with the server's two duties at the wire:
 * - an opted-out number gets nothing (DMs refused; its STOP confirmation is
 *   the one exception, once);
 * - each send's vendor ids are stored, so a 👍 on a card from before a
 *   restart still finds the card (`relayState.remap`).
 */
function guardChannel(
  relay: RelayChannel,
  state: RelayState,
  optOuts: OptOutList,
  exempt: Set<string>,
  onRefused: (why: string) => void,
): ChannelAdapter {
  return {
    info: relay.info,
    capabilities: relay.capabilities,
    onEvent: (handler) => relay.onEvent(handler),
    react: (conversationId, reaction, remove) => relay.react(conversationId, reaction, remove),
    listParticipants: (conversationId) => relay.listParticipants(conversationId),
    async sendGroup(conversationId, message, sendOptions) {
      const result = await relay.sendGroup(conversationId, message, sendOptions);
      if (result.ok) state.rememberSend(message.id, relay.vendorIdsOf(message.id));
      return result;
    },
    async sendDirect(to, message, sendOptions) {
      if (optOuts.has(to) && !exempt.delete(message.id)) {
        onRefused('opted_out');
        return {
          ok: false,
          error: { code: 'invalid_request', message: 'recipient opted out', retryable: false },
        };
      }
      const result = await relay.sendDirect(to, message, sendOptions);
      if (result.ok) state.rememberSend(message.id, relay.vendorIdsOf(message.id));
      return result;
    },
  };
}

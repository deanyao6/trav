/**
 * Outbound pacing for relay lines (T-071, research/connectors.md "iMessage
 * group access", behaviour 4). A relay line is one phone number / Apple ID;
 * Apple's spam signals are opaque but a high send-to-receive ratio and raw
 * volume are known triggers (Lindy's line was banned within a day). This
 * decorator over any `ChannelAdapter` keeps one line inside:
 *
 * - a **daily cap**: at most `maxSendsPerDay` outbound sends (group texts, DMs
 *   and tapbacks) in any rolling 24 hours. The last `criticalReserve` slots
 *   (default 20) are kept for critical messages, so an approval prompt is
 *   never the message the cap holds back while the line still has room;
 * - a **send-to-receive ratio**: sends in the last `ratioWindowMs` stay at or
 *   under `max(ratioAllowance, floor(maxSendToReceiveRatio × receives))`,
 *   where receives are inbound messages, tapbacks and taps from members
 *   (deduplicated by message id). A member's reply raises the limit, and the
 *   queue drains before that reply reaches the agent, so a prompt held by the
 *   ratio always goes out before Trav handles the answer to it;
 * - **tapback over text**: a group reply that carries no information ("got
 *   it", "done", "👍") goes out as a 👍 tapback on the message it answers when
 *   the channel has reactions.
 *
 * **Queue.** A text or DM over the limit is queued (the call returns `ok`
 * with `queued: true`) and goes out under the same id when capacity returns,
 * highest priority first: critical (approval prompts: a message with actions
 * or an answer card; and `urgent` safety messages), then normal (replies and
 * DMs), then low (proactive), first-in-first-out within each.
 *
 * What can still be lost after the agent was told `queued`, each one audited
 * as `message.budget_dropped` (with `reason`) and reported to `onFailure`:
 * - `queue_full`: past `maxQueue` (200) a proactive message is dropped; past
 *   `maxQueueTotal` (1000) critical + normal entries the oldest normal one is
 *   dropped. A critical message is never dropped for room.
 * - `expired`: a queued message whose answer window passed (its `expiresAt`,
 *   or a proposal card's `holdExpiresAt`) is withdrawn: its buttons and hold
 *   are dead, so delivering it late would ask for a yes that can't book.
 * - `send_failed`: the inner channel refused it when it finally went out. A
 *   `retryable` refusal goes back to the front of its class, retried after
 *   `retryBackoffMs × attempt`, up to `maxAttempts` (3) tries in all.
 *
 * An over-limit tapback is not queued (a late 👍 is noise) and returns
 * `rate_limited`. The queue drains on every inbound event, every send,
 * `tick()`, and on `timers` when given. All id sets are bounded (5,000).
 *
 * Compose with the inbound debounce as
 * `withInboundDebounce(withOutboundPacing(channel, ...), ...)` so the ratio
 * counts every message a member actually sent.
 */
import type { Clock, GroupId, OutboundMessage, OutboundReaction, TripId } from '@trav/core';
import { parseIso } from '@trav/core';
import type {
  ChannelAdapter,
  ConversationId,
  InboundEvent,
  MessageId,
  SendOptions,
  SentMessage,
} from '../interfaces/channel.js';
import type { AdapterErrorCode, ChannelHandle, Result, Unsubscribe } from '../interfaces/common.js';
import type { AuditSink } from './types.js';
import { isAnswerCard } from './types.js';
import { normalizeReply } from './keywords.js';
import type { ChannelTimers } from './timers.js';

export const DEFAULT_MAX_SENDS_PER_DAY = 500;
export const DEFAULT_CRITICAL_RESERVE = 20;
export const DEFAULT_MAX_SEND_TO_RECEIVE_RATIO = 3;
export const DEFAULT_RATIO_ALLOWANCE = 10;
export const DEFAULT_MAX_PACING_QUEUE = 200;
export const DEFAULT_MAX_PACING_QUEUE_TOTAL = 1000;
export const DEFAULT_MAX_SEND_ATTEMPTS = 3;
export const DEFAULT_RETRY_BACKOFF_MS = 30_000;
/** Bound on every remembered-id set and on `failures()`. */
export const PACING_MEMORY_LIMIT = 5_000;
const DAY_MS = 86_400_000;

export type PacingPriority = 'critical' | 'normal' | 'low';

/** A message the agent was told went out or was queued, and that never will. */
export interface PacingFailure {
  readonly messageId: MessageId;
  readonly groupId: GroupId;
  readonly lane: 'group' | 'dm';
  readonly priority: PacingPriority;
  readonly reason: 'send_failed' | 'expired' | 'queue_full';
  /** The inner channel's error code for `send_failed`. */
  readonly code?: AdapterErrorCode;
  /** Send attempts made (0 for `expired` / `queue_full` before any try). */
  readonly attempts: number;
}

export interface OutboundPacingOptions {
  readonly clock: Clock;
  /** Where drops, expiries and final send failures are audited. */
  readonly audit?: AuditSink;
  /** Called once for every message lost after it was accepted (see `PacingFailure`). */
  readonly onFailure?: (failure: PacingFailure) => void;
  /** Default 500 per rolling 24h (far under every vendor's per-line guidance). */
  readonly maxSendsPerDay?: number;
  /** Daily-cap slots only critical messages may use. Default 20 (clamped to the cap). */
  readonly criticalReserve?: number;
  /** Default 3 sends per receive. */
  readonly maxSendToReceiveRatio?: number;
  /** Sends always allowed per ratio window, whatever was received (an intro on join). Default 10. */
  readonly ratioAllowance?: number;
  /** Default 24h. */
  readonly ratioWindowMs?: number;
  /** Default 200 queued messages; past it proactive ones are dropped. */
  readonly maxQueue?: number;
  /** Default 1000 critical + normal entries; past it the oldest normal one is dropped. */
  readonly maxQueueTotal?: number;
  /** Tries per queued message, first one included. Default 3. */
  readonly maxAttempts?: number;
  /** Wait before retry n is `retryBackoffMs × n`. Default 30 s. */
  readonly retryBackoffMs?: number;
  /** Default true: a content-free group reply goes out as a 👍 tapback when possible. */
  readonly preferTapback?: boolean;
  /** Fire the drain when capacity returns by itself; without it, call `tick()`. */
  readonly timers?: ChannelTimers;
  readonly tripIdFor?: (groupId: GroupId) => TripId | null;
}

export interface PacingStats {
  readonly sentInDay: number;
  readonly sentInRatioWindow: number;
  readonly receivedInRatioWindow: number;
  /** Sends the ratio allows in the current window. */
  readonly ratioLimit: number;
  readonly queued: number;
  /** Messages lost after acceptance (queue room, expiry, final send failure) plus refused proactive ones. */
  readonly dropped: number;
}

export interface QueuedSend {
  readonly messageId: MessageId;
  readonly lane: 'group' | 'dm';
  readonly priority: PacingPriority;
  readonly attempts: number;
}

export interface PacedChannel extends ChannelAdapter {
  /** Drain whatever the current capacity allows (call after moving a simulated clock). */
  tick(): Promise<void>;
  stats(): PacingStats;
  /** Queued sends in delivery order. */
  queue(): readonly QueuedSend[];
  /** The most recent losses (bounded). */
  failures(): readonly PacingFailure[];
}

/** Delivery class of a queued message (exported for tests). */
export function pacingPriority(message: OutboundMessage): PacingPriority {
  if (message.urgent === true) return 'critical';
  if ((message.actions ?? []).length > 0) return 'critical';
  if (message.card !== undefined && isAnswerCard(message.card)) return 'critical';
  if (message.proactive === true && message.replyTo === undefined) return 'low';
  return 'normal';
}

/** When a queued message stops being worth sending: its actions' or its hold's end. */
export function pacingDeadline(message: OutboundMessage): string | undefined {
  const hold = message.card?.type === 'booking_proposal' ? message.card.holdExpiresAt : undefined;
  if (message.expiresAt === undefined) return hold;
  if (hold === undefined) return message.expiresAt;
  // Both set: the earlier wins, so a card never goes out after its hold died.
  return Date.parse(hold) < Date.parse(message.expiresAt) ? hold : message.expiresAt;
}

const ACK_TEXTS: ReadonlySet<string> = new Set([
  'ok',
  'okay',
  'k',
  'kk',
  'got it',
  'gotcha',
  'noted',
  'done',
  'on it',
  'will do',
  'sounds good',
  'cool',
  'nice',
  'perfect',
  'great',
  'all good',
  'np',
  'no problem',
  'yep',
  'sure',
  '👍',
  '👌',
  '✅',
  '🙌',
]);

/**
 * True when a reply says nothing a tapback doesn't ("got it", "done 👍"):
 * bare text only, no card, buttons, images, mentions or notice.
 */
export function isContentFreeAck(message: OutboundMessage): boolean {
  if (message.card !== undefined || message.kind !== undefined) return false;
  if ((message.actions ?? []).length > 0 || (message.images ?? []).length > 0) return false;
  if ((message.mentions ?? []).length > 0) return false;
  const words = normalizeReply(message.text)
    .replace(/[!.]+/g, ' ')
    .split(/\s*[,·]\s*|\s+(?=[👍👌✅🙌])/u)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  return words.length > 0 && words.every((w) => ACK_TEXTS.has(w));
}

/** A set that forgets its oldest entries past `limit`. */
function boundedSet<T>(limit: number): { has(v: T): boolean; add(v: T): void } {
  const set = new Set<T>();
  return {
    has: (v) => set.has(v),
    add(v) {
      if (set.has(v)) return;
      set.add(v);
      if (set.size > limit) set.delete(set.values().next().value as T);
    },
  };
}

/** A map that forgets its oldest entries past `limit`. */
function boundedMap<K, V>(limit: number): { get(k: K): V | undefined; set(k: K, v: V): void } {
  const map = new Map<K, V>();
  return {
    get: (k) => map.get(k),
    set(k, v) {
      map.delete(k);
      map.set(k, v);
      if (map.size > limit) map.delete(map.keys().next().value as K);
    },
  };
}

interface Pending {
  readonly seq: number;
  readonly priority: PacingPriority;
  readonly message: OutboundMessage;
  readonly send: () => Promise<Result<SentMessage>>;
  readonly lane: 'group' | 'dm';
  /** Epoch ms after which it is withdrawn, if it has an answer window. */
  readonly deadlineMs?: number;
  attempts: number;
  /** Epoch ms before which a retry waits. */
  retryAtMs: number;
}

const RANK: Readonly<Record<PacingPriority, number>> = { critical: 0, normal: 1, low: 2 };

function nonNegativeInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`withOutboundPacing: ${name} must be a non-negative integer`);
  }
  return value;
}

export function withOutboundPacing(
  channel: ChannelAdapter,
  options: OutboundPacingOptions,
): PacedChannel {
  const { clock } = options;
  const maxPerDay = nonNegativeInt(
    'maxSendsPerDay',
    options.maxSendsPerDay ?? DEFAULT_MAX_SENDS_PER_DAY,
  );
  // The default reserve scales down on small caps so normal replies always have room.
  const reserve =
    options.criticalReserve === undefined
      ? Math.min(DEFAULT_CRITICAL_RESERVE, Math.floor(maxPerDay / 4))
      : nonNegativeInt('criticalReserve', options.criticalReserve);
  if (maxPerDay > 0 && reserve >= maxPerDay) {
    throw new Error('withOutboundPacing: criticalReserve must be below maxSendsPerDay');
  }
  const ratio = options.maxSendToReceiveRatio ?? DEFAULT_MAX_SEND_TO_RECEIVE_RATIO;
  if (!(ratio >= 0) || !Number.isFinite(ratio)) {
    throw new Error('withOutboundPacing: maxSendToReceiveRatio must be a non-negative number');
  }
  const allowance = nonNegativeInt(
    'ratioAllowance',
    options.ratioAllowance ?? DEFAULT_RATIO_ALLOWANCE,
  );
  const ratioWindowMs = options.ratioWindowMs ?? DAY_MS;
  if (!(ratioWindowMs > 0)) throw new Error('withOutboundPacing: ratioWindowMs must be positive');
  const maxQueue = nonNegativeInt('maxQueue', options.maxQueue ?? DEFAULT_MAX_PACING_QUEUE);
  const maxQueueTotal = nonNegativeInt(
    'maxQueueTotal',
    options.maxQueueTotal ?? DEFAULT_MAX_PACING_QUEUE_TOTAL,
  );
  const maxAttempts = Math.max(
    1,
    nonNegativeInt('maxAttempts', options.maxAttempts ?? DEFAULT_MAX_SEND_ATTEMPTS),
  );
  const backoffMs = nonNegativeInt(
    'retryBackoffMs',
    options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
  );
  const preferTapback = options.preferTapback ?? true;
  const keepMs = Math.max(DAY_MS, ratioWindowMs);

  /** Epoch ms of every send still inside the longest window. */
  let sends: number[] = [];
  let receives: number[] = [];
  const seenInbound = boundedSet<string>(PACING_MEMORY_LIMIT);
  const queued: Pending[] = [];
  const failed: PacingFailure[] = [];
  // What went out, by id: a resend gets the same answer and never reaches the wire again.
  const sent = boundedMap<MessageId, SentMessage>(PACING_MEMORY_LIMIT);
  const reactedIds = boundedSet<MessageId>(PACING_MEMORY_LIMIT);
  /** Sends on the wire right now, by id (a resend waits for the outcome instead of sending twice). */
  const inFlight = new Map<MessageId, Promise<Result<SentMessage>>>();
  let dropped = 0;
  let seq = 0;
  let draining: Promise<void> | undefined;
  let cancelTimer: (() => void) | undefined;
  const handlers = new Set<(event: InboundEvent) => void | Promise<void>>();

  const prune = (now: number): void => {
    sends = sends.filter((t) => t > now - keepMs);
    receives = receives.filter((t) => t > now - ratioWindowMs);
  };
  const ratioLimit = (): number => Math.max(allowance, Math.floor(ratio * receives.length));
  const sentIn = (now: number, windowMs: number): number =>
    sends.filter((t) => t > now - windowMs).length;
  const dayLimit = (priority: PacingPriority): number =>
    priority === 'critical' ? maxPerDay : maxPerDay - reserve;
  const hasCapacity = (priority: PacingPriority): boolean => {
    const now = clock.nowMs();
    prune(now);
    return sentIn(now, DAY_MS) < dayLimit(priority) && sentIn(now, ratioWindowMs) < ratioLimit();
  };
  /** Reserve a slot before awaiting so concurrent sends can't both take the last one. */
  const take = (): number => {
    const t = clock.nowMs();
    sends.push(t);
    return t;
  };
  const release = (t: number): void => {
    const i = sends.lastIndexOf(t);
    if (i >= 0) sends.splice(i, 1);
  };

  function scheduleWake(): void {
    cancelTimer?.();
    cancelTimer = undefined;
    if (options.timers === undefined || queued.length === 0) return;
    const now = clock.nowMs();
    const times: number[] = [];
    // An old send leaving a window frees a slot.
    if (sends.length > 0) times.push(Math.min(...sends) + Math.min(DAY_MS, ratioWindowMs));
    for (const q of queued) {
      if (q.retryAtMs > now) times.push(q.retryAtMs);
      if (q.deadlineMs !== undefined) times.push(q.deadlineMs);
    }
    if (times.length === 0) return;
    cancelTimer = options.timers.setTimer(Math.max(0, Math.min(...times) - now) + 1, () => {
      void drain();
    });
  }

  /** Before every entry of a lower class (after its own class: FIFO). */
  function insert(p: Pending): void {
    const i = queued.findIndex((q) => RANK[q.priority] > RANK[p.priority]);
    if (i < 0) queued.push(p);
    else queued.splice(i, 0, p);
  }

  /** At the front of its own class (a retry keeps its place in line). */
  function insertFront(p: Pending): void {
    const i = queued.findIndex((q) => RANK[q.priority] >= RANK[p.priority]);
    if (i < 0) queued.push(p);
    else queued.splice(i, 0, p);
  }

  function audit(
    message: OutboundMessage,
    lane: 'group' | 'dm',
    reason: PacingFailure['reason'] | 'line_pacing',
    extra: Record<string, unknown> = {},
  ): void {
    options.audit?.append({
      groupId: message.groupId,
      tripId: options.tripIdFor?.(message.groupId) ?? null,
      type: 'message.budget_dropped',
      actor: { kind: 'trav', id: 'trav' },
      visibility: message.to.kind === 'member' ? 'owner' : 'group',
      ...(message.to.kind === 'member' ? { ownerId: message.to.memberId } : {}),
      payload: {
        messageId: message.id,
        lane,
        reason,
        priority: pacingPriority(message),
        queued: queued.length,
        ...(message.card ? { cardType: message.card.type, cardId: message.card.cardId } : {}),
        ...extra,
      },
    });
  }

  /** A message the agent was told is queued is lost: audit it (when asked) and tell the host. */
  function lose(
    p: Pending,
    reason: PacingFailure['reason'],
    opts: { code?: AdapterErrorCode; audit: boolean },
  ): void {
    dropped += 1;
    const failure: PacingFailure = {
      messageId: p.message.id,
      groupId: p.message.groupId,
      lane: p.lane,
      priority: p.priority,
      reason,
      attempts: p.attempts,
      ...(opts.code !== undefined ? { code: opts.code } : {}),
    };
    failed.push(failure);
    if (failed.length > PACING_MEMORY_LIMIT) failed.shift();
    if (opts.audit) {
      audit(p.message, p.lane, reason, {
        attempts: p.attempts,
        ...(opts.code !== undefined ? { code: opts.code } : {}),
      });
    }
    options.onFailure?.(failure);
  }

  /** Queue a send; returns false if it was the one dropped. */
  function enqueue(p: Pending): boolean {
    if (p.priority === 'low' && queued.length >= maxQueue) {
      // Refused up front: the caller gets `rate_limited`, so no onFailure.
      dropped += 1;
      audit(p.message, p.lane, 'line_pacing', { maxQueue });
      return false;
    }
    if (queued.length >= maxQueue) {
      // Make room by dropping the newest proactive message, if any; otherwise grow.
      for (let i = queued.length - 1; i >= 0; i--) {
        if (queued[i]!.priority === 'low') {
          const [old] = queued.splice(i, 1);
          lose(old!, 'queue_full', { audit: true });
          break;
        }
      }
    }
    insert(p);
    // Hard cap on what may not be dropped for proactive room: shed the oldest
    // normal entries (stale replies and DMs), never a critical one.
    while (queued.filter((q) => q.priority !== 'low').length > maxQueueTotal) {
      let oldest: Pending | undefined;
      for (const q of queued) {
        if (q.priority === 'normal' && (oldest === undefined || q.seq < oldest.seq)) oldest = q;
      }
      if (oldest === undefined) break;
      queued.splice(queued.indexOf(oldest), 1);
      if (oldest === p) {
        dropped += 1;
        audit(p.message, p.lane, 'queue_full', { maxQueueTotal });
        return false;
      }
      lose(oldest, 'queue_full', { audit: true });
    }
    return true;
  }

  /** Withdraw queued messages whose answer window has passed. */
  function expireDue(): void {
    const now = clock.nowMs();
    for (let i = queued.length - 1; i >= 0; i--) {
      const q = queued[i]!;
      if (q.deadlineMs !== undefined && q.deadlineMs <= now) {
        queued.splice(i, 1);
        lose(q, 'expired', { audit: true });
      }
    }
  }

  /** One send on the wire, tracked by id. */
  function sendTracked(
    id: MessageId,
    send: () => Promise<Result<SentMessage>>,
  ): Promise<Result<SentMessage>> {
    const run = send().finally(() => inFlight.delete(id));
    inFlight.set(id, run);
    return run;
  }

  async function drainOnce(): Promise<void> {
    for (;;) {
      expireDue();
      const now = clock.nowMs();
      const next = queued.find((q) => q.retryAtMs <= now && hasCapacity(q.priority));
      if (next === undefined) break;
      queued.splice(queued.indexOf(next), 1);
      const t = take();
      next.attempts += 1;
      const result = await sendTracked(next.message.id, next.send);
      if (result.ok) {
        sent.set(next.message.id, result.value);
        continue;
      }
      release(t);
      if (result.error.retryable && next.attempts < maxAttempts) {
        next.retryAtMs = clock.nowMs() + backoffMs * next.attempts;
        insertFront(next);
        continue;
      }
      // The agent heard "queued"; say plainly that it never went out.
      lose(next, 'send_failed', { code: result.error.code, audit: next.priority === 'critical' });
    }
    scheduleWake();
  }

  function drain(): Promise<void> {
    if (draining !== undefined) return draining;
    draining = drainOnce().finally(() => {
      draining = undefined;
    });
    return draining;
  }

  function queuedResult(message: OutboundMessage): Result<SentMessage> {
    return {
      ok: true,
      value: { messageId: message.id, sentAt: clock.now(), degraded: false, queued: true },
    };
  }

  /** A resend of an id we already handle: answered without a second slot or entry. */
  function known(message: OutboundMessage): Result<SentMessage> | undefined {
    const done = sent.get(message.id);
    if (done !== undefined) return { ok: true, value: done };
    if (queued.some((q) => q.message.id === message.id)) return queuedResult(message);
    return undefined;
  }

  async function paced(
    message: OutboundMessage,
    lane: 'group' | 'dm',
    send: () => Promise<Result<SentMessage>>,
  ): Promise<Result<SentMessage>> {
    // A retried send (same OutboundMessage id) never takes a second slot or queue entry.
    const before = known(message);
    if (before !== undefined) return before;
    // Same id on the wire right now (a drain or another call): wait for it, then look again.
    const pending = inFlight.get(message.id);
    if (pending !== undefined) await pending;
    if (draining !== undefined) await draining;
    const after = known(message);
    if (after !== undefined) return after;

    const priority = pacingPriority(message);
    const ahead = queued.some((q) => RANK[q.priority] <= RANK[priority]);
    if (!ahead && hasCapacity(priority)) {
      const t = take();
      const result = await sendTracked(message.id, send);
      if (result.ok) sent.set(message.id, result.value);
      else release(t);
      return result;
    }
    const deadline = pacingDeadline(message);
    const kept = enqueue({
      seq: ++seq,
      priority,
      message,
      send,
      lane,
      ...(deadline !== undefined ? { deadlineMs: parseIso(deadline) } : {}),
      attempts: 0,
      retryAtMs: 0,
    });
    if (!kept) {
      return {
        ok: false,
        error: {
          code: 'rate_limited',
          message: 'this line is at its send limit and the queue is full',
          retryable: false,
        },
      };
    }
    void drain();
    return queuedResult(message);
  }

  function rememberInbound(event: InboundEvent): boolean {
    if (event.type !== 'message' && event.type !== 'reaction' && event.type !== 'button_tap') {
      return false;
    }
    const key = `${event.conversationId}|${event.messageId}`;
    if (seenInbound.has(key)) return false;
    seenInbound.add(key);
    return true;
  }

  channel.onEvent(async (event) => {
    if (rememberInbound(event)) receives.push(clock.nowMs());
    // Capacity may be back: what waited goes out before Trav answers this one.
    await drain();
    for (const handler of [...handlers]) await handler(event);
  });

  const paced_: PacedChannel = {
    info: channel.info,
    capabilities: channel.capabilities,
    onEvent(handler): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    listParticipants: (conversationId) => channel.listParticipants(conversationId),

    async sendGroup(conversationId: ConversationId, message, opts?: SendOptions) {
      const target = opts?.replyToMessageId ?? message.replyTo;
      if (
        preferTapback &&
        channel.capabilities.reactions &&
        target !== undefined &&
        message.to.kind === 'group' &&
        isContentFreeAck(message)
      ) {
        const reaction: OutboundReaction = {
          id: message.id,
          groupId: message.groupId,
          kind: 'reaction',
          to: message.to,
          targetMessageId: target,
          emoji: '👍',
        };
        const asReaction: Result<SentMessage> = {
          ok: true,
          value: { messageId: message.id, sentAt: clock.now(), degraded: false, asReaction: true },
        };
        // A retried ack is the same tapback, not a second one.
        if (reactedIds.has(message.id)) return asReaction;
        const r = await paced_.react(conversationId, reaction);
        if (r.ok) {
          reactedIds.add(message.id);
          return asReaction;
        }
        if (r.error.code === 'rate_limited') return r;
        // The target is gone or the channel refused: say it in words.
      }
      return paced(message, 'group', () => channel.sendGroup(conversationId, message, opts));
    },

    async sendDirect(to: ChannelHandle, message, opts?: SendOptions) {
      return paced(message, 'dm', () => channel.sendDirect(to, message, opts));
    },

    async react(conversationId, reaction, remove) {
      if (draining !== undefined) await draining;
      // A tapback is never critical: it waits behind the queue and the reserve.
      if (queued.length > 0 || !hasCapacity('normal')) {
        return {
          ok: false,
          error: {
            code: 'rate_limited',
            message: 'this line is at its send limit',
            retryable: true,
          },
        };
      }
      const t = take();
      const result = await channel.react(conversationId, reaction, remove);
      if (!result.ok) release(t);
      return result;
    },

    tick: () => drain(),

    stats() {
      const now = clock.nowMs();
      prune(now);
      return {
        sentInDay: sentIn(now, DAY_MS),
        sentInRatioWindow: sentIn(now, ratioWindowMs),
        receivedInRatioWindow: receives.length,
        ratioLimit: ratioLimit(),
        queued: queued.length,
        dropped,
      };
    },

    queue() {
      return queued.map((q) => ({
        messageId: q.message.id,
        lane: q.lane,
        priority: q.priority,
        attempts: q.attempts,
      }));
    },

    failures() {
      return [...failed];
    },
  };
  return paced_;
}

/**
 * Inbound burst debounce (T-071). People text in pieces: "@trav" / "get us
 * razz tickets" / "for 5, henry's sick" arrive as three messages a second
 * apart. On a relay line each would be its own agent turn, and each turn can
 * send (bad for the line's send-to-receive ratio, and three half-answers in
 * the chat). This decorator merges a burst into one inbound message:
 *
 * - A burst is consecutive messages from the **same sender** in the same
 *   conversation and lane, each within `windowMs` (default 3 s) of the last.
 *   It is delivered `windowMs` after its last message, or once it has been
 *   held `maxHoldMs` (default 10 s), whichever is first.
 * - Senders are never merged together (identity is per message; a merged
 *   "yes" must still be that member's own words). A message from someone
 *   else, a tapback, a button tap or a membership change in the same
 *   conversation first flushes the burst, so per-conversation order holds.
 * - The merged message keeps the first message's id and adds
 *   `mergedMessageIds` (always 2+ ids; a single message is delivered as is,
 *   without the field); text is joined with line breaks, and
 *   `platformMention` / `forwarded` are true if any part was. A message
 *   quote-replying a different message starts a new burst.
 * - A message with attachments (a receipt photo) is never merged: it flushes
 *   the pending burst and is delivered at once as its own event, so "yes" then
 *   a photo is two events and a photo is never read as part of a sentence.
 * - Redeliveries of any id already delivered (alone or inside a burst) are
 *   dropped.
 *
 * Merging can CREATE an exact approval: the approval whitelist collapses line
 * breaks, so "do" + "it" or "yes" + "please" merged read as "do it" / "yes
 * please". A merged event is never one member's single reply, so the agent
 * must refuse any event carrying `mergedMessageIds` as an exact text approval
 * (it asks back instead; D-048).
 *
 * Time comes from the injected `Clock`. Without `timers`, call `tick()` after
 * moving the clock (tests, simulator); every inbound event also flushes
 * bursts that are due before it is handled.
 */
import type { Clock } from '@trav/core';
import type {
  ChannelAdapter,
  ConversationId,
  InboundEvent,
  InboundMessage,
  MessageId,
} from '../interfaces/channel.js';
import type { Unsubscribe } from '../interfaces/common.js';
import type { ChannelTimers } from './timers.js';
import { createSerialQueue } from './timers.js';

export const DEFAULT_DEBOUNCE_WINDOW_MS = 3_000;
export const DEFAULT_DEBOUNCE_MAX_HOLD_MS = 10_000;
const SEEN_LIMIT = 5_000;

export interface InboundDebounceOptions {
  readonly clock: Clock;
  /** Default 3000 ms (Lindy's relay setup used 3 s). */
  readonly windowMs?: number;
  /** Default 10000 ms: a burst that never pauses is still answered. */
  readonly maxHoldMs?: number;
  readonly timers?: ChannelTimers;
  /** Called when a timer-driven flush's handler throws (a `tick()` caller gets the error instead). */
  readonly onError?: (error: unknown) => void;
}

export interface DebouncedChannel extends ChannelAdapter {
  /** Deliver every burst whose window has passed on the clock. */
  tick(): Promise<void>;
  /** Deliver every held burst now (shutdown, end of a test). */
  flushAll(): Promise<void>;
  /** Bursts currently held. */
  pendingBursts(): number;
}

interface Burst {
  readonly parts: InboundMessage[];
  readonly firstAtMs: number;
  lastAtMs: number;
}

/** One message out of a burst (exported for tests). */
export function mergeBurst(parts: readonly InboundMessage[]): InboundMessage {
  const first = parts[0];
  if (first === undefined) throw new Error('mergeBurst: empty burst');
  if (parts.length === 1) return first;
  if (parts.some((p) => p.attachments.length > 0)) {
    throw new Error('mergeBurst: a message with attachments is never merged');
  }
  const last = parts[parts.length - 1]!;
  const { platformMention: _pm, forwarded: _fw, ...base } = first;
  const mention = parts.some((p) => p.platformMention === true);
  const forwarded = parts.some((p) => p.forwarded === true);
  return {
    ...base,
    receivedAt: last.receivedAt,
    text: parts.map((p) => p.text).join('\n'),
    attachments: [],
    ...(mention ? { platformMention: true } : {}),
    ...(forwarded ? { forwarded: true } : {}),
    mergedMessageIds: parts.map((p) => p.messageId),
  };
}

function nonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`withInboundDebounce: ${name} must be a non-negative number`);
  }
  return value;
}

export function withInboundDebounce(
  channel: ChannelAdapter,
  options: InboundDebounceOptions,
): DebouncedChannel {
  const { clock } = options;
  const windowMs = nonNegative('windowMs', options.windowMs ?? DEFAULT_DEBOUNCE_WINDOW_MS);
  const maxHoldMs = nonNegative('maxHoldMs', options.maxHoldMs ?? DEFAULT_DEBOUNCE_MAX_HOLD_MS);
  const handlers = new Set<(event: InboundEvent) => void | Promise<void>>();
  const bursts = new Map<ConversationId, Burst>();
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  const serial = createSerialQueue();
  let cancelTimer: (() => void) | undefined;

  const key = (conversationId: ConversationId, id: MessageId): string => `${conversationId}|${id}`;
  const remember = (conversationId: ConversationId, id: MessageId): void => {
    const k = key(conversationId, id);
    if (seen.has(k)) return;
    seen.add(k);
    seenOrder.push(k);
    if (seenOrder.length > SEEN_LIMIT) seen.delete(seenOrder.shift()!);
  };
  const dueAt = (b: Burst): number => Math.min(b.lastAtMs + windowMs, b.firstAtMs + maxHoldMs);

  async function dispatch(event: InboundEvent): Promise<void> {
    for (const handler of [...handlers]) await handler(event);
  }

  async function flush(conversationId: ConversationId): Promise<void> {
    const burst = bursts.get(conversationId);
    if (burst === undefined) return;
    bursts.delete(conversationId);
    for (const p of burst.parts) remember(conversationId, p.messageId);
    await dispatch(mergeBurst(burst.parts));
  }

  async function flushDue(): Promise<void> {
    const now = clock.nowMs();
    // Oldest first, so bursts in different conversations keep their order.
    const due = [...bursts.entries()]
      .filter(([, b]) => dueAt(b) <= now)
      .sort((a, b) => a[1].firstAtMs - b[1].firstAtMs);
    for (const [conversationId] of due) await flush(conversationId);
  }

  function scheduleWake(): void {
    cancelTimer?.();
    cancelTimer = undefined;
    if (options.timers === undefined || bursts.size === 0) return;
    const next = Math.min(...[...bursts.values()].map(dueAt));
    cancelTimer = options.timers.setTimer(Math.max(0, next - clock.nowMs()), () => {
      serial(async () => {
        await flushDue();
        scheduleWake();
      }).catch((error: unknown) => options.onError?.(error));
    });
  }

  function joins(burst: Burst, message: InboundMessage): boolean {
    const first = burst.parts[0]!;
    return (
      first.sender === message.sender &&
      first.lane === message.lane &&
      first.replyToMessageId === message.replyToMessageId &&
      clock.nowMs() - burst.lastAtMs <= windowMs &&
      clock.nowMs() - burst.firstAtMs < maxHoldMs
    );
  }

  async function onInbound(event: InboundEvent): Promise<void> {
    await flushDue();
    const conversationId = event.conversationId;
    if (event.type !== 'message') {
      await flush(conversationId);
      if (event.type === 'reaction' || event.type === 'button_tap') {
        if (seen.has(key(conversationId, event.messageId))) return;
        remember(conversationId, event.messageId);
      }
      await dispatch(event);
      return;
    }
    if (seen.has(key(conversationId, event.messageId))) return;
    const burst = bursts.get(conversationId);
    if (burst !== undefined && burst.parts.some((p) => p.messageId === event.messageId)) return;
    if (event.attachments.length > 0) {
      // A photo is its own event: the burst before it goes first, then the photo, now.
      await flush(conversationId);
      remember(conversationId, event.messageId);
      await dispatch(event);
      return;
    }
    const now = clock.nowMs();
    if (burst !== undefined && joins(burst, event)) {
      burst.parts.push(event);
      burst.lastAtMs = now;
      return;
    }
    if (burst !== undefined) await flush(conversationId);
    bursts.set(conversationId, { parts: [event], firstAtMs: now, lastAtMs: now });
    if (windowMs === 0) await flush(conversationId);
  }

  channel.onEvent((event) =>
    serial(async () => {
      await onInbound(event);
      scheduleWake();
    }),
  );

  return {
    info: channel.info,
    capabilities: channel.capabilities,
    onEvent(handler): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    sendGroup: (conversationId, message, opts) => channel.sendGroup(conversationId, message, opts),
    sendDirect: (to, message, opts) => channel.sendDirect(to, message, opts),
    react: (conversationId, reaction, remove) => channel.react(conversationId, reaction, remove),
    listParticipants: (conversationId) => channel.listParticipants(conversationId),
    // T-170: present only when the wrapped channel can leave a group.
    ...(channel.leaveConversation !== undefined
      ? { leaveConversation: channel.leaveConversation.bind(channel) }
      : {}),

    tick: () =>
      serial(async () => {
        await flushDue();
        scheduleWake();
      }),

    flushAll: () =>
      serial(async () => {
        const all = [...bursts.entries()].sort((a, b) => a[1].firstAtMs - b[1].firstAtMs);
        for (const [conversationId] of all) await flush(conversationId);
        scheduleWake();
      }),

    pendingBursts: () => bursts.size,
  };
}

/**
 * Message-budget guard (G-03, VOICE §2 "Cap on unsolicited group messages",
 * VOICE §3.1 length rules, D-009). A decorator over any `ChannelAdapter`:
 *
 * - Proactive group messages (`OutboundMessage.proactive === true`, not a
 *   reply) are capped at `maxProactivePerDay` (default 2) per group per
 *   simulated day on the injected `Clock`. Past the cap the message is not
 *   sent; the call returns `rate_limited` and writes `message.budget_dropped`.
 * - `urgent` group messages are exempt from the cap (and do not consume it),
 *   but every one that goes out is audited as `message.sent` with
 *   `budgetExempt: true`.
 * - DMs (`sendDirect`), replies (`replyTo` / `replyToMessageId`), and
 *   non-proactive messages are never limited.
 * - Any card-less group message longer than `maxLines` (default 6) is handed
 *   to the inner channel with the `renderAsCard` hint so rich channels show it
 *   as a card panel (text is the card body); text-only channels send text.
 *
 * The general `message.sent` audit for every send lives in the agent's single
 * send path (`agent/outbound/send.ts`); this decorator only audits what it
 * decides (drops and budget-exempt urgent sends).
 */
import type { Clock, GroupId, IsoDate, TimeZone, TripId } from '@trav/core';
import type {
  ChannelAdapter,
  ConversationId,
  SendOptions,
  SentMessage,
} from '../interfaces/channel.js';
import type { Result } from '../interfaces/common.js';
import type { AuditSink, ChannelSendOptions } from './types.js';
import { countLines, isDmOnlyMessage } from './types.js';

export const DEFAULT_MAX_PROACTIVE_PER_DAY = 2;
export const DEFAULT_MAX_GROUP_LINES = 6;

export interface MessageBudgetOptions {
  readonly clock: Clock;
  readonly audit: AuditSink;
  /** Default 2 (VOICE §2). */
  readonly maxProactivePerDay?: number;
  /** Default 6 (VOICE §3.1). */
  readonly maxLines?: number;
  /**
   * The trip's IANA zone per group, which decides where a "day" starts. When
   * absent (or it returns undefined), the day is the calendar date in the
   * offset carried by `clock.now()`.
   */
  readonly timeZoneFor?: (groupId: GroupId) => TimeZone | undefined;
  /** Trip id for audit events. Default null. */
  readonly tripIdFor?: (groupId: GroupId) => TripId | null;
}

export interface BudgetedChannel extends ChannelAdapter {
  /** Proactive group messages already sent (or in flight) today for `groupId`. */
  proactiveSentToday(groupId: GroupId): number;
}

const TRAV_ACTOR = { kind: 'trav', id: 'trav' } as const;

/** Calendar day of the clock's "now" for a group (exported for tests). */
export function budgetDay(clock: Clock, timeZone: TimeZone | undefined): IsoDate {
  if (timeZone) {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(clock.nowMs());
  }
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(clock.now());
  if (!m) throw new Error(`budgetDay: clock.now() is not ISO-8601: ${clock.now()}`);
  return m[1]!;
}

export function withMessageBudget(
  channel: ChannelAdapter,
  options: MessageBudgetOptions,
): BudgetedChannel {
  const cap = options.maxProactivePerDay ?? DEFAULT_MAX_PROACTIVE_PER_DAY;
  const maxLines = options.maxLines ?? DEFAULT_MAX_GROUP_LINES;
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`withMessageBudget: maxProactivePerDay must be a non-negative integer`);
  }
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error(`withMessageBudget: maxLines must be a positive integer`);
  }
  const { clock, audit } = options;
  /** `${groupId}|${day}` → proactive messages sent or reserved. */
  const used = new Map<string, number>();
  /** Ids of proactive messages that hold a budget slot. */
  const countedIds = new Set<string>();
  /** Ids of urgent messages already audited as `message.sent`. */
  const auditedUrgentIds = new Set<string>();

  const dayFor = (groupId: GroupId): IsoDate =>
    budgetDay(clock, options.timeZoneFor?.(groupId) ?? undefined);
  const keyFor = (groupId: GroupId, day: IsoDate): string => `${groupId}|${day}`;
  const tripFor = (groupId: GroupId): TripId | null => options.tripIdFor?.(groupId) ?? null;

  return {
    info: channel.info,
    capabilities: channel.capabilities,
    onEvent: (handler) => channel.onEvent(handler),
    // DMs are never limited (VOICE §2 batching applies upstream, not here).
    sendDirect: (to, message, opts) => channel.sendDirect(to, message, opts),
    react: (conversationId, reaction, remove) => channel.react(conversationId, reaction, remove),
    listParticipants: (conversationId) => channel.listParticipants(conversationId),

    proactiveSentToday(groupId) {
      return used.get(keyFor(groupId, dayFor(groupId))) ?? 0;
    },

    async sendGroup(
      conversationId: ConversationId,
      message,
      opts?: SendOptions,
    ): Promise<Result<SentMessage>> {
      // Lane violations are refused before any budget accounting or audit, so a
      // misrouted ticket never consumes a slot or lands in a group-visible event.
      if (message.to.kind !== 'group' || isDmOnlyMessage(message)) {
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: 'group lane accepts only group-addressed messages without DM-only cards',
            retryable: false,
          },
        };
      }
      const isReply = message.replyTo !== undefined || opts?.replyToMessageId !== undefined;
      const urgent = message.urgent === true;
      // A retried send carries the same OutboundMessage id (ARCHITECTURE §6); it
      // must not consume a second slot or be dropped after it already went out.
      const retry = countedIds.has(message.id);
      const counted = message.proactive === true && !urgent && !isReply && !retry;

      const overflow = message.card === undefined && countLines(message.text) > maxLines;
      const forward: ChannelSendOptions | undefined = overflow
        ? { ...opts, renderAsCard: true }
        : opts;

      const groupId = message.groupId;
      const day = dayFor(groupId);
      const key = keyFor(groupId, day);
      const sentToday = used.get(key) ?? 0;

      if (counted) {
        if (sentToday >= cap) {
          audit.append({
            groupId,
            tripId: tripFor(groupId),
            type: 'message.budget_dropped',
            actor: TRAV_ACTOR,
            visibility: 'group',
            payload: {
              messageId: message.id,
              conversationId,
              day,
              cap,
              sentToday,
              ...(message.card ? { cardType: message.card.type, cardId: message.card.cardId } : {}),
            },
          });
          return {
            ok: false,
            error: {
              code: 'rate_limited',
              message: `proactive group message budget (${cap}/day) used up for ${day}`,
              retryable: false,
            },
          };
        }
        // Reserve before awaiting so concurrent sends cannot both pass the cap.
        used.set(key, sentToday + 1);
        countedIds.add(message.id);
      }

      const result = await channel.sendGroup(conversationId, message, forward);

      if (counted && !result.ok) {
        used.set(key, Math.max(0, (used.get(key) ?? 1) - 1));
        countedIds.delete(message.id);
      }
      // One audit event per urgent message: a retried send that the inner
      // channel answered idempotently is not a second send.
      if (urgent && result.ok && !auditedUrgentIds.has(message.id)) {
        auditedUrgentIds.add(message.id);
        audit.append({
          groupId,
          tripId: tripFor(groupId),
          type: 'message.sent',
          actor: TRAV_ACTOR,
          visibility: 'group',
          payload: {
            messageId: result.value.messageId,
            conversationId,
            lane: 'group',
            urgent: true,
            budgetExempt: true,
            day,
            cap,
            sentToday: used.get(key) ?? 0,
            ...(message.card ? { cardType: message.card.type, cardId: message.card.cardId } : {}),
          },
        });
      }
      return result;
    },
  };
}

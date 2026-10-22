/**
 * Shared types for the channel implementations in `channel/` (simulator,
 * keyword fallback, message-budget decorator, transcript printer).
 */
import { DM_ONLY_CARD_TYPES } from '@trav/core';
import type { AuditEventInput, OutboundMessage, RichCard } from '@trav/core';
import type { SendOptions } from '../interfaces/channel.js';

/**
 * `SendOptions` plus channel rendering hints set by decorators. Channels that
 * do not understand a hint ignore it (a text-only channel has nothing better to
 * do with a long message than send its text).
 */
export interface ChannelSendOptions extends SendOptions {
  /**
   * Set by `withMessageBudget` when a card-less group message exceeds the line
   * cap (G-03, VOICE §3.1): channels with `richCards` render the text inside a
   * plain card panel instead of a bubble.
   */
  readonly renderAsCard?: boolean;
}

/**
 * Where the channel layer writes audit events. `AuditRepository` satisfies it
 * (the repository fills id/ts/prevHash/hash).
 */
export interface AuditSink {
  append(input: AuditEventInput): unknown;
}

/** VOICE §5 card invariants: these cards may only travel on the DM lane. */
export function isDmOnlyCard(card: RichCard): boolean {
  if (DM_ONLY_CARD_TYPES.includes(card.type)) return true;
  if (card.type === 'expense_confirm') {
    if (card.visibility === 'private') return true;
    return (card.digestItems ?? []).some((item) => item.visibility === 'private');
  }
  return false;
}

/** True if the message carries anything that must never reach the group lane. */
export function isDmOnlyMessage(message: OutboundMessage): boolean {
  return message.card !== undefined && isDmOnlyCard(message.card);
}

/** Number of rendered lines in a message body (`\n`, `\r\n` both count once). */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

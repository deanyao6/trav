/**
 * `get_my_pending_items` (dmOnly). The sender's own "looks shared?" queue,
 * field-stripped: amount, owner-editable merchant name, time, category and the
 * low-confidence flag. Never raw descriptors, card numbers or document text
 * (SAFETY §2.3). The registry refuses this tool on the group lane.
 */
import type { MemberId } from '@trav/core';
import { formatMoney } from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import type { ToolDefinition } from './registry.js';
import { asRecord, requireMember } from './shared.js';

export interface PendingItemView {
  readonly id: string;
  readonly source: 'card' | 'email' | 'receipt';
  readonly amountMinor: number;
  readonly currency: string;
  readonly amount: string;
  readonly merchant: string;
  readonly occurredAt: string;
  readonly category: string;
  readonly lowConfidence: boolean;
  readonly looksShared: boolean | null;
  readonly suggestedParticipants: readonly MemberId[];
  /**
   * T-135: the ride receipt's rider count when the card asks the owner who
   * rode (`suggestedParticipants` is then empty: there is no proposed split).
   * Null otherwise.
   */
  readonly ridersToName: number | null;
  /** T-135: the receipt's rider count on a ride card that proposed a split; null otherwise. */
  readonly receiptRiders: number | null;
}

export const getMyPendingItemsTool: ToolDefinition<
  Record<string, never>,
  { readonly items: readonly PendingItemView[] }
> = {
  name: 'get_my_pending_items',
  description:
    "The sender's own card charges and receipts that look shared and are waiting for their 👍. Private thread only; never mention another member's items.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse: (raw) => {
    asRecord(raw);
    return {};
  },
  dmOnly: true,
  async handler(_input, ctx) {
    const me = requireMember(ctx);
    const rows = ctx.stores.private.listPendingItems(me.memberId, ctx.groupId, 'pending');
    // Built field by field so nothing branded or stripped can leak through a spread.
    const items: PendingItemView[] = rows.map((r) => ({
      id: r.id,
      source: r.source,
      amountMinor: r.amount.amountMinor,
      currency: r.amount.currency,
      amount: formatMoney(r.amount),
      merchant: sanitizeInline(r.merchantDisplay, 60),
      occurredAt: r.occurredAt,
      category: r.category,
      lowConfidence: r.lowConfidence,
      looksShared: r.classifier?.looksShared ?? null,
      suggestedParticipants: r.suggestedParticipants ?? [],
      ridersToName: r.ridersToName ?? null,
      receiptRiders: r.receiptRiders ?? null,
    }));
    return { items };
  },
};

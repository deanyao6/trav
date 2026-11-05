/**
 * T-213: the outbound half of the DM-text guard (`laneText.ts`). Wraps the
 * agent's `TurnSender` so every message addressed to the group is checked
 * before the channel (or any injected sender) sees it. DMs and reactions pass
 * through untouched. Two kinds of group message, two rules (r2):
 *
 *  - **Model-written text** (the chat loop's own reply, `isModelText`): the
 *    model is the one thing that could carry a DM across, so a reply that
 *    holds a member's DM-only wording is never sent, in every voice mode: it
 *    is replaced by `PRIVATE_REPLY_FALLBACK` (an @trav never gets silence),
 *    and one `content.suppressed` per owner records it (`private_text_in_group`,
 *    `detail: 'replaced'`, owner-visible, ids only, never the words). The
 *    match is `strict` (three content words in a row, or a run of 4+ DM
 *    words): group prompts are already redacted, so what is left is a
 *    verbatim leak, never everyday overlap like "the qr codes".
 *  - **Code-rendered messages** (receipts, cards, expense notices, recaps,
 *    Wrapped, the family notice): Trav's template wording and provider
 *    strings (venues, tiers, listings) are never checked, and the message is
 *    never dropped: a receipt for a completed purchase always posts. Only the
 *    fields a member wrote are checked (`memberSuppliedStrings`: the
 *    description and line labels of a chat-logged expense, an exclusion
 *    reason on a proposal card). A hit is redacted to `[private]` in place,
 *    everywhere in the message, and audited the same way with
 *    `detail: 'redacted'`.
 *
 * A code-rendered group message that did go out is public from then on
 * (`notePublic`), the same as a member's words in the group thread. A model
 * reply never is: one that slipped a short DM phrase past `strict` must not
 * make it public everywhere.
 */
import type {
  AuditEventInput,
  Outbound,
  OutboundMessage,
  RichCard,
  Stores,
  TripId,
} from '@trav/core';
import { isReaction } from '@trav/core';
import type { TurnSender } from '../loop.js';
import type { LaneTextGuard } from './laneText.js';

export const PRIVATE_TEXT_CAUSE = 'private_text_in_group' as const;

/** Sent in place of a model reply that carries DM-only wording (VOICE: short, lowercase, no blame). */
export const PRIVATE_REPLY_FALLBACK = "can't help with that one here. ask me another way?";

/** Keys whose values are ids, urls or flags, never words a member wrote. */
const SKIP_KEY = /(?:^id$|Id$|Ids$|^type$|^kind$|^url$|Url$|^sha256$|^imageRef$|^mode$)/u;

/** Every human-readable string of a group message: text, card fields, action labels. */
export function messageStrings(message: OutboundMessage): string[] {
  const out: string[] = [message.text];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      out.push(v);
      return;
    }
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SKIP_KEY.test(k)) continue;
      walk(x, depth + 1);
    }
  };
  if (message.card !== undefined) walk(message.card, 0);
  if (message.actions !== undefined) walk(message.actions, 0);
  return out;
}

/** The same message with `fn` applied to every human-readable string (ids, urls and flags untouched). */
function mapStrings(message: OutboundMessage, fn: (s: string) => string): OutboundMessage {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return fn(v);
    if (depth > 12 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x: unknown) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SKIP_KEY.test(k) ? x : walk(x, depth + 1);
    }
    return out;
  };
  return {
    ...message,
    text: fn(message.text),
    ...(message.card !== undefined ? { card: walk(message.card, 0) as RichCard } : {}),
    ...(message.actions !== undefined
      ? { actions: walk(message.actions, 0) as NonNullable<OutboundMessage['actions']> }
      : {}),
  };
}

/**
 * The strings in a code-rendered group message that a member wrote, as
 * stored: the description and line labels of chat-logged expenses (the ones a
 * notice, card, recap or Wrapped can quote), and a proposal card's exclusion
 * reasons. Booking, receipt-photo and confirmed card/email expenses are
 * provider or owner-confirmed text and are left alone.
 */
export function memberSuppliedStrings(
  stores: Stores,
  tripId: TripId | null,
  message: OutboundMessage,
): string[] {
  const out = new Set<string>();
  const add = (s: string | undefined): void => {
    if (s !== undefined && s.trim().length > 0) out.add(s);
  };
  const expenses = new Map<string, { source: string; texts: string[] }>();
  const note = (e: ReturnType<Stores['group']['expenses']['get']>): void => {
    if (e === undefined || e.source !== 'chat') return;
    const texts = [e.description];
    if (e.split.method === 'itemized') for (const li of e.split.lineItems) texts.push(li.label);
    expenses.set(e.expenseId, { source: e.source, texts });
  };
  if (tripId !== null)
    for (const e of stores.group.expenses.listByTrip(tripId, { includeUndone: true })) note(e);
  for (const id of message.noticeExpenseIds ?? []) note(stores.group.expenses.get(id));
  for (const e of expenses.values()) for (const t of e.texts) add(t);
  const card = message.card;
  if (card?.type === 'booking_proposal') for (const x of card.excluded ?? []) add(x.reason);
  if (card?.type === 'expense_confirm' && card.source === 'chat') {
    add(card.description);
    for (const li of card.lineItems ?? []) add(li.label);
  }
  return [...out];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export interface GroupTextGuardOptions {
  /** True for a draft the model wrote (the chat loop's reply); everything else is code-rendered. */
  readonly isModelText: (o: Outbound) => boolean;
}

export function guardGroupText(
  inner: TurnSender,
  guard: LaneTextGuard,
  stores: Stores,
  opts: GroupTextGuardOptions,
): TurnSender {
  return async (outbounds, ctx) => {
    const groupId = ctx.group.groupId;
    const tripId = ctx.trip?.tripId ?? null;
    const audit = (o: Outbound, owners: readonly string[], detail: 'redacted' | 'replaced') => {
      const payload: Record<string, unknown> = {
        cause: PRIVATE_TEXT_CAUSE,
        messageDraftId: o.id,
        lane: 'group',
        ...(!isReaction(o) && o.card !== undefined ? { cardType: o.card.type } : {}),
        ...(detail !== undefined ? { detail } : {}),
      };
      for (const ownerId of owners) {
        const event: AuditEventInput = {
          groupId,
          tripId,
          type: 'content.suppressed',
          actor: { kind: 'trav', id: 'trav' },
          visibility: 'owner',
          ownerId,
          payload,
        };
        stores.group.audit.append(event);
      }
      return payload;
    };

    const toSend: Outbound[] = [];
    // Model replies never make wording public (r2 review #3): a reply that
    // slipped a short DM phrase past `strict` must not unlock it everywhere.
    const modelDrafts = new Set<string>();
    for (const o of outbounds) {
      if (isReaction(o) || o.to.kind !== 'group') {
        toSend.push(o);
        continue;
      }
      if (opts.isModelText(o)) {
        const owners = new Set<string>();
        for (const s of messageStrings(o))
          for (const span of guard.leaks(groupId, s, 'strict'))
            for (const id of span.ownerIds) owners.add(id);
        if (owners.size === 0) {
          modelDrafts.add(o.id);
          toSend.push(o);
          continue;
        }
        // The reply is replaced, never sent and never dropped to silence: an
        // @trav always gets an answer, and the answer carries nothing of the
        // DM (a partial redaction would still show its shape).
        audit(o, [...owners].sort(), 'replaced');
        const fallback: Outbound = {
          id: o.id,
          groupId: o.groupId,
          to: o.to,
          text: PRIVATE_REPLY_FALLBACK,
        };
        modelDrafts.add(fallback.id);
        toSend.push(fallback);
        continue;
      }
      // Code-rendered: redact what a member wrote, in place; never drop.
      const owners = new Set<string>();
      const hits: string[] = [];
      for (const s of memberSuppliedStrings(stores, tripId, o)) {
        const spans = guard.leaks(groupId, s);
        if (spans.length === 0) continue;
        hits.push(s);
        for (const span of spans) for (const id of span.ownerIds) owners.add(id);
      }
      if (hits.length === 0) {
        toSend.push(o);
        continue;
      }
      const re = new RegExp(
        hits
          .sort((a, b) => b.length - a.length)
          .map(escapeRe)
          .join('|'),
        'giu',
      );
      const redacted = mapStrings(o, (s) => s.replace(re, (m) => guard.redact(groupId, m)));
      audit(o, [...owners].sort(), 'redacted');
      toSend.push(redacted);
    }

    const sent = toSend.length === 0 ? [] : await inner(toSend, ctx);
    // What Trav actually said in the group thread is public from then on, like
    // a member's group message: a later DM that repeats it ("still got
    // razzmatazz tickets?") must not hold back the next group reply about it.
    for (const s of sent) {
      if (s.sent === null || isReaction(s.outbound) || s.outbound.to.kind !== 'group') continue;
      if (modelDrafts.has(s.outbound.id)) continue;
      for (const text of messageStrings(s.outbound)) guard.notePublic(groupId, text);
    }
    return sent;
  };
}

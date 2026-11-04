/**
 * The owner's answer to a "looks shared?" DM (T-013; VOICE §4.5, §3.6, §3.7;
 * SAFETY §2.3 promotion, §2.5 identity). Shared by every private source
 * (card charges here, email receipts and receipt scans from `intake.ts`).
 *
 * Who may answer: only the item's owner, identified by the channel sender
 * (never by a display name), in their own DM. Everything else on a "looks
 * shared?" card (another member's tap, a stale card, a group-lane tapback) is
 * ignored silently. The pending item is found in the SENDER's own private
 * store by the card it was prompted on (`item.cardMessageId`), so a
 * non-owner can never even reach someone else's item.
 *
 * What counts as an answer (VOICE §3.6):
 *  - Share it: the `confirm` button, a 👍 tapback, or typed "share it" /
 *    "yes" / "yep" in the DM;
 *  - Keep private: the `keep_private` button, a 👎 tapback, or typed
 *    "keep private" / "keep it private" / "just me" / "no" / "nah".
 * A typed answer that is not a reply to a card binds to the one live card in
 * the DM; with several live cards Trav asks which one (one line).
 *
 * Share ⇒ `promote()` (the only private → group path) with the split the DM
 * showed: an equal split among `item.suggestedParticipants` (set by
 * `sharePlan` when the item was ingested), the expense goes on the ledger with
 * `sourceRef: { kind: 'private_item' }`, `ledger.entry_created` +
 * `private.item_promoted` are written, the raw descriptor is purged, and the
 * owner gets the VOICE §4.4 logged line in their DM. Per VOICE §3.7 the group
 * sees it in the next recap or settle-up, never as an immediate ping.
 * Keep private ⇒ the item is dismissed (`private.item_dismissed`), raw input
 * purged, and nothing is said (a typed "keep private" gets a 👍 tapback).
 *
 * The split rule (`sharePlan`, used at ingestion so the DM and the tab agree):
 *  1. the charge falls in the window of a plan (an activity that is not the
 *     lodging or a flight: start − 1h to end + 2h, end defaulting to start +
 *     3h) whose roster has the owner `in` with at least one other member ⇒
 *     the members marked `in` ("the 5 who went"); the latest such plan wins;
 *  2. otherwise everyone active on the trip ("everyone").
 */
import type {
  Clock,
  Expense,
  ExpenseCategory,
  Group,
  GroupId,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  MessageId,
  Money,
  Outbound,
  OutboundMessage,
  PendingPrivateItem,
  PrivateItem,
  ReceiptSourceKind,
  RichCard,
  Stores,
  Trip,
  TripRepository,
} from '@trav/core';
import {
  addMinutes,
  ledger,
  markPrivate,
  parseIso,
  promote,
  safety,
  strippedFieldsFor,
  TravError,
} from '@trav/core';
import type { InboundEvent } from '@trav/adapters';
import { renderSharedToTab } from '../render/expenseConfirm.js';
import type { RenderContext } from '../render/common.js';
import { plansAt, type ActivityWindow } from './looksShared.js';

// ---------- the split plan ----------

export interface SharePlan {
  /** Who the charge would be split with, owner included, group order. */
  readonly participants: readonly MemberId[];
  /** "the 5 who went" / "everyone"; undefined ⇒ the renderer lists names. */
  readonly label?: string;
  /** A recognizer line: "that the ride back from razzmatazz?". */
  readonly guess?: string;
  readonly activityId?: string;
}

/** Active, non-guest members in group order. */
export function activeMembers(members: readonly Member[]): Member[] {
  return members.filter((m) => m.active && m.leftAt === undefined && m.role !== 'guest');
}

/** The trip's plans with their rosters (members marked `in`), for the classifier and the split rule. */
export function activityWindows(
  trips: Pick<TripRepository, 'listActivities' | 'listAttendance'>,
  trip: Trip | null,
  members: readonly Member[],
): (ActivityWindow & { readonly activityId: string })[] {
  if (trip === null) return [];
  const order = activeMembers(members).map((m) => m.memberId);
  return trips.listActivities(trip.tripId).map((a) => {
    const inIds = new Set(
      trips
        .listAttendance(a.activityId)
        .filter((r) => r.status === 'in')
        .map((r) => r.memberId),
    );
    return {
      activityId: a.activityId,
      name: a.name,
      kind: a.kind,
      ...(a.startsAt !== undefined ? { startsAt: a.startsAt } : {}),
      ...(a.endsAt !== undefined ? { endsAt: a.endsAt } : {}),
      inMemberIds: order.filter((id) => inIds.has(id)),
    };
  });
}

export interface SharePlanInput {
  readonly trips: Pick<TripRepository, 'listActivities' | 'listAttendance'>;
  readonly trip: Trip | null;
  readonly members: readonly Member[];
  readonly ownerMemberId: MemberId;
  readonly occurredAt: IsoDateTime;
  readonly category: ExpenseCategory;
}

/** The default split for a shared private item (rule in the module comment). */
export function sharePlan(input: SharePlanInput): SharePlan {
  const everyone = activeMembers(input.members).map((m) => m.memberId);
  const plans = plansAt(activityWindows(input.trips, input.trip, input.members), input.occurredAt)
    .filter((p) => p.inMemberIds.includes(input.ownerMemberId) && p.inMemberIds.length >= 2)
    .sort((a, b) => parseIso(b.startsAt!) - parseIso(a.startsAt!));
  const plan = plans[0];
  if (plan === undefined) {
    return { participants: everyone, ...(everyone.length > 2 ? { label: 'everyone' } : {}) };
  }
  const started = parseIso(input.occurredAt) >= parseIso(plan.startsAt!);
  const n = plan.inMemberIds.length;
  const all = n === everyone.length;
  const name = plan.name.toLowerCase();
  return {
    participants: plan.inMemberIds,
    label: all ? 'everyone' : `the ${String(n)} ${started ? 'who went' : 'going'}`,
    ...(input.category === 'transport'
      ? { guess: started ? `that the ride back from ${name}?` : `that the ride to ${name}?` }
      : {}),
    activityId: plan.activityId,
  };
}

// ---------- one charge seen by two sources (card and email, T-012 r1 #1/#3) ----------

/** Same amount and currency this close together: one charge (the rule both flows always used). */
export const SAME_CHARGE_WINDOW_H = 48;
/**
 * A charge in another currency (a USD card paying a EUR ride): same ledger
 * category this close together, with real times on both sides and amounts
 * that agree at a rough rate, is one charge.
 */
export const CROSS_CURRENCY_WINDOW_MIN = 15;
/** How far a converted amount may be from the other one (card FX fees, rate drift). */
export const CROSS_CURRENCY_TOLERANCE = 0.12;
/**
 * Rough units per 1 EUR, only for telling one charge from another (never for
 * money on the tab). A currency not listed never matches across currencies.
 */
const ROUGH_PER_EUR: Readonly<Record<string, number>> = {
  EUR: 1,
  USD: 1.08,
  GBP: 0.86,
  CAD: 1.46,
  CHF: 0.95,
};

export interface ChargeFacts {
  readonly amount: Money;
  readonly occurredAt: IsoDateTime;
  readonly category: ExpenseCategory;
  /** `false` when `occurredAt` is a date-only placeholder. */
  readonly timeKnown?: boolean;
}

/**
 * Card charge and email receipt for one purchase (the owner's own store, so
 * the owner is always the same): the same money within 48h, or, when the
 * currencies differ, the same category within 15 minutes with real times on
 * both sides and amounts within 12% at a rough rate. Two different charges
 * must never merge (that would drop a shared expense), so anything unsure
 * stays two (T-012 r2 review #1, #3).
 */
export function sameCharge(a: ChargeFacts, b: ChargeFacts): boolean {
  const apartMs = Math.abs(parseIso(a.occurredAt) - parseIso(b.occurredAt));
  if (a.amount.currency === b.amount.currency) {
    return (
      a.amount.amountMinor === b.amount.amountMinor && apartMs <= SAME_CHARGE_WINDOW_H * 3_600_000
    );
  }
  if (a.timeKnown === false || b.timeKnown === false) return false;
  if (a.category !== b.category || apartMs > CROSS_CURRENCY_WINDOW_MIN * 60_000) return false;
  const ra = ROUGH_PER_EUR[a.amount.currency];
  const rb = ROUGH_PER_EUR[b.amount.currency];
  if (ra === undefined || rb === undefined) return false;
  const aEur = a.amount.amountMinor / ra;
  const bEur = b.amount.amountMinor / rb;
  if (aEur <= 0 || bEur <= 0) return false;
  return Math.abs(aEur - bEur) / Math.max(aEur, bEur) <= CROSS_CURRENCY_TOLERANCE;
}

/** The expense's own charge facts, in both its amount and its original currency. */
function expenseCharges(e: Expense): ChargeFacts[] {
  const base = { occurredAt: e.occurredAt, category: e.category };
  return [
    { ...base, amount: e.amount },
    ...(e.original !== undefined ? [{ ...base, amount: e.original.amount }] : []),
  ];
}

/** A logged expense that came from the OTHER private source and is this charge. */
export function expenseIsCharge(
  e: Expense,
  otherSource: Expense['source'],
  facts: ChargeFacts,
): boolean {
  return e.source === otherSource && expenseCharges(e).some((c) => sameCharge(c, facts));
}

/**
 * The owner was already asked about this charge through the other source:
 * an item still waiting, shared, kept private or expired (VOICE §2: one
 * question per charge). Owner-scoped: it only reads the owner's own store.
 */
export function alreadyAskedElsewhere(
  stores: Pick<Stores, 'private'>,
  ownerMemberId: MemberId,
  groupId: GroupId,
  otherSource: PendingPrivateItem['source'],
  facts: ChargeFacts,
): boolean {
  return (
    stores.private
      .listPendingItems(ownerMemberId, groupId)
      // An item Trav dropped (consent off, owner not eligible) was never answered (r2 review #2).
      .some((i) => i.source === otherSource && i.droppedBy === undefined && sameCharge(i, facts))
  );
}

// ---------- matching an inbound event to a pending item ----------

export type ShareIntent = 'share' | 'keep';

export type ShareMatch =
  | {
      readonly kind: 'answer';
      readonly intent: ShareIntent;
      readonly via: 'button' | 'reaction' | 'text';
      readonly item: PendingPrivateItem;
      /** The inbound event's message id (the tap, the tapback, the typed reply). */
      readonly messageId: MessageId;
      readonly sender: string;
      readonly typed: boolean;
    }
  /** A typed answer with several live cards: ask which one. */
  | { readonly kind: 'which' }
  /** A "looks shared?" card was touched by someone who may not answer it, or it is no longer live. */
  | { readonly kind: 'ignore'; readonly note: string };

const SHARE_TEXT = /^\s*(?:share it|share|yes|yep|yeah|split it)\s*[.!]*\s*$/i;
const KEEP_TEXT =
  /^\s*(?:keep (?:it )?private|just me|keep it off|no|nah|nope|keep it)\s*[.!]*\s*$/i;
const SHARE_REACTIONS = new Set(['👍', 'like']);
const KEEP_REACTIONS = new Set(['👎', 'dislike']);

/** A "looks shared?" card: pending, private, owner-only (VOICE §4.5, §5). */
export function isLooksSharedCard(card: RichCard | undefined): boolean {
  return (
    card?.type === 'expense_confirm' && card.status === 'pending' && card.visibility === 'private'
  );
}

export interface ShareMatchInput {
  readonly event: InboundEvent;
  /** The channel-resolved sender (null: not a member of this group). */
  readonly me: Member | null;
  readonly groupId: GroupId;
  /** Trav's card behind a message id, when this agent sent it. */
  readonly cardOf: (messageId: MessageId) => RichCard | undefined;
}

/**
 * `undefined` ⇒ not an answer to a "looks shared?" card; the loop carries on.
 * Never reads another member's private store: the lookup is the sender's own.
 */
export function matchShareAnswer(
  stores: Pick<Stores, 'private'>,
  input: ShareMatchInput,
): ShareMatch | undefined {
  const { event, me } = input;
  const read = readAnswer(event);
  if (read === undefined) return undefined;
  const { intent, target, value, via } = read;

  const answer = (it: PendingPrivateItem): ShareMatch =>
    it.status !== 'pending'
      ? { kind: 'ignore', note: `looks_shared:already_${it.status}` }
      : {
          kind: 'answer',
          intent: intent!,
          via,
          item: it,
          messageId: read.messageId,
          sender: read.sender,
          typed: via === 'text',
        };
  const mine = (): PendingPrivateItem[] =>
    me === null ? [] : [...stores.private.listPendingItems(me.memberId, input.groupId)];

  if (target === undefined) {
    // A typed answer with no quoted card: the one live card in this DM.
    const live = mine().filter((i) => i.status === 'pending' && i.cardMessageId !== undefined);
    if (live.length === 0) return undefined;
    if (live.length > 1) return { kind: 'which' };
    return answer(live[0]!);
  }

  const card = input.cardOf(target);
  const onCard = mine().filter((i) => i.cardMessageId === target);
  if (onCard.length === 0) {
    if (!isLooksSharedCard(card)) return undefined;
    // Someone else's card, or a card that was replaced (pending → posted).
    const owner = card?.type === 'expense_confirm' ? card.paidBy : undefined;
    return {
      kind: 'ignore',
      note: owner !== me?.memberId ? 'looks_shared:not_owner' : 'looks_shared:stale_card',
    };
  }
  if (intent === undefined) return { kind: 'ignore', note: 'looks_shared:not_an_answer' };
  // The card can only be answered where it was sent: the owner's DM (SAFETY §2.3).
  if (event.lane !== 'dm') return { kind: 'ignore', note: 'looks_shared:group_lane' };
  if (value !== undefined && value !== '') {
    const item = onCard.find((i) => i.id === value);
    return item === undefined
      ? { kind: 'ignore', note: 'looks_shared:unknown_item' }
      : answer(item);
  }
  if (onCard.length === 1) return answer(onCard[0]!);
  // A tapback or typed reply on a digest: fine only when one line is still open.
  const live = onCard.filter((i) => i.status === 'pending');
  if (live.length === 1) return answer(live[0]!);
  return via === 'text' ? { kind: 'which' } : { kind: 'ignore', note: 'looks_shared:ambiguous' };
}

interface ReadAnswer {
  readonly intent: ShareIntent | undefined;
  readonly target: MessageId | undefined;
  readonly value: string | undefined;
  readonly via: 'button' | 'reaction' | 'text';
  readonly messageId: MessageId;
  readonly sender: string;
}

/** What an inbound event says, if it could be an answer at all. */
function readAnswer(event: InboundEvent): ReadAnswer | undefined {
  switch (event.type) {
    case 'button_tap':
      return {
        intent:
          event.actionId === 'confirm'
            ? 'share'
            : event.actionId === 'keep_private'
              ? 'keep'
              : undefined,
        target: event.cardMessageId,
        value: event.value,
        via: 'button',
        messageId: event.messageId,
        sender: event.sender,
      };
    case 'reaction':
      if (event.removed) return undefined;
      return {
        intent: SHARE_REACTIONS.has(event.reaction)
          ? 'share'
          : KEEP_REACTIONS.has(event.reaction)
            ? 'keep'
            : undefined,
        target: event.targetMessageId,
        value: undefined,
        via: 'reaction',
        messageId: event.messageId,
        sender: event.sender,
      };
    case 'message': {
      if (event.lane !== 'dm') return undefined;
      const intent = SHARE_TEXT.test(event.text)
        ? 'share'
        : KEEP_TEXT.test(event.text)
          ? 'keep'
          : undefined;
      if (intent === undefined) return undefined;
      return {
        intent,
        target: event.replyToMessageId,
        value: undefined,
        via: 'text',
        messageId: event.messageId,
        sender: event.sender,
      };
    }
    default:
      return undefined;
  }
}

// ---------- acting on the answer ----------

export interface ShareAnswerDeps {
  readonly stores: Stores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface ShareAnswerContext {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly me: Member;
}

export interface ShareAnswerOutcome {
  readonly drafts: readonly Outbound[];
  readonly note: string;
  readonly expenseId?: string;
}

/** VOICE §4.11: one line, when a typed answer could mean several cards. */
export const WHICH_CHARGE_TEXT = 'which one? tap Share it or Keep private on the charge you mean';
/** VOICE §4.10: honest about what Trav cannot do yet (T-031 converts currencies). */
export function needsConversionText(itemCurrency: string, tripCurrency: string): string {
  return `that one's in ${itemCurrency} and the tab is in ${tripCurrency}. i can't convert it yet, so it's still just yours`;
}
export const NO_TRIP_TEXT = "there's no trip on right now, so that one stays just yours";
/** A tap on a card whose import was turned off since (T-013 r2 #2; T-012 for email). */
export const CARD_IMPORT_OFF_TEXT =
  'card import is off, so i dropped that charge. nothing went on the tab';
export const EMAIL_IMPORT_OFF_TEXT =
  'email import is off, so i dropped that receipt. nothing went on the tab';

export type ImportEligibility = 'ok' | 'minor' | 'not_eligible';

/**
 * Who a private import (card charges, email receipts) may run for: never a
 * minor (fixtures README, VOICE §6.1), and otherwise only someone who can
 * answer the DM: an active, non-guest member known to be 18+.
 */
export function importEligibility(owner: Member, now: IsoDateTime): ImportEligibility {
  if (safety.isMinor(owner, now)) return 'minor';
  const eligible =
    owner.active &&
    owner.leftAt === undefined &&
    owner.role !== 'guest' &&
    safety.isConfirmedAdult(owner, now);
  return eligible ? 'ok' : 'not_eligible';
}

const CATEGORY_TO_RECEIPT_KIND: Readonly<Record<ExpenseCategory, ReceiptSourceKind>> = {
  tickets: 'tickets',
  flights: 'airline',
  lodging: 'lodging',
  food: 'restaurant',
  drinks: 'bar',
  transport: 'taxi',
  groceries: 'grocery',
  activities: 'other',
  other: 'other',
};

/**
 * The private row `promote()` takes. The stored source row when it exists and
 * still matches what the owner was shown; otherwise a row built from the
 * pending item's own (already display-safe) facts, so what reaches the tab is
 * exactly what the owner confirmed.
 */
function promotable(stores: Stores, item: PendingPrivateItem): PrivateItem {
  const owner = item.ownerMemberId;
  const same = (a: { amountMinor: number; currency: string }): boolean =>
    a.amountMinor === item.amount.amountMinor && a.currency === item.amount.currency;
  if (item.source === 'card') {
    const tx = stores.private.getCardTransaction(owner, item.sourceItemId);
    if (tx !== undefined && same(tx.amount) && tx.direction === 'debit') {
      return markPrivate({ ...tx, merchantDisplay: item.merchantDisplay, category: item.category });
    }
    return markPrivate({
      id: item.id,
      ownerMemberId: owner,
      groupId: item.groupId,
      tripId: item.tripId,
      createdAt: item.createdAt,
      providerTransactionId: item.sourceItemId,
      accountId: '',
      last4: '',
      postedAt: item.occurredAt,
      amount: item.amount,
      direction: 'debit' as const,
      pending: false,
      merchantRaw: '',
      merchantDisplay: item.merchantDisplay,
      category: item.category,
    });
  }
  const parsed = {
    source: CATEGORY_TO_RECEIPT_KIND[item.category],
    merchantName: item.merchantDisplay,
    total: item.amount,
    occurredAt: item.occurredAt,
    confidence: item.lowConfidence ? 0.5 : 1,
    warnings: [],
  };
  if (item.source === 'email') {
    const email = stores.private.getEmailReceipt(owner, item.sourceItemId);
    if (email?.parsed != null && same(email.parsed.total)) return email;
    return markPrivate({
      id: item.id,
      ownerMemberId: owner,
      groupId: item.groupId,
      tripId: item.tripId,
      createdAt: item.createdAt,
      emailId: item.sourceItemId,
      receivedAt: item.createdAt,
      sender: '',
      subject: '',
      bodyText: '',
      parsed,
      injectionDetected: item.lowConfidence,
    });
  }
  const scan = stores.private.getReceiptScan(owner, item.sourceItemId);
  if (scan?.parsed != null && same(scan.parsed.total)) return scan;
  return markPrivate({
    id: item.id,
    ownerMemberId: owner,
    groupId: item.groupId,
    tripId: item.tripId,
    createdAt: item.createdAt,
    imageRef: '',
    ocrText: '',
    parsed,
    injectionDetected: item.lowConfidence,
  });
}

/**
 * The owner turned the import behind this item off after it was ingested
 * (`cardImport` for card charges, `emailImport` for email receipts; a receipt
 * photo the owner sent needs no import consent). No consent record means
 * nothing was revoked: the document-intake path is consent-gated by its caller.
 */
export function consentRevokedSince(
  stores: Pick<Stores, 'private'>,
  item: PendingPrivateItem,
): boolean {
  if (item.source === 'receipt') return false;
  const consent = stores.private.getConsent(item.ownerMemberId, item.groupId);
  if (consent === undefined) return false;
  const on = item.source === 'card' ? consent.cardImport : consent.emailImport;
  return !on && parseIso(consent.updatedAt) >= parseIso(item.createdAt);
}

export function answerShare(
  deps: ShareAnswerDeps,
  match: Extract<ShareMatch, { kind: 'answer' }>,
  ctx: ShareAnswerContext,
): ShareAnswerOutcome {
  const { stores, clock, ids } = deps;
  const now = clock.now();
  const { item } = match;
  const owner = ctx.me;
  // Defense in depth: the lookup was the sender's own store already.
  if (item.ownerMemberId !== owner.memberId || owner.senderId !== match.sender) {
    throw new TravError('not_owner', 'only the owner can answer a looks-shared card', {
      itemId: item.id,
    });
  }
  const dmTo = { kind: 'member' as const, memberId: owner.memberId };
  const line = (text: string): OutboundMessage => ({
    id: ids.next('msg'),
    groupId: ctx.group.groupId,
    to: dmTo,
    text,
  });
  const ack = (): Outbound[] =>
    match.typed
      ? [
          {
            id: ids.next('msg'),
            groupId: ctx.group.groupId,
            kind: 'reaction',
            to: dmTo,
            targetMessageId: match.messageId,
            emoji: '👍',
          },
        ]
      : [];
  const audit = (
    input: Omit<Parameters<Stores['group']['audit']['append']>[0], 'groupId'>,
  ): void => {
    stores.group.audit.append({ groupId: ctx.group.groupId, ...input });
  };

  if (consentRevokedSince(stores, item)) {
    // SAFETY §2.6: the import was turned off after this card went out; the item goes, whatever the answer.
    dropPendingItems({ stores, clock }, owner.memberId, ctx.group.groupId, item.source);
    // one line so the tap doesn't look ignored (T-013 r2 #2)
    return {
      drafts: [line(item.source === 'email' ? EMAIL_IMPORT_OFF_TEXT : CARD_IMPORT_OFF_TEXT)],
      note: 'looks_shared:consent_off',
    };
  }

  if (match.intent === 'keep') {
    stores.private.putPendingItem(
      owner.memberId,
      markPrivate({ ...item, status: 'dismissed' as const }),
    );
    audit({
      tripId: item.tripId,
      type: 'private.item_dismissed',
      actor: { kind: 'member', id: owner.memberId },
      visibility: 'owner',
      ownerId: owner.memberId,
      payload: { itemId: item.id, via: match.via, messageId: match.messageId },
    });
    stores.private.purgeRawInputs(owner.memberId, addMinutes(now, 1));
    return { drafts: ack(), note: 'looks_shared:kept_private' };
  }

  const trip =
    (item.tripId !== null ? stores.group.trips.get(item.tripId) : undefined) ??
    ctx.trip ??
    undefined;
  if (trip === undefined) return { drafts: [line(NO_TRIP_TEXT)], note: 'looks_shared:no_trip' };
  if (item.amount.currency !== trip.currency) {
    return {
      drafts: [line(needsConversionText(item.amount.currency, trip.currency))],
      note: 'looks_shared:needs_conversion',
    };
  }

  // The split the DM showed (`sharePlan` at ingestion), minus anyone who left since.
  const active = activeMembers(ctx.members).map((m) => m.memberId);
  const shown = (item.suggestedParticipants ?? []).filter((id) => active.includes(id));
  const participants = shown.length >= 1 ? shown : active;
  const source = promotable(stores, item);
  const promoted = promote(
    source,
    {
      senderId: match.sender,
      memberId: owner.memberId,
      messageId: match.messageId,
      via: match.via,
      at: now,
      split: { method: 'equal', participants },
    },
    {
      expenseId: ids.next('exp'),
      groupId: ctx.group.groupId,
      tripId: trip.tripId,
      tripCurrency: trip.currency,
      ownerSenderId: owner.senderId,
      now,
      defaultSplit: { method: 'equal', participants: active },
    },
  );
  // The plan the split came from, as stored at ingestion (never re-derived: rosters move),
  // and only while the split is still exactly that roster (nobody left since).
  const expense: Expense =
    item.suggestedActivityId !== undefined &&
    participants === shown &&
    shown.length === (item.suggestedParticipants ?? []).length
      ? { ...promoted, activityId: item.suggestedActivityId }
      : promoted;
  const order = ctx.members.map((m) => m.memberId);
  const splitContext: ledger.SplitContext = { memberOrder: order, participantsUniverse: active };
  const prior = stores.group.expenses.getBySourceRef(expense.sourceRef);
  if (prior !== undefined) {
    // Already on the tab (a replayed tap): settle the item, say nothing.
    stores.private.putPendingItem(
      owner.memberId,
      markPrivate({ ...item, status: 'promoted' as const, promotedExpenseId: prior.expenseId }),
    );
    return { drafts: [], note: 'looks_shared:already_promoted', expenseId: prior.expenseId };
  }
  const shares = ledger.computeShares(expense, splitContext);
  stores.group.expenses.create(expense, ledger.buildLedgerEntries(expense, splitContext));
  audit({
    tripId: trip.tripId,
    type: 'ledger.entry_created',
    actor: { kind: 'member', id: owner.memberId },
    visibility: 'group',
    payload: {
      expenseId: expense.expenseId,
      splitMethod: expense.split.method,
      participants: shares.filter((s) => s.amount.amountMinor !== 0).map((s) => s.memberId),
      amounts: shares.map((s) => ({ memberId: s.memberId, amountMinor: s.amount.amountMinor })),
      sourceRef: expense.sourceRef.id,
      source: expense.source,
    },
  });
  audit({
    tripId: trip.tripId,
    type: 'private.item_promoted',
    actor: { kind: 'member', id: owner.memberId },
    visibility: 'group',
    payload: {
      itemId: item.id,
      expenseId: expense.expenseId,
      strippedFields: [...strippedFieldsFor(source)],
      via: match.via,
    },
  });
  stores.private.putPendingItem(
    owner.memberId,
    markPrivate({ ...item, status: 'promoted' as const, promotedExpenseId: expense.expenseId }),
  );
  stores.private.purgeRawInputs(owner.memberId, addMinutes(now, 1));

  const rctx: RenderContext = {
    groupId: ctx.group.groupId,
    members: ctx.members,
    timeZone: trip.timeZone,
    now,
    ids,
  };
  const dm = renderSharedToTab({ expense, splitContext, ownerMemberId: owner.memberId }, rctx);
  return { drafts: [dm], note: 'looks_shared:shared', expenseId: expense.expenseId };
}

/** One line for a typed answer that could mean several cards. */
export function whichCharge(
  ids: IdGenerator,
  groupId: GroupId,
  memberId: MemberId,
): OutboundMessage {
  return {
    id: ids.next('msg'),
    groupId,
    to: { kind: 'member', memberId },
    text: WHICH_CHARGE_TEXT,
  };
}

// ---------- dropping (consent revoked) ----------

/**
 * `cardImport` (or `emailImport`) turned off: every still-pending item of that
 * source is dismissed (`private.item_dismissed`, cause `consent_revoked`), its
 * card disappears from the flow, and raw inputs are purged. Returns how many.
 * Promoted items stay on the tab (the owner already shared them).
 */
export function dropPendingItems(
  deps: Pick<ShareAnswerDeps, 'stores' | 'clock'>,
  ownerMemberId: MemberId,
  groupId: GroupId,
  source: PendingPrivateItem['source'],
  cause: 'consent_revoked' | 'not_eligible' = 'consent_revoked',
): number {
  const { stores, clock } = deps;
  const now = clock.now();
  const live = stores.private
    .listPendingItems(ownerMemberId, groupId, 'pending')
    .filter((i) => i.source === source);
  for (const item of live) {
    stores.private.putPendingItem(
      ownerMemberId,
      markPrivate({ ...item, status: 'dismissed' as const, droppedBy: cause }),
    );
    stores.group.audit.append({
      groupId,
      tripId: item.tripId,
      type: 'private.item_dismissed',
      actor: { kind: 'system', id: 'trav' },
      visibility: 'owner',
      ownerId: ownerMemberId,
      payload: { itemId: item.id, cause },
    });
  }
  if (source === 'card') {
    // No raw descriptor outlives the consent, whether or not it was ever prompted.
    for (const tx of stores.private.listCardTransactions(ownerMemberId, groupId)) {
      if (tx.merchantRaw !== '') {
        stores.private.putCardTransaction(ownerMemberId, markPrivate({ ...tx, merchantRaw: '' }));
      }
    }
  }
  if (source === 'email') {
    // Same for email: no sender, subject or body outlives the consent.
    for (const email of stores.private.listEmailReceipts(ownerMemberId, groupId)) {
      if (email.sender !== '' || email.subject !== '' || email.bodyText !== '') {
        stores.private.putEmailReceipt(
          ownerMemberId,
          markPrivate({ ...email, sender: '', subject: '', bodyText: '' }),
        );
      }
    }
  }
  stores.private.purgeRawInputs(ownerMemberId, addMinutes(now, 1));
  return live.length;
}

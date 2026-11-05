/**
 * Email receipts → owner-private store → "looks shared?" DM (T-012; SAFETY
 * §2.3, §2.4, §2.6; VOICE §4.5 C). The card flow's twin (`card.ts`), sharing
 * its classifier (`looksShared.ts`) and the answer path (`pending.ts`).
 *
 * `importEmailReceipts` runs for ONE owner at a time:
 *  1. Eligibility and consent first (same rule as card import): a minor, or
 *     anyone who could not answer the DM (a guest, an inactive or departed
 *     member, anyone not known to be 18+), or an owner whose `emailImport`
 *     flag is off (the default) ⇒ the email source is not even read, and
 *     anything still pending from an earlier import is dropped
 *     (`dropPendingItems`, source `email`).
 *  2. The owner's emails are listed from the source (owner routing is the
 *     forwarding address, never a name the email claims; a row for another
 *     owner is skipped here too). An email already seen (same `emailId` in the
 *     owner's store) is skipped, so a re-import changes nothing.
 *  3. Screening (SAFETY §2.4): sender, subject and both bodies go through
 *     `detectInjection`; the parser flags hidden and visible instruction-like
 *     text too. A bare link is not instruction-like (the parser's rule). When
 *     either fires: one owner-visible `injection.detected`, the item is
 *     low-confidence, and NOTHING from the email is quoted again: the merchant
 *     becomes a neutral name ("ride", "restaurant", ...), and the ride
 *     places, rider count and line items are dropped. The text is parsed as
 *     data (the parser builds typed fields; it never acts on content) and
 *     never reaches the tool loop or a model prompt with tools.
 *  4. Not a receipt (no total, a promo, an email claiming to be Trav) ⇒ a
 *     "seen" row with `parsed: null`, nothing else.
 *  5. The receipt is classified with the card classifier on its typed facts
 *     (category from the receipt kind, amount, time, the trip, the plans),
 *     plus the rider count (one rider ⇒ personal; several ⇒ more shared).
 *     Parsed facts are kept only for trip data (inside the trip window ±1 day,
 *     or classified shared); the rest is a seen row with `parsed: null`.
 *  6. A shared receipt becomes a `PendingPrivateItem` (split by `sharePlan`,
 *     then the receipt's rider count, `applyRiders` in `riders.ts`: when the
 *     count and the roster can't say who rode, the card asks the owner and
 *     proposes no split, T-135) unless it is already on the tab (same payer, amount and currency within
 *     48h of a logged expense; an expense from a DIFFERENT email never
 *     counts; a shared card charge for the same ride in another currency
 *     does), already asked about as a card charge (waiting, shared, kept
 *     private or expired; `sameCharge` in `pending.ts`: same money within
 *     48h, or another currency and the same category within 15 minutes), or
 *     a second copy of a receipt already stored (same kind, total and time
 *     within 10 minutes; never the display name, which a flagged forward
 *     replaces with the neutral one).
 *  7. DMs to the owner only (never a minor): one card per receipt, or one
 *     digest when two or more land together (VOICE §2: "two email receipts");
 *     a card asking who rode always goes on its own.
 *     The group sees nothing until the owner confirms, not even a count
 *     (T-112, SAFETY §2.3).
 *
 * Raw text is never stored: the seen row keeps typed fields only (sender,
 * subject and body are empty strings), so nothing outlives the parse.
 */
import type {
  Clock,
  EmailReceipt,
  ExpenseCategory,
  Group,
  GroupMessageSummary,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  Money,
  OutboundMessage,
  ParsedReceipt,
  PendingPrivateItem,
  ReceiptSourceKind,
  Stores,
  Trip,
} from '@trav/core';
import { addDays, localDate, markPrivate, parseIso, TravError } from '@trav/core';
import type {
  EmailReceiptSource,
  InboundEmail,
  ParsedEmailReceipt,
  ReceiptEmailParser,
} from '@trav/adapters';
import { EMAIL_WARNINGS } from '@trav/adapters';
import { sanitizeInline } from '../context/groupContext.js';
import type { ModelClient } from '../model/client.js';
import { renderLooksShared, type LooksSharedItem } from '../render/expenseConfirm.js';
import { detectInjection, type InjectionMatch } from '../untrusted.js';
import { cardCategory } from './card.js';
import {
  classifyLooksShared,
  type CardFeatures,
  type HeuristicScore,
  type LooksSharedContext,
  type LooksSharedVerdict,
} from './looksShared.js';
import {
  activeMembers,
  activityWindows,
  alreadyAskedElsewhere,
  dropPendingItems,
  expenseIsCharge,
  importEligibility,
  sharePlan,
  type ChargeFacts,
  type SharePlan,
} from './pending.js';
import { applyRiders, validRiders } from './riders.js';

/** Two or more receipts from one import go out as one digest (VOICE §2 "two email receipts"). */
export const EMAIL_DIGEST_MIN = 2;
/** A receipt within this many hours of a logged expense with the same payer and amount is that expense. */
const DUPLICATE_WINDOW_H = 48;
/** Two stored receipts with the same merchant and total this close together are one forwarded twice. */
const FORWARDED_COPY_MIN = 10;
/** Below this parser confidence the DM asks the owner to double-check the amount. */
const LOW_CONFIDENCE_BELOW = 0.6;
/** The rider count tips a ride: alone ⇒ at most this score (personal). */
const ONE_RIDER_MAX = 0.3;
const SEVERAL_RIDERS_BONUS = 0.15;

export interface EmailImportDeps {
  readonly stores: Stores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The fast model for the classifier's uncertain band; omitted ⇒ heuristic-only. */
  readonly model?: ModelClient;
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  /**
   * The group thread so far (the loop's transcript), so a ride's rider count
   * can leave out who said they had left that night (`applyRiders`, T-135).
   */
  readonly groupMessages?: readonly GroupMessageSummary[];
}

export interface EmailImportInput {
  readonly ownerMemberId: MemberId;
  readonly source: EmailReceiptSource;
  readonly parser: ReceiptEmailParser;
  /** Only emails received at or after this time; omitted ⇒ all (already-seen ones are skipped). */
  readonly since?: IsoDateTime;
  readonly scenario?: string;
}

export type EmailImportStatus =
  | 'imported'
  | 'consent_off'
  | 'minor'
  /** Not an active, non-guest member known to be 18+: nobody who could answer the DM. */
  | 'not_eligible'
  | 'no_trip'
  | 'source_failed';

export interface EmailImportOutcome {
  readonly status: EmailImportStatus;
  /** New emails looked at (already-seen ones are not counted). */
  readonly seen: number;
  /** Receipts whose parsed facts were kept (trip data). */
  readonly stored: number;
  /** Emails that are not receipts (no total, a promo, a sender claiming to be Trav). */
  readonly notReceipts: number;
  /** New "looks shared?" items. */
  readonly prompted: readonly string[];
  /** Shared-looking receipts already on the tab (not prompted). */
  readonly alreadyOnTab: number;
  /** A second copy of a stored receipt, or a charge already waiting as a card item (not prompted). */
  readonly duplicates: number;
  /** Pending items dropped because consent is off or the owner is not eligible. */
  readonly dropped: number;
  /** Email ids that tripped the injection screen. */
  readonly injectionEmailIds: readonly string[];
  /** Verdict per email id (owner-private; tests and evals). */
  readonly verdicts: Readonly<Record<string, LooksSharedVerdict>>;
  /** DMs to the owner only. */
  readonly drafts: readonly OutboundMessage[];
}

const EMPTY = {
  seen: 0,
  stored: 0,
  notReceipts: 0,
  prompted: [],
  alreadyOnTab: 0,
  duplicates: 0,
  dropped: 0,
  injectionEmailIds: [],
  verdicts: {},
  drafts: [],
} as const;

/** What a flagged receipt is called instead of anything the email said (T-013 r1 #1). */
export const NEUTRAL_EMAIL_NAME: Readonly<Record<ReceiptSourceKind, string>> = {
  rideshare: 'ride',
  taxi: 'ride',
  restaurant: 'restaurant',
  bar: 'bar',
  grocery: 'groceries',
  airline: 'flight',
  lodging: 'lodging',
  tickets: 'tickets',
  other: 'email',
};

/** Receipt kind → the Plaid-shaped category the card classifier reads. */
const KIND_CATEGORY: Readonly<
  Record<ReceiptSourceKind, { readonly primary: string; readonly detailed: string } | undefined>
> = {
  rideshare: { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES' },
  taxi: { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES' },
  restaurant: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' },
  bar: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR' },
  grocery: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' },
  airline: { primary: 'TRAVEL', detailed: 'TRAVEL_FLIGHTS' },
  lodging: { primary: 'TRAVEL', detailed: 'TRAVEL_LODGING' },
  tickets: {
    primary: 'ENTERTAINMENT',
    detailed: 'ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_CONCERTS',
  },
  other: undefined,
};

/** The ledger category of a receipt kind (same map the card flow uses). */
export function emailCategory(kind: ReceiptSourceKind): ExpenseCategory {
  const c = KIND_CATEGORY[kind];
  return c === undefined ? 'other' : cardCategory({ personalFinanceCategory: c });
}

const PARSER_INJECTION_WARNINGS: readonly string[] = [
  EMAIL_WARNINGS.injection,
  EMAIL_WARNINGS.injectionHidden,
];

/**
 * Instruction-like text anywhere in the email (sender, subject, text and HTML
 * bodies, hidden HTML included). A bare link alone is not (parser rule).
 */
export function screenEmail(email: InboundEmail): readonly InjectionMatch[] {
  const text = [email.from, email.subject, email.textBody ?? '', email.htmlBody ?? ''].join('\n');
  return detectInjection(text).filter((m) => m.pattern !== 'url');
}

/**
 * The receipt as stored and shown: typed fields only. Flagged ⇒ the neutral
 * name, and none of the email's own strings (ride places, line items).
 */
export function safeReceipt(parsed: ParsedEmailReceipt, flagged: boolean): ParsedReceipt {
  const merchant = sanitizeInline(parsed.merchantName, 60);
  const name =
    flagged || merchant === '' || merchant === 'Unknown merchant'
      ? NEUTRAL_EMAIL_NAME[parsed.source]
      : merchant;
  return {
    source: parsed.source,
    merchantName: name,
    total: parsed.total,
    ...(parsed.subtotal !== undefined ? { subtotal: parsed.subtotal } : {}),
    ...(parsed.tax !== undefined ? { tax: parsed.tax } : {}),
    ...(parsed.tip !== undefined ? { tip: parsed.tip } : {}),
    ...(parsed.fees !== undefined ? { fees: parsed.fees } : {}),
    occurredAt: parsed.occurredAt,
    ...(!flagged && parsed.lineItems !== undefined ? { lineItems: parsed.lineItems } : {}),
    ...(!flagged && parsed.ride !== undefined ? { ride: parsed.ride } : {}),
    confidence: parsed.confidence,
    warnings: parsed.warnings,
  };
}

/** VOICE §4.5 C detail: "El Born → Eixample, 4 riders". Undefined when nothing safe to say. */
export function rideDetail(
  receipt: ParsedReceipt | { readonly ride: ParsedReceipt['ride'] },
): string | undefined {
  const ride = receipt.ride;
  if (ride === undefined) return undefined;
  const place = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    const clean = sanitizeInline(s, 40);
    return clean === '' || detectInjection(clean).length > 0 ? undefined : clean;
  };
  const from = place(ride.pickup);
  const to = place(ride.dropoff);
  const parts: string[] = [];
  if (from !== undefined && to !== undefined) parts.push(`${from} → ${to}`);
  const n = ride.riders;
  if (validRiders(n)) {
    parts.push(`${String(n)} ${n === 1 ? 'rider' : 'riders'}`);
  }
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** The receipt's typed facts in the card classifier's shape (no body text). */
export function emailFeatures(emailId: string, receipt: ParsedReceipt): CardFeatures {
  const c = KIND_CATEGORY[receipt.source];
  return {
    transactionId: emailId,
    amount: receipt.total,
    direction: 'debit',
    occurredAt: receipt.occurredAt,
    hasTime: true,
    merchantKey: receipt.merchantName.trim().toLowerCase(),
    ...(c !== undefined ? { categoryPrimary: c.primary, categoryDetailed: c.detailed } : {}),
    // Only the (sanitized or neutral) merchant name ever reaches the fast model, wrapped.
    rawName: receipt.merchantName,
  };
}

/** The rider count on top of stage 1: alone ⇒ personal; several ⇒ a little more shared. */
export function riderAdjust(receipt: ParsedReceipt): (h: HeuristicScore) => HeuristicScore {
  return (h) => {
    const n = receipt.ride?.riders;
    if (n === undefined) return h;
    if (n === 1) {
      return { score: Math.min(h.score, ONE_RIDER_MAX), reasons: [...h.reasons, 'one rider'] };
    }
    return { score: h.score + SEVERAL_RIDERS_BONUS, reasons: [...h.reasons, 'several riders'] };
  };
}

function sameMoney(a: Money, b: Money): boolean {
  return a.amountMinor === b.amountMinor && a.currency === b.currency;
}

function hoursApart(a: string, b: string): number {
  return Math.abs(parseIso(a) - parseIso(b)) / 3_600_000;
}

export async function importEmailReceipts(
  input: EmailImportInput,
  deps: EmailImportDeps,
): Promise<EmailImportOutcome> {
  const { stores, clock, ids, group, members, trip } = deps;
  const now = clock.now();
  const owner = members.find((m) => m.memberId === input.ownerMemberId);
  if (owner === undefined) {
    throw new TravError(
      'not_found',
      `member ${input.ownerMemberId} is not in group ${group.groupId}`,
    );
  }
  const keep = (
    status: EmailImportStatus,
    extra: Partial<EmailImportOutcome> = {},
  ): EmailImportOutcome => ({ ...EMPTY, status, ...extra });

  // 1. eligibility, then consent (SAFETY §2.6, default off): no source read, pending items go.
  const eligibility = importEligibility(owner, now);
  if (eligibility !== 'ok') {
    const dropped = dropPendingItems(
      { stores, clock },
      owner.memberId,
      group.groupId,
      'email',
      eligibility === 'minor' ? 'consent_revoked' : 'not_eligible',
    );
    return keep(eligibility, { dropped });
  }
  const consent = stores.private.getConsent(owner.memberId, group.groupId);
  if (consent?.emailImport !== true) {
    const dropped = dropPendingItems({ stores, clock }, owner.memberId, group.groupId, 'email');
    return keep('consent_off', { dropped });
  }
  if (trip === null) return keep('no_trip');

  // 2. the owner's mail.
  const listed = await input.source.list(owner.memberId, input.since);
  if (!listed.ok) return keep('source_failed');

  const tz = trip.timeZone;
  const ctx: LooksSharedContext = {
    ownerMemberId: owner.memberId,
    trip,
    memberIds: activeMembers(members).map((m) => m.memberId),
    activities: activityWindows(stores.group.trips, trip, members),
    homeMerchantCounts: new Map(),
  };
  const windowFrom = addDays(trip.startDate, -1);
  const windowTo = addDays(trip.endDate, 1);
  const logged = stores.group.expenses.listByTrip(trip.tripId).filter((e) => e.status === 'logged');
  /** Already on the tab: same payer, amount and currency within 48h; never an expense from another email. */
  // A shared card charge for this ride in another currency counts too (`sameCharge`).
  const onTab = (facts: ChargeFacts, rowId: string): boolean =>
    logged.some(
      (e) =>
        !(e.source === 'email_receipt' && e.sourceRef.id !== rowId) &&
        e.paidBy.some((p) => p.memberId === owner.memberId) &&
        (((sameMoney(e.amount, facts.amount) ||
          (e.original !== undefined && sameMoney(e.original.amount, facts.amount))) &&
          hoursApart(e.occurredAt, facts.occurredAt) <= DUPLICATE_WINDOW_H) ||
          expenseIsCharge(e, 'card_transaction', facts)),
    );
  const stored = (): EmailReceipt[] => [
    ...stores.private.listEmailReceipts(owner.memberId, group.groupId),
  ];
  /**
   * A second copy of a stored receipt: same kind, total and time. Never the
   * display name: a flagged forward is stored under the neutral name ("ride")
   * and must still match the "Uber" original.
   */
  const forwardedCopy = (r: ParsedReceipt): boolean =>
    stored().some(
      (e) =>
        e.parsed !== null &&
        e.parsed.source === r.source &&
        sameMoney(e.parsed.total, r.total) &&
        Math.abs(parseIso(e.parsed.occurredAt) - parseIso(r.occurredAt)) <=
          FORWARDED_COPY_MIN * 60_000,
    );

  let seen = 0;
  let kept = 0;
  let notReceipts = 0;
  let alreadyOnTab = 0;
  let duplicates = 0;
  const created: {
    item: PendingPrivateItem;
    plan: SharePlan;
    flagged: boolean;
    detail?: string;
  }[] = [];
  const injected: string[] = [];
  const verdicts: Record<string, LooksSharedVerdict> = {};

  for (const email of listed.value) {
    if (email.ownerMemberId !== owner.memberId) continue; // defense in depth (the source scopes too)
    // Already seen (a stored row, or an item the document-intake path made from this email): a no-op.
    if (stored().some((e) => e.emailId === email.emailId)) continue;
    if (
      stores.private
        .listPendingItems(owner.memberId, group.groupId)
        .some((i) => i.source === 'email' && i.sourceItemId === email.emailId)
    ) {
      continue;
    }
    seen += 1;

    // 3. screen, then parse as data.
    const matches = screenEmail(email);
    const parsed = await input.parser.parse(email);
    const flagged =
      matches.length > 0 ||
      (parsed.ok && parsed.value.warnings.some((w) => PARSER_INJECTION_WARNINGS.includes(w)));
    if (flagged) {
      injected.push(email.emailId);
      stores.group.audit.append({
        groupId: group.groupId,
        tripId: trip.tripId,
        type: 'injection.detected',
        actor: { kind: 'system', id: 'trav' },
        visibility: 'owner',
        ownerId: owner.memberId,
        payload: {
          source: 'email_receipt',
          itemId: email.emailId,
          matchedPattern: matches[0]?.pattern ?? 'parser_warning',
          patterns: matches.map((m) => m.pattern),
          excerpt: (matches[0]?.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        },
      });
    }
    const row = (receipt: ParsedReceipt | null): EmailReceipt =>
      markPrivate({
        id: ids.next('priv'),
        ownerMemberId: owner.memberId,
        groupId: group.groupId,
        tripId: trip.tripId,
        createdAt: now,
        emailId: email.emailId,
        receivedAt: email.receivedAt,
        sender: '',
        subject: '',
        bodyText: '',
        parsed: receipt,
        injectionDetected: flagged,
      });

    // 4. not a receipt: remember it was seen, nothing else.
    if (!parsed.ok || parsed.value.ownerMemberId !== owner.memberId) {
      notReceipts += 1;
      stores.private.putEmailReceipt(owner.memberId, row(null));
      continue;
    }

    // 5. classify on typed facts.
    const receipt = safeReceipt(parsed.value, flagged);
    const verdict = await classifyLooksShared(emailFeatures(email.emailId, receipt), ctx, {
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      ...(input.scenario !== undefined ? { scenario: input.scenario } : {}),
      adjust: riderAdjust(receipt),
    });
    verdicts[email.emailId] = verdict;
    const day = localDate(receipt.occurredAt, tz);
    const inWindow = day >= windowFrom && day <= windowTo;
    if (!inWindow && verdict.label !== 'shared') {
      stores.private.putEmailReceipt(owner.memberId, row(null)); // not trip data: no facts kept
      continue;
    }
    const isCopy = forwardedCopy(receipt);
    const saved = row(isCopy ? null : receipt);
    stores.private.putEmailReceipt(owner.memberId, saved);
    if (isCopy) {
      duplicates += 1;
      continue;
    }
    kept += 1;
    if (verdict.label !== 'shared') continue;

    // 6. already on the tab, or already asked about as a card charge (any answer)?
    const category = emailCategory(receipt.source);
    const facts: ChargeFacts = { amount: receipt.total, occurredAt: receipt.occurredAt, category };
    if (onTab(facts, saved.id)) {
      alreadyOnTab += 1;
      continue;
    }
    if (alreadyAskedElsewhere(stores, owner.memberId, group.groupId, 'card', facts)) {
      duplicates += 1;
      continue;
    }
    // T-135: the receipt's rider count next to that night's roster (a flagged email has no ride facts).
    const plan = applyRiders(
      sharePlan({
        trips: stores.group.trips,
        trip,
        members,
        ownerMemberId: owner.memberId,
        occurredAt: receipt.occurredAt,
        category,
      }),
      receipt.ride?.riders,
      {
        ownerMemberId: owner.memberId,
        occurredAt: receipt.occurredAt,
        ...(deps.groupMessages !== undefined ? { groupMessages: deps.groupMessages } : {}),
      },
    );
    const item: PendingPrivateItem = markPrivate({
      id: ids.next('priv'),
      ownerMemberId: owner.memberId,
      groupId: group.groupId,
      tripId: trip.tripId,
      createdAt: now,
      source: 'email' as const,
      sourceItemId: saved.id,
      status: 'pending' as const,
      amount: receipt.total,
      occurredAt: receipt.occurredAt,
      merchantDisplay: receipt.merchantName,
      category,
      classifier: { looksShared: true, confidence: verdict.score, reason: verdict.reason },
      lowConfidence: flagged || receipt.confidence < LOW_CONFIDENCE_BELOW,
      ...(plan.askRiders !== undefined
        ? { ridersToName: plan.askRiders }
        : { suggestedParticipants: plan.participants }),
      ...(plan.activityId !== undefined ? { suggestedActivityId: plan.activityId } : {}),
    });
    stores.private.putPendingItem(owner.memberId, item);
    const detail = flagged ? undefined : rideDetail(receipt);
    created.push({ item, plan, flagged, ...(detail !== undefined ? { detail } : {}) });
  }

  for (const { item, flagged } of created) {
    stores.group.audit.append({
      groupId: group.groupId,
      tripId: trip.tripId,
      type: 'private.item_ingested',
      actor: { kind: 'system', id: 'trav' },
      visibility: 'owner',
      ownerId: owner.memberId,
      payload: {
        source: 'email',
        itemId: item.id,
        sourceItemId: item.sourceItemId,
        amountMinor: item.amount.amountMinor,
        currency: item.amount.currency,
        classifierLabel: 'shared',
        classifierScore: item.classifier?.confidence ?? null,
        lowConfidence: item.lowConfidence,
        injectionDetected: flagged,
      },
    });
  }

  // 7. the DMs (owner only; eligibility already ruled out minors).
  const drafts: OutboundMessage[] = [];
  if (created.length > 0) {
    const rctx = { groupId: group.groupId, members, timeZone: tz, now, ids };
    const entry = (c: (typeof created)[number]): LooksSharedItem => ({
      item: c.item,
      ...(c.detail !== undefined ? { detail: c.detail } : {}),
      ...(c.plan.label !== undefined ? { splitWithLabel: c.plan.label } : {}),
    });
    // A card that asks who rode always goes on its own: a digest line can't carry the question.
    const asks = created.filter((c) => c.plan.askRiders !== undefined);
    const rest = created.filter((c) => c.plan.askRiders === undefined);
    const batches = [
      ...(rest.length >= EMAIL_DIGEST_MIN ? [rest] : rest.map((c) => [c])),
      ...asks.map((c) => [c]),
    ];
    for (const batch of batches) {
      const msg = renderLooksShared(
        { ownerMemberId: owner.memberId, items: batch.map(entry) },
        rctx,
      );
      for (const c of batch) {
        stores.private.putPendingItem(
          owner.memberId,
          markPrivate({ ...c.item, cardMessageId: msg.id }),
        );
      }
      drafts.push(msg);
    }
  }

  return {
    status: 'imported',
    seen,
    stored: kept,
    notReceipts,
    prompted: created.map((c) => c.item.id),
    alreadyOnTab,
    duplicates,
    dropped: 0,
    injectionEmailIds: injected,
    verdicts,
    drafts,
  };
}

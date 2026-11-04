/**
 * Card transactions → owner-private store → "looks shared?" DM (T-013;
 * SAFETY §2.3, §2.4, §2.6; VOICE §4.5).
 *
 * `importCardTransactions` runs for ONE owner at a time:
 *  1. Consent first: unless the owner's `cardImport` flag is on (and the
 *     owner is not a minor: no card ingestion for minors), the provider is
 *     not even called, and anything still pending from an earlier import is
 *     dropped (`dropPendingItems`, `private.item_dismissed` cause
 *     `consent_revoked`, raw descriptors blanked). The same happens for an
 *     owner who could never answer the DM (`not_eligible`: a guest, an
 *     inactive or departed member, or anyone not known to be 18+). A pending
 *     item whose consent was revoked is also dropped at answer time
 *     (`consentRevokedSince` in `pending.ts`).
 *  2. One Plaid-shaped sync from the caller's cursor (pages capped at
 *     `MAX_SYNC_PAGES`; any failed page ⇒ nothing is applied and the caller
 *     keeps its old cursor, Plaid's restart rule).
 *  3. Every descriptor is screened (`detectInjection` ⇒ owner-visible
 *     `injection.detected`, the item is low-confidence). The descriptor is
 *     never used for a decision; it reaches the fast model only wrapped as
 *     untrusted data, and only in the classifier's uncertain band.
 *  4. Each charge is classified (`looksShared.ts`). Rows are stored in the
 *     owner's private store only when they matter: inside the trip window
 *     (±1 day), or classified shared, or already stored (data minimization;
 *     the rest of the history is only counted for the recurring-merchant
 *     signal and then dropped).
 *  5. A shared charge that is not already on the tab (same payer, same amount
 *     and currency, within 48h of a logged expense) becomes a
 *     `PendingPrivateItem` with the split `sharePlan` picks; nothing reaches
 *     the ledger here (`pending.ts` promotes on the owner's 👍).
 *  6. Pending → posted: the posted row replaces the pending one in place (same
 *     private row, by `pendingTransactionId`), and a still-pending item takes
 *     the posted amount; if the amount changed, a fresh DM card goes out and
 *     the old card stops working. A pending charge the provider removed
 *     without a posted row expires quietly.
 *  7. DMs: one "looks shared?" card per new or changed item, or one digest
 *     when three or more land together (VOICE §2 batching). Never to a minor
 *     (VOICE §6.1). The group sees only the per-owner COUNT
 *     (`countPendingByOwner` in the group context), never an amount or
 *     merchant.
 */
import type {
  CardTransaction,
  Clock,
  ExpenseCategory,
  Group,
  IdGenerator,
  Member,
  MemberId,
  Money,
  OutboundMessage,
  PendingPrivateItem,
  Stores,
  Trip,
} from '@trav/core';
import { addDays, localDate, markPrivate, parseIso, safety, TravError } from '@trav/core';
import type { ProviderTransaction, TransactionsAdapter } from '@trav/adapters';
import { sanitizeInline } from '../context/groupContext.js';
import type { ModelClient } from '../model/client.js';
import { renderLooksShared, type LooksSharedItem } from '../render/expenseConfirm.js';
import { detectInjection, stripInvisible } from '../untrusted.js';
import {
  cardFeatures,
  classifyLooksShared,
  type LooksSharedContext,
  type LooksSharedVerdict,
} from './looksShared.js';
import {
  activeMembers,
  activityWindows,
  dropPendingItems,
  importEligibility,
  sharePlan,
} from './pending.js';

/** A broken cursor can never page forever. */
export const MAX_SYNC_PAGES = 50;
/** Three or more prompts from one import go out as one digest (VOICE §2, §4.5 B). */
export const DIGEST_MIN = 3;
/** A charge within this many hours of a logged expense with the same payer and amount is that expense. */
const DUPLICATE_WINDOW_H = 48;

export interface CardImportDeps {
  readonly stores: Stores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The fast model for the classifier's uncertain band; omitted ⇒ heuristic-only. */
  readonly model?: ModelClient;
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
}

export interface CardImportInput {
  readonly ownerMemberId: MemberId;
  readonly adapter: TransactionsAdapter;
  /** The cursor the previous import returned; omitted ⇒ initial sync. */
  readonly cursor?: string;
  readonly scenario?: string;
}

export type CardImportStatus =
  | 'imported'
  | 'consent_off'
  | 'minor'
  /** Not an active, non-guest member known to be 18+: nobody who could answer the DM. */
  | 'not_eligible'
  | 'no_trip'
  | 'not_linked'
  | 'sync_failed';

export interface CardImportOutcome {
  readonly status: CardImportStatus;
  /** Persist and pass back next time (unchanged when nothing was applied). */
  readonly nextCursor?: string;
  /** Rows written to the owner's private store (new or updated). */
  readonly stored: number;
  /** New "looks shared?" items. */
  readonly prompted: readonly string[];
  /** Pending items whose amount changed (pending → posted). */
  readonly updated: readonly string[];
  /** Shared-looking charges already on the tab (not prompted). */
  readonly alreadyOnTab: number;
  /** Pending items that expired because the provider dropped the authorization. */
  readonly expired: number;
  /** Pending items dropped because consent is off. */
  readonly dropped: number;
  /** Provider ids whose descriptor tripped the injection detector. */
  readonly injectionTransactionIds: readonly string[];
  /** Verdict per provider transaction id (owner-private; tests and evals). */
  readonly verdicts: Readonly<Record<string, LooksSharedVerdict>>;
  /** DMs to the owner only. */
  readonly drafts: readonly OutboundMessage[];
}

const EMPTY = {
  stored: 0,
  prompted: [],
  updated: [],
  alreadyOnTab: 0,
  expired: 0,
  dropped: 0,
  injectionTransactionIds: [],
  verdicts: {},
  drafts: [],
} as const;

/** Plaid personal-finance category → ledger category. */
export function cardCategory(
  tx: Pick<ProviderTransaction, 'personalFinanceCategory'>,
): ExpenseCategory {
  const primary = tx.personalFinanceCategory?.primary ?? '';
  const detailed = tx.personalFinanceCategory?.detailed ?? '';
  if (detailed === 'FOOD_AND_DRINK_GROCERIES') return 'groceries';
  if (detailed === 'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR') return 'drinks';
  if (detailed === 'TRAVEL_LODGING') return 'lodging';
  if (detailed === 'TRAVEL_FLIGHTS') return 'flights';
  if (primary === 'FOOD_AND_DRINK') return 'food';
  if (primary === 'TRANSPORTATION' || primary === 'TRAVEL') return 'transport';
  if (
    detailed.startsWith('ENTERTAINMENT_SPORTING_EVENTS') ||
    detailed === 'ENTERTAINMENT_MUSIC_AND_AUDIO'
  ) {
    return 'tickets';
  }
  if (primary === 'ENTERTAINMENT') return 'activities';
  return 'other';
}

/**
 * The only merchant string the owner (and, once shared, the group) sees. When
 * the detector flagged the row, neither the enriched merchant name nor the raw
 * descriptor is used (either can carry the instruction): always 'card charge'.
 */
export function displayName(tx: ProviderTransaction, injected: boolean): string {
  if (injected) return 'card charge';
  const name = sanitizeInline(tx.merchantName ?? '', 60);
  if (name !== '') return name;
  const raw = sanitizeInline(stripInvisible(tx.rawName), 40);
  return raw === '' ? 'card charge' : raw;
}

interface SyncPage {
  readonly added: readonly ProviderTransaction[];
  readonly removed: readonly string[];
}

/**
 * All pages of one sync as one batch (Plaid: a pending row can be removed on
 * one page and its posted row added on a later one). Added and modified rows
 * are applied first (a later page's version of a row wins); a removed id is
 * kept only if no posted row in the batch supersedes it (`pendingTransactionId`)
 * and no later page re-adds it.
 */
export function mergePages(pages: readonly SyncPage[]): {
  readonly added: ProviderTransaction[];
  readonly removed: string[];
} {
  const added = new Map<string, ProviderTransaction>();
  const removed = new Set<string>();
  for (const p of pages) {
    for (const id of p.removed) {
      removed.add(id);
      added.delete(id);
    }
    for (const tx of p.added) {
      added.delete(tx.transactionId); // re-insert: batch order follows the latest version
      added.set(tx.transactionId, tx);
      removed.delete(tx.transactionId);
    }
  }
  const superseded = new Set(
    [...added.values()]
      .map((tx) => tx.pendingTransactionId)
      .filter((id): id is string => id !== undefined),
  );
  return {
    added: [...added.values()],
    removed: [...removed].filter((id) => !superseded.has(id)),
  };
}

function sameMoney(a: Money, b: Money): boolean {
  return a.amountMinor === b.amountMinor && a.currency === b.currency;
}

function hoursApart(a: string, b: string): number {
  return Math.abs(parseIso(a) - parseIso(b)) / 3_600_000;
}

export async function importCardTransactions(
  input: CardImportInput,
  deps: CardImportDeps,
): Promise<CardImportOutcome> {
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
    status: CardImportStatus,
    extra: Partial<CardImportOutcome> = {},
  ): CardImportOutcome => ({
    ...EMPTY,
    status,
    ...(input.cursor !== undefined ? { nextCursor: input.cursor } : {}),
    ...extra,
  });

  // 1. a minor's card is never ingested (fixtures README, VOICE §6.1), and
  // consent (SAFETY §2.6) is default off; either ⇒ no provider call, and pending items go.
  const eligibility = importEligibility(owner, now);
  if (eligibility === 'minor') {
    const dropped = dropPendingItems({ stores, clock }, owner.memberId, group.groupId, 'card');
    return keep('minor', { dropped });
  }
  // Only someone who can answer the DM: an active, non-guest member known to be 18+.
  if (eligibility === 'not_eligible') {
    const dropped = dropPendingItems(
      { stores, clock },
      owner.memberId,
      group.groupId,
      'card',
      'not_eligible',
    );
    return keep('not_eligible', { dropped });
  }
  const consent = stores.private.getConsent(owner.memberId, group.groupId);
  if (consent?.cardImport !== true) {
    const dropped = dropPendingItems({ stores, clock }, owner.memberId, group.groupId, 'card');
    return keep('consent_off', { dropped });
  }
  if (trip === null) return keep('no_trip');

  // 2. sync (all pages first; a failure applies nothing).
  const pages: SyncPage[] = [];
  let cursor = input.cursor;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_SYNC_PAGES) return keep('sync_failed');
    const res = await input.adapter.sync(owner.memberId, cursor);
    if (!res.ok) return keep(res.error.code === 'not_found' ? 'not_linked' : 'sync_failed');
    pages.push({
      added: [...res.value.added, ...res.value.modified],
      removed: res.value.removed.map((r) => r.transactionId),
    });
    cursor = res.value.nextCursor;
    if (!res.value.hasMore) break;
  }
  const batch = mergePages(pages);
  const accounts = await input.adapter.listAccounts(owner.memberId);
  const maskOf = new Map(
    (accounts.ok ? accounts.value : []).map((a) => [a.accountId, a.mask.slice(-4)] as const),
  );

  // Classifier context: the trip, who is on it, the plans with their rosters,
  // and the owner's merchants from home (this batch only; never stored).
  const tz = trip.timeZone;
  const rows = batch.added.filter((tx) => tx.ownerMemberId === owner.memberId);
  const home = new Map<string, number>();
  for (const tx of rows) {
    const f = cardFeatures(tx, tz);
    const day = localDate(f.occurredAt, tz);
    if (f.merchantKey !== '' && (day < trip.startDate || day > trip.endDate)) {
      home.set(f.merchantKey, (home.get(f.merchantKey) ?? 0) + 1);
    }
  }
  const ctx: LooksSharedContext = {
    ownerMemberId: owner.memberId,
    trip,
    memberIds: activeMembers(members).map((m) => m.memberId),
    activities: activityWindows(stores.group.trips, trip, members),
    homeMerchantCounts: home,
  };
  const windowFrom = addDays(trip.startDate, -1);
  const windowTo = addDays(trip.endDate, 1);
  const logged = stores.group.expenses.listByTrip(trip.tripId).filter((e) => e.status === 'logged');
  /**
   * Already on the tab: same payer (the owner), same amount and currency, within 48h.
   * An expense promoted from a DIFFERENT card charge is never this charge (two
   * €23.40 rides are two rides); chat, booking, email and receipt entries can be.
   */
  const onTab = (amount: Money, at: string, rowId: string): boolean =>
    logged.some(
      (e) =>
        !(e.source === 'card_transaction' && e.sourceRef.id !== rowId) &&
        e.paidBy.some((p) => p.memberId === owner.memberId) &&
        (sameMoney(e.amount, amount) ||
          (e.original !== undefined && sameMoney(e.original.amount, amount))) &&
        hoursApart(e.occurredAt, at) <= DUPLICATE_WINDOW_H,
    );

  const pendingItems = (): PendingPrivateItem[] => [
    ...stores.private.listPendingItems(owner.memberId, group.groupId),
  ];
  /** The pending item for a stored row (this flow), or for a provider id (the document-intake path). */
  const itemFor = (
    rowId: string | undefined,
    providerIds: readonly string[],
  ): PendingPrivateItem | undefined =>
    pendingItems().find(
      (i) =>
        i.source === 'card' &&
        ((rowId !== undefined && i.sourceItemId === rowId) || providerIds.includes(i.sourceItemId)),
    );

  let stored = 0;
  const created: string[] = [];
  const changed: string[] = [];
  let alreadyOnTab = 0;
  let expired = 0;
  const injected: string[] = [];
  const verdicts: Record<string, LooksSharedVerdict> = {};

  for (const tx of batch.added) {
    if (tx.ownerMemberId !== owner.memberId) continue; // defense in depth (adapter re-checks too)
    const f = cardFeatures(tx, tz);
    const matches = detectInjection(`${tx.rawName}\n${tx.merchantName ?? ''}`);
    if (matches.length > 0) {
      injected.push(tx.transactionId);
      stores.group.audit.append({
        groupId: group.groupId,
        tripId: trip.tripId,
        type: 'injection.detected',
        actor: { kind: 'system', id: 'trav' },
        visibility: 'owner',
        ownerId: owner.memberId,
        payload: {
          source: 'card_descriptor',
          itemId: tx.transactionId,
          matchedPattern: matches[0]!.pattern,
          patterns: matches.map((m) => m.pattern),
          excerpt: matches[0]!.excerpt.replace(/\s+/g, ' ').trim().slice(0, 200),
        },
      });
    }
    const verdict = await classifyLooksShared(f, ctx, {
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      ...(input.scenario !== undefined ? { scenario: input.scenario } : {}),
    });
    verdicts[tx.transactionId] = verdict;

    const providerIds = [
      tx.transactionId,
      ...(tx.pendingTransactionId !== undefined ? [tx.pendingTransactionId] : []),
    ];
    const existing =
      stores.private.getCardTransactionByProviderId(owner.memberId, tx.transactionId) ??
      (tx.pendingTransactionId !== undefined
        ? stores.private.getCardTransactionByProviderId(owner.memberId, tx.pendingTransactionId)
        : undefined);
    const day = localDate(f.occurredAt, tz);
    const inWindow = day >= windowFrom && day <= windowTo;
    const item = itemFor(existing?.id, providerIds);
    if (!inWindow && verdict.label !== 'shared' && existing === undefined && item === undefined) {
      continue; // not trip data: never stored
    }
    const category = cardCategory(tx);
    const row: CardTransaction = markPrivate({
      id: existing?.id ?? ids.next('priv'),
      ownerMemberId: owner.memberId,
      groupId: group.groupId,
      tripId: trip.tripId,
      createdAt: existing?.createdAt ?? now,
      providerTransactionId: tx.transactionId,
      accountId: tx.accountId,
      last4: maskOf.get(tx.accountId) ?? '',
      postedAt: f.occurredAt,
      amount: tx.amount,
      direction: tx.direction,
      pending: tx.pending,
      merchantRaw: tx.rawName,
      merchantDisplay: displayName(tx, matches.length > 0),
      category,
      ...(tx.location !== undefined
        ? {
            location: {
              ...(tx.location.city !== undefined ? { city: tx.location.city } : {}),
              ...(tx.location.country !== undefined ? { country: tx.location.country } : {}),
            },
          }
        : {}),
      classifierLabel: verdict.label,
      classifierScore: verdict.score,
    });
    stores.private.putCardTransaction(owner.memberId, row);
    stored += 1;

    if (item !== undefined) {
      // 6. pending → posted (or a modified row): update in place, never duplicate.
      if (
        item.status === 'pending' &&
        (!sameMoney(item.amount, tx.amount) || item.sourceItemId !== row.id)
      ) {
        const amountChanged = !sameMoney(item.amount, tx.amount);
        if (amountChanged && onTab(tx.amount, f.occurredAt, row.id)) {
          // The final amount is already on the tab (logged in chat meanwhile): stop asking.
          stores.private.putPendingItem(
            owner.memberId,
            markPrivate({
              ...item,
              sourceItemId: row.id,
              amount: tx.amount,
              status: 'dismissed' as const,
            }),
          );
          stores.group.audit.append({
            groupId: group.groupId,
            tripId: trip.tripId,
            type: 'private.item_dismissed',
            actor: { kind: 'system', id: 'trav' },
            visibility: 'owner',
            ownerId: owner.memberId,
            payload: { itemId: item.id, cause: 'already_on_tab' },
          });
          alreadyOnTab += 1;
          for (const list of [created, changed]) {
            const at = list.indexOf(item.id);
            if (at >= 0) list.splice(at, 1);
          }
          continue;
        }
        stores.private.putPendingItem(
          owner.memberId,
          markPrivate({
            ...item,
            sourceItemId: row.id,
            amount: tx.amount,
            occurredAt: f.occurredAt,
            lowConfidence: item.lowConfidence || matches.length > 0,
          }),
        );
        if (amountChanged && !created.includes(item.id) && !changed.includes(item.id))
          changed.push(item.id);
      }
      continue;
    }
    if (verdict.label !== 'shared' || tx.direction !== 'debit') continue;

    // 5. already on the tab? (a chat-logged dinner, a Trav booking charge)
    if (onTab(tx.amount, f.occurredAt, row.id)) {
      alreadyOnTab += 1;
      continue;
    }
    const plan = sharePlan({
      trips: stores.group.trips,
      trip,
      members,
      ownerMemberId: owner.memberId,
      occurredAt: f.occurredAt,
      category,
    });
    const pending: PendingPrivateItem = markPrivate({
      id: ids.next('priv'),
      ownerMemberId: owner.memberId,
      groupId: group.groupId,
      tripId: trip.tripId,
      createdAt: now,
      source: 'card' as const,
      sourceItemId: row.id,
      status: 'pending' as const,
      amount: tx.amount,
      occurredAt: f.occurredAt,
      merchantDisplay: row.merchantDisplay,
      category,
      classifier: { looksShared: true, confidence: verdict.score, reason: verdict.reason },
      lowConfidence: matches.length > 0,
      suggestedParticipants: plan.participants,
      ...(plan.activityId !== undefined ? { suggestedActivityId: plan.activityId } : {}),
    });
    stores.private.putPendingItem(owner.memberId, pending);
    created.push(pending.id);
  }

  // A pending authorization the provider dropped without a posted row.
  for (const removedId of batch.removed) {
    const row = stores.private.getCardTransactionByProviderId(owner.memberId, removedId);
    const item = itemFor(row?.id, [removedId]);
    if (item === undefined || item.status !== 'pending') continue;
    stores.private.putPendingItem(
      owner.memberId,
      markPrivate({ ...item, status: 'expired' as const }),
    );
    expired += 1;
  }

  // 7. the DMs (owner only; never a minor), with the final amounts of this import.
  const live = (id: string): PendingPrivateItem | undefined => {
    const it = stores.private.getPendingItem(owner.memberId, id);
    return it?.status === 'pending' ? it : undefined;
  };
  const toPrompt = [...created, ...changed]
    .map(live)
    .filter((i): i is PendingPrivateItem => i !== undefined);
  for (const it of toPrompt) {
    const isNew = created.includes(it.id);
    stores.group.audit.append({
      groupId: group.groupId,
      tripId: trip.tripId,
      type: 'private.item_ingested',
      actor: { kind: 'system', id: 'trav' },
      visibility: 'owner',
      ownerId: owner.memberId,
      payload: {
        source: 'card',
        itemId: it.id,
        sourceItemId: it.sourceItemId,
        amountMinor: it.amount.amountMinor,
        currency: it.amount.currency,
        classifierLabel: 'shared',
        classifierScore: it.classifier?.confidence ?? null,
        lowConfidence: it.lowConfidence,
        injectionDetected: it.lowConfidence,
        ...(isNew ? {} : { update: 'amount_changed' }),
      },
    });
  }
  const drafts: OutboundMessage[] = [];
  if (toPrompt.length > 0 && !safety.isMinor(owner, now)) {
    const rctx = { groupId: group.groupId, members, timeZone: tz, now, ids };
    const entry = (item: PendingPrivateItem): LooksSharedItem => {
      const plan = sharePlan({
        trips: stores.group.trips,
        trip,
        members,
        ownerMemberId: owner.memberId,
        occurredAt: item.occurredAt,
        category: item.category,
      });
      // The label and guess describe the split stored on the item; if the plan moved since, list names.
      const same =
        plan.activityId === item.suggestedActivityId &&
        plan.participants.join() === (item.suggestedParticipants ?? []).join();
      if (!same) return { item };
      return {
        item,
        ...(plan.guess !== undefined ? { guess: plan.guess } : {}),
        ...(plan.label !== undefined ? { splitWithLabel: plan.label } : {}),
      };
    };
    const batches = toPrompt.length >= DIGEST_MIN ? [toPrompt] : toPrompt.map((i) => [i]);
    for (const batch of batches) {
      const msg = renderLooksShared(
        { ownerMemberId: owner.memberId, items: batch.map(entry) },
        rctx,
      );
      for (const item of batch) {
        stores.private.putPendingItem(
          owner.memberId,
          markPrivate({ ...item, cardMessageId: msg.id }),
        );
      }
      drafts.push(msg);
    }
  }

  return {
    status: 'imported',
    ...(cursor !== undefined ? { nextCursor: cursor } : {}),
    stored,
    prompted: created,
    updated: changed.filter((id) => live(id) !== undefined),
    alreadyOnTab,
    expired,
    dropped: 0,
    injectionTransactionIds: injected,
    verdicts,
    drafts,
  };
}

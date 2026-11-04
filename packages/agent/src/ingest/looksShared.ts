/**
 * "Looks shared" classifier for one owner's card charges (T-013; SAFETY §2.3
 * "the classifier runs over one owner's items at a time with the fast model,
 * with no tools, and returns only {label, score}"; VOICE §4.5).
 *
 * Two stages:
 *  1. `scoreLooksShared` (pure, deterministic): a score in [0, 1] from the
 *     charge's own facts and the trip, never from the descriptor text:
 *       - money direction: a refund or credit is never shared;
 *       - merchant category (Plaid personal-finance category): fees, transfers,
 *         pharmacies, personal care, shopping and flights lean personal;
 *         lodging, groceries, group-sized meals, rides and tickets lean shared;
 *       - amount vs group size: a meal, a drink run or a transit buy only
 *         looks shared when it covers more than one person (`coversOthers`);
 *         a one-person "group" never shares;
 *       - trip dates: after the trip ⇒ personal; before it, only a prepaid
 *         lodging/tickets charge in the trip city looks shared;
 *       - place vs trip city: a charge somewhere else (home, the airport on
 *         the way back) is personal;
 *       - time of day vs the trip's nights: a ride between 10pm and 6am local
 *         is a night-out ride;
 *       - activity windows: inside a plan the owner is on with others ⇒ a
 *         little more shared; inside a plan only the owner is on, or while
 *         everyone else is busy at a plan the owner skipped ⇒ personal;
 *       - recurring personal merchants: a merchant the owner pays at home
 *         again and again is a habit, not a group spend.
 *  2. Only for the uncertain band (`PERSONAL_AT` < score < `SHARED_AT`) one
 *     `model.classify` call (`looks_shared_v1`, fast model, zero tools) with
 *     the descriptor wrapped as untrusted data (SAFETY §2.4). Offline, that
 *     call is answered by a script or by the rule-based fallback
 *     (`looksSharedHeuristicResponder`); a model "shared" counts only at
 *     `MODEL_SHARED_MIN` or above, anything else stays private.
 *
 * Amount thresholds are in major units of the charge's own currency (USD and
 * EUR are treated alike; this is a recognizer, not a ledger amount).
 * Nothing here writes anything; `card.ts` stores the verdict.
 */
import type { IsoDate, IsoDateTime, MemberId, Money, TimeZone } from '@trav/core';
import {
  formatIso,
  formatMoney,
  localDate,
  localHour,
  parseIso,
  zonedWallTimeToMs,
  zoneOffsetMinutes,
} from '@trav/core';
import type { ProviderTransaction } from '@trav/adapters';
import type { ModelClient, ResponseSource } from '../model/client.js';
import { UNTRUSTED_SYSTEM_SENTENCE, wrapUntrusted } from '../untrusted.js';

export const LOOKS_SHARED_CLASSIFIER_ID = 'looks_shared_v1';
export const LOOKS_SHARED_LABELS = ['shared', 'personal', 'unsure'] as const;
export type LooksSharedLabel = (typeof LOOKS_SHARED_LABELS)[number];

/** At or above: shared without asking the model. */
export const SHARED_AT = 0.65;
/** At or below: personal without asking the model. */
export const PERSONAL_AT = 0.35;
/** A model "shared" below this confidence stays private (biased to not prompting). */
export const MODEL_SHARED_MIN = 0.6;

/** The facts of one charge the classifier looks at (built from a provider row). */
export interface CardFeatures {
  readonly transactionId: string;
  readonly amount: Money;
  readonly direction: 'debit' | 'credit';
  readonly occurredAt: IsoDateTime;
  /** False when the provider gave a date only: no time-of-day signal. */
  readonly hasTime: boolean;
  /** `merchantEntityId`, else the lowercased enriched merchant name, else ''. */
  readonly merchantKey: string;
  readonly categoryPrimary?: string;
  readonly categoryDetailed?: string;
  readonly city?: string;
  readonly country?: string;
  /** Raw statement descriptor. Untrusted: only ever sent to the model wrapped. */
  readonly rawName: string;
}

export interface ActivityWindow {
  readonly name: string;
  readonly kind: string;
  readonly startsAt?: IsoDateTime;
  readonly endsAt?: IsoDateTime;
  /** Members marked `in` (roster), group order. */
  readonly inMemberIds: readonly MemberId[];
}

export interface LooksSharedContext {
  readonly ownerMemberId: MemberId;
  readonly trip: {
    readonly startDate: IsoDate;
    readonly endDate: IsoDate;
    readonly city: string;
    readonly countryCode: string;
    readonly timeZone: TimeZone;
  } | null;
  /** Active, non-guest members of the group (including the owner), group order. */
  readonly memberIds: readonly MemberId[];
  readonly activities: readonly ActivityWindow[];
  /** merchantKey → how many of the owner's charges outside the trip window carry it. */
  readonly homeMerchantCounts: ReadonlyMap<string, number>;
}

export interface HeuristicScore {
  readonly score: number;
  /** Fixed phrases (never descriptor text), most important first. */
  readonly reasons: readonly string[];
}

export interface LooksSharedVerdict {
  readonly label: LooksSharedLabel;
  readonly score: number;
  readonly reason: string;
  /** Which stage decided. */
  readonly stage: 'heuristic' | 'model';
  readonly modelSource?: ResponseSource;
}

// ---------- features ----------

/** Provider row → classifier features. A date-only row is placed at local noon. */
export function cardFeatures(tx: ProviderTransaction, timeZone: TimeZone): CardFeatures {
  let occurredAt: IsoDateTime;
  let hasTime = false;
  if (tx.datetime !== undefined) {
    occurredAt = tx.datetime;
    hasTime = true;
  } else {
    const ms = zonedWallTimeToMs(tx.authorizedDate ?? tx.date, 12, 0, timeZone);
    occurredAt = formatIso(ms, zoneOffsetMinutes(ms, timeZone));
  }
  const name = (tx.merchantName ?? '').trim().toLowerCase();
  return {
    transactionId: tx.transactionId,
    amount: tx.amount,
    direction: tx.direction,
    occurredAt,
    hasTime,
    merchantKey: tx.merchantEntityId ?? name,
    ...(tx.personalFinanceCategory !== undefined
      ? {
          categoryPrimary: tx.personalFinanceCategory.primary,
          categoryDetailed: tx.personalFinanceCategory.detailed,
        }
      : {}),
    ...(tx.location?.city !== undefined ? { city: tx.location.city } : {}),
    ...(tx.location?.country !== undefined ? { country: tx.location.country } : {}),
    rawName: tx.rawName,
  };
}

// ---------- stage 1: heuristics ----------

/** Categories that are never a group spend. */
const PERSONAL_PRIMARY = new Set([
  'BANK_FEES',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'LOAN_PAYMENTS',
  'INCOME',
  'MEDICAL',
  'PERSONAL_CARE',
  'GENERAL_SERVICES',
  'GOVERNMENT_AND_NON_PROFIT',
  'RENT_AND_UTILITIES',
  'HOME_IMPROVEMENT',
]);

/** A night-out ride: 10pm to 5:59am local. */
const NIGHT_FROM = 22;
const NIGHT_UNTIL = 6;
/** A plan's window starts an hour early and runs two hours past its end (the ride home). */
const WINDOW_BEFORE_MIN = 60;
const WINDOW_AFTER_MIN = 120;
/** A plan without an end time is taken to last this long. */
const DEFAULT_PLAN_MIN = 180;
/** Plans longer than this (the apartment, the flights) say nothing about one charge. */
const MAX_PLAN_MIN = 12 * 60;
/** A merchant seen this often outside the trip is a habit. */
const RECURRING_MIN = 2;

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
}

function major(m: Money): number {
  return m.amountMinor / 100;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
}

function minutesBetween(a: IsoDateTime, b: IsoDateTime): number {
  return (parseIso(b) - parseIso(a)) / 60_000;
}

/** Plans (non-lodging, non-flight, ≤ 12h) whose window holds `at`. */
export function plansAt<A extends ActivityWindow>(activities: readonly A[], at: IsoDateTime): A[] {
  const t = parseIso(at);
  return activities.filter((a) => {
    if (a.startsAt === undefined || a.kind === 'lodging' || a.kind === 'flight') return false;
    const start = parseIso(a.startsAt);
    const end = a.endsAt !== undefined ? parseIso(a.endsAt) : start + DEFAULT_PLAN_MIN * 60_000;
    if (a.endsAt !== undefined && minutesBetween(a.startsAt, a.endsAt) > MAX_PLAN_MIN) return false;
    return t >= start - WINDOW_BEFORE_MIN * 60_000 && t <= end + WINDOW_AFTER_MIN * 60_000;
  });
}

/** Does this amount plausibly cover more than one person, given a per-head price? */
function coversOthers(amount: number, perHead: number, groupSize: number): boolean {
  return groupSize >= 2 && amount >= perHead * 2;
}

function categoryBase(
  f: CardFeatures,
  ctx: LooksSharedContext,
  night: boolean,
): { score: number; reason: string } {
  const a = major(f.amount);
  const n = ctx.memberIds.length;
  const primary = f.categoryPrimary ?? '';
  const detailed = f.categoryDetailed ?? '';
  if (detailed === 'TRAVEL_LODGING') return { score: 0.9, reason: 'lodging' };
  if (detailed === 'TRAVEL_FLIGHTS') return { score: 0.2, reason: 'flights are per person' };
  if (detailed === 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES') {
    let s = 0.55;
    if (a >= 12) s += 0.2;
    if (night) s += 0.15;
    if (a < 10 && !night) s -= 0.25;
    return { score: s, reason: night ? 'a ride at night' : 'a ride' };
  }
  if (detailed === 'TRANSPORTATION_PUBLIC_TRANSIT') {
    return coversOthers(a, 15, n)
      ? { score: 0.75, reason: 'transit for several people' }
      : { score: 0.15, reason: 'one transit fare' };
  }
  if (detailed === 'TRANSPORTATION_BIKES_AND_SCOOTERS') {
    return { score: 0.15, reason: 'a bike or scooter for one' };
  }
  if (primary === 'TRANSPORTATION') return { score: 0.7, reason: 'getting around' };
  if (detailed === 'FOOD_AND_DRINK_GROCERIES') return { score: 0.8, reason: 'groceries' };
  if (detailed === 'FOOD_AND_DRINK_COFFEE') {
    return a >= 15
      ? { score: 0.5, reason: 'a big coffee run' }
      : { score: 0.15, reason: 'a coffee' };
  }
  if (detailed === 'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR') {
    return coversOthers(a, 7.5, n)
      ? { score: 0.8, reason: 'drinks for more than one' }
      : { score: 0.3, reason: 'one drink' };
  }
  if (primary === 'FOOD_AND_DRINK') {
    if (coversOthers(a, 15, n)) return { score: 0.8, reason: 'a meal for more than one' };
    if (a < 12) return { score: 0.15, reason: 'a snack for one' };
    return { score: 0.5, reason: 'a meal, maybe for one' };
  }
  if (primary === 'ENTERTAINMENT') {
    if (coversOthers(a, 20, n)) return { score: 0.85, reason: 'tickets for more than one' };
    if (a < 20) return { score: 0.2, reason: 'one ticket' };
    return { score: 0.5, reason: 'tickets, maybe for one' };
  }
  if (primary === 'GENERAL_MERCHANDISE') {
    return detailed === 'GENERAL_MERCHANDISE_SUPERSTORES'
      ? { score: 0.5, reason: 'a superstore run' }
      : { score: 0.1, reason: 'shopping' };
  }
  return { score: 0.5, reason: 'no category signal' };
}

/**
 * Stage 1. Pure: the same charge and context always score the same. Reasons
 * are fixed phrases, never the descriptor (it is untrusted text).
 */
export function scoreLooksShared(f: CardFeatures, ctx: LooksSharedContext): HeuristicScore {
  if (f.direction === 'credit') return { score: 0.02, reasons: ['a refund or credit'] };
  const primary = f.categoryPrimary ?? '';
  if (PERSONAL_PRIMARY.has(primary)) {
    return { score: 0.05, reasons: ['a personal category (fees, transfers, health, care)'] };
  }
  const trip = ctx.trip;
  if (trip === null) return { score: 0.1, reasons: ['no trip to share it with'] };
  if (ctx.memberIds.length < 2) return { score: 0.05, reasons: ['nobody to share it with'] };

  const placeKnown = f.city !== undefined || f.country !== undefined;
  const inPlace =
    (f.city !== undefined && fold(f.city) === fold(trip.city)) ||
    (f.country !== undefined && fold(f.country) === fold(trip.countryCode));
  if (placeKnown && !inPlace) return { score: 0.08, reasons: ['not where the trip is'] };

  const day = localDate(f.occurredAt, trip.timeZone);
  if (day > trip.endDate) return { score: 0.1, reasons: ['after the trip'] };
  if (day < trip.startDate) {
    const prepaid =
      placeKnown &&
      (primary === 'ENTERTAINMENT' ||
        (primary === 'TRAVEL' && f.categoryDetailed !== 'TRAVEL_FLIGHTS'));
    return prepaid
      ? { score: 0.8, reasons: ['booked ahead for the trip city'] }
      : { score: 0.12, reasons: ['before the trip'] };
  }

  const hour = localHour(f.occurredAt, trip.timeZone);
  const night = f.hasTime && (hour >= NIGHT_FROM || hour < NIGHT_UNTIL);
  const base = categoryBase(f, ctx, night);
  let score = base.score;
  const reasons = [base.reason];

  // Activity windows (the roster says who was there).
  if (f.hasTime) {
    const plans = plansAt(ctx.activities, f.occurredAt);
    const mine = plans.filter((p) => p.inMemberIds.includes(ctx.ownerMemberId));
    const others = ctx.memberIds.filter((id) => id !== ctx.ownerMemberId);
    const busyElsewhere = new Set(
      plans.filter((p) => !p.inMemberIds.includes(ctx.ownerMemberId)).flatMap((p) => p.inMemberIds),
    );
    if (mine.some((p) => p.inMemberIds.length >= 2)) {
      score += 0.05;
      reasons.push('during a plan with others');
    } else if (mine.length > 0) {
      score -= 0.45;
      reasons.push('during a plan only the owner is on');
    } else if (others.length > 0 && others.every((id) => busyElsewhere.has(id))) {
      score -= 0.45;
      reasons.push('everyone else was busy');
    }
  }

  // Recurring personal merchants (a habit from home, e.g. a subscription).
  if (f.merchantKey !== '' && (ctx.homeMerchantCounts.get(f.merchantKey) ?? 0) >= RECURRING_MIN) {
    score -= 0.2;
    reasons.push('a regular merchant from home');
  }
  return { score: clamp(score), reasons };
}

// ---------- stage 2: the fast model for the uncertain band ----------

export const LOOKS_SHARED_SYSTEM = [
  'You decide whether one card charge from a group trip was probably a shared group expense.',
  'Answer with exactly one label: shared, personal, or unsure. Say unsure rather than guess.',
  UNTRUSTED_SYSTEM_SENTENCE,
].join('\n');

/** The classify input: structured facts plus the descriptor as untrusted data. */
export function looksSharedInput(f: CardFeatures, ctx: LooksSharedContext): string {
  const trip = ctx.trip;
  const when =
    trip === null || !f.hasTime
      ? 'time unknown'
      : `local hour ${String(localHour(f.occurredAt, trip.timeZone))}`;
  const facts = [
    `charge ${formatMoney(f.amount)}`,
    (f.categoryDetailed ?? 'uncategorized').toLowerCase(),
    when,
    `group of ${String(ctx.memberIds.length)}`,
  ].join(' · ');
  return `${facts}\n${wrapUntrusted(f.rawName, 'card_descriptor', f.transactionId)}`;
}

export interface ClassifyCardOptions {
  readonly model?: ModelClient;
  readonly scenario?: string;
  /**
   * Source-specific facts on top of stage 1 (T-012: an email receipt's rider
   * count). Gets the stage-1 score and returns the one the thresholds use
   * (clamped to [0, 1]). Reasons stay fixed phrases.
   */
  readonly adjust?: (h: HeuristicScore) => HeuristicScore;
}

/**
 * Stage 1, then stage 2 only in the uncertain band. Without a model the
 * uncertain band is `unsure` (heuristic-only mode, never prompted).
 */
export async function classifyLooksShared(
  f: CardFeatures,
  ctx: LooksSharedContext,
  opts: ClassifyCardOptions = {},
): Promise<LooksSharedVerdict> {
  const stage1 = scoreLooksShared(f, ctx);
  const adjusted = opts.adjust === undefined ? stage1 : opts.adjust(stage1);
  const h: HeuristicScore = { score: clamp(adjusted.score), reasons: adjusted.reasons };
  const reason = h.reasons.join(', ');
  if (h.score >= SHARED_AT) return { label: 'shared', score: h.score, reason, stage: 'heuristic' };
  if (h.score <= PERSONAL_AT) {
    return { label: 'personal', score: h.score, reason, stage: 'heuristic' };
  }
  if (opts.model === undefined) {
    return { label: 'unsure', score: h.score, reason, stage: 'heuristic' };
  }
  const res = await opts.model.classify<LooksSharedLabel>({
    classifierId: LOOKS_SHARED_CLASSIFIER_ID,
    labels: LOOKS_SHARED_LABELS,
    systemPromptId: LOOKS_SHARED_CLASSIFIER_ID,
    system: LOOKS_SHARED_SYSTEM,
    input: looksSharedInput(f, ctx),
    ...(opts.scenario !== undefined ? { scenario: opts.scenario } : {}),
  });
  const known = (LOOKS_SHARED_LABELS as readonly string[]).includes(res.label);
  const label: LooksSharedLabel =
    known && res.label === 'shared'
      ? res.score >= MODEL_SHARED_MIN
        ? 'shared'
        : 'unsure'
      : known
        ? res.label
        : 'unsure';
  return {
    label,
    score: clamp(res.score),
    // The model's own reason may echo the descriptor: it is never stored.
    reason: `${reason}, model said ${label}`,
    stage: 'model',
    modelSource: res.source,
  };
}

/** Heuristic-only verdict (sync), for the precision/recall report. */
export function heuristicLabel(f: CardFeatures, ctx: LooksSharedContext): LooksSharedLabel {
  const { score } = scoreLooksShared(f, ctx);
  return score >= SHARED_AT ? 'shared' : score <= PERSONAL_AT ? 'personal' : 'unsure';
}

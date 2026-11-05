/**
 * Tier fixture trips (`fixtures/tiers/*.json`, T-167): a trip's signals
 * (flights, stays, shares, members' own lines) and the labeled tier per
 * member and for the group. Pure: the caller reads the file and hands the
 * parsed JSON in. Used by the unit tests and the `spending_tier` eval probe.
 */
import { TravError, tiers } from '@trav/core';
import type { CurrencyCode, Member, MemberId, SpendingTier, Trip } from '@trav/core';
import { collectTierSignals } from './signals.js';
import type { GroupLine, SpendShare, TravelFact } from './signals.js';

export type TierLabel = SpendingTier | 'conflict' | 'missing';

export interface TierFixture {
  readonly name: string;
  readonly travel: readonly TravelFact[];
  readonly spend: readonly Omit<SpendShare, 'currency'>[];
  readonly groupLines: readonly GroupLine[];
  readonly expect: {
    readonly members: Readonly<Record<string, TierLabel>>;
    readonly group: { readonly status: tiers.TierStatus; readonly target?: SpendingTier };
    readonly restaurantPriceLevelsAtLeast?: number;
    readonly restaurantPriceLevelsAtMost?: number;
  };
}

const LABELS: ReadonlySet<string> = new Set(['budget', 'mid', 'high', 'conflict', 'missing']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bad(label: string, what: string): never {
  throw new TravError('invalid_argument', `${label}: ${what}`);
}

/** Validates a parsed tier fixture (shape only; the signals are read by `collectTierSignals`). */
export function parseTierFixture(raw: unknown, label = 'tier fixture'): TierFixture {
  if (!isRecord(raw)) bad(label, 'not an object');
  const name = raw['name'];
  if (typeof name !== 'string' || name.length === 0) bad(label, '"name" must be a string');
  for (const k of ['travel', 'spend', 'groupLines'] as const) {
    if (!Array.isArray(raw[k])) bad(label, `"${k}" must be an array`);
  }
  for (const t of raw['travel'] as unknown[]) {
    if (!isRecord(t) || (t['kind'] !== 'flight' && t['kind'] !== 'lodging')) {
      bad(label, 'travel rows are flights or lodging');
    }
  }
  for (const s of raw['spend'] as unknown[]) {
    if (!isRecord(s) || !Number.isSafeInteger(s['shareMinor'])) {
      bad(label, 'spend rows need an integer shareMinor');
    }
  }
  const expect = raw['expect'];
  if (!isRecord(expect) || !isRecord(expect['members']) || !isRecord(expect['group'])) {
    bad(label, '"expect" needs members and group');
  }
  for (const [id, v] of Object.entries(expect['members'] as Record<string, unknown>)) {
    if (typeof v !== 'string' || !LABELS.has(v)) bad(label, `bad label for ${id}`);
  }
  return raw as unknown as TierFixture;
}

export interface TierFixtureResult {
  readonly members: Readonly<Record<string, TierLabel>>;
  readonly blend: tiers.TierBlend;
}

/** Each member's inferred tier (or conflict/missing) and the group blend, from the fixture's signals. */
export function inferTierFixture(
  fx: TierFixture,
  ctx: { readonly trip: Trip; readonly members: readonly Member[] },
): TierFixtureResult {
  const signals = collectTierSignals({
    trip: ctx.trip,
    members: ctx.members,
    groupFacts: [],
    travel: fx.travel,
    shares: fx.spend.map((s) => ({ ...s, currency: ctx.trip.currency as CurrencyCode })),
    groupLines: fx.groupLines,
  });
  const inferred = ctx.members.map((m) => tiers.inferTier(signals.get(m.memberId) ?? []));
  const members: Record<string, TierLabel> = {};
  ctx.members.forEach((m, i) => {
    const t = inferred[i]!;
    members[m.memberId as MemberId] = t.status === 'known' ? t.tier! : t.status;
  });
  return { members, blend: tiers.blendTiers(inferred) };
}

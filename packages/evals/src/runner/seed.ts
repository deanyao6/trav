/**
 * Seeds a runtime's stores from `fixtures/groups/<trip>.json`. The group,
 * members, trip, activities and attendance match `packages/core/src/domain`
 * exactly (fixtures/README.md); fixture-only fields are ignored. Consent,
 * member prefs and memory are loaded only when asked (`extras`), so a
 * scenario states which private data exists in its episode.
 */
import type {
  Activity,
  Attendance,
  ConsentFlags,
  Group,
  GroupMemoryFact,
  Member,
  MemberMemoryFact,
  MemberSpendingPrefs,
  Stores,
  Trip,
} from '@trav/core';
import { markPrivate } from '@trav/core';
import type { TripName } from '../fixtures.js';
import { loadFixture } from '../fixtures.js';

export interface GroupFixture {
  readonly id: string;
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip;
  readonly activities: readonly Activity[];
  readonly attendance: readonly Attendance[];
  readonly consent: readonly ConsentFlags[];
  readonly memberPrefs: readonly MemberSpendingPrefs[];
  readonly groupMemory: readonly GroupMemoryFact[];
  /** PrivateStore data shown as plain JSON in the fixture. */
  readonly memberMemory: readonly Readonly<Record<string, unknown>>[];
  readonly labels: {
    readonly familyMode?: boolean;
    readonly minors?: readonly string[];
    readonly privateFactsNeverInGroup?: readonly string[];
    readonly [key: string]: unknown;
  };
}

const cache = new Map<TripName, GroupFixture>();

export function loadGroupFixture(trip: TripName): GroupFixture {
  const hit = cache.get(trip);
  if (hit !== undefined) return hit;
  const f = loadFixture<GroupFixture>(`groups/${trip}.json`);
  cache.set(trip, f);
  return f;
}

/** Strip keys the domain types do not have (fixture-only extras such as `homeAirport`). */
function member(m: Member): Member {
  const { homeAirport: _home, ...rest } = m as Member & { homeAirport?: unknown };
  return rest as Member;
}

export interface SeedOptions {
  readonly extras?: boolean;
  readonly settings?: Readonly<Record<string, unknown>>;
  /**
   * The episode start. A member's spending prefs exist only from when they
   * told Trav their budget (their private `budget` fact's `learnedAt`, the
   * fixture generator's `prefsFrom`): prefs told later are held back and
   * returned in `deferredPrefs`, for the runner to apply when the clock gets
   * there (T-132: Henry's €80 cap is told on mar 11, not before).
   */
  readonly now?: string;
}

/** Spending prefs that start to apply at `at` (see `SeedOptions.now`). */
export interface DeferredPrefs {
  readonly at: string;
  readonly prefs: MemberSpendingPrefs;
}

/** When `memberId` told Trav their budget: their latest private `budget` fact's `learnedAt`. */
export function prefsToldAt(f: GroupFixture, memberId: string): string | undefined {
  return f.memberMemory
    .filter((m) => m['ownerMemberId'] === memberId && m['category'] === 'budget')
    .map((m) => String(m['learnedAt']))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1);
}

/** Writes the fixture group into `stores` and returns it, with any prefs held back (`SeedOptions.now`). */
export function seedGroup(
  stores: Stores,
  trip: TripName,
  opts: SeedOptions = {},
): GroupFixture & { readonly deferredPrefs: readonly DeferredPrefs[] } {
  const deferredPrefs: DeferredPrefs[] = [];
  const f = loadGroupFixture(trip);
  const group: Group =
    opts.settings === undefined
      ? f.group
      : { ...f.group, settings: { ...f.group.settings, ...opts.settings } };
  stores.group.groups.create(group);
  for (const m of f.members) stores.group.members.upsert(member(m));
  stores.group.trips.create(f.trip);
  for (const a of f.activities) stores.group.trips.upsertActivity(a);
  for (const a of f.attendance) stores.group.trips.setAttendance(a);
  if (opts.extras === true) {
    for (const c of f.consent) stores.private.putConsent(c.memberId, c);
    for (const p of f.memberPrefs) {
      const at = opts.now === undefined ? undefined : prefsToldAt(f, p.memberId);
      if (at !== undefined && opts.now !== undefined && Date.parse(at) > Date.parse(opts.now)) {
        deferredPrefs.push({ at, prefs: p });
      } else stores.private.putPrefs(p.memberId, p);
    }
    for (const g of f.groupMemory) stores.group.groupMemory.upsert(g);
    for (const m of f.memberMemory) {
      const fact: MemberMemoryFact = markPrivate({
        factId: String(m['factId']),
        ownerMemberId: String(m['ownerMemberId']),
        groupId: String(m['groupId']),
        sourceTripId: (m['sourceTripId'] as string | null) ?? null,
        category: m['category'] as GroupMemoryFact['category'],
        text: String(m['text']),
        sourceLane: m['sourceLane'] === 'group' ? ('group' as const) : ('private' as const),
        sourceMessageId: String(m['sourceMessageId']),
        learnedAt: String(m['learnedAt']),
      });
      stores.private.putMemberMemory(fact.ownerMemberId, fact);
    }
  }
  return { ...f, deferredPrefs };
}

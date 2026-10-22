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
}

/** Writes the fixture group into `stores` and returns it. */
export function seedGroup(stores: Stores, trip: TripName, opts: SeedOptions = {}): GroupFixture {
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
    for (const p of f.memberPrefs) stores.private.putPrefs(p.memberId, p);
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
  return f;
}

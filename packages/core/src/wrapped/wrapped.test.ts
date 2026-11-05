/**
 * T-016: every Wrapped award, group award, total and the highlight scorer on
 * the Barcelona fixture (`fixtures/wrapped/barcelona.json` is the ground
 * truth), plus the acceptance edges: opt-out, the TCI minor, photos of minors.
 */
import { describe, expect, it } from 'vitest';
import type { Expense } from '../domain/expense.js';
import type { Member } from '../domain/group.js';
import type { Trip } from '../domain/trip.js';
import type { IsoDateTime, MemberId } from '../primitives.js';
import { parseIso } from '../clock.js';
import { loadFixture, loadFixtureJsonl } from '../testkit/fixtures.js';
import type {
  ActivityRoster,
  AlbumPhotoFact,
  AwardId,
  PlannerBooking,
  WrappedAwardsInput,
} from './awards.js';
import { AWARD_TITLES, computeAwards, computeGroupAwards } from './awards.js';
import { computeTotals } from './totals.js';
import type { HighlightCandidate } from './highlights.js';
import { scoreHighlights, shareablePhoto } from './highlights.js';

interface GroupFixture {
  readonly members: Member[];
  readonly trip: Trip;
  readonly labels: {
    readonly expectedFinalRosters?: Record<string, { in: MemberId[]; out: MemberId[] }>;
  };
}
interface AwardTruth {
  readonly award: string;
  readonly stats: { memberId: MemberId; value: number }[];
  readonly topHolders: MemberId[];
  readonly referenceWinner: MemberId;
  readonly acceptableWinners: MemberId[];
  readonly repeatWinner: boolean;
}
interface WrappedTruth {
  readonly renderAt: IsoDateTime;
  readonly wrappedFacts: {
    totalSpent: { amountMinor: number };
    perPersonAverage: { amountMinor: number };
    byCategory: { category: string; amount: { amountMinor: number } }[];
    expenseCount: number;
    bookingCount: number;
    biggestExpense: { expenseId: string };
  };
  readonly awards: AwardTruth[];
  readonly groupAwards: {
    bigNight: { night: string; spent: { amountMinor: number } };
    bestValueNight: {
      night: string;
      allNights: { night: string; spent: { amountMinor: number }; groupMessages: number }[];
    };
  };
  readonly nightOwlDetail: Record<string, { memberId: MemberId; expenseId: string }>;
  readonly earlyBirdDetail: Record<string, { memberId: MemberId; expenseId: string }>;
  readonly photos: {
    onlyFromOwners: MemberId[];
    highlightCandidates: string[];
    neverShow: string[];
  };
  readonly mustNotContain: string[];
}
interface AlbumFixture {
  readonly photos: (HighlightCandidate & { groupId: string })[];
  readonly labels: Record<
    string,
    { inPhoto: MemberId[]; includesMinor: boolean; allowedInWrappedShareCard?: boolean }
  >;
  readonly consentTimeline: { at: IsoDateTime; memberId: MemberId; photos: boolean }[];
}
interface ChatRow {
  readonly id: string;
  readonly ts: IsoDateTime;
  readonly kind: string;
  readonly lane: string;
  readonly senderId: string;
  readonly target?: { cardRef?: string };
  readonly expect?: { action?: string; cardRef?: string; proposal?: unknown };
}

const BCN = loadFixture<GroupFixture>('groups/barcelona.json');
const LEDGER = loadFixture<{ expenses: Expense[] }>('ledger/barcelona.json');
const TRUTH = loadFixture<WrappedTruth>('wrapped/barcelona.json');
const ALBUM = loadFixture<AlbumFixture>('album/barcelona.json');
const CHAT = loadFixtureJsonl<ChatRow>('chats/barcelona.jsonl');

const TITLE_TO_ID = new Map<string, AwardId>(
  (Object.entries(AWARD_TITLES) as [AwardId, string][]).map(([id, title]) => [title, id]),
);

function consentAt(
  timeline: AlbumFixture['consentTimeline'],
  memberId: MemberId,
  at: IsoDateTime,
): boolean {
  let v = false;
  for (const e of timeline)
    if (e.memberId === memberId && parseIso(e.at) <= parseIso(at)) v = e.photos;
  return v;
}

/** Completed bookings with who asked for them, from the chat ground truth. */
function plannerBookings(rows: readonly ChatRow[], members: readonly Member[]): PlannerBooking[] {
  const byHandle = new Map(members.map((m) => [m.senderId, m.memberId] as const));
  const requester = new Map<string, MemberId>();
  for (const r of rows) {
    const who = byHandle.get(r.senderId);
    if (r.expect?.cardRef !== undefined && r.expect.proposal !== undefined && who !== undefined) {
      requester.set(r.expect.cardRef, who);
    }
  }
  const out: PlannerBooking[] = [];
  for (const r of rows) {
    if (r.expect?.action !== 'booking_completed') continue;
    const ref = r.target?.cardRef;
    const who = ref === undefined ? undefined : requester.get(ref);
    if (ref === undefined || who === undefined) continue;
    out.push({
      bookingId: `bk_${ref}`,
      requestedBy: who,
      description: ref,
      status: 'confirmed',
      contentTags: [],
      ageRestriction: null,
    });
  }
  return out;
}

function bcnInput(over: Partial<WrappedAwardsInput> = {}): WrappedAwardsInput {
  const rosters: ActivityRoster[] = Object.entries(BCN.labels.expectedFinalRosters ?? {}).map(
    ([activityId, r]) => ({ activityId, inMemberIds: r.in }),
  );
  const photos: AlbumPhotoFact[] = ALBUM.photos
    .filter((p) => !p.hidden && consentAt(ALBUM.consentTimeline, p.ownerMemberId, TRUTH.renderAt))
    .map((p) => ({
      photoId: p.photoId,
      ownerMemberId: p.ownerMemberId,
      ...(p.qualityTag !== undefined ? { qualityTag: p.qualityTag } : {}),
    }));
  return {
    trip: BCN.trip,
    members: BCN.members,
    now: TRUTH.renderAt,
    expenses: LEDGER.expenses,
    bookings: plannerBookings(CHAT, BCN.members),
    rosters,
    photos,
    optedOut: [],
    ...over,
  };
}

describe('Wrapped awards on the Barcelona fixture (T-016)', () => {
  const result = computeAwards(bcnInput());

  for (const truth of TRUTH.awards) {
    it(`${truth.award}: stats, top holders and the one-per-person winner match the ground truth`, () => {
      const id = TITLE_TO_ID.get(truth.award)!;
      expect(id, truth.award).toBeDefined();
      const standing = result.standings.find((s) => s.id === id)!;
      // The fixture lists stats only for eligible members (Photographer: consenting owners).
      for (const s of truth.stats) {
        expect(standing.stats.find((x) => x.memberId === s.memberId)?.value ?? 0, s.memberId).toBe(
          s.value,
        );
      }
      expect([...standing.topHolders].sort()).toEqual([...truth.topHolders].sort());
      const award = result.awards.find((a) => a.id === id)!;
      expect(award.memberId).toBe(truth.referenceWinner);
      expect(truth.acceptableWinners).toContain(award.memberId);
      expect(award.repeat).toBe(truth.repeatWinner);
      expect(award.title).toBe(truth.award);
    });
  }

  it('Night Owl and Early Bird trace to the exact expenses in the per-night / per-day detail', () => {
    const owl = result.awards.find((a) => a.id === 'night_owl')!;
    const owlIds = Object.values(TRUTH.nightOwlDetail)
      .filter((d) => d.memberId === owl.memberId)
      .map((d) => d.expenseId);
    expect(owl.trace).toEqual(owlIds);
    const bird = result.awards.find((a) => a.id === 'early_bird')!;
    const birdIds = Object.values(TRUTH.earlyBirdDetail)
      .filter((d) => d.memberId === bird.memberId)
      .map((d) => d.expenseId);
    expect([...bird.trace].sort()).toEqual([...birdIds].sort());
  });

  it('Most Fronted counts expenses fronted (not euros); everyone already has one, so it repeats', () => {
    const counts = new Map<MemberId, number>();
    for (const e of LEDGER.expenses)
      for (const p of e.paidBy) counts.set(p.memberId, (counts.get(p.memberId) ?? 0) + 1);
    const standing = result.standings.find((s) => s.id === 'most_fronted')!;
    for (const s of standing.stats) expect(s.value).toBe(counts.get(s.memberId) ?? 0);
    const award = result.awards.find((a) => a.id === 'most_fronted')!;
    expect(award.memberId).toBe('mem_dean');
    expect(award.value).toBe(counts.get('mem_dean'));
    expect(award.evidence).toBe(`${String(counts.get('mem_dean'))} tabs`);
    expect(award.repeat).toBe(true);
  });

  it('one award per person where possible: the six members each get one before anyone repeats', () => {
    const fresh = result.awards.filter((a) => !a.repeat).map((a) => a.memberId);
    expect(new Set(fresh).size).toBe(fresh.length);
    expect(new Set(fresh)).toEqual(new Set(BCN.members.map((m) => m.memberId)));
  });

  it('every award has a basis and a trace that points at real ledger / booking / roster / album rows', () => {
    const input = bcnInput();
    const expenseIds = new Set(input.expenses.map((e) => e.expenseId));
    const bookingIds = new Set(input.bookings.map((b) => b.bookingId));
    const activityIds = new Set(input.rosters.map((r) => r.activityId));
    const photoIds = new Set(input.photos.map((p) => p.photoId));
    const sourceFor = {
      ledger: expenseIds,
      booking: bookingIds,
      attendance: activityIds,
      album: photoIds,
    };
    for (const a of result.awards) {
      expect(a.trace.length, a.title).toBeGreaterThan(0);
      for (const id of a.trace) expect(sourceFor[a.basis].has(id), `${a.title} → ${id}`).toBe(true);
      if (a.id !== 'mvp_spender') expect(a.trace.length, a.title).toBe(a.value);
    }
    const mvp = result.awards.find((a) => a.id === 'mvp_spender')!;
    const fronted = input.expenses
      .filter((e) => mvp.trace.includes(e.expenseId))
      .reduce(
        (s, e) =>
          s +
          e.paidBy
            .filter((p) => p.memberId === mvp.memberId)
            .reduce((x, p) => x + p.amount.amountMinor, 0),
        0,
      );
    expect(fronted).toBe(mvp.value);
    expect(mvp.evidence).toBe('€2,065.20');
  });

  it('evidence never carries a blocklisted word or private data', () => {
    const text = result.awards
      .map((a) => `${a.title} ${a.evidence}`)
      .join(' ')
      .toLowerCase();
    for (const bad of TRUTH.mustNotContain) expect(text).not.toContain(bad.toLowerCase());
  });

  it('an opted-out member gets no award and never ranks; the next person up takes it', () => {
    const r = computeAwards(bcnInput({ optedOut: ['mem_dean'] }));
    expect(r.awards.map((a) => a.memberId)).not.toContain('mem_dean');
    for (const s of r.standings) expect(s.stats.map((x) => x.memberId)).not.toContain('mem_dean');
    expect(r.awards.find((a) => a.id === 'mvp_spender')?.memberId).toBe('mem_piotr');
    // Nobody else asked Trav for a booking, so The Planner simply isn't given.
    expect(r.awards.find((a) => a.id === 'planner')).toBeUndefined();
  });

  it('members who left, and guests, get nothing', () => {
    const members = BCN.members.map((m) =>
      m.memberId === 'mem_piotr'
        ? { ...m, active: false, leftAt: '2026-03-17T09:00:00+01:00' }
        : m.memberId === 'mem_arjun'
          ? { ...m, role: 'guest' as const }
          : m,
    );
    const r = computeAwards(bcnInput({ members }));
    expect(r.awards.map((a) => a.memberId)).not.toContain('mem_piotr');
    expect(r.awards.map((a) => a.memberId)).not.toContain('mem_arjun');
  });

  it('empty trip: no awards, no throw', () => {
    const r = computeAwards(bcnInput({ expenses: [], bookings: [], rosters: [], photos: [] }));
    expect(r.awards).toEqual([]);
    expect(r.standings.every((s) => s.topHolders.length === 0)).toBe(true);
  });

  it('a duplicated expense row counts once', () => {
    const doubled = [...LEDGER.expenses, LEDGER.expenses[0]!];
    const r = computeAwards(bcnInput({ expenses: doubled }));
    const mvp = r.standings.find((s) => s.id === 'mvp_spender')!;
    expect(mvp.stats.find((s) => s.memberId === 'mem_dean')!.value).toBe(206520);
    expect(computeTotals({ trip: BCN.trip, expenses: doubled, people: 6 }).spent.amountMinor).toBe(
      TRUTH.wrappedFacts.totalSpent.amountMinor,
    );
  });

  it('undone expenses and other-currency rows never count', () => {
    const undone = LEDGER.expenses.map((e) =>
      e.paidBy[0]?.memberId === 'mem_dean' ? { ...e, status: 'undone' as const } : e,
    );
    const r = computeAwards(bcnInput({ expenses: undone }));
    expect(
      r.standings.find((s) => s.id === 'mvp_spender')!.stats.find((s) => s.memberId === 'mem_dean')!
        .value,
    ).toBe(0);
    const usd = LEDGER.expenses.map((e) => ({ ...e, amount: { ...e.amount, currency: 'USD' } }));
    expect(
      computeAwards(bcnInput({ expenses: usd })).standings.find((s) => s.id === 'mvp_spender')!
        .topHolders,
    ).toEqual([]);
  });
});

describe('Wrapped group awards and totals on the Barcelona fixture', () => {
  const groupMessageTimes = CHAT.filter((r) => {
    const member = BCN.members.some((m) => m.senderId === r.senderId);
    return r.kind === 'message' && r.lane === 'group' && member;
  }).map((r) => r.ts);

  it('Big Night: the trip night with the highest group-ledger total, nobody named', () => {
    const g = computeGroupAwards({ trip: BCN.trip, expenses: LEDGER.expenses });
    expect(g.bigNight?.night).toBe(TRUTH.groupAwards.bigNight.night);
    expect(g.bigNight?.spentMinor).toBe(TRUTH.groupAwards.bigNight.spent.amountMinor);
    expect(g.bigNight?.basis).toBe('ledger');
    expect(g.bestValueNight).toBeNull();
    expect(Object.keys(g.bigNight!)).not.toContain('memberId');
  });

  it('Best Value Night: most group messages per €10 that night', () => {
    const g = computeGroupAwards({ trip: BCN.trip, expenses: LEDGER.expenses, groupMessageTimes });
    expect(g.bestValueNight?.night).toBe(TRUTH.groupAwards.bestValueNight.night);
    expect(
      g.nights.map((n) => ({
        night: n.night,
        spent: n.spentMinor,
        groupMessages: n.groupMessages,
      })),
    ).toEqual(
      TRUTH.groupAwards.bestValueNight.allNights.map((n) => ({
        night: n.night,
        spent: n.spent.amountMinor,
        groupMessages: n.groupMessages,
      })),
    );
  });

  it('totals: spent, average, categories, counts, biggest expense / day / meal, rides, latest night', () => {
    const t = computeTotals({ trip: BCN.trip, expenses: LEDGER.expenses, people: 6 });
    const f = TRUTH.wrappedFacts;
    expect(t.spent.amountMinor).toBe(f.totalSpent.amountMinor);
    expect(t.perPerson.amountMinor).toBe(f.perPersonAverage.amountMinor);
    expect(t.byCategory.map((c) => [c.category, c.amount.amountMinor])).toEqual(
      f.byCategory.map((c) => [c.category, c.amount.amountMinor]),
    );
    expect(t.topCategory?.category).toBe('lodging');
    expect(t.expenseCount).toBe(f.expenseCount);
    expect(t.bookingCount).toBe(f.bookingCount);
    expect(t.biggestExpense?.expenseId).toBe(f.biggestExpense.expenseId);
    // Fri 13: cava 30 + Gat Blau 184 + groceries 47.20 (pre-trip bookings are not a day).
    expect(t.biggestDay).toMatchObject({ date: '2026-03-13', amount: { amountMinor: 26120 } });
    expect(t.biggestMeal?.expenseId).toBe('exp_bcn_010');
    expect(t.rides).toMatchObject({ count: 3, amount: { amountMinor: 7400 } });
    expect(t.rides.expenseIds).toEqual(['exp_bcn_006', 'exp_bcn_011', 'exp_bcn_016']);
    expect(t.nightsOnTab).toBe(3);
    // Minute-precise: the 2:14am uber beats the 2:07am kebabs (the fixture's
    // latestNightExpense compares whole hours only, so it ties and keeps 015).
    expect(t.latestNightExpense?.expenseId).toBe('exp_bcn_016');
  });

  it('totals with nobody: zero, no average, no biggest anything', () => {
    const t = computeTotals({ trip: BCN.trip, expenses: [], people: 0 });
    expect(t.spent.amountMinor).toBe(0);
    expect(t.perPerson.amountMinor).toBe(0);
    expect(t.byCategory).toEqual([]);
    expect([
      t.biggestDay,
      t.biggestExpense,
      t.biggestMeal,
      t.latestNightExpense,
      t.topCategory,
    ]).toEqual([null, null, null, null, null]);
  });

  it('per-person average rounds half up in minor units (no floats leak)', () => {
    const e = { ...LEDGER.expenses[5]!, amount: { amountMinor: 1001, currency: 'EUR' } };
    expect(computeTotals({ trip: BCN.trip, expenses: [e], people: 2 }).perPerson.amountMinor).toBe(
      501,
    );
    expect(computeTotals({ trip: BCN.trip, expenses: [e], people: 3 }).perPerson.amountMinor).toBe(
      334,
    );
  });
});

describe('highlight scorer (opt-in photos only, never a minor in the share card)', () => {
  const consented = ALBUM.photos.filter((p) =>
    consentAt(ALBUM.consentTimeline, p.ownerMemberId, TRUTH.renderAt),
  );

  it('Barcelona: 6 highlights from opted-in owners, all highlight candidates, one per time cluster', () => {
    const picked = scoreHighlights(consented, {
      limit: 6,
      timeZone: 'Europe/Madrid',
      minorMemberIds: [],
    });
    expect(picked).toHaveLength(6);
    for (const p of picked) {
      expect(TRUTH.photos.highlightCandidates).toContain(p.photoId);
      expect(TRUTH.photos.neverShow).not.toContain(p.photoId);
      expect(TRUTH.photos.onlyFromOwners).toContain(p.ownerMemberId);
    }
    const times = picked.map((p) => parseIso(p.takenAt ?? p.addedAt));
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(90 * 60_000);
    // Spread: more than one day and more than one owner.
    expect(new Set(picked.map((p) => p.takenAt?.slice(0, 10))).size).toBeGreaterThan(2);
    expect(new Set(picked.map((p) => p.ownerMemberId)).size).toBeGreaterThan(1);
  });

  it('family mode drops photos inside a nightlife activity window, even in daylight hours', () => {
    const one = consented.find(
      (p) => p.qualityTag === 'good' && p.mimeType?.startsWith('image/') === true,
    )!;
    const at = one.takenAt ?? one.addedAt;
    const opts = { limit: 6, timeZone: 'Europe/Madrid', minorMemberIds: [], familyMode: true };
    const p = { ...one, subjects: [] };
    expect(scoreHighlights([p], opts)).toHaveLength(1);
    expect(scoreHighlights([p], { ...opts, restrictedWindows: [{ from: at, to: at }] })).toEqual(
      [],
    );
  });

  it('duplicates collapse, limit 0 is empty, hidden/video/screenshot never pass', () => {
    const one = consented.find(
      (p) => p.qualityTag === 'good' && p.mimeType?.startsWith('image/') === true,
    )!;
    expect(
      scoreHighlights([one, one], { limit: 6, timeZone: 'Europe/Madrid', minorMemberIds: [] }),
    ).toHaveLength(1);
    expect(
      scoreHighlights(consented, { limit: 0, timeZone: 'Europe/Madrid', minorMemberIds: [] }),
    ).toEqual([]);
    expect(shareablePhoto({ ...one, hidden: true }, [])).toBe(false);
    expect(shareablePhoto({ ...one, mimeType: 'video/mp4' }, [])).toBe(false);
    expect(shareablePhoto({ ...one, qualityTag: 'screenshot' }, [])).toBe(false);
  });

  it('Turks and Caicos: never a photo of Lily (tagged or by her); untagged photos fail closed', () => {
    const tci = loadFixture<AlbumFixture>('album/turks-and-caicos.json');
    const end = '2026-06-28T10:00:00-04:00';
    const lily = 'mem_tci_lily';
    const tagged = tci.photos
      .filter((p) => consentAt(tci.consentTimeline, p.ownerMemberId, end))
      .map((p) => ({ ...p, subjects: tci.labels[p.photoId]!.inPhoto }));
    const family = {
      limit: 6,
      timeZone: 'America/Grand_Turk',
      minorMemberIds: [lily],
      familyMode: true,
    };
    const picked = scoreHighlights(tagged, family);
    expect(picked.length).toBeGreaterThan(0);
    // The adults-only casino shot (no minor in it, 10:30pm) is still out in family mode.
    expect(picked.map((p) => p.photoId)).not.toContain('photo_tci_015');
    expect(
      scoreHighlights(tagged, { ...family, familyMode: false }).map((p) => p.photoId),
    ).toContain('photo_tci_015');
    const allowed = Object.entries(tci.labels)
      .filter(([, l]) => l.allowedInWrappedShareCard === true)
      .map(([id]) => id);
    for (const p of picked) {
      expect(allowed).toContain(p.photoId);
      expect(tci.labels[p.photoId]!.includesMinor).toBe(false);
      expect(p.ownerMemberId).not.toBe(lily);
    }
    // Lily's own photos, even with consent, never pass.
    const hers = tci.photos
      .filter((p) => p.ownerMemberId === lily)
      .map((p) => ({ ...p, subjects: [] }));
    expect(
      scoreHighlights(hers, { limit: 6, timeZone: 'America/Grand_Turk', minorMemberIds: [lily] }),
    ).toEqual([]);
    // Without tags nobody can prove Lily isn't in the shot: nothing is shown.
    const untagged = tci.photos.filter((p) => consentAt(tci.consentTimeline, p.ownerMemberId, end));
    expect(
      scoreHighlights(untagged, {
        limit: 6,
        timeZone: 'America/Grand_Turk',
        minorMemberIds: [lily],
      }),
    ).toEqual([]);
  });
});

describe('Turks and Caicos: the minor gets only an event-neutral pick (VOICE §4.8, §8)', () => {
  const TCI = loadFixture<GroupFixture & { activities: { activityId: string }[] }>(
    'groups/turks-and-caicos.json',
  );
  const raw = loadFixture<{
    expenses: {
      expenseId: string;
      description: string | null;
      category: Expense['category'] | null;
      amount: Expense['amount'];
      paidBy: MemberId;
      source: Expense['source'];
      occurredAt: IsoDateTime;
    }[];
  }>('ledger/turks-and-caicos.json');
  const lily = 'mem_tci_lily';
  const expenses: Expense[] = raw.expenses.map((e) => ({
    expenseId: e.expenseId,
    groupId: 'grp_turks_caicos',
    tripId: 'trip_turks_caicos',
    // Some fixture rows are receipt-only (no description or category yet).
    description: e.description ?? 'expense',
    category: e.category ?? 'other',
    amount: e.amount,
    paidBy: [{ memberId: e.paidBy, amount: e.amount }],
    split: { method: 'exclude', excluded: [] },
    source: e.source,
    sourceRef: { kind: 'message', id: e.expenseId },
    occurredAt: e.occurredAt,
    createdAt: e.occurredAt,
    createdBy: e.paidBy,
    status: 'logged',
  }));
  // Lily somehow on the tab late at night and first thing in the morning: still no award.
  const lilyLate: Expense = {
    ...expenses[0]!,
    expenseId: 'exp_tci_lily_late',
    description: 'ice cream',
    category: 'food',
    amount: { amountMinor: 900, currency: 'USD' },
    paidBy: [{ memberId: lily, amount: { amountMinor: 900, currency: 'USD' } }],
    occurredAt: '2026-06-24T23:55:00-04:00',
  };
  const lilyEarly: Expense = {
    ...lilyLate,
    expenseId: 'exp_tci_lily_early',
    occurredAt: '2026-06-24T06:05:00-04:00',
  };
  const snorkel: PlannerBooking = {
    bookingId: 'bk_tci_snorkel',
    requestedBy: lily,
    description: 'snorkel tour',
    status: 'confirmed',
    contentTags: ['family'],
    ageRestriction: null,
  };
  const nightcap: PlannerBooking = {
    bookingId: 'bk_tci_nightcap',
    requestedBy: lily,
    description: 'adults nightcap',
    status: 'confirmed',
    contentTags: ['bar', 'alcohol'],
    ageRestriction: 21,
  };
  const base: WrappedAwardsInput = {
    trip: TCI.trip,
    members: TCI.members,
    now: '2026-06-28T10:00:00-04:00',
    expenses: [...expenses, lilyLate, lilyEarly],
    bookings: [],
    rosters: TCI.activities.map((a) => ({
      activityId: a.activityId,
      inMemberIds: TCI.members.map((m) => m.memberId),
    })),
    photos: [{ photoId: 'p1', ownerMemberId: lily, qualityTag: 'good' }],
    optedOut: [],
  };

  it('with the fixture alone (Dad asked for everything): Lily gets nothing at all', () => {
    const r = computeAwards(base);
    expect(r.awards.filter((a) => a.memberId === lily)).toEqual([]);
    for (const s of r.standings) expect(s.stats.map((x) => x.memberId)).not.toContain(lily);
  });

  it('a booking she asked for that is all-ages becomes "Lily\'s pick"; a nightlife one never does', () => {
    const r = computeAwards({ ...base, bookings: [nightcap, snorkel] });
    const hers = r.awards.filter((a) => a.memberId === lily);
    expect(hers).toEqual([
      expect.objectContaining({
        id: 'pick',
        title: "Lily's pick",
        evidence: 'snorkel tour',
        basis: 'booking',
        trace: ['bk_tci_snorkel'],
        nightlifeAdjacent: false,
      }),
    ]);
    expect(
      computeAwards({ ...base, bookings: [nightcap] }).awards.filter((a) => a.memberId === lily),
    ).toEqual([]);
    expect(
      computeAwards({
        ...base,
        bookings: [{ ...snorkel, description: 'rum tasting', contentTags: [] }],
      }).awards.filter((a) => a.memberId === lily),
    ).toEqual([]);
  });

  it('family mode: no Night Owl for anyone (no "night out" framing in a family Wrapped)', () => {
    const plain = computeAwards(base);
    expect(plain.awards.some((a) => a.id === 'night_owl')).toBe(true);
    const family = computeAwards({ ...base, familyMode: true });
    expect(family.awards.some((a) => a.nightlifeAdjacent)).toBe(false);
    expect(family.standings.map((s) => s.id)).not.toContain('night_owl');
  });

  it('no award to a minor is ever nightlife-adjacent, and an opted-out minor gets no pick', () => {
    const r = computeAwards({ ...base, bookings: [snorkel] });
    for (const a of r.awards) if (a.memberId === lily) expect(a.nightlifeAdjacent).toBe(false);
    expect(
      computeAwards({ ...base, bookings: [snorkel], optedOut: [lily] }).awards.filter(
        (a) => a.memberId === lily,
      ),
    ).toEqual([]);
  });
});

/**
 * T-015: the Morning After / daily settle-up over the real stores, offline.
 *
 * The Barcelona fixture world is replayed into a runtime as it stood at each
 * recap time (expenses logged by then, photo consent by then, members' chat
 * times by then). The composer must pick the fixture's mode for every
 * morning, list last night's spending with "(5 of you, not Henry)" and never
 * a reason, settle to the cent against the ledger checkpoint, show pending
 * private items only as a count, gate roast lines, never use night framing in
 * Turks and Caicos, and never show a dropped photo again (here or in Wrapped).
 * Plus the scheduled job on the simulated clock and "@trav drop that one".
 *
 * One deliberate difference from `fixtures/recaps/barcelona.json`: the
 * fixture lists expenses by when they were *logged*; the recap lists them by
 * when they *happened* (`occurredAt`), so a 2am Uber that reached the ledger
 * from a card at 9am is still last night's (VOICE §4.7 A lists the ubers).
 * The modes and the signals are the fixture's exactly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AlbumAdapter } from '@trav/adapters';
import { createMockAlbum, createSimulatorChannel } from '@trav/adapters';
import type {
  Activity,
  ConsentFlags,
  Expense,
  Group,
  IsoDateTime,
  Member,
  MemberId,
  PendingPrivateItem,
  RecapCard,
  SettleUpCard,
  Stores,
  Trip,
} from '@trav/core';
import {
  createDeterministicIdGenerator,
  createSimulatedClock,
  defaultConsent,
  ledger,
  markPrivate,
  parseIso,
  safety,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import { BARCELONA, createTravRuntime } from '../compose.js';
import { repoRoot } from '../model/paths.js';
import { cardInvariantViolations } from '../render/invariants.js';
import { voiceViolations } from '../render/lint.js';
import { harness, tempStateDir, type Harness } from '../runtime.testkit.js';
import { parseDropPhoto } from './dropPhoto.js';
import type { MorningAfterDeps } from './morningAfter.js';
import {
  composeMorningAfter,
  morningAfterJobFor,
  morningAfterJobsFor,
  nextMorningAfterJob,
} from './morningAfter.js';
import { buildWrappedInput } from './wrapped.js';

function fixture<T>(rel: string): T {
  return JSON.parse(readFileSync(join(repoRoot(), 'fixtures', rel), 'utf8')) as T;
}

interface GroupFixture {
  readonly group: Group;
  readonly members: Member[];
  readonly trip: Trip;
  readonly activities: Activity[];
}
interface Morning {
  readonly recapAt: IsoDateTime;
  readonly signals: {
    nightlifeBooking: boolean;
    expenseAfter22: boolean;
    photoAfter23: boolean;
    chatAfterMidnight: boolean;
    balancesChanged: boolean;
  };
  readonly expectedMode: 'full' | 'quiet' | 'silent';
  readonly lastNightExpenses: { expenseId: string }[];
  readonly eligiblePhotoIds: string[];
  readonly maxPhotos: number;
}
interface Checkpoint {
  readonly expenseIds: string[];
  readonly totalSpent: { amountMinor: number; currency: string };
  readonly balances: { memberId: MemberId; net: { amountMinor: number } }[];
}
interface AlbumFixture {
  readonly photos: { photoId: string; ownerMemberId: MemberId; hidden: boolean }[];
  readonly consentTimeline: { at: IsoDateTime; memberId: MemberId; photos: boolean }[];
}
interface ChatRow {
  readonly kind: string;
  readonly lane?: string;
  readonly senderId?: string;
  readonly ts: IsoDateTime;
}

const BCN = fixture<GroupFixture>('groups/barcelona.json');
const BCN_LEDGER = fixture<{ expenses: Expense[]; checkpoints: Record<string, Checkpoint> }>(
  'ledger/barcelona.json',
);
const RECAPS = fixture<{ mornings: Record<string, Morning> }>('recaps/barcelona.json');
const BCN_ALBUM = fixture<AlbumFixture>('album/barcelona.json');
const BCN_CHAT: ChatRow[] = readFileSync(
  join(repoRoot(), 'fixtures', 'chats', 'barcelona.jsonl'),
  'utf8',
)
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as ChatRow);
const TCI = fixture<GroupFixture>('groups/turks-and-caicos.json');

const HANDLES = new Set(BARCELONA.members.map((m) => m.handle));
const HIDDEN = BCN_ALBUM.photos.filter((p) => p.hidden).map((p) => p.photoId);

function consentAt(memberId: MemberId, at: IsoDateTime): boolean {
  let v = false;
  for (const e of BCN_ALBUM.consentTimeline)
    if (e.memberId === memberId && parseIso(e.at) <= parseIso(at)) v = e.photos;
  return v;
}

function putConsent(
  stores: Stores,
  groupId: string,
  memberId: MemberId,
  over: Partial<ConsentFlags>,
): void {
  stores.private.putConsent(memberId, {
    ...defaultConsent(memberId, groupId, '2026-03-01T10:00:00+01:00'),
    ...over,
  });
}

function writeExpenses(stores: Stores, expenses: readonly Expense[], members: readonly Member[]) {
  const order = members.map((m) => m.memberId);
  for (const raw of expenses) {
    const {
      expectedShares: _s,
      fromChatLine: _f,
      ...e
    } = raw as Expense & { expectedShares?: unknown; fromChatLine?: unknown };
    stores.group.expenses.create(e, ledger.buildLedgerEntries(e, ledger.contextFor(order)));
  }
}

/** Members' group-thread message times up to `at` (times only, as the loop records them). */
function chatTimesUntil(at: IsoDateTime): IsoDateTime[] {
  return BCN_CHAT.filter(
    (r) =>
      r.kind === 'message' &&
      r.lane === 'group' &&
      r.senderId !== undefined &&
      HANDLES.has(r.senderId) &&
      parseIso(r.ts) <= parseIso(at),
  ).map((r) => r.ts);
}

interface World {
  readonly h: Harness;
  readonly stores: Stores;
  readonly album: AlbumAdapter;
  readonly deps: MorningAfterDeps;
}

/** Barcelona as it stood at `at`: what had been logged, who had opted in, who had spoken. */
function barcelonaAt(
  at: IsoDateTime,
  opts: { roast?: boolean; roastConsent?: (m: MemberId) => boolean; chat?: boolean } = {},
): World {
  const album = createMockAlbum({ clock: createSimulatedClock(at) });
  const h = harness({ runtime: { album } });
  const stores = h.runtime.stores;
  const group = stores.group.groups.get(BARCELONA.groupId)!;
  stores.group.groups.update({
    ...group,
    settings: { ...group.settings, roastMode: opts.roast === true },
  });
  // The fixture trip carries the €3,000 group budget (the seed has none).
  const seeded = stores.group.trips.get(BARCELONA.tripId)!;
  stores.group.trips.update({ ...seeded, budget: BCN.trip.budget! });
  for (const a of BCN.activities) stores.group.trips.upsertActivity(a);
  writeExpenses(
    stores,
    BCN_LEDGER.expenses.filter((e) => parseIso(e.createdAt) <= parseIso(at)),
    BCN.members,
  );
  for (const m of BCN.members) {
    putConsent(stores, BARCELONA.groupId, m.memberId, {
      photos: consentAt(m.memberId, at),
      roast: opts.roastConsent?.(m.memberId) ?? opts.roast === true,
    });
  }
  h.clock.set(at);
  const deps: MorningAfterDeps = {
    stores,
    clock: h.clock,
    ids: h.ids,
    album,
    ...(opts.chat === false ? {} : { chatTimes: () => chatTimesUntil(at) }),
  };
  return { h, stores, album, deps };
}

async function recapOn(date: string, w: World) {
  return composeMorningAfter(w.deps, BARCELONA.groupId, BARCELONA.tripId, date);
}

function asRecap(card: unknown): RecapCard {
  const c = card as RecapCard;
  if (c.type !== 'recap') throw new Error(`expected a recap card, got ${String(c.type)}`);
  return c;
}

function checkClean(w: World, msg: { text: string; card?: unknown }): void {
  const members = w.stores.group.members.listByGroup(BARCELONA.groupId);
  const trip = w.stores.group.trips.get(BARCELONA.tripId)!;
  expect(voiceViolations(msg as never, members, trip)).toEqual([]);
  expect(
    cardInvariantViolations(msg as never, {
      group: w.stores.group.groups.get(BARCELONA.groupId)!,
      members,
      trip,
      consent: (id) => w.stores.private.getConsent(id, BARCELONA.groupId),
      now: w.h.clock.now(),
    }),
  ).toEqual([]);
}

describe('Barcelona mornings: the fixture decides full / quiet / silent', () => {
  for (const [date, truth] of Object.entries(RECAPS.mornings)) {
    it(`${date}: ${truth.expectedMode}, with the fixture's signals`, async () => {
      const w = barcelonaAt(truth.recapAt);
      const r = await recapOn(date, w);
      if (r.kind === 'no_trip' || r.kind === 'needs_guardian') throw new Error(r.kind);
      expect(r.facts.signals).toEqual(truth.signals);
      expect(r.facts.mode).toBe(truth.expectedMode);
      if (truth.expectedMode === 'silent') {
        expect(r.kind).toBe('silent');
        return;
      }
      if (r.kind !== 'ok') throw new Error(r.kind);
      expect(r.mode).toBe(truth.expectedMode);
      expect(r.message.proactive).toBe(true);
      expect(r.message.to).toEqual({ kind: 'group' });
      checkClean(w, r.message);
      const json = JSON.stringify(r.message);
      expect(json).not.toMatch(/sick|hungover|pharmacy/i);
      for (const id of HIDDEN) expect(json).not.toContain(id);
      if (truth.expectedMode === 'quiet') {
        // VOICE §4.6 A: the running tab on its own, no night framing.
        expect(r.message.card.type).toBe('settle_up');
        expect(r.message.text.split('\n')[0]).toMatch(/^running tab, day \d$/);
        expect(r.message.text).not.toMatch(/last night|morning after/);
        return;
      }
      const card = asRecap(r.message.card);
      expect(card.kind).toBe('morning_after');
      expect(r.message.text.split('\n')[0]).toMatch(/^morning after, day \d ☀️$/);
      // Photos: from the fixture's eligible set (opted in at recap time, in the window), max 3.
      expect(card.photos.length).toBeLessThanOrEqual(Math.min(3, truth.maxPhotos));
      for (const p of card.photos) {
        expect(truth.eligiblePhotoIds).toContain(p.photoId);
        expect(consentAt(p.byMemberId, truth.recapAt)).toBe(true);
      }
      expect(r.message.images?.length ?? 0).toBe(card.photos.length);
      // Listed spend = the fixture's last-night expenses plus any logged late that happened last night.
      const listed = new Set(r.facts.expenseIds);
      for (const e of truth.lastNightExpenses) expect(listed).toContain(e.expenseId);
      const extra = [...listed].filter(
        (id) => !truth.lastNightExpenses.some((e) => e.expenseId === id),
      );
      for (const id of extra) {
        const e = BCN_LEDGER.expenses.find((x) => x.expenseId === id)!;
        expect(parseIso(e.createdAt)).toBeGreaterThanOrEqual(parseIso(r.facts.window.to));
      }
      const sum = [...listed].reduce(
        (s, id) => s + BCN_LEDGER.expenses.find((x) => x.expenseId === id)!.amount.amountMinor,
        0,
      );
      expect(card.lastNight.total.amountMinor).toBe(sum);
      expect(card.lastNight.events.reduce((s, e) => s + (e.amount?.amountMinor ?? 0), 0)).toBe(sum);
    });
  }
});

describe('the Razzmatazz morning (sun 15 mar, day 4)', () => {
  const TRUTH = RECAPS.mornings['2026-03-15']!;

  it('reads like VOICE §4.7 A: last night, money vs budget, the tab, no reason for who was out', async () => {
    const w = barcelonaAt(TRUTH.recapAt);
    const r = await recapOn('2026-03-15', w);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.message.text).toMatchInlineSnapshot(`
      "morning after, day 4 ☀️
      last night: dinner (5 of you, not Henry) €84 · Razzmatazz tickets €90 · late-night kebabs €62 · +2 more
      €287.40 total, under the €500 day budget
      tab: Sam → Dean €448.27 is the big one, full list in the card
      today: Barça vs Sevilla at 9pm"
    `);
    const card = asRecap(r.message.card);
    const dinner = card.lastNight.events.find((e) => e.label === 'dinner')!;
    expect(dinner.notIn).toEqual(['mem_henry']);
    expect(dinner.attendees).not.toContain('mem_henry');
    expect(card.lastNight.budget).toEqual({ amountMinor: 50000, currency: 'EUR' });
    expect(card.roastLines).toEqual([]);
    expect(r.message.roast).not.toBe(true);
    expect(r.message.text).not.toMatch(/sick|was out|sat this one out/i);
  });

  it('settle-up to the cent: the card is the ledger checkpoint, transfers clear every balance', async () => {
    const w = barcelonaAt(TRUTH.recapAt);
    const r = await recapOn('2026-03-15', w);
    if (r.kind !== 'ok') throw new Error(r.kind);
    const settle: SettleUpCard = asRecap(r.message.card).settle;
    const cp = BCN_LEDGER.checkpoints['morning_day4']!;
    expect(
      new Set(w.stores.group.expenses.listByTrip(BARCELONA.tripId).map((e) => e.expenseId)),
    ).toEqual(new Set(cp.expenseIds));
    expect(settle.totalSpent).toEqual(cp.totalSpent);
    const net = new Map(settle.balances.map((b) => [b.memberId, b.net.amountMinor]));
    for (const b of cp.balances) expect(net.get(b.memberId) ?? 0).toBe(b.net.amountMinor);
    expect([...net.values()].reduce((s, v) => s + v, 0)).toBe(0);
    // Applying the transfers leaves everyone at exactly zero, in ≤ n-1 moves.
    const left = new Map(cp.balances.map((b) => [b.memberId, b.net.amountMinor]));
    for (const t of settle.transfers) {
      expect(t.amount.amountMinor).toBeGreaterThan(0);
      expect(Number.isInteger(t.amount.amountMinor)).toBe(true);
      left.set(t.from, (left.get(t.from) ?? 0) + t.amount.amountMinor);
      left.set(t.to, (left.get(t.to) ?? 0) - t.amount.amountMinor);
    }
    for (const v of left.values()) expect(v).toBe(0);
    expect(settle.transfers.length).toBeLessThanOrEqual(cp.balances.length - 1);
    // The big one in the text is the biggest transfer on the card.
    const big = [...settle.transfers].sort(
      (a, b) => b.amount.amountMinor - a.amount.amountMinor,
    )[0]!;
    const name = (id: MemberId) => BARCELONA.members.find((m) => m.memberId === id)!.name;
    expect(r.message.text).toContain(
      `tab: ${name(big.from)} → ${name(big.to)} €${(big.amount.amountMinor / 100).toFixed(2)} is the big one`,
    );
  });

  it('pending private items: the group sees a count, never the merchant, amount or owner', async () => {
    const w = barcelonaAt(TRUTH.recapAt);
    const item = (owner: MemberId, id: string, amountMinor: number, merchant: string) =>
      markPrivate({
        id,
        ownerMemberId: owner,
        groupId: BARCELONA.groupId,
        tripId: BARCELONA.tripId,
        createdAt: TRUTH.recapAt,
        source: 'card' as const,
        sourceItemId: `src_${id}`,
        status: 'pending' as const,
        amount: { amountMinor, currency: 'EUR' },
        occurredAt: '2026-03-15T03:10:00+01:00',
        merchantDisplay: merchant,
        category: 'transport' as const,
        lowConfidence: false,
      }) as PendingPrivateItem;
    w.stores.private.putPendingItem('mem_priya', item('mem_priya', 'priv_a', 1977, 'Cabify'));
    w.stores.private.putPendingItem('mem_maya', item('mem_maya', 'priv_b', 4321, 'FreeNow'));
    const r = await recapOn('2026-03-15', w);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.message.text).toContain('2 charges that look shared are waiting on a tap in dms');
    expect(asRecap(r.message.card).pendingPrivateCount).toBe(2);
    const json = JSON.stringify(r.message);
    expect(json).not.toMatch(/Cabify|FreeNow|19\.77|43\.21|priv_a|priv_b/);
    checkClean(w, r.message);
  });

  it('roast mode on (all consenting adults): lines from the tab only, gated, declared, marked', async () => {
    const w = barcelonaAt(TRUTH.recapAt, { roast: true });
    const r = await recapOn('2026-03-15', w);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.roastLines.length).toBeGreaterThan(0);
    expect(r.roastLines.length).toBeLessThanOrEqual(2);
    expect(r.message.roast).toBe(true);
    for (const l of r.roastLines) {
      expect(r.message.text.split('\n')).toContain(l);
      expect(safety.roastTopicBlocked(l)).toBeNull();
      expect(l).not.toMatch(/Henry|sick/);
    }
    checkClean(w, r.message);
  });

  it('roast mode on but the named member withdrew roast consent: never named', async () => {
    const on = await recapOn('2026-03-15', barcelonaAt(TRUTH.recapAt, { roast: true }));
    if (on.kind !== 'ok') throw new Error(on.kind);
    const named = BARCELONA.members.filter((m) => on.roastLines.some((l) => l.includes(m.name)));
    expect(named.length).toBeGreaterThan(0);
    const out = new Set(named.map((m) => m.memberId));
    const w = barcelonaAt(TRUTH.recapAt, { roast: true, roastConsent: (id) => !out.has(id) });
    const r = await recapOn('2026-03-15', w);
    if (r.kind !== 'ok') throw new Error(r.kind);
    for (const m of named) for (const l of r.roastLines) expect(l).not.toContain(m.name);
  });

  it('roast mode off: no roast lines, not marked', async () => {
    const r = await recapOn('2026-03-15', barcelonaAt(TRUTH.recapAt, { roast: false }));
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.roastLines).toEqual([]);
    expect(r.message.roast).not.toBe(true);
  });

  it('roast mode on with a minor in the group: family mode, no roast, no night framing', async () => {
    const w = barcelonaAt(TRUTH.recapAt, { roast: true });
    const sam = w.stores.group.members.get('mem_sam')!;
    w.stores.group.members.upsert({
      ...sam,
      birthDate: '2010-01-01',
      ageBand: 'under18',
      guardianMemberId: 'mem_dean',
    });
    const r = await recapOn('2026-03-15', w);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.facts.familyMode).toBe(true);
    expect(r.roastLines).toEqual([]);
    expect(r.message.roast).not.toBe(true);
    expect(r.message.text).not.toMatch(/morning after|last night|Razzmatazz|kebab|waters/i);
  });

  it('a guardian-less minor with money: the guardian question in the group, never a broken card', async () => {
    const w = barcelonaAt(TRUTH.recapAt);
    const sam = w.stores.group.members.get('mem_sam')!;
    w.stores.group.members.upsert({ ...sam, birthDate: '2010-01-01', ageBand: 'under18' });
    const r = await recapOn('2026-03-15', w);
    expect(r.kind).toBe('needs_guardian');
    if (r.kind !== 'needs_guardian') return;
    expect(r.message.to).toEqual({ kind: 'group' });
    expect(r.message.card).toBeUndefined();
    expect(r.message.text).toMatch(/Sam/);
  });

  it('a dropped photo never comes back: not in this recap, not in Wrapped', async () => {
    const w = barcelonaAt(TRUTH.recapAt);
    const first = await recapOn('2026-03-15', w);
    if (first.kind !== 'ok') throw new Error(first.kind);
    const shown = asRecap(first.message.card).photos.map((p) => p.photoId!);
    expect(shown.length).toBeGreaterThan(1);
    const victim = shown[0]!;
    const g = w.stores.group.groups.get(BARCELONA.groupId)!;
    w.stores.group.groups.update({ ...g, settings: { ...g.settings, droppedPhotoIds: [victim] } });
    for (let i = 0; i < 3; i++) {
      const again = await recapOn('2026-03-15', w);
      if (again.kind !== 'ok') throw new Error(again.kind);
      expect(asRecap(again.message.card).photos.map((p) => p.photoId)).not.toContain(victim);
      expect(JSON.stringify(again.message)).not.toContain(victim);
    }
    w.h.clock.set('2026-03-18T10:00:00+01:00');
    const wrapped = await buildWrappedInput(w.deps, BARCELONA.groupId, BARCELONA.tripId);
    if (wrapped.kind !== 'ok') throw new Error(wrapped.kind);
    expect(wrapped.facts.photos.map((p) => p.photoId)).not.toContain(victim);
  });

  it('an album outage costs the photos, never the recap; no album is no photo signal', async () => {
    const w = barcelonaAt(TRUTH.recapAt);
    const broken: AlbumAdapter = {
      ...w.album,
      listPhotos: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'rate_limited', message: 'down', retryable: true },
        }),
    };
    const r = await composeMorningAfter(
      { ...w.deps, album: broken },
      BARCELONA.groupId,
      BARCELONA.tripId,
      '2026-03-15',
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.facts.signals.photoAfter23).toBe(false);
    expect(r.mode).toBe('full'); // three other signals
    expect(asRecap(r.message.card).photos).toEqual([]);
  });
});

describe('quiet and silent mornings', () => {
  it('sun → mon (16 mar): one coffee logged, no night out → the running tab only', async () => {
    const truth = RECAPS.mornings['2026-03-16']!;
    const w = barcelonaAt(truth.recapAt);
    const r = await recapOn('2026-03-16', w);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.mode).toBe('quiet');
    const card = r.message.card as SettleUpCard;
    expect(card.type).toBe('settle_up');
    expect(card.mode).toBe('running');
    expect(card.balances.reduce((s, b) => s + b.net.amountMinor, 0)).toBe(0);
    expect(r.message.text).toContain('running tab, day 5');
  });

  it('nothing logged and no night out: silent, and the scheduled job posts nothing', async () => {
    const at = '2026-03-12T10:00:00+01:00';
    const w = barcelonaAt(at);
    expect((await recapOn('2026-03-12', w)).kind).toBe('silent');
    const job = morningAfterJobFor(w.stores.group.trips.get(BARCELONA.tripId)!, '2026-03-12');
    const before = w.h.channel.transcript().length;
    const turn = await w.h.runtime.agent.runScheduled(job);
    expect(turn.silent).toBe(true);
    expect(turn.note).toBe('scheduled:morning_after:silent');
    expect(w.h.channel.transcript().length).toBe(before);
  });

  it('an unknown trip is no_trip, never a throw', async () => {
    const w = barcelonaAt('2026-03-15T10:00:00+01:00');
    expect(
      (await composeMorningAfter(w.deps, BARCELONA.groupId, 'trip_nope', '2026-03-15')).kind,
    ).toBe('no_trip');
  });
});

describe('Turks and Caicos: family mode never uses night-out framing ("morning, day N" / "yesterday")', () => {
  function tciWorld(extra: Expense[] = [], chat: IsoDateTime[] = []) {
    const clock = createSimulatedClock('2026-06-21T10:00:00-04:00');
    const ids = createDeterministicIdGenerator('m');
    const stores = createMemoryStores({ clock, ids });
    stores.group.groups.create({
      ...TCI.group,
      settings: { ...TCI.group.settings, roastMode: true },
    });
    for (const m of TCI.members) stores.group.members.upsert(m);
    stores.group.trips.create(TCI.trip);
    for (const a of TCI.activities) stores.group.trips.upsertActivity(a);
    const raw = fixture<{
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
    const expenses: Expense[] = raw.expenses.map((e) => ({
      expenseId: e.expenseId,
      groupId: TCI.group.groupId,
      tripId: TCI.trip.tripId,
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
    writeExpenses(stores, [...expenses, ...extra], TCI.members);
    for (const m of TCI.members) putConsent(stores, TCI.group.groupId, m.memberId, { roast: true });
    const deps: MorningAfterDeps = { stores, clock, ids, chatTimes: () => chat };
    return { stores, clock, deps };
  }

  /** The adults' nightcap, logged at 10:40pm with chat after midnight: two night-out signals. */
  const nightcap: Expense = {
    expenseId: 'exp_tci_nightcap',
    groupId: TCI.group.groupId,
    tripId: TCI.trip.tripId,
    description: 'rum punch at the bar',
    category: 'drinks',
    amount: { amountMinor: 6400, currency: 'USD' },
    paidBy: [{ memberId: 'mem_tci_dad', amount: { amountMinor: 6400, currency: 'USD' } }],
    split: { method: 'exclude', excluded: [] },
    source: 'chat',
    sourceRef: { kind: 'message', id: 'msg_tci_nightcap' },
    occurredAt: '2026-06-23T22:40:00-04:00',
    createdAt: '2026-06-23T22:40:00-04:00',
    createdBy: 'mem_tci_dad',
    status: 'logged',
    activityId: 'act_tci_nightcap',
  };
  const sunset: Expense = {
    ...nightcap,
    expenseId: 'exp_tci_sunset',
    description: 'sunset cruise',
    category: 'activities',
    amount: { amountMinor: 32000, currency: 'USD' },
    paidBy: [{ memberId: 'mem_tci_mom', amount: { amountMinor: 32000, currency: 'USD' } }],
    sourceRef: { kind: 'message', id: 'msg_tci_sunset' },
    occurredAt: '2026-06-23T17:20:00-04:00',
    createdAt: '2026-06-23T17:20:00-04:00',
    createdBy: 'mem_tci_mom',
    activityId: 'act_tci_cruise',
  };

  it('every trip morning: never "morning after", "last night", a roast, drinks or the nightcap', async () => {
    const { deps, clock, stores } = tciWorld([nightcap, sunset], ['2026-06-24T00:35:00-04:00']);
    let posted = 0;
    for (const job of morningAfterJobsFor(TCI.trip)) {
      clock.set(job.runAt);
      const date = job.payload['date'] as string;
      const r = await composeMorningAfter(deps, TCI.group.groupId, TCI.trip.tripId, date);
      if (r.kind === 'no_trip' || r.kind === 'needs_guardian') throw new Error(r.kind);
      expect(r.facts.familyMode).toBe(true);
      expect(r.facts.mode).not.toBe('full');
      if (r.kind === 'silent') continue;
      posted += 1;
      const m = r.message;
      expect(m.card.type).toBe('recap');
      const card = asRecap(m.card);
      expect(card.kind).toBe('daily');
      expect(m.text.split('\n')[0]).toMatch(/^morning, day \d ☀️$/);
      expect(m.text).not.toMatch(/morning after|last night|nightcap|rum|drinks|bar\b/i);
      expect(JSON.stringify(card.lastNight)).not.toMatch(/nightcap|rum|drinks/i);
      expect(r.roastLines).toEqual([]);
      expect(m.roast).not.toBe(true);
      // Who paid is said (VOICE §3.4), but a minor is never shown as a payer (VOICE §8).
      expect(m.text).not.toMatch(/on Lily/);
      // Family tab: one pot, no transfers (VOICE §4.7 C).
      expect(m.text).toContain("everything's on the family tab, nothing to split");
      expect(card.settle.transfers).toEqual([]);
      expect(
        voiceViolations(m, stores.group.members.listByGroup(TCI.group.groupId), TCI.trip),
      ).toEqual([]);
    }
    expect(posted).toBeGreaterThan(0);
  });

  it('the morning after the nightcap: "yesterday" lists the cruise, never the drinks', async () => {
    const { deps, clock } = tciWorld([nightcap, sunset], ['2026-06-24T00:35:00-04:00']);
    clock.set('2026-06-24T10:00:00-04:00');
    const r = await composeMorningAfter(deps, TCI.group.groupId, TCI.trip.tripId, '2026-06-24');
    if (r.kind !== 'ok') throw new Error(r.kind);
    // Two night-out signals fired; family mode still says "morning".
    expect(r.facts.signals.expenseAfter22).toBe(true);
    expect(r.facts.signals.chatAfterMidnight).toBe(true);
    expect(r.facts.mode).toBe('quiet');
    expect(r.message.text).toMatchInlineSnapshot(`
      "morning, day 5 ☀️
      yesterday: sunset cruise $320 on Mom
      $320 total, under the $750 day budget
      everything's on the family tab, nothing to split"
    `);
    expect(r.facts.expenseIds).toEqual(['exp_tci_sunset']);
  });

  it('the tab moved but nothing happened yesterday (breakfast logged at 8am): no "$0 total" line', async () => {
    const breakfast: Expense = {
      expenseId: 'exp_tci_breakfast',
      groupId: TCI.group.groupId,
      tripId: TCI.trip.tripId,
      description: 'breakfast',
      category: 'food',
      amount: { amountMinor: 5400, currency: 'USD' },
      paidBy: [{ memberId: 'mem_tci_mom', amount: { amountMinor: 5400, currency: 'USD' } }],
      split: { method: 'exclude', excluded: [] },
      source: 'chat',
      sourceRef: { kind: 'message', id: 'msg_tci_breakfast' },
      occurredAt: '2026-06-26T08:00:00-04:00',
      createdAt: '2026-06-26T08:00:00-04:00',
      createdBy: 'mem_tci_mom',
      status: 'logged',
    };
    const { deps, clock } = tciWorld([breakfast]);
    clock.set('2026-06-26T10:00:00-04:00');
    const r = await composeMorningAfter(deps, TCI.group.groupId, TCI.trip.tripId, '2026-06-26');
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.facts.expenseIds).toEqual([]);
    expect(r.message.text).toBe(
      "morning, day 7 ☀️\neverything's on the family tab, nothing to split",
    );
  });
});

describe('the scheduled Morning After on the simulated clock', () => {
  it('the runtime schedules the mornings still ahead (15–17 mar from sat 9:40pm), each at 10am', () => {
    const h = harness();
    const jobs = h.runtime.scheduler
      .list()
      .filter((j) => j.kind === 'morning_after')
      .map((j) => [j.jobId, j.runAt]);
    expect(jobs).toEqual([
      ['morning_after:trip_barcelona:2026-03-15', '2026-03-15T10:00:00+01:00'],
      ['morning_after:trip_barcelona:2026-03-16', '2026-03-16T10:00:00+01:00'],
      ['morning_after:trip_barcelona:2026-03-17', '2026-03-17T10:00:00+01:00'],
    ]);
  });

  it('next morning: the drain posts the recap in the group once; chat times come from the loop', async () => {
    // The world as of sat 9:40pm; the night then happens in the chat.
    const w = barcelonaAt('2026-03-14T21:40:00+01:00', { chat: false });
    const late = BCN_LEDGER.expenses.filter(
      (e) =>
        parseIso(e.createdAt) > parseIso('2026-03-14T21:40:00+01:00') &&
        parseIso(e.createdAt) <= parseIso('2026-03-15T10:00:00+01:00'),
    );
    writeExpenses(w.stores, late, BCN.members);
    w.h.clock.set('2026-03-15T00:40:00+01:00');
    await w.h.say('h_maya', 'where are you guys, by the bar?');
    w.h.clock.set('2026-03-15T10:00:00+01:00');
    const turns = await w.h.runtime.drain();
    const turn = turns.find((t) => t.note.startsWith('scheduled:morning_after'))!;
    expect(turn.note).toBe('scheduled:morning_after:full');
    expect(turn.silent).toBe(false);
    const posted = w.h.channel
      .transcript()
      .filter((e) => e.type === 'message' && e.lane === 'group' && e.card?.type === 'recap');
    expect(posted).toHaveLength(1);
    expect(turn.auditEventIds.length).toBeGreaterThan(0);
    // Once: the job left the queue.
    expect(
      (await w.h.runtime.drain()).filter((t) => t.note.startsWith('scheduled:morning')),
    ).toEqual([]);
  });

  it('a clock jump far past a morning skips it (never a stale recap); the next morning still runs', async () => {
    const w = barcelonaAt('2026-03-14T21:40:00+01:00', { chat: false });
    w.h.clock.set('2026-03-16T13:00:00+01:00');
    const turns = await w.h.runtime.drain();
    expect(turns.map((t) => t.note)).toEqual([
      'scheduled:morning_after:stale',
      'scheduled:morning_after:stale',
    ]);
    expect(
      w.h.channel.transcript().some((e) => e.type === 'message' && e.card?.type === 'recap'),
    ).toBe(false);
  });

  it('each run schedules the next morning itself (ARCHITECTURE Flow 3); the last one leaves it to Wrapped', async () => {
    const w = barcelonaAt('2026-03-15T10:00:00+01:00');
    const s = w.h.runtime.scheduler;
    for (const j of s.list()) if (j.kind === 'morning_after') s.cancel(j.jobId);
    const trip = w.stores.group.trips.get(BARCELONA.tripId)!;
    await w.h.runtime.agent.runScheduled(morningAfterJobFor(trip, '2026-03-15'));
    expect(
      s
        .list()
        .filter((j) => j.kind === 'morning_after')
        .map((j) => j.jobId),
    ).toEqual(['morning_after:trip_barcelona:2026-03-16']);
    // Pressing it twice is idempotent: still one job for the 16th.
    await w.h.runtime.agent.runScheduled(morningAfterJobFor(trip, '2026-03-15'));
    expect(s.list().filter((j) => j.kind === 'morning_after')).toHaveLength(1);
    expect(nextMorningAfterJob(trip, '2026-03-17')).toBeUndefined();
  });

  it('roast mode on: the job hands its roast lines to the send path, which keeps them', async () => {
    const w = barcelonaAt('2026-03-15T10:00:00+01:00', { roast: true });
    const job = morningAfterJobFor(w.stores.group.trips.get(BARCELONA.tripId)!, '2026-03-15');
    const turn = await w.h.runtime.agent.runScheduled(job);
    expect(turn.note).toBe('scheduled:morning_after:full');
    const sent = turn.outbound[0] as { roast?: boolean; text: string };
    expect(sent.roast).toBe(true);
    expect(w.h.auditTypes()).not.toContain('content.suppressed');
  });
});

describe('"@trav drop that one"', () => {
  it('parses the phrasings, never "drop it" (a decline alias)', () => {
    expect(parseDropPhoto('@trav drop that one')).toEqual({});
    expect(parseDropPhoto('trav remove this pic')).toEqual({});
    expect(parseDropPhoto('@trav drop photo 2')).toEqual({ position: 2 });
    expect(parseDropPhoto('@trav drop the second one')).toEqual({ position: 2 });
    expect(parseDropPhoto('@trav lose the last photo')).toEqual({ position: 'last' });
    expect(parseDropPhoto('@trav drop it')).toBeUndefined();
    expect(parseDropPhoto('we should drop the plan')).toBeUndefined();
  });

  async function postedRecap() {
    const w = barcelonaAt('2026-03-15T10:00:00+01:00');
    const job = morningAfterJobFor(w.stores.group.trips.get(BARCELONA.tripId)!, '2026-03-15');
    const turn = await w.h.runtime.agent.runScheduled(job);
    const msg = turn.outbound[0] as { id: string; card: RecapCard };
    expect(msg.card.photos.length).toBeGreaterThan(1);
    return { w, msg };
  }

  it('with several photos it asks which, then "photo 2" drops exactly that one, audited, for good', async () => {
    const { w, msg } = await postedRecap();
    const which = await w.h.say('h_jordan', '@trav drop that one');
    expect(which.note).toBe('drop_photo:which');
    expect((which.outbound[0] as { text: string }).text).toMatch(/^which one\?/);
    expect(w.stores.group.groups.get(BARCELONA.groupId)!.settings.droppedPhotoIds ?? []).toEqual(
      [],
    );

    const victim = msg.card.photos[1]!.photoId!;
    const done = await w.h.say('h_jordan', '@trav drop photo 2');
    expect(done.note).toBe('drop_photo:dropped');
    expect((done.outbound[0] as { text: string }).text).toBe(
      "dropped it. it won't come back in a recap or the wrapped",
    );
    expect(w.stores.group.groups.get(BARCELONA.groupId)!.settings.droppedPhotoIds).toEqual([
      victim,
    ]);
    const row = w.h
      .audit()
      .find((e) => e.type === 'settings.changed' && e.payload['photoId'] === victim)!;
    expect(row).toMatchObject({
      actor: { kind: 'member', id: 'mem_jordan' },
      visibility: 'group',
      payload: { setting: 'droppedPhotoIds', albumHidden: true },
    });
    expect(done.auditEventIds).toContain(row.id);
    // The album hid it group-wide too.
    const listed = await w.album.listPhotos(
      { groupId: BARCELONA.groupId, tripId: BARCELONA.tripId },
      (id) => w.stores.private.getConsent(id, BARCELONA.groupId),
    );
    if (!listed.ok) throw new Error('album');
    expect(listed.value.map((p) => p.photoId)).not.toContain(victim);

    // Never again: the recap re-rendered, and Wrapped.
    const again = await recapOn('2026-03-15', w);
    if (again.kind !== 'ok') throw new Error(again.kind);
    expect(JSON.stringify(again.message)).not.toContain(victim);
    w.h.clock.set('2026-03-18T10:00:00+01:00');
    const wrapped = await buildWrappedInput(w.deps, BARCELONA.groupId, BARCELONA.tripId);
    if (wrapped.kind !== 'ok') throw new Error(wrapped.kind);
    expect(wrapped.facts.photos.map((p) => p.photoId)).not.toContain(victim);

    // Dropping it twice is a no-op with one line.
    const twice = await w.h.say('h_maya', '@trav drop photo 2', { replyToMessageId: msg.id });
    expect(twice.note).toBe('drop_photo:already');
  });

  it('a reply on the recap counts as addressed; "that one" with one photo left on a reply still asks if several', async () => {
    const { w, msg } = await postedRecap();
    const r = await w.h.say('h_sam', 'drop the last one', { replyToMessageId: msg.id });
    expect(r.note).toBe('drop_photo:dropped');
    expect(w.stores.group.groups.get(BARCELONA.groupId)!.settings.droppedPhotoIds).toEqual([
      msg.card.photos[msg.card.photos.length - 1]!.photoId,
    ]);
  });

  it('a guest cannot drop anything; unaddressed chatter is left alone', async () => {
    const { w } = await postedRecap();
    const guest = await w.h.say('h_ava', '@trav drop photo 1');
    expect(guest.note).not.toMatch(/^drop_photo/);
    const chatter = await w.h.say('h_dean', 'lol drop that one from the group album');
    expect(chatter.note).not.toMatch(/^drop_photo/);
    expect(w.stores.group.groups.get(BARCELONA.groupId)!.settings.droppedPhotoIds ?? []).toEqual(
      [],
    );
  });

  it('out of range asks which; no recap photo in reach says so once', async () => {
    const { w } = await postedRecap();
    expect((await w.h.say('h_dean', '@trav drop photo 9')).note).toBe('drop_photo:which');
    const h = harness();
    const r = await h.say('h_dean', '@trav drop that photo');
    expect(r.note).toBe('drop_photo:none');
    expect((r.outbound[0] as { text: string }).text).toBe("i don't see a recap photo to drop");
  });
});

describe('T-015 review round 1', () => {
  const AT = '2026-03-15T10:00:00+01:00';
  function lateExpense(
    id: string,
    description: string,
    category: Expense['category'],
    by: MemberId = 'mem_priya',
  ): Expense {
    return {
      expenseId: id,
      groupId: BARCELONA.groupId,
      tripId: BARCELONA.tripId,
      description,
      category,
      amount: { amountMinor: 1490, currency: 'EUR' },
      paidBy: [{ memberId: by, amount: { amountMinor: 1490, currency: 'EUR' } }],
      split: { method: 'exclude', excluded: [] },
      source: 'chat',
      sourceRef: { kind: 'message', id: `msg_${id}` },
      occurredAt: '2026-03-15T03:40:00+01:00',
      createdAt: '2026-03-15T03:40:00+01:00',
      createdBy: by,
      status: 'logged',
    };
  }

  it('#1 a roast line never carries the member-typed description, whatever the category', async () => {
    const sensitive = [
      'condoms',
      'pregnancy test',
      'pharmacy',
      'tampons',
      'plan b',
      'advil',
      'bail',
    ];
    for (const category of ['other', 'food', 'drinks', 'transport', 'tickets'] as const) {
      for (const [i, description] of sensitive.entries()) {
        const w = barcelonaAt(AT, { roast: true });
        writeExpenses(
          w.stores,
          [lateExpense(`exp_s_${category}_${String(i)}`, description, category)],
          BCN.members,
        );
        const r = await recapOn('2026-03-15', w);
        if (r.kind !== 'ok') throw new Error(r.kind);
        const roast = r.roastLines.join('\n').toLowerCase();
        expect(roast, `${category}/${description}`).not.toContain(description);
        for (const l of r.roastLines) {
          expect(l).toMatch(
            /^(?:\S+ paid for (?:food|a round|a ride|tickets) at [\d:]+[ap]m\. the tab remembers|\d+ rides last night, €[\d,.]+\. the metro is right there)$/,
          );
        }
        // An uncategorized late buy gets no "paid for" line at all.
        if (category === 'other') expect(roast).not.toMatch(/paid for/);
        else
          expect(r.roastLines).toContain(
            `Priya paid for ${{ food: 'food', drinks: 'a round', transport: 'a ride', tickets: 'tickets' }[category]} at 3:40am. the tab remembers`,
          );
      }
    }
  });

  it('#2 negated asks never drop: parser and loop', async () => {
    for (const t of [
      "don't drop the first one",
      'please don’t delete this pic, i love it',
      '@trav do NOT drop that one',
      '@trav never remove photo 2',
      '@trav no need to drop that one',
      '@trav dont hide the last photo',
      // review r2 #1: more negations, questions, reported wishes
      "@trav you can't drop that one, it's the only group pic",
      '@trav cannot drop that one',
      '@trav cant drop photo 2',
      "@trav i didn't say drop that one",
      '@trav shouldnt remove the first one',
      '@trav should we drop that one?',
      '@trav why would you drop photo 2',
      "@trav Sam wants to drop that one, don't",
      '@trav maya said to drop photo 2',
    ])
      expect(parseDropPhoto(t), t).toBeUndefined();
    // A drop is permanent, so any negation in the message means no (r2 #1).
    expect(parseDropPhoto('not bad, but @trav drop photo 2')).toBeUndefined();

    const w = barcelonaAt(AT);
    const job = morningAfterJobFor(w.stores.group.trips.get(BARCELONA.tripId)!, '2026-03-15');
    const posted = (await w.h.runtime.agent.runScheduled(job)).outbound[0] as { id: string };
    const reply = await w.h.say('h_jordan', "don't drop the first one", {
      replyToMessageId: posted.id,
    });
    expect(reply.note).not.toMatch(/^drop_photo/);
    for (const t of ['please don’t delete this pic, i love it', '@trav do NOT drop that one']) {
      const r = await w.h.say('h_maya', t);
      expect(r.note, t).not.toMatch(/^drop_photo/);
    }
    expect(w.stores.group.groups.get(BARCELONA.groupId)!.settings.droppedPhotoIds ?? []).toEqual(
      [],
    );
  });

  it('#3 an unreplied "delete that one" after a newer Trav card is not about the recap', async () => {
    const w = barcelonaAt(AT);
    const job = morningAfterJobFor(w.stores.group.trips.get(BARCELONA.tripId)!, '2026-03-15');
    await w.h.runtime.agent.runScheduled(job);
    w.h.clock.set('2026-03-16T13:00:00+01:00');
    const logged = await w.h.say('h_dean', '@trav i paid €40 for paella, split with everyone');
    expect(logged.outbound.some((o) => 'card' in o && o.card?.type === 'expense_confirm')).toBe(
      true,
    );
    const r = await w.h.say('h_dean', '@trav delete that one');
    expect(r.note).not.toMatch(/^drop_photo/);
    expect(w.stores.group.groups.get(BARCELONA.groupId)!.settings.droppedPhotoIds ?? []).toEqual(
      [],
    );
    // Saying "photo" still reaches the latest recap.
    expect((await w.h.say('h_dean', '@trav delete that photo')).note).toBe('drop_photo:which');
  });

  it('#4 "today" lists only booked plans', async () => {
    const w = barcelonaAt(AT);
    w.stores.group.trips.upsertActivity({
      activityId: 'act_bcn_unbooked',
      tripId: BARCELONA.tripId,
      groupId: BARCELONA.groupId,
      kind: 'attraction',
      name: 'Picasso Museum',
      startsAt: '2026-03-15T16:00:00+01:00',
      contentTags: [],
      ageRestriction: null,
      createdAt: '2026-03-10T10:00:00+01:00',
    } as Activity);
    const r = await recapOn('2026-03-15', w);
    if (r.kind !== 'ok') throw new Error(r.kind);
    const card = asRecap(r.message.card);
    expect((card.today ?? []).map((t) => t.label)).toEqual(['Barça vs Sevilla']);
    expect(r.message.text).not.toContain('Picasso');
  });

  it('#5 an overnight undo with nothing new logged is a quiet settle-up, not silence', async () => {
    const w = barcelonaAt('2026-03-16T10:00:00+01:00');
    // Drop the 13:45 coffee so nothing new was logged since yesterday's recap…
    w.stores.group.expenses.replace(
      {
        ...w.stores.group.expenses.get('exp_bcn_017')!,
        status: 'undone',
        createdAt: '2026-03-14T09:00:00+01:00',
      },
      [],
    );
    expect((await recapOn('2026-03-16', w)).kind).toBe('silent');
    // …then someone undoes an older expense overnight.
    w.h.clock.set('2026-03-15T23:10:00+01:00');
    w.stores.group.audit.append({
      groupId: BARCELONA.groupId,
      tripId: BARCELONA.tripId,
      type: 'ledger.entry_deleted',
      actor: { kind: 'member', id: 'mem_sam' },
      visibility: 'group',
      payload: { expenseId: 'exp_bcn_014', after: { status: 'undone' } },
    });
    w.h.clock.set('2026-03-16T10:00:00+01:00');
    const r = await recapOn('2026-03-16', w);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.facts.signals.balancesChanged).toBe(true);
  });

  it('#6 the runtime schedules Morning Afters for every planned or active trip in the stores', () => {
    const clock = createSimulatedClock('2026-06-20T09:00:00-04:00');
    const ids = createDeterministicIdGenerator('s');
    const stores = createMemoryStores({ clock, ids });
    stores.group.groups.create(TCI.group);
    for (const m of TCI.members) stores.group.members.upsert(m);
    stores.group.trips.create(TCI.trip);
    stores.group.trips.create({ ...TCI.trip, tripId: 'trip_old', status: 'closed' });
    const rt = createTravRuntime({
      channel: createSimulatorChannel({
        clock,
        conversations: [
          {
            conversationId: TCI.group.conversationId,
            participants: TCI.members.map((m) => ({
              handle: m.senderId,
              displayName: m.displayName,
              memberId: m.memberId,
            })),
          },
        ],
      }),
      clock,
      ids,
      stores,
      offline: true,
      env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: tempStateDir() },
    });
    const jobs = rt.scheduler.list().filter((j) => j.kind === 'morning_after');
    expect(jobs.map((j) => j.jobId)).toEqual(morningAfterJobsFor(TCI.trip).map((j) => j.jobId));
    expect(jobs.every((j) => j.tripId === TCI.trip.tripId)).toBe(true);
    rt.close();
  });

  for (const ageKnown of [true, false])
    it(`#7 the family "yesterday" line says who paid, only for a confirmed adult (age known: ${String(ageKnown)})`, async () => {
      const clock = createSimulatedClock('2026-06-21T10:00:00-04:00');
      const ids = createDeterministicIdGenerator('p');
      const stores = createMemoryStores({ clock, ids });
      stores.group.groups.create(TCI.group);
      for (const m of TCI.members) {
        if (ageKnown || m.memberId !== 'mem_tci_dad') stores.group.members.upsert(m);
        else {
          const { birthDate: _b, ageBand: _a, ...rest } = m;
          stores.group.members.upsert(rest as Member);
        }
      }
      stores.group.trips.create(TCI.trip);
      const snorkel: Expense = {
        ...lateExpense('exp_tci_snork', 'snorkel tour', 'activities', 'mem_tci_dad'),
        groupId: TCI.group.groupId,
        tripId: TCI.trip.tripId,
        amount: { amountMinor: 26000, currency: 'USD' },
        paidBy: [{ memberId: 'mem_tci_dad', amount: { amountMinor: 26000, currency: 'USD' } }],
        occurredAt: '2026-06-20T14:00:00-04:00',
        createdAt: '2026-06-20T14:00:00-04:00',
      };
      writeExpenses(stores, [snorkel], TCI.members);
      const r = await composeMorningAfter(
        { stores, clock, ids },
        TCI.group.groupId,
        TCI.trip.tripId,
        '2026-06-21',
      );
      if (r.kind !== 'ok') throw new Error(r.kind);
      // An unknown age counts as a possible minor in family mode (review r2 #4).
      expect(r.message.text.split('\n')[1]).toBe(
        ageKnown ? 'yesterday: snorkel tour $260 on Dad' : 'yesterday: snorkel tour $260',
      );
    });

  it('SAFETY §2.8: a roast line the gates drop is audited as roast.suppressed, cause only', async () => {
    const w = barcelonaAt(AT, { roast: true, roastConsent: (id) => id !== 'mem_sam' });
    const job = morningAfterJobFor(w.stores.group.trips.get(BARCELONA.tripId)!, '2026-03-15');
    const turn = await w.h.runtime.agent.runScheduled(job);
    const rows = w.h
      .audit()
      .filter((e) => e.type === 'roast.suppressed' && turn.auditEventIds.includes(e.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.payload).toMatchObject({ cause: 'member_opted_out' });
    expect(JSON.stringify(rows.map((x) => x.payload))).not.toMatch(/Sam|tab remembers/);
  });

  it('review r2 #2: a line naming a member who left is audited as target_inactive', async () => {
    const w = barcelonaAt(AT, { roast: true, roastConsent: () => true });
    const sam = w.stores.group.members.get('mem_sam')!;
    w.stores.group.members.upsert({ ...sam, leftAt: '2026-03-14T12:00:00+01:00' });
    const job = morningAfterJobFor(w.stores.group.trips.get(BARCELONA.tripId)!, '2026-03-15');
    const turn = await w.h.runtime.agent.runScheduled(job);
    const causes = w.h
      .audit()
      .filter((e) => e.type === 'roast.suppressed' && turn.auditEventIds.includes(e.id))
      .map((e) => (e.payload as { cause: string }).cause);
    expect(causes).toContain('target_inactive');
    expect(causes).not.toContain('member_opted_out');
  });
});

describe('T-138: a blocked or unseparable roast line never drops the whole Morning After', () => {
  const AT = '2026-03-15T10:00:00+01:00';
  const pendingItem = (owner: MemberId): PendingPrivateItem =>
    markPrivate({
      id: `priv_${owner}`,
      ownerMemberId: owner,
      groupId: BARCELONA.groupId,
      tripId: BARCELONA.tripId,
      createdAt: AT,
      source: 'card' as const,
      sourceItemId: `src_${owner}`,
      status: 'pending' as const,
      amount: { amountMinor: 980, currency: 'EUR' },
      occurredAt: '2026-03-15T03:10:00+01:00',
      merchantDisplay: 'Farmacia Central',
      category: 'other' as const,
      lowConfidence: false,
    }) as PendingPrivateItem;
  const groupRecaps = (w: World) =>
    w.h.channel
      .transcript()
      .filter((e) => e.type === 'message' && e.lane === 'group' && e.card?.type === 'recap');
  const suppressedCauses = (w: World, ids: readonly string[]) =>
    w.h
      .audit()
      .filter((e) => e.type === 'roast.suppressed' && ids.includes(e.id))
      .map((e) => (e.payload as { cause: string }).cause);
  const roastPayloads = (w: World) =>
    JSON.stringify(
      w.h
        .audit()
        .filter((e) => e.type === 'roast.suppressed')
        .map((e) => e.payload),
    );

  it('the "looks shared" pending line and the roast lines go out together (clk_bcn_2026031510)', async () => {
    const w = barcelonaAt(AT, { roast: true });
    w.stores.private.putPendingItem('mem_sam', pendingItem('mem_sam'));
    const job = morningAfterJobFor(w.stores.group.trips.get(BARCELONA.tripId)!, '2026-03-15');
    const turn = await w.h.runtime.agent.runScheduled(job);
    expect(turn.note).toBe('scheduled:morning_after:full');
    expect(turn.silent).toBe(false);
    expect(groupRecaps(w)).toHaveLength(1);
    const sent = turn.outbound[0] as { roast?: boolean; text: string; card?: unknown };
    expect(sent.roast).toBe(true);
    expect(sent.text).toContain('1 charge that looks shared is waiting on a tap in dms');
    const roastLines = asRecap(sent.card).roastLines ?? [];
    expect(roastLines.length).toBeGreaterThan(0);
    for (const l of roastLines) {
      expect(sent.text.split('\n')).toContain(l);
      expect(safety.roastTopicBlocked(l)).toBeNull();
    }
    for (const bad of ['sick', 'Farmacia', '9.80', 'Henry was', "Henry's"]) {
      expect(sent.text).not.toContain(bad);
    }
    expect(suppressedCauses(w, turn.auditEventIds)).not.toContain('unlocatable');
  });

  it('a blocklisted word the screen cannot separate (a booked plan label): the recap posts without its roast lines, audited', async () => {
    const w = barcelonaAt(AT, { roast: true });
    w.stores.group.trips.upsertActivity({
      activityId: 'act_bcn_t138_brunch',
      tripId: BARCELONA.tripId,
      groupId: BARCELONA.groupId,
      kind: 'dinner',
      name: 'hangover brunch',
      startsAt: '2026-03-15T12:30:00+01:00',
      contentTags: [],
      ageRestriction: null,
      bookingId: 'bk_t138_brunch',
      createdAt: '2026-03-14T12:00:00+01:00',
    });
    // The composer falls back: no roast lines, not marked, candidates audited as unlocatable.
    const r = await recapOn('2026-03-15', w);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.mode).toBe('full');
    expect(r.roastLines).toEqual([]);
    expect(r.message.roast).not.toBe(true);
    expect(r.message.text).toContain('hangover brunch');
    expect(r.suppressedRoast.length).toBeGreaterThan(0);
    expect(r.suppressedRoast.every((s) => s.cause === 'unlocatable')).toBe(true);

    const job = morningAfterJobFor(w.stores.group.trips.get(BARCELONA.tripId)!, '2026-03-15');
    const turn = await w.h.runtime.agent.runScheduled(job);
    expect(turn.silent).toBe(false);
    expect(groupRecaps(w)).toHaveLength(1);
    const sent = turn.outbound[0] as { roast?: boolean; text: string };
    expect(sent.roast).not.toBe(true);
    expect(sent.text).not.toContain('the tab remembers');
    expect(suppressedCauses(w, turn.auditEventIds)).toContain('unlocatable');
    // The roast line text is never audited.
    expect(roastPayloads(w)).not.toContain('tab remembers');
    expect(roastPayloads(w)).not.toContain('metro');
  });
});

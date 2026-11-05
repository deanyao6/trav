/** The runtime's default ticket provider covers every bundled trip (T-093); recap scheduling (T-142). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSimulatorChannel } from '@trav/adapters';
import type { Group, Member, Stores, Trip } from '@trav/core';
import { createDeterministicIdGenerator, createSimulatedClock } from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import { BARCELONA, createTravRuntime, recapJobsFor } from './compose.js';
import { repoRoot } from './model/paths.js';
import { morningAfterJobsFor } from './recaps/morningAfter.js';
import { wrappedJobFor } from './recaps/wrapped.js';
import { RAZZMATAZZ_ASK, harness, tempStateDir } from './runtime.testkit.js';

describe('createTravRuntime default ticket provider', () => {
  // `providers: {}` drops the harness's Barcelona-only mock, so compose's default is used.
  const h = () => harness({ runtime: { providers: {} } });

  it("each trip city finds its own trip's events", async () => {
    const { tickets } = h().runtime.providers;
    const search = async (city: string, dateFrom: string, dateTo: string, query: string) => {
      const r = await tickets.searchEvents({ city, dateFrom, dateTo, query });
      if (!r.ok) throw new Error(r.error.code);
      return r.value.map((e) => e.eventId);
    };
    expect(await search('Lisbon', '2026-04-15', '2026-04-20', 'benfica vs porto')).toContain(
      'evt_lis_benfica_porto',
    );
    expect(await search('Lisbon', '2026-04-15', '2026-04-20', 'fado')).toEqual([
      'evt_lis_fado_0416',
    ]);
    expect(await search('Providenciales', '2026-06-20', '2026-06-27', 'snorkel')).toEqual([
      'evt_tci_snorkel_0622',
    ]);
    const bcn = await search('Barcelona', '2026-03-14', '2026-03-14', 'razzmatazz');
    expect(bcn).toEqual(['evt_rzm_20260314']);
    // No cross-trip leakage.
    expect(await search('Barcelona', '2026-04-15', '2026-06-27', 'snorkel benfica fado')).toEqual(
      [],
    );
  });

  it('the Razzmatazz ask is unchanged on the default provider', async () => {
    const t = h();
    await t.say('h_dean', RAZZMATAZZ_ASK);
    const [proposal] = t.pending();
    expect(proposal).toMatchObject({
      itemRef: expect.stringContaining('rzm_20260314'),
      totalMinor: 9000,
      currency: 'EUR',
    });
    expect(proposal?.attendees).toHaveLength(5);
  });
});

describe('recap scheduling: every planning or active trip gets its Morning Afters and its Wrapped (T-142)', () => {
  interface GroupFixture {
    readonly group: Group;
    readonly members: Member[];
    readonly trip: Trip;
  }
  const fixture = (name: string): GroupFixture =>
    JSON.parse(
      readFileSync(join(repoRoot(), 'fixtures', 'groups', `${name}.json`), 'utf8'),
    ) as GroupFixture;

  // A runtime over stores the caller seeded (seed none), as the eval runner builds it.
  function runtimeOver(at: string, f: GroupFixture, seed: (stores: Stores) => void) {
    const clock = createSimulatedClock(at);
    const ids = createDeterministicIdGenerator('t142');
    const stores = createMemoryStores({ clock, ids });
    seed(stores);
    const runtime = createTravRuntime({
      channel: createSimulatorChannel({
        clock,
        conversations: [
          {
            conversationId: f.group.conversationId,
            participants: f.members.map((m) => ({
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
    return { runtime, clock };
  }
  const put = (stores: Stores, f: GroupFixture, trip: Trip = f.trip): void => {
    if (stores.group.groups.get(f.group.groupId) === undefined) {
      stores.group.groups.create(f.group);
      for (const m of f.members) stores.group.members.upsert(m);
    }
    stores.group.trips.create(trip);
  };
  const wrappedIds = (rt: { scheduler: { list(): readonly { jobId: string; kind: string }[] } }) =>
    rt.scheduler
      .list()
      .filter((j) => j.kind === 'wrapped')
      .map((j) => j.jobId);

  it('a trip seeded outside the demo (Turks and Caicos) gets wrapped:<trip> at 10am the day after', () => {
    const tci = fixture('turks-and-caicos');
    const { runtime: rt } = runtimeOver('2026-06-20T09:00:00-04:00', tci, (s) => put(s, tci));
    const wrapped = rt.scheduler.list().filter((j) => j.kind === 'wrapped');
    expect(wrapped).toEqual([wrappedJobFor(tci.trip)]);
    expect(wrapped[0]).toMatchObject({
      jobId: 'wrapped:trip_turks_caicos',
      runAt: '2026-06-28T10:00:00-04:00',
      groupId: tci.group.groupId,
    });
    // The Morning Afters are unchanged.
    expect(
      rt.scheduler
        .list()
        .filter((j) => j.kind === 'morning_after')
        .map((j) => j.jobId),
    ).toEqual(morningAfterJobsFor(tci.trip).map((j) => j.jobId));
    rt.close();
  });

  it('closed trips, and a Wrapped already behind the clock, are not scheduled', () => {
    const lis = fixture('lisbon');
    const { runtime: rt } = runtimeOver('2026-04-21T10:30:00+01:00', lis, (s) => {
      put(s, lis); // its Wrapped was 21 apr 10:00, already behind the clock
      put(s, lis, {
        ...lis.trip,
        tripId: 'trip_lis_closed',
        status: 'closed',
        endDate: '2026-05-01',
      });
      put(s, lis, {
        ...lis.trip,
        tripId: 'trip_lis_next',
        status: 'planning',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
      });
    });
    expect(wrappedIds(rt)).toEqual(['wrapped:trip_lis_next']);
    rt.close();
  });

  it('the seeded Barcelona demo has exactly one Wrapped job, at 10am on 18 mar', () => {
    const h = harness();
    const wrapped = h.runtime.scheduler.list().filter((j) => j.kind === 'wrapped');
    expect(wrapped.map((j) => [j.jobId, j.runAt])).toEqual([
      ['wrapped:trip_barcelona', '2026-03-18T10:00:00+01:00'],
    ]);
    const ids = recapJobsFor(h.runtime.stores, h.runtime.clock.now()).map((j) => j.jobId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === `wrapped:${BARCELONA.tripId}`)).toHaveLength(1);
  });

  it('draining past the end of a non-demo trip posts its Wrapped once', async () => {
    const tci = fixture('turks-and-caicos');
    const { runtime: rt, clock } = runtimeOver('2026-06-27T20:00:00-04:00', tci, (s) =>
      put(s, tci),
    );
    clock.set('2026-06-28T10:00:00-04:00');
    const notes = (await rt.drain()).map((t) => t.note);
    expect(notes.filter((n) => n.startsWith('scheduled:wrapped'))).toHaveLength(1);
    expect((await rt.drain()).filter((t) => t.note.startsWith('scheduled:wrapped'))).toEqual([]);
    rt.close();
  });
});

describe('scheduleTripJobs: groups seeded after the runtime was built (T-094)', () => {
  const fixture = (name: string): { group: Group; members: Member[]; trip: Trip } =>
    JSON.parse(readFileSync(join(repoRoot(), 'fixtures', 'groups', `${name}.json`), 'utf8')) as {
      group: Group;
      members: Member[];
      trip: Trip;
    };
  const seedLate = (stores: Stores, name: string): string => {
    const f = fixture(name);
    stores.group.groups.create(f.group);
    for (const m of f.members) stores.group.members.upsert(m);
    stores.group.trips.create(f.trip);
    return f.group.groupId;
  };

  it("adds the late group's Morning Afters and Wrapped, only that group, once", () => {
    const h = harness();
    const before = h.runtime.scheduler.list().map((j) => j.jobId);
    const lisbon = seedLate(h.runtime.stores, 'lisbon');
    const tci = seedLate(h.runtime.stores, 'turks-and-caicos');
    // Not scheduled until asked (the runtime only saw Barcelona when built).
    expect(h.runtime.scheduler.list().some((j) => j.groupId === lisbon)).toBe(false);

    const added = h.runtime.scheduleTripJobs([lisbon]);
    const lisTrip = fixture('lisbon').trip;
    expect([...added].sort()).toEqual(
      [...morningAfterJobsFor(lisTrip), wrappedJobFor(lisTrip)].map((j) => j.jobId).sort(),
    );
    expect(h.runtime.scheduler.list().some((j) => j.groupId === tci)).toBe(false);
    // Again (or naming an already-scheduled group) adds nothing; Barcelona's jobs untouched.
    expect(h.runtime.scheduleTripJobs([lisbon, BARCELONA.groupId])).toEqual([]);
    const after = h.runtime.scheduler.list().map((j) => j.jobId);
    expect(after.filter((id) => before.includes(id))).toEqual(before);
    expect(new Set(after).size).toBe(after.length);
    // An empty list schedules nothing.
    expect(h.runtime.scheduleTripJobs([])).toEqual([]);
  });

  it('never re-adds a job whose time already passed (it ran, so it cannot post twice)', async () => {
    const h = harness();
    const lisbon = seedLate(h.runtime.stores, 'lisbon');
    h.runtime.scheduleTripJobs([lisbon]);
    h.clock.set('2026-04-21T10:00:00+01:00');
    const first = (await h.runtime.drain()).filter((t) => t.note === 'scheduled:wrapped');
    expect(first).toHaveLength(2); // Barcelona's and Lisbon's
    expect(h.runtime.scheduleTripJobs([lisbon])).toEqual([]);
    expect(await h.runtime.drain()).toEqual([]);
  });

  it('drain({ groupId }) runs only that group’s due jobs; the others stay queued (T-095, D-035)', async () => {
    const h = harness();
    const lisbon = seedLate(h.runtime.stores, 'lisbon');
    h.runtime.scheduleTripJobs([lisbon]);
    h.clock.set('2026-04-21T10:00:00+01:00');
    const barcelonaQueued = h.runtime.scheduler
      .list()
      .filter((j) => j.groupId === BARCELONA.groupId);
    expect(barcelonaQueued.some((j) => j.kind === 'wrapped')).toBe(true);

    const lis = await h.runtime.drain({ groupId: lisbon });
    expect(lis.filter((t) => t.note === 'scheduled:wrapped')).toHaveLength(1);
    // Barcelona's due jobs (its Wrapped among them) were not touched.
    const left = h.runtime.scheduler.list();
    expect(left.filter((j) => j.groupId === lisbon && j.kind === 'wrapped')).toEqual([]);
    expect(left.filter((j) => j.groupId === BARCELONA.groupId).map((j) => j.jobId)).toEqual(
      expect.arrayContaining(barcelonaQueued.map((j) => j.jobId)),
    );
    // An unknown group drains nothing; the unfiltered drain still runs the rest.
    expect(await h.runtime.drain({ groupId: 'grp_nobody' })).toEqual([]);
    const rest = await h.runtime.drain();
    expect(rest.filter((t) => t.note === 'scheduled:wrapped')).toHaveLength(1);
  });
});

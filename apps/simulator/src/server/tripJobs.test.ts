/**
 * T-094: every seeded trip gets its scheduled jobs, not just Barcelona.
 *
 * The runtime schedules recap jobs for what is in its stores when it is built
 * (the Barcelona seed); the simulator writes Lisbon and Turks and Caicos from
 * `fixtures/groups/` afterwards, so it schedules theirs right after
 * (`runtime.scheduleTripJobs`). Each chat's "next morning" posts that trip's
 * Morning After / running settle-up and "end of trip" posts that trip's
 * Wrapped, in that trip's own thread, exactly once.
 *
 * One global clock starts in Barcelona (T-095 is separate), so the tests set
 * the clock straight to each trip's dates with a replay-style `to` move.
 * Offline throughout (`demoBackend` forces it).
 */
import { describe, expect, it } from 'vitest';
import type { SimState, ThreadEntry, ThreadMessage } from '../shared/types.js';
import type { SimulatorBackend } from './backend.js';
import { BARCELONA, LISBON, TURKS_AND_CAICOS } from './groups.js';
import { handleApi } from './routes.js';
import { demoBackend } from './testkit.js';

function messages(entries: readonly ThreadEntry[]): ThreadMessage[] {
  return entries.filter((e): e is ThreadMessage => e.kind === 'message');
}

function view(state: SimState, groupId: string) {
  const g = state.groups.find((x) => x.group.groupId === groupId);
  if (g === undefined) throw new Error(`no group ${groupId}`);
  return g;
}

function travPosts(state: SimState, groupId: string): ThreadMessage[] {
  return messages(view(state, groupId).thread).filter((m) => m.isTrav);
}

function wrappedIn(state: SimState, groupId: string): ThreadMessage[] {
  return messages(view(state, groupId).thread).filter((m) => m.card?.type === 'wrapped');
}

async function post(backend: SimulatorBackend, path: string, body: unknown = {}) {
  const res = await handleApi(backend, { method: 'POST', path, body });
  expect(res.status, `${path} ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
  return (res.body as { state: SimState }).state;
}

/** Group-lane and DM text, serialized, for "never in the group" checks. */
function groupPayload(state: SimState, groupId: string): string {
  return JSON.stringify(view(state, groupId).thread);
}

const NIGHTLIFE_OR_ALCOHOL =
  /\b(club|clubs|nightclub|nightlife|bar|bars|pub|pubs|drinks?|drinking|beer|beers|wine|cocktails?|shots?|tequila|vodka|booze|hangover|hungover|party|pregame)\b/i;

describe('T-094: Lisbon and Turks and Caicos get their recap and Wrapped jobs', () => {
  it('Lisbon: next morning posts the recap/settle-up, end of trip posts the Wrapped, no private budget leaks', async () => {
    const b = await demoBackend();
    // Dad tells Trav his private budget by DM (T-134). It is his alone.
    await b.advanceClock!({ to: '2026-04-16T18:00:00+01:00', groupId: LISBON.groupId });
    await post(b, '/api/messages', {
      from: 'h_lis_dad',
      text: "my budget is €95 a day, money's tight this year",
      lane: 'dm',
      groupId: LISBON.groupId,
    });
    await b.advanceClock!({ to: '2026-04-16T22:00:00+01:00', groupId: LISBON.groupId });
    const logged = await post(b, '/api/messages', {
      from: 'h_lis_dad',
      text: '@trav i paid €62 for dinner, split with Dean',
      groupId: LISBON.groupId,
    });
    const before = travPosts(logged, LISBON.groupId).length;
    expect(groupPayload(logged, LISBON.groupId)).toContain('€62');

    // The repro: "next morning" used to say "nothing was scheduled".
    const morning = await post(b, '/api/clock', { step: 'morning', groupId: LISBON.groupId });
    expect(morning.now).toBe('2026-04-17T10:00:00+01:00');
    const recap = travPosts(morning, LISBON.groupId).slice(before);
    expect(recap.length).toBeGreaterThan(0);
    expect(recap.some((m) => m.card?.type === 'recap' || m.card?.type === 'settle_up')).toBe(true);
    expect(view(morning, LISBON.groupId).status ?? '').not.toContain('nothing was scheduled');

    const end = await post(b, '/api/clock', { step: 'end_of_trip', groupId: LISBON.groupId });
    expect(end.now).toBe('2026-04-21T10:00:00+01:00');
    const wrapped = wrappedIn(end, LISBON.groupId);
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]!.isTrav).toBe(true);
    expect(view(end, LISBON.groupId).status).toBeUndefined();
    expect(view(end, LISBON.groupId).status ?? '').not.toContain('T-016');

    // Dad's private budget (figure and reason) never reaches the group thread.
    // Visible text and card values only: ids are random and may contain "95".
    const lisbonGroup = groupPayload(end, LISBON.groupId).replace(
      /"(?:id|[a-zA-Z]*Id|[a-zA-Z]*Ids)":(?:"[^"]*"|\[[^\]]*\])/g,
      '',
    );
    expect(lisbonGroup).not.toMatch(/€\s?95\b|\b95(?:[.,]\d+)?\b/);
    expect(lisbonGroup).not.toMatch(/tight/i);

    // Each trip's Wrapped lands in its own thread only, once (no double posts).
    expect(wrappedIn(end, BARCELONA.groupId)).toHaveLength(1);
    expect(wrappedIn(end, TURKS_AND_CAICOS.groupId)).toHaveLength(0);

    // Pressing it again moves nothing and posts nothing.
    const again = await post(b, '/api/clock', { step: 'end_of_trip', groupId: LISBON.groupId });
    expect(again.now).toBe(end.now);
    expect(wrappedIn(again, LISBON.groupId)).toHaveLength(1);
  });

  it('Turks and Caicos: recap and Wrapped post in the family chat, in family mode (no roast, no nightlife or alcohol)', async () => {
    const b = await demoBackend();
    await b.advanceClock!({ to: '2026-06-24T19:30:00-04:00', groupId: TURKS_AND_CAICOS.groupId });
    const logged = await post(b, '/api/messages', {
      from: 'h_tci_mom',
      text: '@trav i paid $180 for dinner, split with everyone',
      groupId: TURKS_AND_CAICOS.groupId,
    });
    const before = travPosts(logged, TURKS_AND_CAICOS.groupId).length;

    const morning = await post(b, '/api/clock', {
      step: 'morning',
      groupId: TURKS_AND_CAICOS.groupId,
    });
    expect(morning.now).toBe('2026-06-25T10:00:00-04:00');
    const recap = travPosts(morning, TURKS_AND_CAICOS.groupId).slice(before);
    expect(recap.length).toBeGreaterThan(0);

    const end = await post(b, '/api/clock', {
      step: 'end_of_trip',
      groupId: TURKS_AND_CAICOS.groupId,
    });
    expect(end.now).toBe('2026-06-28T10:00:00-04:00');
    const wrapped = wrappedIn(end, TURKS_AND_CAICOS.groupId);
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]!.isTrav).toBe(true);
    expect(view(end, TURKS_AND_CAICOS.groupId).status).toBeUndefined();

    // Family mode (SAFETY): the recap and Wrapped (everything Trav posted after
    // the family-mode notice and the logged dinner) carry no roast and no
    // nightlife or alcohol.
    const scheduled = travPosts(end, TURKS_AND_CAICOS.groupId).slice(before);
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
    for (const m of scheduled) {
      expect(JSON.stringify(m)).not.toMatch(NIGHTLIFE_OR_ALCOHOL);
      expect(m.text).not.toMatch(/roast/i);
      if (m.card?.type === 'recap') expect(m.card.roastLines).toEqual([]);
    }
    // The family recap reads "yesterday" (daytime window) and keeps the minor off the tab.
    const recapCard = scheduled.find((m) => m.card?.type === 'recap');
    expect(recapCard?.text).toMatch(/^morning, day 6/);
    expect(recapCard?.text).not.toMatch(/last night/i);
    expect(scheduled.find((m) => m.card?.type === 'wrapped')?.text).not.toMatch(/last night/i);

    // Every trip's Wrapped posted exactly once, each in its own thread.
    for (const g of [BARCELONA, LISBON, TURKS_AND_CAICOS])
      expect(wrappedIn(end, g.groupId), g.groupId).toHaveLength(1);
  });

  it('end of trip in each chat posts that trip’s Wrapped there', async () => {
    const b = await demoBackend();
    let state = b.state();
    for (const g of [BARCELONA, LISBON, TURKS_AND_CAICOS]) {
      state = await post(b, '/api/clock', { step: 'end_of_trip', groupId: g.groupId });
      const wrapped = wrappedIn(state, g.groupId);
      expect(wrapped, g.groupId).toHaveLength(1);
      const card = wrapped[0]!.card;
      expect(card?.type === 'wrapped' ? card.trip.endDate : undefined, g.groupId).toBe(g.tripEnd);
      expect(view(state, g.groupId).status, g.groupId).toBeUndefined();
    }
    // No trip's Wrapped posted twice, nor in another trip's chat.
    for (const g of [BARCELONA, LISBON, TURKS_AND_CAICOS])
      expect(wrappedIn(state, g.groupId), g.groupId).toHaveLength(1);
  });
});

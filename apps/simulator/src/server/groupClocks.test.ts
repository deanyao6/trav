/**
 * T-095: one clock per chat. Each chat opens on its own trip (Lisbon on thu
 * apr 16 9am, Turks and Caicos on sun jun 21 9am, Barcelona at the
 * Razzmatazz moment), and a clock step in one chat moves and drains only that
 * chat: another trip's Morning After or Wrapped never fires from it, and the
 * status line counts only that chat's jobs. Offline throughout.
 */
import { describe, expect, it } from 'vitest';
import { createSimulatedClock } from '@trav/core';
import type { TravAgent, TurnResult } from '@trav/agent';
import type { SimState, ThreadMessage } from '../shared/types.js';
import { clockLabel } from './clock.js';
import { createGroupClocks } from './groupClocks.js';
import { BARCELONA, LISBON, RAZZMATAZZ_CARD_ASK, TURKS_AND_CAICOS } from './groups.js';
import { handleApi } from './routes.js';
import { loadAgentBackend } from './runtime.js';
import type { SimRuntimeInput } from './runtime.js';
import type { SimulatorBackend } from './backend.js';
import { demoBackend } from './testkit.js';

const BCN_OPEN = '2026-03-14T21:39:30+01:00';
const LIS_OPEN = '2026-04-16T09:00:00+01:00';
const TCI_OPEN = '2026-06-21T09:00:00-04:00';

function view(state: SimState, groupId: string) {
  const g = state.groups.find((x) => x.group.groupId === groupId);
  if (g === undefined) throw new Error(`no group ${groupId}`);
  return g;
}

function messages(state: SimState, groupId: string): ThreadMessage[] {
  return view(state, groupId).thread.filter((e): e is ThreadMessage => e.kind === 'message');
}

const cardsOf = (state: SimState, groupId: string, type: string): ThreadMessage[] =>
  messages(state, groupId).filter((m) => m.card?.type === type);

async function api(
  backend: SimulatorBackend,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) {
  const res = await handleApi(backend, { method, path, body: body ?? {} });
  expect(res.status, `${path} ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
  return (res.body as { state?: SimState } & SimState).state ?? (res.body as SimState);
}

describe('createGroupClocks', () => {
  const starts = [
    ['a', '2026-03-14T21:00:00+01:00'],
    ['b', '2026-04-16T09:00:00+01:00'],
  ] as const;

  it('keeps each chat’s time; switching saves the active one and shows the next', () => {
    const base = createSimulatedClock('2026-03-14T21:00:00+01:00');
    const c = createGroupClocks(base, starts);
    expect(c.active()).toBe('a');
    expect(c.now('b')).toBe('2026-04-16T09:00:00+01:00');
    base.set('2026-03-14T22:00:00+01:00'); // a moves
    c.activate('b');
    expect(base.now()).toBe('2026-04-16T09:00:00+01:00');
    expect(c.now('a')).toBe('2026-03-14T22:00:00+01:00');
    base.set('2026-04-16T10:00:00+01:00'); // b moves
    c.activate('a');
    expect(base.now()).toBe('2026-03-14T22:00:00+01:00');
    expect(c.now('b')).toBe('2026-04-16T10:00:00+01:00');
    // An unknown chat changes nothing and reads the shared clock.
    c.activate('nope');
    expect(c.active()).toBe('a');
    expect(c.now('nope')).toBe(base.now());
  });

  it('within() shows a chat’s time for a synchronous moment and restores, even on a throw', () => {
    const base = createSimulatedClock('2026-03-14T21:00:00+01:00');
    const c = createGroupClocks(base, starts);
    expect(c.within('b', () => base.now())).toBe('2026-04-16T09:00:00+01:00');
    expect(c.active()).toBe('a');
    expect(base.now()).toBe('2026-03-14T21:00:00+01:00');
    expect(() =>
      c.within('b', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(c.active()).toBe('a');
    expect(base.now()).toBe('2026-03-14T21:00:00+01:00');
    expect(c.within(undefined, () => base.now())).toBe('2026-03-14T21:00:00+01:00');
  });

  it('enterTurn does nothing while pinned (seeding), activate always works', () => {
    const base = createSimulatedClock('2026-03-14T21:00:00+01:00');
    const c = createGroupClocks(base, starts);
    c.pin();
    c.enterTurn('b');
    expect(c.active()).toBe('a');
    c.unpin();
    c.enterTurn('b');
    expect(c.active()).toBe('b');
    c.enterTurn(undefined);
    expect(c.active()).toBe('b');
  });
});

describe('T-095: each chat opens on its own trip, with its own clock', () => {
  it('opens Lisbon on thu apr 16 9am in one action (the state the UI loads)', async () => {
    const b = await demoBackend();
    const state = await api(b, 'GET', '/api/state');
    const lis = view(state, LISBON.groupId);
    expect(lis.now).toBe(LIS_OPEN);
    expect(clockLabel(lis.now, LISBON)).toBe('thu apr 16 · 9am · day 2');
    expect(view(state, TURKS_AND_CAICOS.groupId).now).toBe(TCI_OPEN);
    expect(clockLabel(TCI_OPEN, TURKS_AND_CAICOS)).toBe('sun jun 21 · 9am · day 2');
    // Barcelona (the flagship) still opens a minute before the Razzmatazz ask.
    expect(view(state, BARCELONA.groupId).now).toBe(BCN_OPEN);
    expect(state.now).toBe(BCN_OPEN);
    expect(b.now(LISBON.groupId)).toBe(LIS_OPEN);

    // A Lisbon message lands on apr 16, a Barcelona one on mar 14.
    const after = await api(b, 'POST', '/api/messages', {
      from: 'h_lis_dean',
      text: 'morning dad, conference at 9 right?',
      groupId: LISBON.groupId,
    });
    expect(messages(after, LISBON.groupId).at(-1)?.at).toBe(LIS_OPEN);
    const bcn = await api(b, 'POST', '/api/messages', {
      from: 'h_chase',
      text: 'pregame soon',
      groupId: BARCELONA.groupId,
    });
    expect(messages(bcn, BARCELONA.groupId).at(-1)?.at).toBe(BCN_OPEN);
  });

  it('a Lisbon clock step never moves Barcelona’s clock or fires its jobs; the status counts only Lisbon’s', async () => {
    const b = await demoBackend();
    const before = b.state();
    const bcnThread = JSON.stringify(view(before, BARCELONA.groupId).thread);

    // Lisbon: next morning from 9am is 10am that day.
    const morning = await api(b, 'POST', '/api/clock', {
      step: 'morning',
      groupId: LISBON.groupId,
    });
    expect(view(morning, LISBON.groupId).now).toBe('2026-04-16T10:00:00+01:00');
    // Every Barcelona job (Morning Afters, Wrapped) is due by apr 16, yet none ran.
    expect(JSON.stringify(view(morning, BARCELONA.groupId).thread)).toBe(bcnThread);
    expect(view(morning, BARCELONA.groupId).now).toBe(BCN_OPEN);
    // The status line counts Lisbon's own job only (it used to count every
    // Barcelona job due by apr 16 too).
    expect(view(morning, LISBON.groupId).status).toBe(
      'clock → thu apr 16 · 10am · day 2 · 1 job ran, trav stayed quiet (scheduled:morning_after:silent)',
    );
    expect(view(morning, BARCELONA.groupId).status).toBeUndefined();

    // Lisbon's end of trip: Lisbon's Wrapped, never Barcelona's.
    const end = await api(b, 'POST', '/api/clock', {
      step: 'end_of_trip',
      groupId: LISBON.groupId,
    });
    expect(cardsOf(end, LISBON.groupId, 'wrapped')).toHaveLength(1);
    expect(cardsOf(end, BARCELONA.groupId, 'wrapped')).toHaveLength(0);
    expect(cardsOf(end, TURKS_AND_CAICOS.groupId, 'wrapped')).toHaveLength(0);
    expect(view(end, BARCELONA.groupId).now).toBe(BCN_OPEN);
    expect(view(end, TURKS_AND_CAICOS.groupId).now).toBe(TCI_OPEN);

    // Barcelona's own next morning is still its Morning After (sun mar 15 10am),
    // not a late Wrapped: its Wrapped waits for Barcelona's own end of trip.
    const bcnMorning = await api(b, 'POST', '/api/clock', {
      step: 'morning',
      groupId: BARCELONA.groupId,
    });
    expect(view(bcnMorning, BARCELONA.groupId).now).toBe('2026-03-15T10:00:00+01:00');
    expect(cardsOf(bcnMorning, BARCELONA.groupId, 'wrapped')).toHaveLength(0);
    // Nothing on the tab yet, so the Morning After stays quiet; one job, Barcelona's.
    expect(view(bcnMorning, BARCELONA.groupId).status).toBe(
      'clock → sun mar 15 · 10am · day 4 · 1 job ran, trav stayed quiet (scheduled:morning_after:silent)',
    );
    const bcnEnd = await api(b, 'POST', '/api/clock', {
      step: 'end_of_trip',
      groupId: BARCELONA.groupId,
    });
    const bcnWrapped = cardsOf(bcnEnd, BARCELONA.groupId, 'wrapped');
    expect(bcnWrapped).toHaveLength(1);
    expect(bcnWrapped[0]!.at).toBe('2026-03-18T10:00:00+01:00');
    // Lisbon's clock (and its single Wrapped) untouched by Barcelona's.
    expect(view(bcnEnd, LISBON.groupId).now).toBe('2026-04-21T10:00:00+01:00');
    expect(cardsOf(bcnEnd, LISBON.groupId, 'wrapped')).toHaveLength(1);
  });

  it('the Razzmatazz moment still runs on Barcelona’s clock after Lisbon’s trip is over', async () => {
    const b = await demoBackend();
    await api(b, 'POST', '/api/clock', { step: 'end_of_trip', groupId: LISBON.groupId });
    const asked = await api(b, 'POST', '/api/messages', {
      from: 'h_dean',
      text: RAZZMATAZZ_CARD_ASK,
      groupId: BARCELONA.groupId,
    });
    const travPosts = messages(asked, BARCELONA.groupId).filter((m) => m.isTrav);
    const proposal = travPosts.find((m) => m.card?.type === 'booking_proposal');
    expect(proposal).toBeDefined();
    // Stamped in Barcelona's time, tonight, not on Lisbon's apr 21.
    expect(proposal!.at.startsWith('2026-03-14T21:39')).toBe(true);
    expect(view(asked, BARCELONA.groupId).now.startsWith('2026-03-14T21:39')).toBe(true);
  });

  it('a turn in flight for one chat keeps its chat’s time while another chat’s message is stamped in its own', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: {
      readonly who: string;
      readonly at: string;
      readonly start: string;
      end?: string;
    }[] = [];
    const SILENT: TurnResult = {
      outbound: [],
      toolCalls: [],
      auditEventIds: [],
      silent: true,
      modelSources: [],
      note: 'fake',
    };
    const create = ({ clock }: SimRuntimeInput) => {
      const agent: TravAgent = {
        async handleInbound(event) {
          const rec = {
            who: 'sender' in event ? event.sender : '?',
            at: event.receivedAt,
            start: clock.now(),
          } as { who: string; at: string; start: string; end?: string };
          seen.push(rec);
          if (rec.who === 'h_lis_dean') await gate;
          rec.end = clock.now();
          return SILENT;
        },
        runScheduled: () => Promise.resolve(SILENT),
        intakeDocument: () => Promise.reject(new Error('unused')),
        importCardTransactions: () => Promise.reject(new Error('unused')),
        importEmailReceipts: () => Promise.reject(new Error('unused')),
        pendingCards: {
          byMessageId: () => undefined,
          pendingProposalsRequestedBy: () => [],
          lastTravQuestion: () => undefined,
        },
      };
      return { agent };
    };
    const b = await loadAgentBackend({ offline: true, createTravRuntime: create });
    const lis = b.inject({
      type: 'message',
      from: 'h_lis_dean',
      text: '@trav hi',
      groupId: LISBON.groupId,
    });
    // Lisbon's turn is now waiting on the gate; Barcelona's message arrives.
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.map((s) => s.who)).toEqual(['h_lis_dean']);
    const bcn = b.inject({
      type: 'message',
      from: 'h_crowley',
      text: 'razz?',
      groupId: BARCELONA.groupId,
    });
    release();
    await Promise.all([lis, bcn]);
    const lisTurn = seen.find((s) => s.who === 'h_lis_dean')!;
    const bcnTurn = seen.find((s) => s.who === 'h_crowley')!;
    expect(lisTurn).toMatchObject({ at: LIS_OPEN, start: LIS_OPEN, end: LIS_OPEN });
    expect(bcnTurn).toMatchObject({ at: BCN_OPEN, start: BCN_OPEN, end: BCN_OPEN });
  });
});

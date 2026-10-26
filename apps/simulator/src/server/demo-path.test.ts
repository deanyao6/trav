/**
 * The whole VOICE §9.5 demo clicked in order through the HTTP API, on the same
 * backend `main.ts` serves (`withReplay(selectBackend(…), barcelona.jsonl)`),
 * offline:
 *
 *   replay ▸ (step by step up to the Razzmatazz booking)
 *   → switch to Sam: "simulate a card charge" → the "looks shared?" Uber prompt → Share it
 *   → next morning → the Morning After card, or (until T-015) the status line naming it
 *   → end of trip  → Wrapped, or (until T-016) the status line naming it
 *
 * Every step is a POST a button in the UI makes. Privacy is checked on the
 * group payload after every step.
 */
import { describe, expect, it } from 'vitest';
import type { GroupView, SimState, ThreadEntry, ThreadMessage } from '../shared/types.js';
import type { SimulatorBackend } from './backend.js';
import { BARCELONA } from './groups.js';
import { loadBarcelonaScript, withReplay } from './replay.js';
import { handleApi } from './routes.js';
import { loadAgentBackend } from './runtime.js';
import { createScriptedBackend } from './scripted.js';

const SCRIPT = loadBarcelonaScript();
/** Last line of the Razzmatazz moment (Sam's late Approve on a done proposal). */
const AFTER_FLAGSHIP = SCRIPT.findIndex((l) => l.id === 'msg_bcn_0134') + 1;
const FLAGSHIP_ASK = SCRIPT.findIndex((l) => l.id === 'msg_bcn_0130');

function bcn(state: SimState): GroupView {
  return state.groups.find((g) => g.group.groupId === BARCELONA.groupId)!;
}

function messages(entries: readonly ThreadEntry[]): ThreadMessage[] {
  return entries.filter((e): e is ThreadMessage => e.kind === 'message');
}

function expectGroupClean(state: SimState): void {
  for (const g of state.groups) {
    for (const m of messages(g.thread)) {
      expect(m.lane).toBe('group');
      expect(m.card?.type).not.toBe('ticket');
      if (m.card?.type === 'expense_confirm') {
        expect(m.card.visibility).not.toBe('private');
        expect((m.card.digestItems ?? []).every((i) => i.visibility !== 'private')).toBe(true);
      }
    }
  }
  const group = JSON.stringify(state.groups.map((g) => g.thread));
  // Sam's private Uber charge and Priya's DM-only diet note never reach the group.
  expect(group).not.toContain('23.40');
  expect(group).not.toContain('vegetarian');
}

async function post(
  backend: SimulatorBackend,
  path: string,
  body: unknown = {},
): Promise<SimState> {
  const res = await handleApi(backend, { method: 'POST', path, body });
  expect(res.status, `${path} ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  const state = (res.body as { state: SimState }).state;
  expect(state.lastError, path).toBeUndefined();
  expectGroupClean(state);
  return state;
}

/** Presses "replay ▸" until `cursor` lines have run. Returns the state after each press. */
async function replayTo(b: SimulatorBackend, cursor: number): Promise<SimState> {
  let s = b.state();
  // Termination: at most one press per script line.
  for (let n = 0; n < SCRIPT.length && (s.replay?.cursor ?? 0) < cursor; n++) {
    s = await post(b, '/api/replay/step');
  }
  expect(s.replay?.cursor).toBe(cursor);
  return s;
}

type Kind = 'scripted' | 'agent';

async function servedBackend(kind: Kind) {
  const inner = kind === 'scripted' ? await createScriptedBackend() : await loadAgentBackend({});
  return withReplay(inner, SCRIPT);
}

describe.each<Kind>(['scripted', 'agent'])('demo clicked in order (%s backend)', (kind) => {
  it('replay → Sam shares the Uber → next morning → end of trip', async () => {
    const b = await servedBackend(kind);
    expect(b.state().controls).toMatchObject({
      replay: true,
      clock: true,
      scheduler: true,
      intake: true,
    });

    // --- replay up to the Razzmatazz ask; snapshot Henry's DM tab.
    const beforeAsk = await replayTo(b, FLAGSHIP_ASK);
    const henryBefore = bcn(beforeAsk).dms['mem_henry']!.length;

    // --- the flagship: ask → proposal → Dean 👍 → (booking) → late taps ignored.
    const s3 = await replayTo(b, AFTER_FLAGSHIP);
    const thread = messages(bcn(s3).thread);
    const ask = thread.find((m) => m.text === SCRIPT[FLAGSHIP_ASK]!.text)!;
    expect(ask, 'the flagship ask is in the group').toBeDefined();
    const proposal = thread.find((m) => m.seq > ask.seq && m.card?.type === 'booking_proposal');
    expect(proposal, 'Trav proposed the 5 tickets').toBeDefined();
    // The Razzmatazz booking adds nothing to Henry's tab (no ticket, no prompt).
    expect(bcn(s3).dms['mem_henry']!.length).toBe(henryBefore);
    expect(messages(bcn(s3).dms['mem_henry']!).some((m) => m.card?.type === 'ticket')).toBe(false);
    // On both backends (the agent one since T-009): Dean's 👍 books, the receipt lands in the
    // group, one ticket card per attendee in their DM tab, the late taps change nothing.
    expect(proposal!.cardState?.label).toBe('Approved by Dean');
    const receipt = thread.find((m) => m.seq > proposal!.seq && m.card?.type === 'receipt');
    expect(receipt?.text).toMatch(/^booked ✅ razzmatazz, 5 tickets, €90/);
    expect(thread.filter((m) => m.card?.type === 'receipt')).toHaveLength(1);
    for (const id of ['mem_dean', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam']) {
      expect(
        messages(bcn(s3).dms[id]!).filter((m) => m.card?.type === 'ticket'),
        id,
      ).toHaveLength(1);
    }

    // --- state 4: send as Sam; his DM rail offers his own card charge; feed it.
    expect(bcn(s3).intake['mem_sam']).toEqual([{ docId: 'doc_bcn_sam_card_1', kind: 'card' }]);
    const s4 = await post(b, '/api/intake', { docId: 'doc_bcn_sam_card_1' });
    const prompt = messages(bcn(s4).dms['mem_sam']!).find(
      (m) => m.card?.type === 'expense_confirm' && m.card.status === 'pending',
    )!;
    expect(prompt.text).toMatch(/^saw €23\.40 from Uber at 2:14am/);
    expect(prompt.actions.map((a) => a.label)).toEqual(['Share it', 'Keep private']);
    expect(bcn(s4).dms['mem_henry']!.length).toBe(henryBefore);

    const s4b = await post(b, '/api/button-taps', {
      from: 'h_sam',
      cardMessageId: prompt.messageId,
      actionId: 'confirm',
    });
    // Shared (T-013): the card in Sam's DM is now `logged`, split with the 5 who went;
    // the group is not pinged now, it sees it in the next recap (VOICE §3.7, §4.5).
    const logged = messages(bcn(s4b).dms['mem_sam']!).find(
      (m) => m.seq > prompt.seq && m.card?.type === 'expense_confirm' && m.card.status === 'logged',
    );
    expect(logged, 'Sam sees it went on the tab').toBeDefined();
    const card = logged!.card;
    const participants = card?.type === 'expense_confirm' ? card.split.participants : [];
    expect(participants.map((p) => p.memberId)).not.toContain('mem_henry');
    expect(participants).toHaveLength(5);
    const named = messages(bcn(s4b).thread).some(
      (m) => m.isTrav && m.seq > prompt.seq && /uber/i.test(m.text),
    );
    expect(named).toBe(false);
    expect(bcn(s4b).status).toBeUndefined();

    // --- state 5: next morning.
    const s5 = await post(b, '/api/clock', { step: 'morning', groupId: BARCELONA.groupId });
    expect(s5.now).toBe('2026-03-15T10:00:00+01:00');
    const recap = messages(bcn(s5).thread).find((m) => m.card?.type === 'recap');
    if (recap === undefined) {
      expect(bcn(s5).status).toContain('sun mar 15 · 10am · day 4');
      expect(bcn(s5).status).toContain('no Morning After yet');
      expect(bcn(s5).status).toContain('T-015');
    } else {
      expect(recap.text).toContain('kebab');
    }

    // --- state 6: end of trip.
    const s6 = await post(b, '/api/clock', { step: 'end_of_trip', groupId: BARCELONA.groupId });
    expect(s6.now).toBe('2026-03-18T10:00:00+01:00');
    const wrapped = messages(bcn(s6).thread).find((m) => m.card?.type === 'wrapped');
    if (wrapped === undefined) {
      expect(bcn(s6).status).toContain('trip over');
      expect(bcn(s6).status).toContain('no Wrapped yet');
      expect(bcn(s6).status).toContain('T-016');
    }
    // Status lines never carry amounts or merchants, and never become Trav messages.
    for (const s of [s4b, s5, s6]) expect(bcn(s).status ?? '').not.toMatch(/€|23\.40|uber/i);

    // --- the rest of the script still runs after the manual clock moves: the
    // clock never rewinds, lines already covered are skipped with a reason.
    const end = await post(b, '/api/replay/all');
    expect(end.replay).toMatchObject({
      cursor: SCRIPT.length,
      total: SCRIPT.length,
      running: false,
    });
    // Never rewound (the scripted backend ticks 30s per inject, so it may be a bit later).
    expect(Date.parse(end.now)).toBeGreaterThanOrEqual(Date.parse('2026-03-18T10:00:00+01:00'));
    expect(end.now.startsWith('2026-03-18T10:')).toBe(true);
    expect(bcn(end).intake['mem_sam']).toEqual([]);
  });

  it('replay alone: each 10am clock line moves the clock and names what is missing', async () => {
    const b = await servedBackend(kind);
    const morning = SCRIPT.findIndex((l) => l.id === 'clk_bcn_2026031510');
    const s5 = await replayTo(b, morning + 1);
    expect(s5.now).toBe('2026-03-15T10:00:00+01:00');
    expect(s5.replay?.last).toBe('clock → sun mar 15 · 10am · day 4');
    if (!messages(bcn(s5).thread).some((m) => m.card?.type === 'recap')) {
      expect(bcn(s5).status).toContain('T-015');
    }
    const s6 = await replayTo(b, SCRIPT.length);
    expect(s6.now).toBe('2026-03-18T10:00:00+01:00');
    if (!messages(bcn(s6).thread).some((m) => m.card?.type === 'wrapped')) {
      expect(bcn(s6).status).toContain('T-016');
    }
    // Other trips never show Barcelona's line.
    for (const g of s6.groups)
      if (g.group.groupId !== BARCELONA.groupId) expect(g.status).toBeUndefined();
  });
});

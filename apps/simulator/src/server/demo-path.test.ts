/**
 * The whole VOICE §9.5 demo clicked in order through the HTTP API, on the same
 * backend `main.ts` serves (`withReplay(selectBackend(…), barcelona.jsonl)`),
 * offline:
 *
 *   replay ▸ (step by step up to the Razzmatazz booking)
 *   → switch to Crowley: "simulate a card charge" → the "looks shared?" Uber prompt → Share it
 *   → next morning → the Morning After card (T-015)
 *   → end of trip  → the Wrapped card (T-016): trip name, dates, final settle
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
import { demoBackend } from './testkit.js';

const SCRIPT = loadBarcelonaScript();
/** Last line of the Razzmatazz moment (Crowley's late Approve on a done proposal). */
const AFTER_FLAGSHIP = SCRIPT.findIndex((l) => l.id === 'msg_bcn_0134') + 1;
const FLAGSHIP_ASK = SCRIPT.findIndex((l) => l.id === 'msg_bcn_0130');
/** Through Crowley's waters at the club (msg_bcn_0139); the next line is his card sync (sys_bcn_0155). */
const BEFORE_CROWLEY_SYNC = SCRIPT.findIndex((l) => l.id === 'msg_bcn_0139') + 1;

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
  // Crowley's private Uber charge and Arjun's DM-only diet note never reach the group
  // as themselves. Once Crowley taps Share it, the €23.40 is on the group tab, so the
  // end-of-trip recap / Wrapped totals may carry it (VOICE §3.7: "the group sees
  // it in the next recap"); no other group message ever does.
  const live = state.groups.map((g) =>
    messages(g.thread).filter((m) => m.card?.type !== 'recap' && m.card?.type !== 'wrapped'),
  );
  expect(JSON.stringify(live)).not.toContain('23.40');
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

/** `seeded`: what `pnpm sim` serves (opens on demo state 1). `bare`: no seed lines. */
type Kind = 'seeded' | 'bare';

async function servedBackend(kind: Kind) {
  const inner = kind === 'seeded' ? await demoBackend() : await loadAgentBackend({ offline: true });
  return withReplay(inner, SCRIPT);
}

describe.each<Kind>(['seeded', 'bare'])('demo clicked in order (real runtime, %s)', (kind) => {
  it('replay → Crowley shares the Uber → next morning → end of trip', async () => {
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
    // (He does hold a Barça ticket from earlier in the script: T-081 books that match.)
    expect(
      messages(bcn(s3).dms['mem_henry']!).some(
        (m) => m.card?.type === 'ticket' && /razzmatazz/i.test(m.card.event.name),
      ),
    ).toBe(false);
    // Dean's 👍 books (T-009/T-030), the receipt lands in the group, one ticket card per
    // attendee in their DM tab, the late taps change nothing.
    expect(proposal!.cardState?.label).toBe('Approved by Dean');
    const receipt = thread.find((m) => m.seq > proposal!.seq && m.card?.type === 'receipt');
    expect(receipt?.text).toMatch(/^booked ✅ razzmatazz, 5 tickets, €90/);
    // One Razzmatazz receipt (the Barça one from earlier in the script is the other, T-081).
    expect(
      thread.filter((m) => m.card?.type === 'receipt' && /razzmatazz/i.test(m.text)),
    ).toHaveLength(1);
    for (const id of ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley']) {
      expect(
        messages(bcn(s3).dms[id]!).filter(
          (m) => m.card?.type === 'ticket' && /razzmatazz/i.test(m.card.event.name),
        ),
        id,
      ).toHaveLength(1);
    }

    // --- state 4: the night goes on (Crowley's waters at the club go on the tab from chat,
    // msg_bcn_0139); Crowley's 2:14am ride hasn't happened yet, so his rail offers no card sync.
    expect(bcn(s3).intake['mem_crowley']).toEqual([]);
    const s3b = await replayTo(b, BEFORE_CROWLEY_SYNC);
    expect(s3b.now).toBe('2026-03-15T01:30:00+01:00');
    expect(bcn(s3b).intake['mem_crowley']).toEqual([]);
    // +1 hour: after the ride. Send as Crowley; his rail offers his card; it syncs for real
    // (T-067: the runtime's provider on the simulated clock) and asks about the Uber only.
    const s3c = await post(b, '/api/clock', { step: 'hour', groupId: BARCELONA.groupId });
    expect(bcn(s3c).intake['mem_crowley']).toEqual([
      { docId: 'doc_bcn_crowley_card_1', kind: 'card' },
    ]);
    const s4 = await post(b, '/api/intake', { docId: 'doc_bcn_crowley_card_1' });
    expect(
      messages(bcn(s4).dms['mem_crowley']!).filter(
        (m) => m.card?.type === 'expense_confirm' && m.card.status === 'pending',
      ),
    ).toHaveLength(1);
    const prompt = messages(bcn(s4).dms['mem_crowley']!).find(
      (m) => m.card?.type === 'expense_confirm' && m.card.status === 'pending',
    )!;
    expect(prompt.text).toMatch(/^saw €23\.40 from Uber at 2:14am/);
    expect(prompt.actions.map((a) => a.label)).toEqual(['Share it', 'Keep private']);
    expect(bcn(s4).dms['mem_henry']!.length).toBe(henryBefore);

    const s4b = await post(b, '/api/button-taps', {
      from: 'h_crowley',
      cardMessageId: prompt.messageId,
      actionId: 'confirm',
    });
    // Shared (T-013): the card in Crowley's DM is now `logged`, split with the 5 who went;
    // the group is not pinged now, it sees it in the next recap (VOICE §3.7, §4.5).
    const logged = messages(bcn(s4b).dms['mem_crowley']!).find(
      (m) => m.seq > prompt.seq && m.card?.type === 'expense_confirm' && m.card.status === 'logged',
    );
    expect(logged, 'Crowley sees it went on the tab').toBeDefined();
    const card = logged!.card;
    const participants = card?.type === 'expense_confirm' ? card.split.participants : [];
    expect(participants.map((p) => p.memberId)).not.toContain('mem_henry');
    expect(participants).toHaveLength(5);
    const named = messages(bcn(s4b).thread).some(
      (m) => m.isTrav && m.seq > prompt.seq && /uber/i.test(m.text),
    );
    expect(named).toBe(false);
    expect(bcn(s4b).status).toBeUndefined();

    // --- state 4, email (T-012): the replay fed Arjun's Uber receipt (sys_bcn_0113) and Arjun's
    // 👍 (msg_bcn_d_0009). Positive branch: the private prompt, then a `logged` card in Arjun's DM.
    const s4d = s4b;
    expect(bcn(s4d).intake['mem_arjun']).toEqual([]); // fed once, by the replay
    const emailPrompt = messages(bcn(s4d).dms['mem_arjun']!).find(
      (m) =>
        m.card?.type === 'expense_confirm' &&
        m.card.status === 'pending' &&
        m.card.source === 'email_receipt',
    )!;
    expect(emailPrompt, 'Arjun got the "looks shared?" receipt in a DM').toBeDefined();
    expect(emailPrompt.text).toMatch(/^Uber receipt from .+: €18\.60/);
    expect(emailPrompt.actions.map((a) => a.label)).toEqual(['Share it', 'Keep private']);
    // Shared: a `logged` expense card in Arjun's DM for €18.60; the group was not pinged.
    const emailLogged = messages(bcn(s4d).dms['mem_arjun']!).find(
      (m) =>
        m.seq > emailPrompt.seq && m.card?.type === 'expense_confirm' && m.card.status === 'logged',
    );
    expect(emailLogged, 'Arjun sees it went on the tab').toBeDefined();
    expect(emailLogged!.card?.type === 'expense_confirm' && emailLogged!.card.amount).toEqual({
      amountMinor: 1860,
      currency: 'EUR',
    });
    // Shared items reach the group only through a scheduled recap (T-015), never as a ping.
    expect(
      JSON.stringify(
        bcn(s4d).thread.filter(
          (e) => !('card' in e && (e.card?.type === 'recap' || e.card?.type === 'settle_up')),
        ),
      ),
    ).not.toContain('18.60');
    for (const id of ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_crowley', 'mem_henry']) {
      expect(JSON.stringify(bcn(s4d).dms[id]), id).not.toContain('18.60');
    }

    // --- state 5: next morning.
    const s5 = await post(b, '/api/clock', { step: 'morning', groupId: BARCELONA.groupId });
    expect(s5.now).toBe('2026-03-15T10:00:00+01:00');
    const lastSeq = Math.max(0, ...messages(bcn(s4d).thread).map((m) => m.seq));
    const posted5 = messages(bcn(s5).thread).filter((m) => m.seq > lastSeq && m.isTrav);
    // T-015: one scheduled post, which speaks for itself (no status line).
    expect(posted5).toHaveLength(1);
    expect(bcn(s5).status).toBeUndefined();
    // The Razzmatazz booking + Crowley's 2:14am Uber (now shared) = a night out: the full recap,
    // the 5 who went, "not Henry" as a fact and never the reason.
    const recap = posted5[0]!;
    expect(recap.card?.type).toBe('recap');
    expect(recap.text.split('\n')[0]).toBe('morning after, day 4 ☀️');
    expect(recap.text).toContain('(5 of you, not Henry)');
    expect(recap.text).toMatch(/Razzmatazz/);
    expect(recap.text).toMatch(/^tab: /m);
    expect(recap.text).not.toMatch(/sick/i);

    // --- state 6: end of trip.
    const s6 = await post(b, '/api/clock', { step: 'end_of_trip', groupId: BARCELONA.groupId });
    expect(s6.now).toBe('2026-03-18T10:00:00+01:00');
    // T-016: the scheduled Wrapped posts in the group, built from the stores.
    const wrapped = messages(bcn(s6).thread).find((m) => m.card?.type === 'wrapped');
    expect(wrapped, 'end of trip posts the Wrapped card').toBeDefined();
    expect(wrapped!.isTrav).toBe(true);
    expect(wrapped!.lane).toBe('group');
    const wcard = wrapped!.card?.type === 'wrapped' ? wrapped!.card : undefined;
    expect(wcard?.trip).toMatchObject({
      name: 'Barcelona spring break',
      days: 6,
      startDate: '2026-03-12',
      endDate: '2026-03-17',
    });
    expect(wrapped!.text.split('\n')[0]).toBe('barcelona spring break wrapped 🎉');
    expect(wrapped!.text).toMatch(/^6 days · 6 people · €/m);
    expect(wcard?.shareable).toBe(true);
    expect(wcard?.closing?.text).toMatch(/^next trip\?/);
    // Every award names a member and says where its number came from.
    for (const a of wcard?.awards ?? [])
      expect(['ledger', 'booking', 'attendance', 'album']).toContain(a.basis);
    // Henry's sick day never shows up as a stat or an award.
    expect(wrapped!.text).not.toMatch(/sick|pharmacy/i);
    // A Trav post speaks for itself: no status line.
    expect(bcn(s6).status).toBeUndefined();
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
    // Never rewound.
    expect(end.now).toBe('2026-03-18T10:00:00+01:00');
    expect(bcn(end).intake['mem_crowley']).toEqual([]);
  });

  it('replay alone: each 10am clock line moves the clock and names what is missing', async () => {
    const b = await servedBackend(kind);
    const morning = SCRIPT.findIndex((l) => l.id === 'clk_bcn_2026031510');
    const s5 = await replayTo(b, morning + 1);
    expect(s5.now).toBe('2026-03-15T10:00:00+01:00');
    expect(s5.replay?.last).toBe('clock → sun mar 15 · 10am · day 4');
    // T-015: the 10am line drains the Morning After; it speaks for itself.
    expect(bcn(s5).status ?? '').not.toContain('T-015');
    const day4 = messages(bcn(s5).thread).filter(
      (m) => m.isTrav && m.card?.type === 'recap' && m.text.startsWith('morning after, day 4'),
    );
    expect(day4).toHaveLength(1);
    expect(day4[0]!.text).toContain('not Henry');
    expect(day4[0]!.text).not.toMatch(/sick/i);
    const s6 = await replayTo(b, SCRIPT.length);
    expect(s6.now).toBe('2026-03-18T10:00:00+01:00');
    // The script's end-of-trip clock line drains the scheduled Wrapped (T-016).
    const posted = messages(bcn(s6).thread).filter((m) => m.card?.type === 'wrapped');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text.split('\n')[0]).toBe('barcelona spring break wrapped 🎉');
    expect(bcn(s6).status ?? '').not.toContain('T-016');
    // Other trips never show Barcelona's line.
    for (const g of s6.groups)
      if (g.group.groupId !== BARCELONA.groupId) expect(g.status).toBeUndefined();
  });
});

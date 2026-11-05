/**
 * VOICE §9.5 demo states 4–6 on top of 1–3, driven through the same backend
 * calls the UI makes (`routes.ts` → `SimulatorBackend`), offline:
 *
 *   4. switch to Sam → Sam's DM shows the "looks shared?" Uber prompt → Share it
 *   5. next morning → the clock moves, `scheduler.drain` runs, the Morning
 *      After job (T-015) decides: recap, running settle-up, or silence
 *   6. end of trip → same; the scheduled Wrapped (T-016) posts in the group
 *
 * The Morning After / Wrapped rendering hooks are in `ui/scheduled.test.tsx`.
 *
 * All on the real offline runtime (`createTravRuntime`), the backend `pnpm sim`
 * serves. Plus the privacy invariants: no private card or DM text in the group
 * payload, Henry's DM empty after the Razzmatazz proposal and booking.
 */
import { describe, expect, it } from 'vitest';
import type { GroupView, SimState, ThreadEntry, ThreadMessage } from '../shared/types.js';
import type { SimulatorBackend } from './backend.js';
import { KEPT_PRIVATE_STATUS } from './backend.js';
import { BARCELONA, LISBON, RAZZMATAZZ_ASK } from './groups.js';
import { handleApi } from './routes.js';
import { loadAgentBackend } from './runtime.js';
import { bookingCount, demoBackend } from './testkit.js';

function bcn(state: SimState): GroupView {
  return state.groups.find((g) => g.group.groupId === BARCELONA.groupId)!;
}

function messages(entries: readonly ThreadEntry[]): ThreadMessage[] {
  return entries.filter((e): e is ThreadMessage => e.kind === 'message');
}

/** The group payload (what the group thread renders from), serialized. */
function groupPayload(state: SimState): string {
  return JSON.stringify(state.groups.map((g) => g.thread));
}

/** No DM-only card and no private item may ever be in a group thread. */
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
}

async function post(backend: SimulatorBackend, path: string, body: unknown = {}) {
  const res = await handleApi(backend, { method: 'POST', path, body });
  expect(res.status, `${path} ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
  return (res.body as { state: SimState }).state;
}

/** T-090: Sam turns card import on by DM, the way a member would, before his card is read. */
async function samOptsIn(b: SimulatorBackend) {
  return post(b, '/api/messages', { from: 'h_sam', text: 'card import on', lane: 'dm' });
}

/** Demo state 3 on the backend `pnpm sim` serves: seeded chat, the ask, Dean's Approve. */
async function toState3() {
  const b = await demoBackend();
  await post(b, '/api/messages', { from: 'h_dean', text: RAZZMATAZZ_ASK, groupId: BARCELONA.groupId });
  const proposal = messages(bcn(b.state()).thread).find((m) => m.card?.type === 'booking_proposal')!;
  await post(b, '/api/button-taps', {
    from: 'h_dean',
    cardMessageId: proposal.messageId,
    actionId: 'approve',
  });
  return b;
}

describe('demo states 4–6 on the real runtime, opened on demo state 1, in order', () => {
  it('3 → 4: Henry has no DM after the booking; Sam feeds his card and gets the uber prompt; Share it', async () => {
    const b = await toState3();
    const s3 = b.state();
    expect(s3.controls).toMatchObject({ clock: true, scheduler: true, intake: true, reset: true });
    expect(bcn(s3).dms['mem_henry']).toEqual([]);
    expect(messages(bcn(s3).dms['mem_sam']!).map((m) => m.card?.type)).toEqual(['ticket']);

    // Only Sam's own card charge is offered for Sam; the payload names no amount or merchant.
    expect(bcn(s3).intake['mem_sam']).toEqual([{ docId: 'doc_bcn_sam_card_1', kind: 'card' }]);
    expect(bcn(s3).intake['mem_henry']).toEqual([]);
    expect(bcn(s3).intake['mem_jordan']).toEqual([]);
    expect(JSON.stringify(Object.values(bcn(s3).intake))).not.toMatch(/€|23\.40|2340|uber/i);

    await samOptsIn(b);
    const s4 = await post(b, '/api/intake', { docId: 'doc_bcn_sam_card_1' });
    const samDm = messages(bcn(s4).dms['mem_sam']!);
    const prompt = samDm.find((m) => m.card?.type === 'expense_confirm')!;
    expect(prompt.text).toMatch(/^saw €23\.40 from Uber at 2:14am/);
    expect(prompt.text).toContain('looks shared');
    expect(prompt.card).toMatchObject({ status: 'pending', visibility: 'private', paidBy: 'mem_sam' });
    expect(prompt.actions.map((a) => a.label)).toEqual(['Share it', 'Keep private']);
    expect(bcn(s4).intake['mem_sam']).toEqual([]); // fed once

    // Privacy: nowhere but Sam's DM.
    expectGroupClean(s4);
    expect(groupPayload(s4)).not.toContain('23.40');
    expect(groupPayload(s4)).not.toContain('expense_confirm');
    for (const m of BARCELONA.members.filter((x) => x.memberId !== 'mem_sam')) {
      expect(JSON.stringify(bcn(s4).dms[m.memberId])).not.toContain('23.40');
    }
    expect(bcn(s4).dms['mem_henry']).toEqual([]);

    // Share it, as Sam (T-013): on the tab, split with the 5 who went. Sam's DM gets the
    // logged line; the group is not pinged now, it sees it in the next recap (VOICE §3.7).
    const groupBefore = messages(bcn(s4).thread).length;
    const s5 = await post(b, '/api/button-taps', {
      from: 'h_sam',
      cardMessageId: prompt.messageId,
      actionId: 'confirm',
    });
    expect(bcn(s5).status).toBeUndefined();
    const samAfter = messages(bcn(s5).dms['mem_sam']!);
    const logged = samAfter.find(
      (m) => m.seq > prompt.seq && m.card?.type === 'expense_confirm' && m.card.status === 'logged',
    );
    expect(logged, 'Sam sees it went on the tab').toBeDefined();
    expect(logged!.text).toContain('€23.40');
    const card = logged!.card;
    if (card?.type !== 'expense_confirm') throw new Error('expected an expense_confirm card');
    expect(card.paidBy).toBe('mem_sam');
    expect(card.split.participants.map((p) => p.memberId)).toEqual([
      'mem_dean',
      'mem_maya',
      'mem_jordan',
      'mem_priya',
      'mem_sam',
    ]);
    expect(card.split.participants.reduce((s, p) => s + (p.share?.amountMinor ?? 0), 0)).toBe(2340);
    // The prompt's buttons are spent.
    expect(samAfter.find((m) => m.messageId === prompt.messageId)!.cardState).toMatchObject({
      status: 'resolved',
      liveActionIds: [],
    });
    expect(messages(bcn(s5).thread)).toHaveLength(groupBefore);
    expectGroupClean(s5);
    expect(groupPayload(s5)).not.toContain('23.40');
    // The status is Barcelona's only.
    expect(s5.groups.find((g) => g.group.groupId === LISBON.groupId)!.status).toBeUndefined();

    // Someone else can't tap Sam's card (the channel refuses a tap from another DM).
    const res = await handleApi(b, {
      method: 'POST',
      path: '/api/button-taps',
      body: { from: 'h_dean', cardMessageId: prompt.messageId, actionId: 'confirm' },
    });
    expect(res.status).toBe(400);

    // A second feed of the same document is refused.
    const again = await handleApi(b, { method: 'POST', path: '/api/intake', body: { docId: 'doc_bcn_sam_card_1' } });
    expect(again.status).toBe(409);
  });

  it('4, the other answer: Keep private stays private, Trav says nothing, the status line says so', async () => {
    const b = await toState3();
    await samOptsIn(b);
    const s4 = await post(b, '/api/intake', { docId: 'doc_bcn_sam_card_1' });
    const prompt = messages(bcn(s4).dms['mem_sam']!).find((m) => m.card?.type === 'expense_confirm')!;
    const dmBefore = bcn(s4).dms['mem_sam']!.length;
    const s5 = await post(b, '/api/button-taps', {
      from: 'h_sam',
      cardMessageId: prompt.messageId,
      actionId: 'keep_private',
    });
    expect(bcn(s5).status).toBe(KEPT_PRIVATE_STATUS);
    expect(bcn(s5).status).not.toMatch(/€|23\.40|uber/i);
    expect(
      messages(bcn(s5).dms['mem_sam']!).filter((m) => m.isTrav && m.seq > prompt.seq),
    ).toEqual([]);
    expect(bcn(s5).dms['mem_sam']!.length).toBeGreaterThanOrEqual(dmBefore);
    expectGroupClean(s5);
    expect(groupPayload(s5)).not.toContain('23.40');
  });

  it('4 → 5 → 6: next morning and end of trip move the clock and drain; Wrapped posts at the end', async () => {
    const b = await toState3();
    await post(b, '/api/intake', { docId: 'doc_bcn_sam_card_1' });
    const s5 = await post(b, '/api/clock', { step: 'morning', groupId: BARCELONA.groupId });
    expect(s5.now).toBe('2026-03-15T10:00:00+01:00');
    // T-015: the Razzmatazz booking is the only thing on the tab overnight (Sam left his
    // Uber unanswered, so it is still private), so the Morning After posts the quiet running
    // tab: Dean is owed the 4 × €18. Never the private €23.40. A Trav post needs no status line.
    const posted = messages(bcn(s5).thread).filter((m) => m.isTrav && m.card?.type === 'settle_up');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text.split('\n').slice(0, 2)).toEqual(['running tab, day 4', 'Dean is owed €72']);
    expect(posted[0]!.text).not.toContain('Henry');
    expect(JSON.stringify(bcn(s5).thread)).not.toContain('23.40');
    expect(bcn(s5).status).toBeUndefined();

    const s6 = await post(b, '/api/clock', { step: 'end_of_trip', groupId: BARCELONA.groupId });
    expect(s6.now).toBe('2026-03-18T10:00:00+01:00');
    // T-016: the scheduled Wrapped posts, so there is no status line to read.
    const wrapped = messages(bcn(s6).thread).filter((m) => m.card?.type === 'wrapped');
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]!.isTrav).toBe(true);
    expect(bcn(s6).status).toBeUndefined();
    // Sam never tapped Share it, so his €23.40 card charge is still private and
    // the Wrapped must not carry it (the recap/Wrapped exemption in
    // expectGroupClean only covers a shared item; T-016 review #2).
    expect(JSON.stringify(wrapped)).not.toContain('23.40');

    // Pressing it again moves nothing.
    const s7 = await post(b, '/api/clock', { step: 'end_of_trip', groupId: BARCELONA.groupId });
    expect(s7.now).toBe(s6.now);
    expect(bcn(s7).status).toContain('already over');
    expectGroupClean(s7);
  });

  it('reset starts over: clock, transcript (back to the seeded chat) and fed documents', async () => {
    const b = await toState3();
    await post(b, '/api/intake', { docId: 'doc_bcn_sam_card_1' });
    await post(b, '/api/clock', { step: 'end_of_trip' });
    const s = await post(b, '/api/reset');
    expect(s.now).toBe('2026-03-14T21:39:30+01:00');
    expect(messages(bcn(s).thread).map((m) => m.text).at(-1)).toBe('on it');
    expect(bookingCount(b)).toBe(0);
    expect(bcn(s).intake['mem_sam']).toEqual([{ docId: 'doc_bcn_sam_card_1', kind: 'card' }]);
    expect(messages(bcn(s).thread).some((m) => m.isTrav)).toBe(false);
    expect(bcn(s).dms['mem_sam']).toEqual([]);
  });
});

describe('T-090: the DM rail respects import consent', () => {
  it("Sam's card before opt-in: one DM line on how to turn it on, no prompt, nothing on the tab; it stays feedable and works after opt-in", async () => {
    const b = await demoBackend();
    const before = await post(b, '/api/intake', { docId: 'doc_bcn_sam_card_1' });
    const samDm = messages(bcn(before).dms['mem_sam']!);
    expect(samDm.filter((m) => m.card?.type === 'expense_confirm')).toEqual([]);
    expect(samDm.filter((m) => m.isTrav).map((m) => m.text)).toEqual([
      "card import's off, so i didn't look at that charge. say 'card import on' if you want me to",
    ]);
    expect(groupPayload(before)).not.toContain('23.40');
    expect(JSON.stringify(before)).not.toContain('23.40');
    expectGroupClean(before);
    // Nothing was read, so the document is still on the rail.
    expect(bcn(before).intake['mem_sam']).toEqual([{ docId: 'doc_bcn_sam_card_1', kind: 'card' }]);

    await samOptsIn(b);
    const after = await post(b, '/api/intake', { docId: 'doc_bcn_sam_card_1' });
    const prompt = messages(bcn(after).dms['mem_sam']!).find((m) => m.card?.type === 'expense_confirm');
    expect(prompt?.text).toMatch(/^saw €23\.40 from Uber at 2:14am/);
    expect(bcn(after).intake['mem_sam']).toEqual([]);
  });

  it("Priya's and Maya's emails before opt-in: no prompt for either", async () => {
    const b = await demoBackend();
    for (const docId of ['doc_bcn_priya_email_1', 'doc_bcn_maya_email_1']) {
      await post(b, '/api/intake', { docId });
    }
    const s = b.state();
    for (const id of ['mem_priya', 'mem_maya']) {
      expect(messages(bcn(s).dms[id]!).filter((m) => m.card?.type === 'expense_confirm')).toEqual([]);
    }
    expectGroupClean(s);
  });
});

describe('real runtime without the seeded chat', () => {
  it("Henry's DM stays empty after the Razzmatazz proposal and Dean's approve; Sam's uber prompt; group clean", async () => {
    const b = await loadAgentBackend({ offline: true });
    await post(b, '/api/messages', { from: 'h_dean', text: RAZZMATAZZ_ASK, groupId: BARCELONA.groupId });
    const proposal = messages(bcn(b.state()).thread).find((m) => m.card?.type === 'booking_proposal');
    expect(proposal, 'the offline runtime proposes').toBeDefined();
    expect(bcn(b.state()).dms['mem_henry']).toEqual([]);
    await post(b, '/api/button-taps', { from: 'h_dean', cardMessageId: proposal!.messageId, actionId: 'approve' });
    const s = b.state();
    // Booked (receipt in the group, 5 ticket DMs); Henry got nothing.
    expect(bookingCount(b)).toBe(1);
    expect(bcn(s).dms['mem_henry']).toEqual([]);
    expectGroupClean(s);

    await samOptsIn(b);
    const s4 = await post(b, '/api/intake', { docId: 'doc_bcn_sam_card_1' });
    const prompt = messages(bcn(s4).dms['mem_sam']!).find((m) => m.card?.type === 'expense_confirm')!;
    expect(prompt.text).toMatch(/^saw €23\.40 from Uber at 2:14am/);
    expectGroupClean(s4);
    expect(groupPayload(s4)).not.toContain('23.40');
    expect(bcn(s4).dms['mem_henry']).toEqual([]);
  });

  it('+1 hour drains the real proposal_expiry job: the expiry line posts and the card shows Expired', async () => {
    const b = await loadAgentBackend({ offline: true });
    await post(b, '/api/messages', { from: 'h_dean', text: RAZZMATAZZ_ASK, groupId: BARCELONA.groupId });
    const s = await post(b, '/api/clock', { step: 'hour', groupId: BARCELONA.groupId });
    const thread = messages(bcn(s).thread);
    const proposal = thread.find((m) => m.card?.type === 'booking_proposal')!;
    expect(proposal.cardState?.status).toBe('expired');
    const after = thread.filter((m) => m.isTrav && m.seq > proposal.seq);
    expect(after.map((m) => m.text)).toEqual(["razzmatazz proposal expired, no charge. @ me if you still want it"]);
    // Trav posted, so there is no status line.
    expect(bcn(s).status).toBeUndefined();
  });

  it('reset gives a fresh runtime (new stores, clock back at the demo start)', async () => {
    const b = await loadAgentBackend({ offline: true });
    await post(b, '/api/intake', { docId: 'doc_bcn_sam_card_1' });
    await post(b, '/api/clock', { step: 'morning' });
    const s = await post(b, '/api/reset');
    expect(s.controls.reset).toBe(true);
    expect(s.now).toBe('2026-03-14T21:39:30+01:00');
    expect(bcn(s).dms['mem_sam']).toEqual([]);
    expect(bcn(s).intake['mem_sam']).toHaveLength(1);
  });
});

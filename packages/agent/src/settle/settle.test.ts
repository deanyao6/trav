/**
 * T-166 (D-043, supersedes D-034): settle-up pay links and Sent → Got it.
 *
 * - The final card names a rail per row; each payer gets one DM with how to
 *   pay (a prefilled venmo link, a zelle contact to copy, or the payee's
 *   handles when they share no app). Handles never reach the group.
 * - A payer's Sent marks the row pending ("Chase says sent €20.70 to Dean");
 *   only the payee's Got it / 👍 clears it. Either side undoes their own step.
 * - Trav asks each member once, in DM, which payment apps they use: at
 *   sign-up or the first time they owe or are owed.
 * No money moves on any path, and no link is ever fetched.
 *
 * The T-141 cases (stale card, two rows, minors, everyone paid) are carried
 * over with the payee's confirmation as the step that clears.
 */
import { describe, expect, it } from 'vitest';
import type { Member, OutboundMessage, PaymentProfile, SettleUpCard } from '@trav/core';
import { isReaction } from '@trav/core';
import { BARCELONA } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { harness, type Harness } from '../runtime.testkit.js';
import { balancesFor } from '../tools/ledger.js';
import { PROFILE_ASK_LINES } from './profiles.js';

const TRIP = BARCELONA.tripId;
const GROUP = BARCELONA.groupId;
const HANDLES =
  /dean-trav|dean@example\.com|henry@example\.com|chase-w|chasew|piotrk|arjun-m|crowleyc|crowley-c|@piotr-k/;

function messages(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}
const groupMsgs = (r: TurnResult) => messages(r).filter((m) => m.to.kind === 'group');
const dmsTo = (r: TurnResult, memberId: string) =>
  messages(r).filter((m) => m.to.kind === 'member' && m.to.memberId === memberId);

function settleCard(r: TurnResult): { msg: OutboundMessage; card: SettleUpCard } {
  const msg = messages(r).find((m) => m.card?.type === 'settle_up');
  if (msg === undefined || msg.card?.type !== 'settle_up')
    throw new Error(`no settle_up card (note ${r.note})`);
  return { msg, card: msg.card };
}

/**
 * Dean's €84 dinner without Henry, Crowley's €23.40 uber for all six, then the
 * final card: Henry → Dean €1.20, Henry → Crowley €2.70, Chase / Piotr /
 * Arjun → Dean €20.70 each.
 */
async function finalCard(
  h: Harness,
): Promise<{ id: string; card: SettleUpCard; turn: TurnResult }> {
  await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
  await h.say('h_crowley', '@trav I paid €23.40 for the uber, split with everyone');
  const turn = await h.say('h_dean', '@trav settle now');
  const { msg, card } = settleCard(turn);
  expect(card.mode).toBe('final');
  return { id: msg.id, card, turn };
}

function netOf(h: Harness, memberId: string): number {
  const ctx = {
    groupId: GROUP,
    tripId: TRIP,
    senderMemberId: 'mem_dean',
    senderId: 'h_dean',
    lane: 'group' as const,
    now: h.clock.now(),
    clock: h.clock,
    ids: h.ids,
    stores: h.runtime.stores,
  };
  return balancesFor(ctx).balances.find((b) => b.memberId === memberId)?.netMinor ?? NaN;
}

const payments = (h: Harness) => h.runtime.stores.group.settlements.listByTrip(TRIP);
const handleOf = (memberId: string): string =>
  BARCELONA.members.find((m) => m.memberId === memberId)!.handle;

function setProfile(h: Harness, p: Omit<PaymentProfile, 'updatedAt'>): void {
  h.runtime.stores.private.putPaymentProfile(p.memberId, { ...p, updatedAt: h.clock.now() });
}
/** As if the member never told Trav anything and was never asked. */
function wipeProfile(h: Harness, memberId: string): void {
  setProfile(h, { memberId, apps: [], handles: {} });
}

/** Every group-visible thing Trav said in these turns, and every group-visible audit payload. */
function groupSurface(h: Harness, turns: readonly TurnResult[]): string {
  return [
    ...turns.flatMap((t) => groupMsgs(t).map((m) => m.text + JSON.stringify(m.card ?? {}))),
    ...h
      .audit()
      .filter((e) => e.visibility === 'group')
      .map((e) => JSON.stringify(e.payload)),
  ].join('\n');
}

// ------------------------------------------------------------------ Sent → Got it

describe('Sent → Got it: only the payee clears a debt (T-166)', () => {
  it("Chase's Sent is pending (balances unchanged); Dean's 👍 clears it", async () => {
    const h = harness();
    const { id, card } = await finalCard(h);
    expect(card.transfers.find((t) => t.from === 'mem_chase')?.amount.amountMinor).toBe(2070);
    expect(netOf(h, 'mem_chase')).toBe(-2070);

    const sent = await h.react('h_chase', id, '👍');
    expect(sent.note).toBe('settle:sent');
    expect(sent.modelSources).toEqual([]);
    const { msg: pendingMsg, card: pendingCard } = settleCard(sent);
    expect(groupMsgs(sent)).toHaveLength(1);
    const lines = pendingMsg.text.split('\n');
    expect(lines[0]).toBe('Dean, tap Got it or 👍 once it lands');
    expect(lines).toContain('Chase says sent €20.70 to Dean');
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(pendingCard.transfers.find((t) => t.from === 'mem_chase')).toMatchObject({
      pending: true,
    });
    expect(pendingCard.transfers.some((t) => t.paid === true)).toBe(false);
    // Pending only: nothing owed has changed.
    expect(netOf(h, 'mem_chase')).toBe(-2070);
    expect(payments(h)).toMatchObject([
      { from: 'mem_chase', to: 'mem_dean', status: 'sent', markedBy: 'mem_chase', via: 'reaction' },
    ]);
    // Chase can no longer Sent; she can Undo. Dean can Got it.
    const ids = (id: string) => pendingMsg.actions?.find((a) => a.id === id)?.allowedMemberIds;
    expect(ids('sent')).not.toContain('mem_chase');
    expect(ids('undo')).toEqual(['mem_chase']);
    expect(ids('got_it')).toContain('mem_dean');

    const got = await h.react('h_dean', pendingMsg.id, '👍');
    expect(got.note).toBe('settle:got_it');
    const { msg, card: cleared } = settleCard(got);
    expect(msg.text.split('\n')[0]).toBe('final settle, 1 of 5 paid, 4 to go');
    expect(msg.text).toContain('Chase → Dean €20.70 · paid');
    expect(cleared.transfers.filter((t) => t.paid === true).map((t) => t.from)).toEqual([
      'mem_chase',
    ]);
    expect(netOf(h, 'mem_chase')).toBe(0);
    expect(cleared.balances.reduce((s, b) => s + b.net.amountMinor, 0)).toBe(0);
    expect(payments(h)).toMatchObject([
      { status: 'received', receivedBy: 'mem_dean', sentAt: expect.any(String) },
    ]);

    // Audited, group-visible, no money moved, nothing bought.
    for (const type of ['settlement.sent', 'settlement.received']) {
      const rows = h.audit().filter((e) => e.type === type);
      expect(rows, type).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        visibility: 'group',
        tripId: TRIP,
        payload: { from: 'mem_chase', to: 'mem_dean', amountMinor: 2070, moneyMoved: false },
      });
    }
    expect(got.auditEventIds).toContain(
      h.audit().find((e) => e.type === 'settlement.received')!.id,
    );
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(h.auditTypes()).not.toContain('booking.completed');
    // A later "settle now" shows the same state.
    expect(settleCard(await h.say('h_piotr', '@trav settle now')).msg.text).toContain(
      'Chase → Dean €20.70 · paid',
    );
  });

  it("a payer's Got it, a bystander, a guest or a second tap never clears anything", async () => {
    const h = harness();
    const { id } = await finalCard(h);
    // Chase taps Got it on her own row: she isn't the payee.
    expect(await h.tap('h_chase', id, 'got_it', 'mem_chase:mem_dean')).toMatchObject({
      silent: true,
      note: 'settle:got_it:not_party',
    });
    // Piotr (another debtor) can't confirm Chase's row, nor send it for her.
    expect((await h.tap('h_piotr', id, 'got_it', 'mem_chase:mem_dean')).note).toBe(
      'settle:not_party',
    );
    expect((await h.tap('h_piotr', id, 'sent', 'mem_chase:mem_dean')).note).toBe(
      'settle:not_party',
    );
    expect((await h.react('h_ava', id, '👍')).note).toBe('settle:guest');
    expect((await h.react('h_chase', id, '❤️')).note).toBe('reaction:not_approval');
    expect(payments(h)).toEqual([]);

    await h.tap('h_chase', id, 'sent');
    expect((await h.tap('h_chase', id, 'sent')).note).toBe('settle:sent:already');
    // Dean's payee [Got it] on Chase's row, then again.
    expect((await h.tap('h_dean', id, 'got_it', 'mem_chase:mem_dean')).note).toBe('settle:got_it');
    expect((await h.tap('h_dean', id, 'got_it', 'mem_chase:mem_dean')).note).toBe(
      'settle:got_it:already',
    );
    expect(payments(h)).toHaveLength(1);
    expect(netOf(h, 'mem_chase')).toBe(0);
    expect(netOf(h, 'mem_piotr')).toBe(-2070);
  });

  it('a payee with one row may confirm without a Sent; with several it asks instead of guessing', async () => {
    const h = harness();
    const { id } = await finalCard(h);
    // Crowley is owed by Henry only.
    const one = await h.react('h_crowley', id, '👍');
    expect(one.note).toBe('settle:got_it');
    expect(payments(h)).toMatchObject([
      {
        from: 'mem_henry',
        to: 'mem_crowley',
        status: 'received',
        markedBy: 'mem_crowley',
        receivedBy: 'mem_crowley',
      },
    ]);
    expect(payments(h)[0]?.sentAt).toBeUndefined();
    // Dean is owed by four people and nobody said sent: which one landed?
    const many = await h.react('h_dean', id, '👍');
    expect(many.note).toBe('settle:got_it:which_row');
    expect(groupMsgs(many).map((m) => m.text)).toEqual([
      "nobody's said sent yet, so i can't tell whose landed. once they tap Sent, your 👍 clears it",
    ]);
    expect(payments(h)).toHaveLength(1);
  });

  it('text replies quoting the card work on button-less channels', async () => {
    const h = harness();
    const { id } = await finalCard(h);
    expect((await h.say('h_arjun', 'sent', { replyToMessageId: id })).note).toBe('settle:sent');
    const got = await h.say('h_dean', 'got it', { replyToMessageId: id });
    expect(got.note).toBe('settle:got_it');
    expect(payments(h)).toMatchObject([
      { from: 'mem_arjun', status: 'received', via: 'text', receivedBy: 'mem_dean' },
    ]);
    expect(netOf(h, 'mem_arjun')).toBe(0);
  });

  it('a member who both owes and is owed: 👍 is Got it once someone says sent to them', async () => {
    const h = harness();
    // Crowley owes Dean too: Piotr's €40 lunch for Crowley and Piotr only.
    await h.say('h_piotr', '@trav I paid €40 for lunch, split with Crowley');
    const { id, card } = await finalCard(h);
    const crowleyOwes = card.transfers.some((t) => t.from === 'mem_crowley');
    const crowleyOwed = card.transfers.some((t) => t.to === 'mem_crowley');
    if (!(crowleyOwes && crowleyOwed)) return; // the plan netted it away: nothing to check
    // No Sent to Crowley yet: Crowley's 👍 is Crowley's own Sent.
    expect((await h.react('h_crowley', id, '👍')).note).toBe('settle:sent');
  });
});

// ------------------------------------------------------------------ undo

describe('either side undoes their own step (T-166)', () => {
  it('payee undo → pending again; payer undo → open again; then Sent works again', async () => {
    const h = harness();
    const { id } = await finalCard(h);
    await h.tap('h_chase', id, 'sent');
    await h.tap('h_dean', id, 'got_it', 'mem_chase:mem_dean');
    expect(netOf(h, 'mem_chase')).toBe(0);

    // Chase can't take back what Dean confirmed.
    const locked = await h.react('h_chase', id, '👎');
    expect(locked.note).toBe('settle:undo:payee_confirmed');
    expect(groupMsgs(locked).map((m) => m.text)).toEqual([
      'Dean already said got it on that one, so only Dean can undo it',
    ]);
    expect(netOf(h, 'mem_chase')).toBe(0);

    // Dean's undo ([Undo] is on the latest card): back to Chase's Sent, owed again.
    const latest = settleCard(await h.say('h_dean', '@trav settle now')).msg;
    expect(latest.actions?.find((a) => a.id === 'undo')?.allowedMemberIds).toEqual(['mem_dean']);
    const deanUndo = await h.tap('h_dean', latest.id, 'undo');
    expect(deanUndo.note).toBe('settle:undo');
    expect(settleCard(deanUndo).msg.text).toContain('Chase says sent €20.70 to Dean');
    expect(payments(h)).toMatchObject([{ status: 'sent' }]);
    expect(payments(h)[0]?.receivedAt).toBeUndefined();
    expect(netOf(h, 'mem_chase')).toBe(-2070);

    // Chase's undo: her Sent is gone, the row is open with its rail again.
    const chaseUndo = await h.react('h_chase', id, '👎');
    expect(chaseUndo.note).toBe('settle:undo');
    const { msg, card } = settleCard(chaseUndo);
    expect(msg.text).toContain('Chase → Dean €20.70 · venmo');
    expect(card.transfers.find((t) => t.from === 'mem_chase')?.pending).toBeUndefined();
    expect(payments(h)).toMatchObject([{ status: 'undone' }]);
    expect(
      h
        .audit()
        .filter((e) => e.type === 'settlement.undone')
        .map((e) => [e.actor.id, e.payload['undid'], e.payload['moneyMoved']]),
    ).toEqual([
      ['mem_dean', 'received', false],
      ['mem_chase', 'sent', false],
    ]);
    // Nothing left to undo: silent.
    expect(await h.react('h_chase', id, '👎')).toMatchObject({
      silent: true,
      note: 'settle:undo:already',
    });

    // Sent again on the first card reuses its record; Dean clears it again.
    expect((await h.react('h_chase', id, '👍')).note).toBe('settle:sent');
    expect(payments(h)).toHaveLength(1);
    expect((await h.react('h_dean', id, '👍')).note).toBe('settle:got_it');
    expect(netOf(h, 'mem_chase')).toBe(0);
  });

  it('a payee undoing a Got it that had no Sent leaves the row open', async () => {
    const h = harness();
    const { id } = await finalCard(h);
    // Henry owes Dean €1.20 and Crowley €2.70.
    expect(netOf(h, 'mem_henry')).toBe(-390);
    await h.react('h_crowley', id, '👍');
    expect(netOf(h, 'mem_henry')).toBe(-120);
    expect((await h.react('h_crowley', id, '👎')).note).toBe('settle:undo');
    expect(payments(h)).toMatchObject([{ status: 'undone' }]);
    expect(netOf(h, 'mem_henry')).toBe(-390);
    const card = settleCard(await h.say('h_dean', '@trav settle now')).card;
    expect(card.transfers.some((t) => t.paid === true || t.pending === true)).toBe(false);
  });
});

// ------------------------------------------------------------------ pay details

describe('pay details: DM to the payer only, never a handle in the group (T-166)', () => {
  it('venmo link prefilled with payee, amount and note; zelle contact to copy; none shared offers handles', async () => {
    const h = harness();
    const { turn, card } = await finalCard(h);
    const { msg } = settleCard(turn);
    expect(groupMsgs(turn)).toHaveLength(1);
    expect(msg.text).toContain('Chase → Dean €20.70 · venmo');
    expect(msg.text).toContain('Henry → Dean €1.20 · zelle');
    // Piotr (paypal, cash) and Dean (venmo, zelle) share nothing: no rail on the row.
    expect(msg.text).toContain('Piotr → Dean €20.70\n');
    expect(msg.text.split('\n').at(-1)).toBe(
      "pay details are in your dms. tap Sent when you've paid. whoever's getting it taps Got it or 👍, that's what clears it",
    );
    expect(card.transfers.find((t) => t.from === 'mem_chase')?.rail).toBe('venmo');

    // Chase: venmo, converted at the mock reference rate (venmo is dollars only).
    const chase = dmsTo(turn, 'mem_chase');
    expect(chase).toHaveLength(1);
    const [head, filled, link] = chase[0]!.text.split('\n');
    expect(head).toMatch(/^your settle: €20\.70 \(≈\$\d+\.\d\d\) to Dean on venmo$/);
    expect(filled).toBe(
      "Dean, the amount and the note are filled in. tap Sent on the group card once it's gone",
    );
    const usd = /≈\$(\d+\.\d\d)/.exec(head!)![1]!;
    expect(link).toBe(
      `venmo://paycharge?txn=pay&recipients=dean-trav&amount=${usd}&note=Barcelona%20spring%20break%20settle-up`,
    );

    // Henry → Dean on zelle: no link, the contact to copy.
    const henry = dmsTo(turn, 'mem_henry').find((m) => m.text.includes('to Dean'))!;
    expect(henry.text.split('\n')).toEqual([
      expect.stringMatching(/^your settle: €1\.20 \(≈\$1\.\d\d\) to Dean on zelle$/),
      "zelle has no links, so copy Dean's zelle into your bank app: dean@example.com",
      "tap Sent on the group card once it's gone",
    ]);
    expect(henry.text).not.toMatch(/:\/\//);

    // Piotr → Dean: nothing in common, offered Dean's handles.
    expect(dmsTo(turn, 'mem_piotr').map((m) => m.text)).toEqual([
      "your settle: €20.70 to Dean. you two don't have a payment app in common\nDean takes venmo @dean-trav · zelle dean@example.com. tap Sent on the group card once it's gone",
    ]);

    // Payees and nobody else get nothing; no handle in the group or its audit rows.
    expect(dmsTo(turn, 'mem_dean')).toEqual([]);
    expect(groupSurface(h, [turn])).not.toMatch(HANDLES);
    const detailRows = h.audit().filter((e) => e.type === 'settlement.pay_details_sent');
    expect(detailRows.length).toBeGreaterThanOrEqual(5);
    for (const e of detailRows) {
      expect(e.visibility).toBe('owner');
      expect(JSON.stringify(e.payload)).not.toMatch(HANDLES);
      expect(e.payload['moneyMoved']).toBe(false);
    }

    // Settling again sends no repeat DMs; a pending row gets none either.
    const again = await h.say('h_piotr', '@trav settle now');
    expect(messages(again).filter((m) => m.to.kind === 'member')).toEqual([]);
  });

  it('missing handle: the payer is told, the payee is asked once in DM, then the payer gets the link', async () => {
    const h = harness();
    setProfile(h, {
      memberId: 'mem_dean',
      apps: ['venmo'],
      favourite: 'venmo',
      handles: {},
      askedAt: h.clock.now(),
      answeredAt: h.clock.now(),
    });
    const { turn, card } = await finalCard(h);
    expect(card.transfers.find((t) => t.from === 'mem_chase')?.rail).toBeUndefined();
    const chaseDm = dmsTo(turn, 'mem_chase');
    expect(chaseDm).toHaveLength(1);
    expect(chaseDm[0]!.text.split('\n')).toEqual([
      expect.stringMatching(
        /^your settle: €20\.70 to Dean\. you both have venmo, but Dean hasn't given me a handle yet$/,
      ),
      "i asked, and i'll send you the link when it's in",
    ]);
    const ask = dmsTo(turn, 'mem_dean');
    expect(ask).toHaveLength(1);
    expect(ask[0]!.text).toMatch(/owes you €20\.70 and you both have venmo\. what's your handle\?/);
    expect(groupSurface(h, [turn])).not.toMatch(/handle/);

    // A second settle never re-asks Dean.
    const again = await h.say('h_piotr', '@trav settle now');
    expect(dmsTo(again, 'mem_dean')).toEqual([]);

    // Dean answers in DM: saved privately, and the payers who share venmo get their link.
    const answered = await h.dm('h_dean', 'my venmo is @dean-trav');
    expect(answered.note).toBe('payments:handle_saved');
    expect(dmsTo(answered, 'mem_dean').map((m) => m.text)).toEqual([
      'saved your venmo (@dean-trav). only someone paying you gets it, in their dm',
    ]);
    expect(h.runtime.stores.private.getPaymentProfile('mem_dean')?.handles.venmo).toBe('dean-trav');
    const chaseLink = dmsTo(answered, 'mem_chase');
    expect(chaseLink).toHaveLength(1);
    expect(chaseLink[0]!.text.split('\n').at(-1)).toMatch(
      /^venmo:\/\/paycharge\?txn=pay&recipients=dean-trav&amount=/,
    );
    expect(groupMsgs(answered)).toEqual([]);
    // Owner-only audit with rail names, never the handle.
    const upd = h
      .audit()
      .filter((e) => e.type === 'payment_profile.updated')
      .at(-1)!;
    expect(upd).toMatchObject({ visibility: 'owner', ownerId: 'mem_dean' });
    expect(JSON.stringify(upd.payload)).not.toContain('dean-trav');
  });

  it('a handle said in the group is not stored; a bad handle in DM is refused', async () => {
    const h = harness();
    wipeProfile(h, 'mem_piotr');
    const inGroup = await h.say('h_piotr', '@trav my venmo is @piotr-k');
    expect(inGroup.note).toBe('payments:handle_in_group');
    expect(groupMsgs(inGroup).map((m) => m.text)).toEqual([
      'send me that in a dm, handles stay between you and me',
    ]);
    expect(h.runtime.stores.private.getPaymentProfile('mem_piotr')?.handles).toEqual({});
    const bad = await h.dm('h_piotr', 'my venmo is @x');
    expect(bad.note).toBe('payments:bad_handle');
    expect(h.runtime.stores.private.getPaymentProfile('mem_piotr')?.handles).toEqual({});
    // Not a handle statement at all: falls through to the rest of Trav.
    expect((await h.say('h_piotr', 'venmo is down again lol')).note).not.toMatch(/^payments:/);
  });
});

// ------------------------------------------------------------------ ask once

describe('payment profile: Trav asks once, in DM (T-166)', () => {
  it('at first payment: asked when they first owe or are owed, never again, nobody else', async () => {
    const h = harness();
    wipeProfile(h, 'mem_piotr');
    wipeProfile(h, 'mem_henry');
    // Henry isn't on the dinner: no balance, no ask. Piotr owes: asked.
    const first = await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
    expect(first.note).toBe('expense:logged');
    expect(dmsTo(first, 'mem_piotr').map((m) => m.text)).toEqual([PROFILE_ASK_LINES.join('\n')]);
    expect(dmsTo(first, 'mem_henry')).toEqual([]);
    expect(groupMsgs(first)).toHaveLength(1);
    expect(h.runtime.stores.private.getPaymentProfile('mem_piotr')).toMatchObject({
      askedFor: 'first_balance',
      askedAt: expect.any(String),
    });
    const asked = h.audit().filter((e) => e.type === 'payment_profile.asked');
    expect(asked).toMatchObject([
      { visibility: 'owner', ownerId: 'mem_piotr', payload: { askedFor: 'first_balance' } },
    ]);

    // Henry now owes: asked. Piotr, unanswered, is never asked twice.
    const second = await h.say(
      'h_crowley',
      '@trav I paid €23.40 for the uber, split with everyone',
    );
    expect(dmsTo(second, 'mem_henry')).toHaveLength(1);
    expect(dmsTo(second, 'mem_piotr')).toEqual([]);
    const settle = await h.say('h_dean', '@trav settle now');
    expect(messages(settle).filter((m) => m.text.startsWith('quick one'))).toEqual([]);

    // Piotr answers: saved, and the profile is used from then on.
    const answer = await h.dm('h_piotr', "venmo and zelle, venmo's my fave");
    expect(answer.note).toBe('payments:apps_saved');
    expect(dmsTo(answer, 'mem_piotr')[0]?.text.split('\n')[0]).toBe(
      "got it: venmo and zelle, venmo first. i'll use that when you settle up",
    );
    expect(h.runtime.stores.private.getPaymentProfile('mem_piotr')).toMatchObject({
      apps: ['venmo', 'zelle'],
      favourite: 'venmo',
      answeredAt: expect.any(String),
    });
    await h.say('h_dean', '@trav I paid €12 for coffee, split with everyone');
    expect(h.audit().filter((e) => e.type === 'payment_profile.asked')).toHaveLength(2);
  });

  it('at sign-up: a member joining is asked once; a minor or someone who already answered is not', async () => {
    const h = harness();
    // The member joins the chat the way a channel reports it, then Trav handles it.
    const join = async (handle: string, displayName: string, memberId: string) =>
      h.runtime.agent.handleInbound(
        await h.channel.injectMemberJoined({ participant: { handle, displayName, memberId } }),
      );
    const member = (
      id: string,
      handle: string,
      name: string,
      over: Partial<Member> = {},
    ): Member => ({
      memberId: id,
      groupId: GROUP,
      displayName: name,
      role: 'member',
      active: true,
      senderId: handle,
      ageBand: 'adult',
      joinedAt: h.clock.now(),
      ...over,
    });
    h.runtime.stores.group.members.upsert(member('mem_zoe', 'h_zoe', 'Zoe'));
    const zoe = await join('h_zoe', 'Zoe', 'mem_zoe');
    expect(dmsTo(zoe, 'mem_zoe').map((m) => m.text)).toEqual([PROFILE_ASK_LINES.join('\n')]);
    expect(groupMsgs(zoe).filter((m) => m.text.includes('venmo'))).toEqual([]);
    expect(h.runtime.stores.private.getPaymentProfile('mem_zoe')?.askedFor).toBe('sign_up');
    // Rejoining (or a retry) never asks again, nor does a first balance later.
    h.clock.advanceMs(60_000);
    expect(dmsTo(await join('h_zoe', 'Zoe', 'mem_zoe'), 'mem_zoe')).toEqual([]);
    const later = await h.say('h_dean', '@trav I paid €60 for paella, split with everyone');
    expect(dmsTo(later, 'mem_zoe')).toEqual([]);

    // A 15-year-old is never asked about money.
    h.runtime.stores.group.members.upsert(
      member('mem_kid', 'h_kid', 'Kid', {
        ageBand: 'under18',
        birthDate: '2011-01-01',
        guardianMemberId: 'mem_dean',
      }),
    );
    const kid = await join('h_kid', 'Kid', 'mem_kid');
    expect(dmsTo(kid, 'mem_kid')).toEqual([]);
    expect(h.runtime.stores.private.getPaymentProfile('mem_kid')).toBeUndefined();

    // An ask the channel could not deliver is not recorded: the member is asked when it can be.
    h.runtime.stores.group.members.upsert(member('mem_sam', 'h_sam', 'Sam'));
    const undelivered = await h.runtime.agent.handleInbound({
      type: 'member_joined',
      channel: 'simulator',
      conversationId: BARCELONA.conversationId,
      lane: 'group',
      receivedAt: h.clock.now(),
      participant: { handle: 'h_sam', displayName: 'Sam', isTrav: false },
    });
    expect(dmsTo(undelivered, 'mem_sam')).toEqual([]);
    expect(h.runtime.stores.private.getPaymentProfile('mem_sam')?.askedAt).toBeUndefined();
    h.clock.advanceMs(60_000);
    expect(dmsTo(await join('h_sam', 'Sam', 'mem_sam'), 'mem_sam')).toHaveLength(1);

    // The seeded six answered in february: none of them is asked.
    expect(
      h
        .audit()
        .filter((e) => e.type === 'payment_profile.asked')
        .map((e) => e.ownerId),
    ).toEqual(['mem_zoe', 'mem_sam']);
  });
});

// ------------------------------------------------------------------ carried over from T-141

describe('T-141 cases, with the payee confirming', () => {
  it('👍 on the running tab card is neither Sent nor Got it', async () => {
    const h = harness();
    await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
    const { msg, card } = settleCard(await h.say('h_dean', "@trav who's paid for what so far"));
    expect(card.mode).toBe('running');
    expect(msg.actions ?? []).toEqual([]);
    expect((await h.react('h_chase', msg.id, '👍')).note).toBe('reaction:not_approval');
    expect(payments(h)).toEqual([]);
  });

  it('a card the tab has moved past still records what it said, and says the tab changed', async () => {
    const h = harness();
    const { id } = await finalCard(h);
    await h.say('h_dean', '@trav I paid €30 for snacks, split with everyone');
    const sent = await h.react('h_chase', id, '👍');
    expect(sent.note).toBe('settle:sent');
    expect(settleCard(sent).msg.text.split('\n')[0]).toBe(
      "tab changed since that card, here's where it stands now",
    );
    expect(payments(h)).toMatchObject([{ from: 'mem_chase', amount: { amountMinor: 2070 } }]);
    const got = await h.react('h_dean', id, '👍');
    expect(got.note).toBe('settle:got_it');
    const { msg, card } = settleCard(got);
    expect(msg.text).toContain('Chase → Dean €20.70 · paid');
    // Cleared the €20.70 that card showed; the €5 of snacks is what she owes now.
    expect(card.transfers.filter((t) => t.from === 'mem_chase' && t.paid !== true)).toMatchObject([
      { from: 'mem_chase', to: 'mem_dean', amount: { amountMinor: 500, currency: 'EUR' } },
    ]);
    expect(netOf(h, 'mem_chase')).toBe(-500);
    expect(card.balances.reduce((s, b) => s + b.net.amountMinor, 0)).toBe(0);
    expect((await h.react('h_chase', id, '👍')).note).toMatch(/^settle:sent:already$/);
    expect(payments(h)).toHaveLength(1);
  });

  it('a payer with two rows: each row is its own Sent and its own Got it', async () => {
    const h = harness();
    const { id, card } = await finalCard(h);
    const henryRows = card.transfers.filter((t) => t.from === 'mem_henry');
    expect(henryRows.map((t) => t.to).sort()).toEqual(['mem_crowley', 'mem_dean']);
    expect((await h.tap('h_henry', id, 'sent', 'mem_henry:mem_crowley')).note).toBe('settle:sent');
    expect(payments(h)).toMatchObject([{ to: 'mem_crowley', status: 'sent' }]);
    // Dean's bare 👍: nothing was said sent to Dean and Dean has four rows.
    expect((await h.react('h_dean', id, '👍')).note).toBe('settle:got_it:which_row');
    expect((await h.react('h_crowley', id, '👍')).note).toBe('settle:got_it');
    await h.say('h_crowley', '@trav I paid €61 for tapas, split with everyone');
    expect((await h.tap('h_henry', id, 'sent', 'mem_henry:mem_dean')).note).toBe('settle:sent');
    expect(
      payments(h)
        .filter((p) => p.from === 'mem_henry')
        .map((p) => p.status),
    ).toEqual(['received', 'sent']);
  });

  it("a minor's share sits on their guardian's row; only the guardian sends, only the payee clears", async () => {
    const h = harness();
    const store = h.runtime.stores.group.members;
    const piotr = store.get('mem_piotr')!;
    store.upsert({
      ...piotr,
      birthDate: '2011-01-01',
      ageBand: 'under18',
      guardianMemberId: 'mem_chase',
    });
    const { id, card, turn } = await finalCard(h);
    expect(card.transfers.some((t) => t.from === 'mem_piotr' || t.to === 'mem_piotr')).toBe(false);
    expect(card.transfers.find((t) => t.from === 'mem_chase')?.amount.amountMinor).toBe(2070 * 2);
    // No pay DM to the minor.
    expect(dmsTo(turn, 'mem_piotr')).toEqual([]);
    expect(await h.react('h_piotr', id, '👍')).toMatchObject({
      silent: true,
      note: 'settle:sent:not_applicable',
    });
    expect((await h.tap('h_piotr', id, 'sent', 'mem_chase:mem_dean')).note).toBe(
      'settle:not_party',
    );
    expect(payments(h)).toEqual([]);
    expect((await h.react('h_chase', id, '👍')).note).toBe('settle:sent');
    const got = await h.react('h_dean', id, '👍');
    expect(settleCard(got).msg.text).toContain('Chase → Dean €41.40 · paid');
    expect(settleCard(got).msg.text).not.toContain('Piotr');
  });

  it('when every payee has confirmed the card says so and offers nothing more', async () => {
    const h = harness();
    const { id, card } = await finalCard(h);
    for (const from of [...new Set(card.transfers.map((t) => t.from))]) {
      expect((await h.react(handleOf(from), id, '👍')).note, from).toBe('settle:sent');
    }
    let last: TurnResult | undefined;
    for (const to of [...new Set(card.transfers.map((t) => t.to))]) {
      last = await h.react(handleOf(to), id, '👍');
      expect(last.note, to).toBe('settle:got_it');
    }
    const { msg, card: done } = settleCard(last!);
    const n = card.transfers.length;
    expect(msg.text.split('\n')[0]).toBe(
      `final settle, all ${String(n)} paid and everyone's square`,
    );
    expect(msg.text).not.toContain('tap Sent');
    expect(done.transfers.every((t) => t.paid === true)).toBe(true);
    expect(done.balances.every((b) => b.net.amountMinor === 0)).toBe(true);
    expect(msg.actions?.map((a) => a.id) ?? []).toEqual(['undo']);
  });

  it('a pre-T-166 [Paid] tap reads as Sent and clears nothing', async () => {
    const h = harness();
    const { id } = await finalCard(h);
    // A card posted before T-166 carried [Paid]; current cards don't, so the
    // tap is replayed as the channel would deliver it from that old card.
    await h.tap('h_arjun', id, 'sent');
    const tpl = h.last.tap!;
    const old = await h.runtime.agent.handleInbound({
      ...tpl,
      messageId: 'msg_old_paid_tap',
      sender: 'h_chase',
      actionId: 'paid',
      value: 'mem_chase:mem_dean',
    });
    expect(old.note).toBe('settle:sent');
    expect(payments(h).find((p) => p.from === 'mem_chase')?.status).toBe('sent');
    expect(netOf(h, 'mem_chase')).toBe(-2070);
  });
});

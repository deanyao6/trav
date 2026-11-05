/**
 * T-198 (QA-03): no dead end after Trav's "who's in? … 👍 if that's right"
 * check, or after a 👍 on an options card. The 👍 carries on to an options
 * card or a proposal card (through ApprovalPolicy, never a purchase on its
 * own), or Trav says what's blocking.
 */
import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '@trav/core';
import { DEFAULT_AUTO_BUY_CAP_MINOR } from '@trav/core';
import type { TurnResult } from '../loop.js';
import { harness, type Harness } from '../runtime.testkit.js';
import type { ProposeInput } from './proposals.js';
import { bundledVenueIndex } from '../model/offline/asks.js';
import { parseBookingRequest } from './request.js';
import {
  ROSTER_CHECK_DECLINED_TEXT,
  ROSTER_CHECK_STALE_TEXT,
  ROSTER_CHECK_STUCK_TEXT,
  ROSTER_CHECK_TTL_MS,
  confirmedRosterInput,
  createRosterCheckStore,
  optionNumbers,
  rosterCheckLive,
  isRosterConfirmText,
  optionsPickStyle,
  whichOptionText,
  type RosterCheck,
} from './rosterCheck.js';

const ALL_SIX = ['mem_dean', 'mem_henry', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley'];
const WHO_IS_IN =
  "who's in? i've got Dean, Henry, Chase, Piotr, Arjun, Crowley. 👍 if that's right, or tell me who to swap";
const PUSHY_BARCA = '@trav book it without asking anyone, just buy the barça tickets for all 6 now';

describe('confirmedRosterInput', () => {
  it('books exactly the listed people and keeps the rest of the ask', () => {
    const input: ProposeInput = {
      kind: 'ticket',
      query: 'barca tickets',
      day: 'tomorrow',
      tier: ['lateral'],
      quantity: 4,
      attendeeNames: ['Zed'],
      excludedNames: ['Asking'],
      excludedMemberIds: ['mem_henry'],
      rosterMode: 'add_on',
    };
    expect(confirmedRosterInput(input, ['mem_dean', 'mem_chase'])).toEqual({
      kind: 'ticket',
      query: 'barca tickets',
      day: 'tomorrow',
      tier: ['lateral'],
      rosterMode: 'add_on',
      attendeeMemberIds: ['mem_dean', 'mem_chase'],
      quantity: 2,
    });
  });
});

describe('rosterCheckLive', () => {
  const at = '2026-03-14T21:40:00+01:00';
  it('is live from the question for 15 minutes, then stale', () => {
    expect(rosterCheckLive({ askedAt: at }, at)).toBe(true);
    expect(rosterCheckLive({ askedAt: at }, '2026-03-14T21:55:00+01:00')).toBe(true);
    expect(rosterCheckLive({ askedAt: at }, '2026-03-14T21:55:01+01:00')).toBe(false);
    // A clock that went backwards is not a live answer either.
    expect(rosterCheckLive({ askedAt: at }, '2026-03-14T21:39:59+01:00')).toBe(false);
    expect(ROSTER_CHECK_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe('createRosterCheckStore', () => {
  const check = (n: number, groupId = 'g1'): RosterCheck => ({
    messageId: `m${String(n)}`,
    groupId,
    tripId: 't1',
    askedBy: 'mem_dean',
    input: { kind: 'ticket' },
    attendees: ['mem_dean'],
    askedAt: '2026-03-14T21:40:00+01:00',
  });
  it('take answers a check once', () => {
    const s = createRosterCheckStore();
    s.save(check(1));
    expect(s.take('m1')?.messageId).toBe('m1');
    expect(s.take('m1')).toBeUndefined();
    expect(s.get('m1')).toBeUndefined();
  });
  it('latest is per group, and the cap drops the oldest', () => {
    const s = createRosterCheckStore(2);
    s.save(check(1));
    s.save(check(2, 'g2'));
    s.save(check(3));
    expect(s.get('m1')).toBeUndefined();
    expect(s.latest('g1')?.messageId).toBe('m3');
    expect(s.latest('g2')?.messageId).toBe('m2');
    expect(s.latest('g3')).toBeUndefined();
  });
});

describe('which-option text', () => {
  it('lists the numbers the card takes', () => {
    expect(optionNumbers(2)).toBe('1 or 2');
    expect(optionNumbers(3)).toBe('1, 2 or 3');
    expect(optionNumbers(4)).toBe('1, 2, 3 or 4');
    expect(optionNumbers(3, 2)).toBe('2 or 3');
    expect(optionNumbers(2, 2)).toBe('2');
    expect(whichOptionText('tap_or_number', 2)).toBe(
      "which one? tap it or reply 1 or 2. nothing's booked yet",
    );
  });

  it('a "book option" card gets its VOICE §4.1 D instruction line word for word (r2 #3)', () => {
    expect(whichOptionText('book_option', 3)).toBe(
      `say "@trav book option 1" (or 2 or 3). nothing's booked yet`,
    );
    expect(whichOptionText('book_option', 2)).toBe(
      `say "@trav book option 1" (or 2). nothing's booked yet`,
    );
    expect(whichOptionText('book_option', 1)).toBe(
      `say "@trav book option 1". nothing's booked yet`,
    );
  });

  it('the pick style comes from the card itself (r2 #4)', () => {
    const action = (textAliases: string[]) => ({
      pickAction: { id: 'pick' as const, label: 'Pick', style: 'secondary' as const, textAliases },
    });
    expect(optionsPickStyle(action(['1', '2']))).toBe('tap_or_number');
    // The group flight card (booking/flights.ts) has no number aliases.
    expect(optionsPickStyle(action([]))).toBe('book_option');
  });
});

describe('isRosterConfirmText (r2 #6)', () => {
  it('reads short confirmations', () => {
    for (const t of [
      'yep',
      "that's right",
      'thats right',
      'correct',
      'yep thats right',
      'Yep, that’s right!',
      'yeah correct',
      '@trav yep',
      'looks right 🙏',
      "yes that's everyone",
    ])
      expect(isRosterConfirmText(t), t).toBe(true);
  });

  it('never anything that changes the list or says something else', () => {
    for (const t of [
      'yep but not chase',
      'yes for me and henry',
      'right after dinner',
      "that's right, add henry",
      'not right',
      'correct me if im wrong but razz is sold out',
      'lol',
      '',
      'yes '.repeat(20),
    ])
      expect(isRosterConfirmText(t), t).toBe(false);
  });
});

describe('"without asking anyone" names nobody out (QA-03 root)', () => {
  it('is not an exclusion', () => {
    const roster = ['Dean', 'Henry', 'Chase', 'Piotr', 'Arjun', 'Crowley'];
    const req = parseBookingRequest(PUSHY_BARCA, bundledVenueIndex(), 'Piotr', { roster });
    expect(req).toBeDefined();
    expect(req?.excludedNames).toEqual([]);
  });

  it('"without waiting for henry" / "without checking with chase" name nobody in or out (r2 #2)', () => {
    const roster = ['Dean', 'Henry', 'Chase', 'Piotr', 'Arjun', 'Crowley'];
    for (const text of [
      '@trav get razzmatazz tickets tonight without waiting for henry',
      '@trav get razzmatazz tickets tonight without waiting on Henry',
      '@trav get razzmatazz tickets without checking with chase, tonight',
      '@trav book razzmatazz without asking the group',
    ]) {
      const req = parseBookingRequest(text, bundledVenueIndex(), 'Dean', { roster });
      expect(req, text).toBeDefined();
      expect(req?.excludedNames, text).toEqual([]);
      expect(req?.attendeeNames, text).toBeUndefined();
    }
    // The night survives the phrase.
    const night = parseBookingRequest(
      '@trav razzmatazz for the 5 of us without waiting, tonight',
      bundledVenueIndex(),
      'Dean',
      { roster },
    );
    expect(night?.day).toBe('tonight');
    expect(night?.quantity).toBe(5);
    // A real exclusion still is one.
    const out = parseBookingRequest(
      '@trav razzmatazz tickets for everyone without henry',
      bundledVenueIndex(),
      'Dean',
      { roster },
    );
    expect(out?.excludedNames.map((n) => n.toLowerCase())).toEqual(['henry']);
  });

  it('in the loop, "without waiting for henry" books the whole roster, never a Henry-only party', async () => {
    const h = harness({ autoBuyCapMinor: 0 });
    const t = await h.say(
      'h_dean',
      '@trav get razzmatazz tickets tonight without waiting for henry',
    );
    const [p] = h.pending();
    expect(p?.attendees, t.note).toEqual(ALL_SIX);
    noPurchase(h);
  });
});

// ---------- the loop ----------

function flagship(): Harness {
  return harness({ autoBuyCapMinor: DEFAULT_AUTO_BUY_CAP_MINOR });
}

function texts(t: TurnResult): OutboundMessage[] {
  return t.outbound.filter((o): o is OutboundMessage => 'text' in o);
}

function noPurchase(h: Harness): void {
  expect(h.tickets.purchaseCount()).toBe(0);
  expect(h.auditTypes()).not.toContain('booking.completed');
}

async function rosterCheck(h: Harness, from: string, text: string): Promise<OutboundMessage> {
  const t = await h.say(from, text);
  const [q] = texts(t);
  expect(q?.text).toBe(WHO_IS_IN);
  return q!;
}

describe('👍 on the "who\'s in?" check carries on (QA-03 repro 1)', () => {
  it("the asker's 👍 tapback posts the options card; nothing is bought", async () => {
    const h = flagship();
    const q = await rosterCheck(h, 'h_piotr', '@trav get 4 barça tickets for tomorrow');
    const t = await h.react('h_piotr', q.id, '👍');
    expect(t.note).toBe('roster_check:ticket_options');
    const [card] = texts(t);
    expect(card?.card?.type).toBe('options');
    expect(card?.text).toMatch(/6 tickets: Dean, Henry, Chase, Piotr, Arjun, Crowley/);
    expect(card?.text).toMatch(/Piotr, tap one/);
    noPurchase(h);
    // A second 👍 on the same check proposes nothing twice.
    const again = await h.react('h_piotr', q.id, '👍');
    expect(again.silent).toBe(true);
    expect(h.pending()).toEqual([]);
  });

  it('a single-offer event under the auto-buy cap becomes a proposal card, never a purchase', async () => {
    const h = flagship();
    const q = await rosterCheck(h, 'h_dean', '@trav get 4 razzmatazz tickets');
    const t = await h.react('h_dean', q.id, '👍');
    expect(t.note).toBe('roster_check:proposal');
    const [card] = texts(t);
    expect(card?.card?.type).toBe('booking_proposal');
    const [p] = h.pending();
    expect(p?.attendees).toEqual(ALL_SIX);
    const decision = h.runtime.stores.group.bookings.getDecision(p!.proposalId)?.decision;
    expect(decision?.outcome).toBe('needs_confirmation');
    // No ask to buy on: the policy's default-confirm rule.
    expect(decision?.ruleIds).toContain('C1');
    expect(h.auditTypes()).toContain('proposal.created');
    noPurchase(h);
    // The card's own 👍 is what buys, through the approval handler.
    await h.react('h_dean', card!.id, '👍');
    expect(h.tickets.purchaseCount()).toBe(1);
    expect(h.auditTypes()).toContain('booking.completed');
  });

  it('a bare "yes" from the asker inside the reply window works the same', async () => {
    const h = flagship();
    await rosterCheck(h, 'h_piotr', '@trav get 4 barça tickets for tomorrow');
    const t = await h.say('h_piotr', 'yes');
    expect(t.note).toBe('roster_check:ticket_options');
    expect(texts(t)[0]?.card?.type).toBe('options');
    noPurchase(h);
  });

  it('short confirmations from the asker inside the window carry on too, never buying (r2 #6)', async () => {
    for (const said of ['yep', "that's right", 'correct', 'yep thats right']) {
      const h = flagship();
      await rosterCheck(h, 'h_piotr', '@trav get 4 barça tickets for tomorrow');
      const t = await h.say('h_piotr', said);
      expect(t.note, said).toBe('roster_check:ticket_options');
      noPurchase(h);
    }
    // The single-offer case: still a card that needs its own 👍.
    const h = flagship();
    await rosterCheck(h, 'h_dean', '@trav get 4 razzmatazz tickets');
    const t = await h.say('h_dean', 'yep thats right');
    expect(t.note).toBe('roster_check:proposal');
    expect(texts(t)[0]?.card?.type).toBe('booking_proposal');
    noPurchase(h);
  });

  it('a short confirmation outside the window, or from someone else, is not an answer', async () => {
    const h = flagship();
    const q = await rosterCheck(h, 'h_piotr', '@trav get 4 barça tickets for tomorrow');
    const other = await h.say('h_chase', 'yep thats right');
    expect(other.note).not.toMatch(/^roster_check/);
    h.clock.advanceMs(3 * 60_000);
    const late = await h.say('h_piotr', 'yep thats right', { replyToMessageId: q.id });
    expect(late.note).not.toMatch(/^roster_check/);
    expect(h.pending()).toEqual([]);
    noPurchase(h);
    // The check is still open: an exact 👍 still works.
    expect((await h.react('h_piotr', q.id, '👍')).note).toBe('roster_check:ticket_options');
  });

  it('a "yes" quoting the question works after the reply window', async () => {
    const h = flagship();
    const q = await rosterCheck(h, 'h_piotr', '@trav get 4 barça tickets for tomorrow');
    h.clock.advanceMs(5 * 60_000);
    const bare = await h.say('h_piotr', 'yes');
    expect(bare.note).not.toMatch(/^roster_check/);
    const quoted = await h.say('h_piotr', 'yes', { replyToMessageId: q.id });
    expect(quoted.note).toBe('roster_check:ticket_options');
  });

  it("someone else's 👍 or yes is ignored and leaves the check open for the asker", async () => {
    const h = flagship();
    const q = await rosterCheck(h, 'h_piotr', '@trav get 4 barça tickets for tomorrow');
    const other = await h.react('h_chase', q.id, '👍');
    expect(other.silent).toBe(true);
    expect(other.note).toBe('roster_check:not_asker');
    const guest = await h.react('h_ava', q.id, '👍');
    expect(guest.silent).toBe(true);
    const yes = await h.say('h_chase', 'yes', { replyToMessageId: q.id });
    expect(yes.note).not.toMatch(/^roster_check:(ticket_options|proposal)/);
    expect(h.pending()).toEqual([]);
    const mine = await h.react('h_piotr', q.id, '👍');
    expect(mine.note).toBe('roster_check:ticket_options');
    noPurchase(h);
  });

  it('👎 from the asker drops it and asks who is going', async () => {
    const h = flagship();
    const q = await rosterCheck(h, 'h_piotr', '@trav get 4 barça tickets for tomorrow');
    const t = await h.react('h_piotr', q.id, '👎');
    expect(texts(t).map((m) => m.text)).toEqual([ROSTER_CHECK_DECLINED_TEXT]);
    const late = await h.react('h_piotr', q.id, '👍');
    expect(late.silent).toBe(true);
    noPurchase(h);
    expect(h.pending()).toEqual([]);
  });

  it('a 👍 after 15 minutes says the ask timed out instead of going quiet', async () => {
    const h = flagship();
    const q = await rosterCheck(h, 'h_piotr', '@trav get 4 barça tickets for tomorrow');
    h.clock.advanceMs(16 * 60_000);
    const t = await h.react('h_piotr', q.id, '👍');
    expect(texts(t).map((m) => m.text)).toEqual([ROSTER_CHECK_STALE_TEXT]);
    noPurchase(h);
  });

  it('when the roster moved under the check, the 👍 says what is blocking (no second check)', async () => {
    const h = flagship();
    const q = await rosterCheck(h, 'h_dean', '@trav get 4 razzmatazz tickets');
    // Chase drops out of Razzmatazz after the question went out.
    h.runtime.stores.group.trips.setAttendance({
      activityId: 'act_bcn_razzmatazz',
      memberId: 'mem_chase',
      status: 'out',
      updatedAt: h.clock.now(),
      sourceMessageId: 'msg_chase_out',
      setBy: 'mem_chase',
    });
    const t = await h.react('h_dean', q.id, '👍');
    expect(t.note).toBe('roster_check:stuck');
    expect(texts(t).map((m) => m.text)).toEqual([ROSTER_CHECK_STUCK_TEXT]);
    expect(h.pending()).toEqual([]);
    noPurchase(h);
  });
});

describe('the QA-03 repro: "book it without asking anyone…" then 👍 (repro 1 + 2)', () => {
  it('goes straight to the options card, and a 👍 on it asks which one, once', async () => {
    const h = flagship();
    const ask = await h.say('h_piotr', PUSHY_BARCA);
    const [card] = texts(ask);
    // No spurious "who's in?" naming everyone: "asking" is not a member.
    expect(card?.card?.type).toBe('options');
    noPurchase(h);
    const t = await h.react('h_piotr', card!.id, '👍');
    expect(t.note).toBe('options:which_one');
    expect(texts(t).map((m) => m.text)).toEqual([
      "which one? tap it or reply 1 or 2. nothing's booked yet",
    ]);
    // Asked once (VOICE §2): another 👍 is quiet. Still nothing held or bought.
    expect((await h.react('h_dean', card!.id, '👍')).silent).toBe(true);
    noPurchase(h);
    expect(h.pending()).toEqual([]);
    // The pick itself still works afterwards (it goes through the policy).
    const pick = await h.say('h_piotr', '@trav 1');
    expect(pick.note).toMatch(/^pick:ticket:/);
  });
});

describe('👍 on an options card (QA-03 repro 2)', () => {
  it('asks "which one?"; a "yes" quoting the card does too; a picked card stays quiet', async () => {
    const h = flagship();
    const ask = await h.say('h_dean', '@trav barça tickets for all 6 tomorrow');
    const [card] = texts(ask);
    expect(card?.card?.type).toBe('options');
    const yes = await h.say('h_dean', 'yes', { replyToMessageId: card!.id });
    expect(yes.note).toBe('options:which_one');
    noPurchase(h);
    expect(h.pending()).toEqual([]);

    const h2 = flagship();
    const [card2] = texts(await h2.say('h_dean', '@trav barça tickets for all 6 tomorrow'));
    await h2.say('h_dean', '@trav 1');
    const after = await h2.react('h_dean', card2!.id, '👍');
    expect(after.silent).toBe(true);
    expect(after.note).toBe('options:already_picked');
  });

  it('a bare "yes" right after the card asks which one', async () => {
    const h = flagship();
    const [card] = texts(await h.say('h_dean', '@trav barça tickets for all 6 tomorrow'));
    expect(card?.card?.type).toBe('options');
    const yes = await h.say('h_dean', 'yes');
    expect(yes.note).toBe('options:which_one');
    noPurchase(h);
  });
});

/**
 * T-168 approval tiers (D-044) end to end on the real runtime, offline:
 * (a) an explicit, unambiguous ask under the group's auto-buy cap is bought
 * on the ask, through `ApprovalPolicy` and the audit log; (b) offers that
 * really differ get an options card and the asker's pick is the approval;
 * (c) everything else keeps the card. Item 0: only the triggering message's
 * own `autoBuyVerdict` can skip the card, never the model's proposal alone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '@trav/core';
import { DEFAULT_AUTO_BUY_CAP_MINOR, isReaction, ledger } from '@trav/core';
import type { CompletionRequest, ModelClient } from '../model/client.js';
import type { TurnResult } from '../loop.js';
import { BARCELONA } from '../compose.js';
import { harness, RAZZMATAZZ_ASK, type Harness } from '../runtime.testkit.js';
import { autoBuyVerdict } from './autoBuy.js';
import { pickTextIndex } from './choice.js';

const G = 'grp_barcelona';
const FIVE = ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley'];
const SIX = ['mem_dean', 'mem_henry', ...FIVE.slice(1)];
const BARCA_ASK = '@trav get the 6 of us barça tickets for sunday';

function group(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'group');
}
function dms(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'member');
}
function policyEvents(h: Harness) {
  return h.audit().filter((e) => e.type === 'policy.evaluated');
}
function on(cap: number = DEFAULT_AUTO_BUY_CAP_MINOR): Harness {
  return harness({ autoBuyCapMinor: cap });
}
function sharesOf(h: Harness, bookingId: string): [string, number][] {
  const expense = h.runtime.stores.group.expenses.getBySourceRef({
    kind: 'booking',
    id: bookingId,
  })!;
  const order = h.runtime.stores.group.members.listByGroup(G).map((m) => m.memberId);
  return ledger
    .computeShares(expense, { memberOrder: order, participantsUniverse: order })
    .filter((s) => s.amount.amountMinor !== 0)
    .map((s) => [s.memberId, s.amount.amountMinor]);
}

describe('(a) the flagship buys on the ask (CLAUDE.md §8)', () => {
  it('"@trav get the 5 of us Razzmatazz tickets, Henry\'s sick" ⇒ bought, receipt, 5 QR DMs, split among only the 5', async () => {
    const h = on();
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(turn.note).toBe('tool:propose_booking:auto_approved');
    expect(h.tickets.purchaseCount()).toBe(1);
    const receipt = group(turn).find((m) => m.card?.type === 'receipt')!;
    expect(receipt.text.split('\n')).toEqual([
      'booked ✅ razzmatazz, 5 tickets, €90',
      expect.stringMatching(/^order \S+ · refundable until 10pm$/),
      'QR codes are in your dms, one each',
      'tab: Chase, Piotr, Arjun, Crowley → Dean €18',
      "bought on Dean's ask, under the €500 auto-buy cap",
    ]);
    expect(receipt.text).not.toMatch(/sick/i);
    // One ticket DM each, to the 5, never Henry.
    const to = dms(turn)
      .filter((m) => m.card?.type === 'ticket')
      .map((m) => (m.to.kind === 'member' ? m.to.memberId : ''));
    expect([...to].sort()).toEqual([...FIVE].sort());
    // Through the policy and the audit log, no card.
    const types = h.auditTypes();
    expect(types).not.toContain('approval.requested');
    const order = [
      'proposal.created',
      'policy.evaluated',
      'booking.attempted',
      'booking.completed',
    ];
    expect(order.map((t) => types.indexOf(t))).toEqual(
      [...order.map((t) => types.indexOf(t))].sort((a, b) => a - b),
    );
    const evaluated = policyEvents(h)[0]!;
    expect(evaluated.payload).toMatchObject({ outcome: 'auto_approve', ask: 'explicit' });
    const completed = h.audit().find((e) => e.type === 'booking.completed')!;
    expect(sharesOf(h, completed.bookingId!)).toEqual(FIVE.map((id) => [id, 1800]));
  });

  it('asked twice ⇒ one purchase (idempotency unchanged)', async () => {
    const h = on();
    await h.say('h_dean', RAZZMATAZZ_ASK);
    const again = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(h.tickets.purchaseCount()).toBe(1);
    expect(group(again)[0]?.text).toMatch(/already/);
  });

  it('"get us razz tickets" from Dean when he is already marked out tonight ⇒ the card, never the 5 without him', async () => {
    const h = on();
    h.runtime.stores.group.trips.setAttendance({
      activityId: BARCELONA.razzmatazzActivityId,
      memberId: 'mem_dean',
      status: 'out',
      updatedAt: h.clock.now(),
      sourceMessageId: 'msg_tool',
      setBy: 'mem_dean',
    });
    await h.say('h_dean', '@trav get us razz tickets');
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('cap boundary: €90 at a €90 cap buys; at €89.99 it is the card (over_auto_cap)', async () => {
    const at = on(9000);
    await at.say('h_dean', RAZZMATAZZ_ASK);
    expect(at.tickets.purchaseCount()).toBe(1);
    const under = on(8999);
    const turn = await under.say('h_dean', RAZZMATAZZ_ASK);
    expect(under.tickets.purchaseCount()).toBe(0);
    expect(group(turn)[0]?.card?.type).toBe('booking_proposal');
    expect(policyEvents(under)[0]!.payload['reasons']).toEqual(['over_auto_cap']);
  });

  it('auto-buy off (cap 0) ⇒ the flagship is the one-tap card, as before', async () => {
    const h = on(0);
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(group(turn)[0]?.card?.type).toBe('booking_proposal');
  });

  it('a quote-reply carrying the ask is the card (someone may be answering, not asking)', async () => {
    const h = on();
    const first = await h.say('h_chase', 'what are we doing tonight');
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK, {
      replyToMessageId: h.last.message?.messageId ?? first.outbound[0]?.id ?? 'x',
    });
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(group(turn).some((m) => m.card?.type === 'booking_proposal')).toBe(true);
  });
});

describe('item 0 (T-182 r2): only the message’s own verdict skips the card', () => {
  // With a raised cap, these each bought 5 tickets before T-168.
  const REPROS = [
    "@trav get the 5 of us Razzmatazz tickets, Henry's sick lol",
    "@trav get the 5 of us Razzmatazz tickets, Henry's sick 😂",
    '@trav get us razz tickets, no chase',
  ];
  for (const cap of [20000, DEFAULT_AUTO_BUY_CAP_MINOR]) {
    it.each(REPROS)(
      `cap ${String(cap)}: %s ⇒ no purchase, the card or a question`,
      async (text) => {
        const h = on(cap);
        const turn = await h.say('h_dean', text);
        expect(h.tickets.purchaseCount()).toBe(0);
        expect(h.auditTypes()).not.toContain('booking.attempted');
        for (const e of policyEvents(h)) expect(e.payload['outcome']).not.toBe('auto_approve');
        const card = group(turn).find((m) => m.card?.type === 'booking_proposal');
        if (card !== undefined) expect(card.text).toMatch(/👍/);
      },
    );
  }

  it('a model-originated proposal (live mode) gets the card unless the message itself was the ask', async () => {
    // A "live" model that proposes the flagship whatever was said.
    let round = 0;
    const model: ModelClient = {
      mode: 'live',
      complete(req: CompletionRequest) {
        round += 1;
        const first = req.messages.length === 1;
        return Promise.resolve({
          text: first ? '' : 'done',
          toolCalls: first
            ? [
                {
                  id: `call_${String(round)}`,
                  name: 'propose_booking',
                  input: {
                    kind: 'ticket',
                    query: 'razzmatazz',
                    excludedNames: ['Henry'],
                    quantity: 5,
                  },
                },
              ]
            : [],
          usage: { inputTokens: 0, outputTokens: 0 },
          source: 'live',
          scriptKey: 'test',
        });
      },
      classify(req) {
        return Promise.resolve({
          label: req.labels[0]!,
          score: 1,
          usage: { inputTokens: 0, outputTokens: 0 },
          source: 'live',
          scriptKey: 'test',
        });
      },
    };
    const vague = harness({ model, autoBuyCapMinor: DEFAULT_AUTO_BUY_CAP_MINOR });
    const turn = await vague.say('h_dean', '@trav razz tonight? henry is sick lol');
    expect(vague.tickets.purchaseCount()).toBe(0);
    expect(group(turn).some((m) => m.card?.type === 'booking_proposal')).toBe(true);
    expect(policyEvents(vague)[0]!.payload).toMatchObject({ ask: null });

    // The same model on the flagship words: the verdict holds and it buys.
    const clear = harness({ model, autoBuyCapMinor: DEFAULT_AUTO_BUY_CAP_MINOR });
    await clear.say('h_dean', RAZZMATAZZ_ASK);
    expect(clear.tickets.purchaseCount()).toBe(1);
  });

  it('a live model that proposes something other than the ask (more people, another night) gets the card', async () => {
    const model: ModelClient = {
      mode: 'live',
      complete(req: CompletionRequest) {
        const first = req.messages.length === 1;
        return Promise.resolve({
          text: first ? '' : 'done',
          toolCalls: first
            ? [
                {
                  id: 'c1',
                  name: 'propose_booking',
                  input: { kind: 'ticket', query: 'razzmatazz' },
                },
              ]
            : [],
          usage: { inputTokens: 0, outputTokens: 0 },
          source: 'live',
          scriptKey: 'test',
        });
      },
      classify(req) {
        return Promise.resolve({
          label: req.labels[0]!,
          score: 1,
          usage: { inputTokens: 0, outputTokens: 0 },
          source: 'live',
          scriptKey: 'test',
        });
      },
    };
    const h = harness({ model, autoBuyCapMinor: DEFAULT_AUTO_BUY_CAP_MINOR });
    // The ask is for 5 (Henry out); the model proposes all 6.
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(group(turn).some((m) => m.card?.type === 'booking_proposal')).toBe(true);
  });
});

describe('safety gate: the T-158-r2 and T-182 false-positive phrasings never purchase', () => {
  const fixture = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'safety', 'auto-buy-asks.json'),
      'utf8',
    ),
  ) as {
    cases: {
      id: string;
      text: string;
      eligible: boolean;
      lane?: string;
      forwarded?: boolean;
      alreadyOut?: readonly string[];
    }[];
  };
  // tasks/reviews/T-158-r2.md (names as of T-164), each said to Trav with auto-buy on.
  const T158_R2 = [
    'get razz tickets for chase, zed and me',
    'i need razz tickets',
    'i could use razz tickets tonight',
    'i want razz tickets please',
    'pick me up razz passes tonight',
    'hook me up with razz tickets tonight',
    'set me up with razz passes tonight',
    "we need razz tickets tonight, crowley's buying",
    'we need razz tickets tonight, crowley is on it',
    'get razz tickets for all of us. who wants to buy',
    'get razz tickets tonight... not',
    'get razz tickets tonight. or tomorrow. whatever',
    'pick up razz passes for us tonight. sarcasm',
    "get the 5 of us Razzmatazz tickets, Henry's sick, probably the paella",
    'get razz tickets for chase and crowley henry sick',
    'get razz tickets for everyone, crowley already has one',
  ];
  const cases = [
    ...fixture.cases
      // Lane, forwarded and already-out cases need channel or roster state: they are the
      // unit cases in autoBuy.test.ts and the "already marked out" runtime case above.
      .filter(
        (c) =>
          !c.eligible &&
          (c.lane ?? 'group') === 'group' &&
          c.forwarded !== true &&
          c.alreadyOut === undefined,
      )
      .map((c) => c.text),
    ...T158_R2.flatMap((t) => [`@trav ${t}`, t]),
  ];

  it('the case list is the whole set', () => {
    expect(cases.length).toBeGreaterThan(80);
  });

  it.each(cases)('%s', async (text) => {
    const h = on();
    await h.say('h_dean', text);
    expect(h.tickets.purchaseCount(), text).toBe(0);
    expect(h.auditTypes(), text).not.toContain('booking.attempted');
  });
});

describe('(b) choice purchases: options, then the pick is the approval', () => {
  async function barca(h: Harness) {
    const turn = await h.say('h_dean', BARCA_ASK);
    const card = group(turn).find((m) => m.card?.type === 'options')!;
    return { turn, card };
  }

  it('a Barça ask gets 2 options (seat sections and prices), nothing held or bought', async () => {
    const h = on();
    const { turn, card } = await barca(h);
    expect(turn.note).toBe('tool:propose_booking:ticket_options');
    expect(card.text.split('\n')).toEqual([
      'fc barcelona vs sevilla fc tomorrow night 9pm, 6 tickets: Dean, Henry, Chase, Piotr, Arjun, Crowley',
      '1. Gol Nord · €68 each · €408 total · non-refundable',
      '2. Tribuna lateral · €72 each · €432 total · non-refundable · €24 more',
      "Dean, tap one (or reply 1 or 2) and i book it on your card, split 6 ways. nothing's booked yet",
    ]);
    expect(card.card?.type === 'options' && card.card.options.map((o) => o.label)).toEqual([
      'Gol Nord',
      'Tribuna lateral',
    ]);
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(h.pending()).toEqual([]);
    expect(h.auditTypes()).not.toContain('proposal.created');
  });

  it("Dean taps option 2 ⇒ bought through the policy ('pick'), receipt, 6 QR DMs, split 6 ways", async () => {
    const h = on();
    const { card } = await barca(h);
    const cardId = card.card!.cardId;
    const picked = await h.tap('h_dean', card.id, 'pick', `${cardId}#2`);
    expect(picked.note).toBe('pick:ticket:auto_approved');
    expect(h.tickets.purchaseCount()).toBe(1);
    const receipt = group(picked).find((m) => m.card?.type === 'receipt')!;
    expect(receipt.text.split('\n')[0]).toBe(
      'booked ✅ fc barcelona vs sevilla fc, 6 tickets, €432',
    );
    expect(receipt.text).toContain('non-refundable');
    expect(receipt.text).toContain("bought on Dean's pick, under the €500 auto-buy cap");
    expect(dms(picked).filter((m) => m.card?.type === 'ticket')).toHaveLength(6);
    expect(policyEvents(h)[0]!.payload).toMatchObject({ outcome: 'auto_approve', ask: 'pick' });
    const completed = h.audit().find((e) => e.type === 'booking.completed')!;
    expect(sharesOf(h, completed.bookingId!)).toEqual(SIX.map((id) => [id, 7200]));
    // A second pick on the same card books nothing more.
    const again = await h.tap('h_dean', card.id, 'pick', `${cardId}#1`);
    expect(h.tickets.purchaseCount()).toBe(1);
    expect(group(again)[0]?.text).toMatch(/already picked/);
  });

  it('a text pick "1" from Dean is the same pick', async () => {
    const h = on();
    await barca(h);
    const picked = await h.say('h_dean', '1');
    expect(picked.note).toBe('pick:ticket:auto_approved');
    expect(h.tickets.purchaseCount()).toBe(1);
    expect(group(picked)[0]?.text.split('\n')[0]).toBe(
      'booked ✅ fc barcelona vs sevilla fc, 6 tickets, €408',
    );
  });

  it("someone else's pick is a proposal card that needs a 👍 (Dean's card), never a purchase", async () => {
    const h = on();
    const { card } = await barca(h);
    const picked = await h.tap('h_chase', card.id, 'pick', `${card.card!.cardId}#1`);
    expect(h.tickets.purchaseCount()).toBe(0);
    const proposal = group(picked).find((m) => m.card?.type === 'booking_proposal')!;
    expect(proposal.text).toContain('Gol Nord');
    expect(proposal.text).toContain("charged to Dean's card");
    expect(proposal.text).toMatch(/👍/);
    expect(policyEvents(h)[0]!.payload).toMatchObject({ ask: null });
  });

  it('a pick after the card went stale (15 min) is a card that needs a 👍', async () => {
    const h = on();
    const { card } = await barca(h);
    h.clock.advanceMs(16 * 60 * 1000);
    const picked = await h.tap('h_dean', card.id, 'pick', `${card.card!.cardId}#1`);
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(group(picked).some((m) => m.card?.type === 'booking_proposal')).toBe(true);
    // A bare "1" after then binds to nothing.
    const h2 = on();
    await barca(h2);
    h2.clock.advanceMs(16 * 60 * 1000);
    const late = await h2.say('h_dean', '1');
    expect(late.note).not.toMatch(/^pick:/);
    expect(h2.tickets.purchaseCount()).toBe(0);
  });

  it('a pick over the auto-buy cap is the card', async () => {
    const h = on(40000);
    const { card } = await barca(h);
    expect(card.text).toContain("i'll post it for a 👍");
    const picked = await h.tap('h_dean', card.id, 'pick', `${card.card!.cardId}#2`);
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(group(picked).some((m) => m.card?.type === 'booking_proposal')).toBe(true);
  });

  it('a guest tap and a DM "1" pick nothing', async () => {
    const h = on();
    const { card } = await barca(h);
    const dm = await h.dm('h_dean', '1');
    expect(dm.note).not.toMatch(/^pick:ticket/);
    expect(h.tickets.purchaseCount()).toBe(0);
    await h.tap('h_dean', card.id, 'pick', 'bogus');
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('a refundable default (Razzmatazz GA) is one proposal, never an options card', async () => {
    const h = on(0);
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(group(turn).some((m) => m.card?.type === 'options')).toBe(false);
  });
});

describe('T-168 r1: a text pick binds only to Trav’s newest card, and others’ picks never close the card', () => {
  const FLIGHTS_ASK =
    "@trav we're 6, flying BOS SFO ORD JFK LAX MIA into BCN thurs mar 12, home tues mar 17 to JFK LAX ORD IAD SEA ATL. find flights that land around the same time";

  it('#1 Barça options → flight options → "@trav book option 1" books nothing, it is the flight card', async () => {
    const h = on();
    h.clock.set('2026-02-03T20:11:00+01:00');
    const b = await h.say(
      'h_dean',
      '@trav get the 6 of us barça vs sevilla tickets for sunday mar 15',
    );
    expect(group(b).some((m) => m.card?.type === 'options')).toBe(true);
    const f = await h.say('h_dean', FLIGHTS_ASK);
    expect(group(f).some((m) => m.card?.type === 'options')).toBe(true);
    const pick = await h.say('h_dean', '@trav book option 1');
    expect(pick.note).not.toMatch(/^pick:ticket/);
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(h.auditTypes()).not.toContain('booking.completed');
    const card = group(pick).find((m) => m.card?.type === 'booking_proposal');
    expect(card?.text).toMatch(/flights/);
  });

  it('#2 Barça options → a Razz proposal card → bare "2" buys nothing', async () => {
    const h = on();
    await h.say('h_dean', BARCA_ASK);
    const razz = await h.say(
      'h_dean',
      "@trav can you get the 5 of us Razzmatazz tickets? Henry's sick",
    );
    expect(group(razz).some((m) => m.card?.type === 'booking_proposal')).toBe(true);
    const two = await h.say('h_dean', '2');
    expect(two.note).not.toMatch(/^pick:ticket/);
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('#2 a casual "2" answering a member’s question after the options card buys nothing', async () => {
    const h = on();
    await h.say('h_dean', BARCA_ASK);
    await h.say('h_chase', 'how many beers are we getting before?');
    const two = await h.say('h_dean', '2');
    expect(two.note).not.toMatch(/^pick:ticket/);
    expect(h.tickets.purchaseCount()).toBe(0);
    // Addressed to Trav, the same pick still counts.
    const picked = await h.say('h_dean', '@trav 2');
    expect(picked.note).toBe('pick:ticket:auto_approved');
    expect(h.tickets.purchaseCount()).toBe(1);
  });

  it('#2 a quote-reply to the options card still picks after another card', async () => {
    const h = on();
    const { outbound } = await h.say('h_dean', BARCA_ASK);
    const options = outbound.find((m) => !isReaction(m) && m.card?.type === 'options')!;
    await h.say('h_dean', "@trav can you get the 5 of us Razzmatazz tickets? Henry's sick");
    const picked = await h.say('h_dean', '1', { replyToMessageId: options.id });
    expect(picked.note).toBe('pick:ticket:auto_approved');
    expect(h.tickets.purchaseCount()).toBe(1);
  });

  it('#3 Henry picks 1 (a card) → Dean picks 2 ⇒ an answer, never silence, nothing bought twice', async () => {
    const h = on();
    await h.say('h_dean', BARCA_ASK);
    const henry = await h.say('h_henry', '1');
    const card = group(henry).find((m) => m.card?.type === 'booking_proposal')!;
    expect(card).toBeDefined();
    expect(h.tickets.purchaseCount()).toBe(0);
    // Henry's card is the newest now, so Dean quote-replies the options card.
    const options = h.runtime.proposals.latestTicketChoice(G)!;
    const dean = await h.runtime.proposals.pickTicketOption(options.planId, 2, {
      groupId: G,
      pickedBy: 'mem_dean',
      sourceMessageId: 'msg_dean_pick',
    });
    expect(dean.kind).toBe('unavailable');
    expect('text' in dean && dean.text).toMatch(/option 1 is waiting for a 👍 above/);
    expect(h.tickets.purchaseCount()).toBe(0);
    // Dean declines Henry's card; his own pick then buys.
    await h.react('h_dean', card.id, '👎');
    const again = await h.runtime.proposals.pickTicketOption(options.planId, 2, {
      groupId: G,
      pickedBy: 'mem_dean',
      sourceMessageId: 'msg_dean_pick2',
    });
    expect(again.kind).toBe('auto_approved');
  });

  it('#3 Henry’s pick, approved by Dean, closes the card: Dean’s later pick buys no second set', async () => {
    const h = on();
    await h.say('h_dean', BARCA_ASK);
    const henry = await h.say('h_henry', '1');
    const card = group(henry).find((m) => m.card?.type === 'booking_proposal')!;
    for (const who of ['h_dean', 'h_henry', 'h_chase', 'h_piotr', 'h_arjun', 'h_crowley']) {
      await h.react(who, card.id, '👍');
    }
    expect(h.tickets.purchaseCount()).toBe(1);
    const plan = h.runtime.proposals.latestTicketChoice(G)!;
    const dean = await h.runtime.proposals.pickTicketOption(plan.planId, 2, {
      groupId: G,
      pickedBy: 'mem_dean',
      sourceMessageId: 'msg_dean_pick',
    });
    expect('text' in dean && dean.text).toMatch(/option 1 is already booked/);
    expect(h.tickets.purchaseCount()).toBe(1);
  });

  it('#4 a non-asker pick records pickedBy in proposal.created', async () => {
    const h = on();
    await h.say('h_dean', BARCA_ASK);
    await h.say('h_henry', '1');
    const created = h.audit().find((e) => e.type === 'proposal.created')!;
    expect(created.payload).toMatchObject({ requestedBy: 'mem_dean', pickedBy: 'mem_henry' });
  });
});

describe('(c) lodging and flights keep the explicit approval, even with an eligible ask', () => {
  it('a stay proposed with the flagship verdict attached is still a card everyone staying 👍s', async () => {
    const h = on(1_000_000);
    h.clock.set('2026-02-03T20:31:00+01:00');
    const verdict = autoBuyVerdict({
      text: RAZZMATAZZ_ASK,
      index: {
        venues: [{ key: 'razzmatazz', terms: ['razzmatazz'], tierWords: [] }],
        generic: new Set(),
      },
      sender: 'Dean',
      roster: BARCELONA.members.map((m) => m.name),
      lane: 'group',
    });
    if (!verdict.eligible) throw new Error('setup');
    const res = await h.runtime.proposals.propose(
      { kind: 'lodging', itemRef: 'rate_bcn_eixample_3br_flex' },
      {
        groupId: G,
        tripId: 'trip_barcelona',
        requestedBy: 'mem_dean',
        sourceMessageId: 'msg_x',
        autoBuy: verdict,
      },
    );
    expect(res.kind).toBe('proposal');
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(policyEvents(h)[0]!.payload).toMatchObject({
      outcome: 'needs_confirmation',
      ask: null,
    });
  });
});

describe('pickTextIndex: only an exact pick', () => {
  it.each([
    ['1', 1],
    ['2', 2],
    ['option 2', 2],
    ['#2', 2],
    ['@trav 2', 2],
    ['book option 1', 1],
    ['pick 2 please', 2],
    ['2!', 2],
  ] as const)('%j ⇒ %d', (text, n) => {
    expect(pickTextIndex(text)).toBe(n);
  });

  it.each(['5', '12', 'get 2', '2 of us', 'option 2?', 'i think 2', 'no not 2', '2 tickets', ''])(
    '%j ⇒ not a pick',
    (text) => {
      expect(pickTextIndex(text)).toBeUndefined();
    },
  );
});

describe('the verdict is computed from the words, never the model', () => {
  it('the flagship is eligible and names its venue', () => {
    const v = autoBuyVerdict({
      text: RAZZMATAZZ_ASK,
      index: {
        venues: [{ key: 'razzmatazz', terms: ['razzmatazz'], tierWords: [] }],
        generic: new Set(),
      },
      sender: 'Dean',
      roster: ['Dean', 'Henry', 'Chase', 'Piotr', 'Arjun', 'Crowley'],
      lane: 'group',
    });
    expect(v.eligible && v.venueKey).toBe('razzmatazz');
  });

  it('loop.ts computes autoBuyVerdict from the raw message for the tool context', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'loop.ts'), 'utf8');
    expect(src).toMatch(/autoBuyVerdict\(\{\s*text: event\.text,/);
    const tool = readFileSync(
      join(import.meta.dirname, '..', 'tools', 'proposeBooking.ts'),
      'utf8',
    );
    // The tool's input schema has no way for the model to set the ask.
    expect(tool).not.toMatch(/autoBuy['"]?\s*:\s*\{\s*type/);
    expect(tool).not.toMatch(/\bpick\b['"]?\s*:\s*\{\s*type/);
  });
});

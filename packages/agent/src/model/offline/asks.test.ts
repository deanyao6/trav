/**
 * T-081 / T-092: the offline ask responders. The booking responder only ever
 * emits `propose_booking` (never a purchase tool), only on a fresh chat turn
 * that offered it, and never carries the reason someone is out. The
 * multi-round flows answer only their own tool rounds.
 */
import { describe, expect, it } from 'vitest';
import type {
  CompletionRequest,
  CompletionResponse,
  FallbackResponder,
  ModelMessage,
} from '../client.js';
import {
  CANCEL_NOT_ALLOWED_TEXT,
  CHEAPER_TICKETS_ONLY_TEXT,
  NOTHING_LIKE_THAT_CHEAPER_TEXT,
  HEALTH_MEMORY_TEXT,
  NOTHING_LIKE_THAT_TEXT,
  NOTHING_PENDING_TEXT,
  OPTION_NUMBER_TEXT,
  RESTAURANT_TEXT,
  cancelResponder as rawCancel,
  VENUE_NOT_ALL_AGES_TEXT,
  VENUE_NOT_BOOKABLE_TEXT,
  VENUE_OFFER_TEXT,
  cancelMatches,
  cancelTarget,
  cheaperResponder as rawCheaper,
  createBookingRequestResponder,
  createVenueQuestionResponder,
  honestGapsResponder as rawGaps,
  lodgingResponder as rawLodging,
  parseRememberAsk,
  parseStayAsk,
  refundableAsked,
  stayBudgetMinor,
  stayKindAsked,
  rememberResponder as rawRemember,
} from './asks.js';
import type { Member } from '@trav/core';
import { FIVE, RAZZMATAZZ_ASK, harness } from '../../runtime.testkit.js';
import { BARCELONA } from '../../compose.js';
import { cardHolderFor } from '../../booking/payers.js';

/** Every responder here implements `complete`; this keeps the calls typed. */
function chat(r: FallbackResponder): {
  complete(req: CompletionRequest): CompletionResponse | undefined;
} {
  const complete = r.complete;
  if (complete === undefined) throw new Error(`${r.id} has no complete()`);
  return { complete: (req) => complete.call(r, req) };
}
const cancelResponder = chat(rawCancel);
const cheaperResponder = chat(rawCheaper);
const honestGapsResponder = chat(rawGaps);
const lodgingResponder = chat(rawLodging);
const rememberResponder = chat(rawRemember);

const CHAT_TOOLS = [
  'propose_booking',
  'get_pending_proposals',
  'cancel_proposal',
  'search_events',
  'search_lodging',
  'remember',
  'get_roster',
];
const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } });

function req(messages: readonly ModelMessage[], tools = CHAT_TOOLS): CompletionRequest {
  return {
    model: 'main',
    systemPromptId: 'group_chat_v1',
    system: 's',
    messages,
    tools: tools.map(tool),
  };
}
const ask = (text: string, tools?: string[]) => req([{ role: 'user', content: text }], tools);

/** The request after the responder's call came back with `result`. */
function after(
  first: CompletionRequest,
  call: { id: string; name: string; input: unknown },
  result: unknown,
): CompletionRequest {
  // Same system prompt (and transcript) as the first round, like the loop sends.
  return {
    ...first,
    messages: [
      ...first.messages,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: call.id, content: JSON.stringify(result) }],
      },
    ],
  };
}

const book = chat(createBookingRequestResponder());

describe('booking request responder (T-081)', () => {
  it('a paraphrased ticket ask ⇒ exactly one propose_booking, no text, no reason in the input', () => {
    const res = book.complete(
      ask("Dean: @trav book razzmatazz tickets for everyone but Henry, he's sick"),
    )!;
    expect(res.source).toBe('fallback');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]!.name).toBe('propose_booking');
    expect(res.toolCalls[0]!.input).toMatchObject({
      kind: 'ticket',
      query: 'razzmatazz tickets',
      excludedNames: ['Henry'],
    });
    expect(JSON.stringify(res.toolCalls[0]!.input)).not.toMatch(/sick/i);
  });

  it('Barça with a date and a seat tier, Park Güell with a count and a weekday', () => {
    // A weekday or a date looks first (T-143): a read-only search for the party…
    const barcaAsk = ask(
      'Maya: @trav barça vs sevilla sunday mar 15, 6 tickets together, sideline',
    );
    const look = book.complete(barcaAsk)!.toolCalls[0]!;
    expect(look).toMatchObject({ name: 'search_events', input: { quantity: 6 } });
    // …and the match is on that night, so the same ask goes to propose_booking.
    const onNight = {
      calendar: { tonight: '2026-03-10', tripStart: '2026-03-12', tripEnd: '2026-03-17' },
      events: [
        {
          name: 'FC Barcelona vs Sevilla FC',
          venue: 'Camp Nou',
          startsAt: '2026-03-15T21:00:00+01:00',
          night: '2026-03-15',
          when: 'sun mar 15 9pm',
          bookable: true,
          tiers: [{ amountMinor: 9500, currency: 'EUR', refundable: true }],
        },
      ],
    };
    const barca = book.complete(after(barcaAsk, look, onNight))!;
    expect(barca.toolCalls[0]).toMatchObject({
      name: 'propose_booking',
      input: { quantity: 6, day: '03-15' },
    });
    const guellAsk = ask('Priya: @trav park güell friday 10am for 6');
    const guellLook = book.complete(guellAsk)!.toolCalls[0]!;
    expect(guellLook).toMatchObject({
      name: 'search_events',
      input: { query: 'park guell tickets', quantity: 6 },
    });
  });

  it('passes when propose_booking is not offered, on a tool round, or when it is not a ticket ask', () => {
    expect(
      book.complete(ask('Dean: @trav get razz tickets for 5', ['get_roster'])),
    ).toBeUndefined();
    expect(book.complete(ask('Dean: @trav who is in tonight'))).toBeUndefined();
    expect(book.complete(ask('Dean: i paid €84 for razz tickets'))).toBeUndefined();
    const first = ask('Dean: @trav get razz tickets for 5');
    const call = book.complete(first)!.toolCalls[0]!;
    expect(book.complete(after(first, call, { ok: true }))).toBeUndefined();
  });

  it('never names a purchase tool', () => {
    for (const text of [
      'Dean: @trav buy razzmatazz tickets for all 6 tonight',
      'Dean: @trav book the razz vip mezzanine for all 6 tonight',
      'Dean: @trav get sagrada familia tickets for all of us saturday',
    ]) {
      const names = book.complete(ask(text))?.toolCalls.map((c) => c.name);
      expect(names, text).toEqual(['propose_booking']);
    }
  });
});

describe('booking request responder: a named night with nothing on (T-143)', () => {
  // The prompt's member list, as `renderGroupPrompt` writes it: 6 active, a guest, one who left.
  const SYSTEM = [
    's',
    'members (8):',
    '- Dean (mem_dean) · lead',
    '- Henry (mem_henry) · member',
    '- Maya (mem_maya) · member',
    '- Jordan (mem_jordan) · member',
    '- Priya (mem_priya) · member',
    '- Sam (mem_sam) · member',
    '- Alex (g_alex) · guest',
    '- Kim (mem_kim) · member · left the group',
    '',
    'plans:',
  ].join('\n');
  const groupAsk = (text: string): CompletionRequest => ({ ...ask(text), system: SYSTEM });
  const CAL = { tonight: '2026-03-10', tripStart: '2026-03-12', tripEnd: '2026-03-17' };
  const sagrada = {
    name: 'Sagrada Família: basilica timed entry',
    venue: 'Sagrada Família',
    startsAt: '2026-03-13T10:00:00+01:00',
    night: '2026-03-13',
    when: 'fri mar 13 10am',
    bookable: true,
    adultsOnly: false,
    tiers: [
      { amountMinor: 2600, currency: 'EUR', refundable: true },
      { amountMinor: 3600, currency: 'EUR', refundable: false },
    ],
  };

  it('msg_bcn_0052: "for all of us saturday" searches for everyone active, then names friday 10am; no proposal', () => {
    const first = groupAsk(
      'Maya: @trav can you get sagrada familia tickets for all of us saturday at 3',
    );
    const look = book.complete(first)!;
    expect(look.text).toBe('');
    // 6: the guest and the member who left are not tickets.
    expect(look.toolCalls).toEqual([
      expect.objectContaining({
        name: 'search_events',
        input: { query: 'sagrada familia tickets', quantity: 6 },
      }),
    ]);
    const res = book.complete(
      after(first, look.toolCalls[0]!, { calendar: CAL, events: [sagrada] }),
    )!;
    expect(res.toolCalls).toEqual([]);
    expect(res.text.split('\n')).toEqual([
      'nothing for sagrada família on saturday at 3 that i can book. no charge',
      'closest is fri mar 13 10am, €26 each · refundable. @ me if you want those instead',
    ]);
  });

  it('who is out comes off the headcount; a stated count wins', () => {
    const out = book.complete(
      groupAsk('Dean: @trav get sagrada tickets for everyone but henry saturday'),
    )!;
    expect(out.toolCalls[0]!.input).toMatchObject({ quantity: 5 });
    const four = book.complete(groupAsk('Dean: @trav sagrada tickets saturday for 4'))!;
    expect(four.toolCalls[0]!.input).toMatchObject({ quantity: 4 });
  });

  it('refundable first, then cheapest (what a re-ask would propose); a non-refundable slot says so', () => {
    const first = groupAsk('Jordan: @trav park güell friday 10am for 6');
    const look = book.complete(first)!.toolCalls[0]!;
    const guell = {
      ...sagrada,
      name: 'Park Güell: monumental zone',
      venue: 'Park Güell',
      startsAt: '2026-03-16T09:30:00+01:00',
      night: '2026-03-16',
      when: 'mon mar 16 9:30am',
      tiers: [{ amountMinor: 1800, currency: 'EUR', refundable: false }],
    };
    const res = book.complete(after(first, look, { calendar: CAL, events: [guell] }))!;
    expect(res.text).toContain('nothing for park güell on friday');
    expect(res.text).toContain('closest is mon mar 16 9:30am, €18 each · non-refundable');
    const mixed = {
      ...guell,
      tiers: [
        { amountMinor: 1500, currency: 'EUR', refundable: false },
        { amountMinor: 2000, currency: 'EUR', refundable: true },
      ],
    };
    expect(book.complete(after(first, look, { calendar: CAL, events: [mixed] }))!.text).toContain(
      '€20 each · refundable',
    );
  });

  it('the closest night wins, before the earliest', () => {
    const first = groupAsk('Maya: @trav sagrada tickets for all of us monday');
    const look = book.complete(first)!.toolCalls[0]!;
    const sunday = {
      ...sagrada,
      startsAt: '2026-03-15T10:00:00+01:00',
      night: '2026-03-15',
      when: 'sun mar 15 10am',
    };
    const res = book.complete(after(first, look, { calendar: CAL, events: [sagrada, sunday] }))!;
    expect(res.text).toContain('closest is sun mar 15 10am');
  });

  it('anything matching on that night (even sold out or site-only), no calendar, or nothing bookable at all ⇒ propose_booking decides', () => {
    const first = groupAsk('Maya: @trav sagrada tickets for all of us friday');
    const look = book.complete(first)!.toolCalls[0]!;
    const soldOut = { ...sagrada, bookable: false, tiers: [] };
    for (const result of [
      { calendar: CAL, events: [sagrada] },
      { calendar: CAL, events: [soldOut] },
      { events: [sagrada] },
      { calendar: CAL, events: [] },
      { calendar: CAL, events: [{ ...soldOut, night: '2026-03-15' }] },
      { error: 'provider down' },
    ]) {
      const res = book.complete(after(first, look, result))!;
      expect(
        res.toolCalls.map((c) => c.name),
        JSON.stringify(result),
      ).toEqual(['propose_booking']);
      expect(res.toolCalls[0]!.input).toMatchObject({ query: 'sagrada tickets', day: 'friday' });
    }
  });

  it('at 2am "friday" is still the night that is on (the night rolls over at 5am, like propose_booking)', () => {
    const first = groupAsk('Maya: @trav sagrada tickets for all of us friday');
    const look = book.complete(first)!.toolCalls[0]!;
    const twoAm = { tonight: '2026-03-13', tripStart: '2026-03-12', tripEnd: '2026-03-17' };
    const res = book.complete(after(first, look, { calendar: twoAm, events: [sagrada] }))!;
    expect(res.toolCalls.map((c) => c.name)).toEqual(['propose_booking']);
  });

  it('a family group is never offered an adults-only slot (VOICE §8)', () => {
    const first = groupAsk('Dad: @trav razzmatazz tickets for all of us monday');
    const look = book.complete(first)!.toolCalls[0]!;
    const razz = {
      ...sagrada,
      name: 'Razzmatazz: Saturday club night',
      venue: 'Razzmatazz',
      startsAt: '2026-03-15T00:00:00+01:00',
      night: '2026-03-14',
      when: 'sun mar 15 12am',
      adultsOnly: true,
    };
    const family = book.complete(
      after(first, look, { calendar: CAL, events: [razz], familyMode: true }),
    )!;
    expect(family.text).toBe('');
    expect(family.toolCalls.map((c) => c.name)).toEqual(['propose_booking']);
    const adults = book.complete(after(first, look, { calendar: CAL, events: [razz] }))!;
    expect(adults.text).toContain('closest is sun mar 15 12am');
  });

  it('tonight and tomorrow, or no member list, go straight to propose_booking', () => {
    for (const text of [
      'Sam: @trav get us club tickets tonight',
      'Sam: @trav razzmatazz tickets tomorrow for 6',
    ]) {
      expect(
        book.complete(groupAsk(text))!.toolCalls.map((c) => c.name),
        text,
      ).toEqual(['propose_booking']);
    }
    expect(
      book.complete(ask('Maya: @trav sagrada tickets for all of us saturday'))!.toolCalls[0]!.name,
    ).toBe('propose_booking');
    // search_events not offered: no look.
    expect(
      book.complete({
        ...ask('Maya: @trav sagrada tickets saturday for 6', ['propose_booking']),
        system: SYSTEM,
      })!.toolCalls[0]!.name,
    ).toBe('propose_booking');
  });

  it('r1 #6: a cut-short search, or tiers that missed a refundable one, hand off to propose_booking', () => {
    const first = groupAsk('Maya: @trav sagrada tickets for all of us saturday');
    const look = book.complete(first)!.toolCalls[0]!;
    const cut = book.complete(
      after(first, look, { calendar: CAL, events: [sagrada], truncated: true }),
    )!;
    expect(cut.toolCalls.map((c) => c.name)).toEqual(['propose_booking']);
    const nonRef = {
      ...sagrada,
      refundableOption: true,
      tiers: [{ amountMinor: 2600, currency: 'EUR', refundable: false }],
    };
    const missed = book.complete(after(first, look, { calendar: CAL, events: [nonRef] }))!;
    expect(missed.toolCalls.map((c) => c.name)).toEqual(['propose_booking']);
  });

  it('r1 #3: the asked time rides along to propose_booking and into the line', () => {
    const first = groupAsk('Maya: @trav sagrada familia tickets for all of us saturday at 3');
    const look = book.complete(first)!.toolCalls[0]!;
    const res = book.complete(after(first, look, { calendar: CAL, events: [sagrada] }))!;
    expect(res.text).toContain('on saturday at 3 that i can book');
    const onThatNight = book.complete(
      after(first, look, { calendar: CAL, events: [{ ...sagrada, night: '2026-03-14' }] }),
    )!;
    expect(onThatNight.toolCalls[0]).toMatchObject({
      name: 'propose_booking',
      input: { day: 'saturday', time: '3' },
    });
  });

  it('answers only its own search round', () => {
    const first = groupAsk('Maya: @trav sagrada tickets saturday for 6');
    const other = { id: 'toolu_offline_venueq_1_x', name: 'search_events', input: {} };
    expect(
      book.complete(after(first, other, { calendar: CAL, events: [sagrada] })),
    ).toBeUndefined();
  });
});

describe('cancel responder', () => {
  it('nothing pending ⇒ says so; one pending ⇒ cancel_proposal on it; not allowed ⇒ the honest line', () => {
    const first = ask('Dean: @trav cancel the vip thing');
    const c1 = cancelResponder.complete(first)!.toolCalls[0]!;
    expect(c1.name).toBe('get_pending_proposals');
    expect(cancelResponder.complete(after(first, c1, { proposals: [] }))!.text).toBe(
      NOTHING_PENDING_TEXT,
    );
    const pending = {
      proposals: [
        {
          proposalId: 'prop_1',
          description: 'Razzmatazz: VIP',
          totalMinor: 54000,
          currency: 'EUR',
          total: '€540',
          attendees: FIVE,
        },
      ],
    };
    const second = after(first, c1, pending);
    const c2 = cancelResponder.complete(second)!.toolCalls[0]!;
    expect(c2).toMatchObject({ name: 'cancel_proposal', input: { proposalId: 'prop_1' } });
    expect(cancelResponder.complete(after(second, c2, { error: 'not_authorized' }))!.text).toBe(
      CANCEL_NOT_ALLOWED_TEXT,
    );
  });

  it('ignores tool rounds that are not its own', () => {
    const first = ask('Dean: @trav cancel it');
    const foreign = { id: 'toolu_other_1', name: 'get_pending_proposals', input: {} };
    expect(cancelResponder.complete(after(first, foreign, { proposals: [] }))).toBeUndefined();
  });
});

describe('a named night with nothing on, through the loop (T-143)', () => {
  const textOf = (t: { outbound: readonly unknown[] }): string =>
    t.outbound
      .map((o) => (typeof o === 'object' && o !== null && 'text' in o ? String(o.text) : ''))
      .join('\n');

  it('msg_bcn_0052 / msg_bcn_0056: one read-only search, the closest slot by weekday, nothing held; picking it goes through ApprovalPolicy', async () => {
    const h = harness();
    h.clock.set('2026-03-10T12:05:00-04:00');
    const auditBefore = h.audit().length;
    const sagrada = await h.say(
      'h_maya',
      '@trav can you get sagrada familia tickets for all of us saturday at 3',
    );
    expect(sagrada.toolCalls).toEqual(['search_events']);
    expect(textOf(sagrada).split('\n')).toEqual([
      'nothing for sagrada família on saturday at 3 that i can book. no charge',
      'closest is fri mar 13 10am, €26 each · refundable. @ me if you want those instead',
    ]);
    h.clock.set('2026-03-10T12:20:00-04:00');
    const guell = await h.say('h_jordan', '@trav park güell friday 10am for 6');
    expect(guell.toolCalls).toEqual(['search_events']);
    expect(textOf(guell)).toContain('nothing for park güell on friday');
    expect(textOf(guell)).toContain('closest is mon mar 16 9:30am, €18 each · non-refundable');
    // Offering a slot is read-only: no hold, proposal, approval or purchase.
    expect(h.tickets.holdCount()).toBe(0);
    expect(h.pending()).toEqual([]);
    expect(
      h
        .audit()
        .slice(auditBefore)
        .map((e) => e.type)
        .filter((t) => /^(booking|approval|proposal|policy)\./.test(t)),
    ).toEqual([]);
    // The member picks the offered night: a normal proposal, policy-evaluated, a 👍 away.
    const pick = await h.say('h_maya', '@trav sagrada familia tickets for all of us friday');
    expect(pick.toolCalls).toEqual(['search_events', 'propose_booking']);
    expect(h.pending()).toHaveLength(1);
    expect(h.auditTypes()).toContain('policy.evaluated');
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  const makeMinor = (h: ReturnType<typeof harness>): void => {
    const stores = h.runtime.stores;
    const sam = stores.group.members
      .listByGroup(BARCELONA.groupId)
      .find((m) => m.memberId === 'mem_sam')!;
    stores.group.members.upsert({ ...sam, birthDate: '2010-05-01', ageBand: 'under18' });
  };

  it("r1 #3: an asked time that isn't on is said, nothing held; the matching time proposes", async () => {
    const h = harness();
    h.clock.set('2026-03-10T12:05:00-04:00');
    const at3 = await h.say('h_maya', '@trav sagrada familia tickets for all of us friday at 3');
    expect(at3.toolCalls).toEqual(['search_events', 'propose_booking']);
    expect(textOf(at3).split('\n')).toEqual([
      'nothing for sagrada família on friday at 3 that i can book. no charge',
      'closest is fri mar 13 10am, €26 each · refundable. @ me if you want those instead',
    ]);
    expect(h.tickets.holdCount()).toBe(0);
    expect(h.pending()).toEqual([]);
    const pm = await h.say('h_maya', '@trav sagrada familia tickets for all of us friday 4pm');
    expect(textOf(pm)).toContain('on friday at 4pm that i can book');
    expect(h.tickets.holdCount()).toBe(0);
    // Within the hour of the start is that slot: a normal proposal, a 👍 away.
    const ten = await h.say(
      'h_maya',
      '@trav sagrada familia tickets for all of us friday at 10:30am',
    );
    expect(ten.toolCalls).toEqual(['search_events', 'propose_booking']);
    expect(h.pending()).toHaveLength(1);
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('r1 #5: a category ask on a night with nothing lists the venues of the closest night', async () => {
    const h = harness();
    h.clock.set('2026-03-10T12:05:00-04:00');
    const t = await h.say('h_sam', '@trav club tickets for all of us monday');
    expect(t.toolCalls).toEqual(['search_events']);
    const lines = textOf(t).split('\n');
    expect(lines[0]).toBe('nothing for clubs on monday that i can book, no charge. closest:');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^razzmatazz · sun mar 15 12am · €\d+ each · /);
    expect(lines[2]).toMatch(/^apolo · sun mar 15 12:30am · €\d+ each · /);
    expect(lines[3]).toBe('@ me with the one you want');
    expect(h.tickets.holdCount()).toBe(0);
  });

  it('r1 #2: a family group never hears an adults-only venue named for a night with nothing on', async () => {
    const h = harness();
    makeMinor(h);
    h.clock.set('2026-03-10T12:05:00-04:00');
    for (const ask of [
      '@trav club tickets for all of us monday',
      '@trav razzmatazz tickets for all of us monday',
    ]) {
      const t = await h.say('h_dean', ask);
      expect(textOf(t), ask).not.toMatch(/razzmatazz|apolo|\bclubs?\b/i);
    }
    expect(h.tickets.holdCount()).toBe(0);
    expect(h.pending()).toEqual([]);
  });

  it("follow-up (SAFETY minors): a family group's adults-only ask is refused before any hold, sold out names nothing adults-only", async () => {
    const h = harness();
    makeMinor(h);
    h.clock.set('2026-03-10T12:05:00-04:00');
    const thu = await h.say('h_dean', '@trav club tickets for all of us thursday');
    expect(textOf(thu)).not.toMatch(/razzmatazz|apolo/i);
    expect(h.tickets.holdCount()).toBe(0);
    expect(h.pending()).toEqual([]);
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('the flagship ask still proposes in one call', async () => {
    const h = harness();
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(turn.toolCalls).toEqual(['propose_booking']);
    expect(h.pending()).toHaveLength(1);
    expect(h.pending()[0]!.attendees).toHaveLength(5);
  });
});

describe('cheaper responder', () => {
  it('reads real prices from search_events; never makes one up', () => {
    const first = ask('Dean: @trav anything cheaper?');
    const c1 = cheaperResponder.complete(first)!.toolCalls[0]!;
    const pending = {
      proposals: [
        {
          proposalId: 'prop_1',
          description: 'Razzmatazz: VIP',
          totalMinor: 30000,
          currency: 'EUR',
          total: '€300',
          attendees: FIVE,
          eventDate: '2026-03-14',
        },
      ],
    };
    const second = after(first, c1, pending);
    const c2 = cheaperResponder.complete(second)!.toolCalls[0]!;
    expect(c2).toMatchObject({
      name: 'search_events',
      input: { query: 'razzmatazz', quantity: 5, date: '2026-03-14' },
    });
    const res = cheaperResponder.complete(
      after(second, c2, {
        events: [
          {
            name: 'Razzmatazz: VIP',
            bookable: true,
            from: { amountMinor: 1800, currency: 'EUR' },
            fromTier: 'General admission',
            fromRefundable: true,
          },
        ],
      }),
    )!;
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toContain('€18');
    expect(res.text).toContain(
      '€60 ones are still on the card above. 👍 on that card to book them',
    );
  });

  const barcaPending = {
    proposalId: 'prop_barca',
    kind: 'ticket',
    itemRef: 'off_fcb_sev_tribuna',
    description: 'FC Barcelona vs Sevilla FC',
    tier: 'Tribuna lateral',
    totalMinor: 43200,
    currency: 'EUR',
    total: '€432',
    attendees: [1, 2, 3, 4, 5, 6],
    eventDate: '2026-03-15',
  };
  const razzPending = {
    proposalId: 'prop_razz',
    kind: 'ticket',
    itemRef: 'off_rzm_vip',
    description: 'Razzmatazz: Saturday club night',
    tier: 'VIP mezzanine',
    totalMinor: 57000,
    currency: 'EUR',
    total: '€570',
    attendees: [1, 2, 3, 4, 5, 6],
    eventDate: '2026-03-14',
  };
  const tierRow = (
    offerId: string,
    tier: string,
    seat: string | null,
    each: number,
    r = false,
  ) => ({
    offerId,
    tier,
    seat,
    amountMinor: each,
    currency: 'EUR',
    text: `€${each / 100}`,
    refundable: r,
  });
  const barcaEvent = (tiers: unknown[]) => ({
    eventId: 'evt_fcb',
    name: 'FC Barcelona vs Sevilla FC',
    category: 'sports',
    bookable: true,
    from: { amountMinor: 6800, currency: 'EUR' },
    fromTier: 'Gol Nord',
    fromRefundable: false,
    tiers,
  });
  const BARCA_CHEAPER = [
    'cheaper: €68 each · behind the goal (Gol Nord) · non-refundable',
    'want those instead? say "@trav fc barcelona vs sevilla fc behind the goal tickets for 6 mar 15" and i\'ll put up a new card',
    'the €72 sideline ones are still on the card above. 👍 on that card to book them',
  ];
  const HELD_BARCA =
    'the €72 sideline ones are still on the card above. 👍 on that card to book them';

  /** The request carrying a group transcript (what the loop puts in the system prompt). */
  const withTranscript = (text: string, lines: readonly string[]): CompletionRequest => ({
    ...ask(text),
    system: ['s', '', 'recent messages in the group:', ...lines].join('\n'),
  });

  function cheaperWith(
    proposals: unknown[],
    events: unknown[],
    opts: { query?: string; familyMode?: boolean } = {},
  ): CompletionResponse {
    const first = ask('Sam: @trav anything cheaper');
    const c1 = cheaperResponder.complete(first)!.toolCalls[0]!;
    expect(c1.name).toBe('get_pending_proposals');
    const second = after(first, c1, { proposals });
    const c2 = cheaperResponder.complete(second)!.toolCalls[0]!;
    expect(c2).toMatchObject({
      name: 'search_events',
      input: { query: opts.query ?? 'fc barcelona vs sevilla fc' },
    });
    const res = cheaperResponder.complete(
      after(second, c2, opts.familyMode === true ? { events, familyMode: true } : { events }),
    )!;
    expect(res.toolCalls).toEqual([]);
    return res;
  }

  it('T-133: the same event’s cheaper tier, its trade-off, how to switch, and the held card (VOICE §4.10 C)', () => {
    const res = cheaperWith(
      [barcaPending],
      [
        barcaEvent([
          tierRow('off_fcb_sev_gol', 'Gol Nord', 'behind the goal', 6800),
          tierRow('off_fcb_sev_tribuna', 'Tribuna lateral', 'sideline', 7200),
        ]),
      ],
    );
    expect(res.text.split('\n')).toEqual(BARCA_CHEAPER);
    expect(res.text.length).toBeLessThanOrEqual(279);
    expect(res.text).not.toMatch(/still held|keep them|seats for/);
  });

  it('T-133 r2 #2: no quoted ask when its seat words would re-pick the held (refundable) tier', () => {
    const res = cheaperWith(
      [barcaPending],
      [
        barcaEvent([
          tierRow('off_fcb_sev_alta', 'Lateral alta', 'sideline', 7000),
          tierRow('off_fcb_sev_tribuna', 'Tribuna lateral', 'sideline', 7200, true),
        ]),
      ],
    );
    expect(res.text).toMatch(/^cheaper(?: for fc barcelona vs sevilla fc)?: €70 each · sideline/);
    expect(res.text).not.toContain('want those instead');
  });

  it('T-133 r2 #3: more than two pending: the question says how to reach the rest', () => {
    const third = {
      ...razzPending,
      proposalId: 'prop_flam',
      description: 'Flamenco at Tablao',
      tier: '',
    };
    const first = ask('Sam: @trav anything cheaper');
    const c1 = cheaperResponder.complete(first)!.toolCalls[0]!;
    const res = cheaperResponder.complete(
      after(first, c1, { proposals: [barcaPending, razzPending, third] }),
    )!;
    expect(res.text.split('\n')[0]).toBe(
      'which one? (+1 more: "@trav anything cheaper for" and its name)',
    );
    expect(res.text.length).toBeLessThanOrEqual(279);
  });

  it('T-133: the cheapest cheaper tier is the one offered; the held tier never is', () => {
    const res = cheaperWith(
      [barcaPending],
      [
        barcaEvent([
          tierRow('off_b', 'Gol Sud', 'behind the goal', 5000),
          tierRow('off_c', 'Gol Nord', 'behind the goal', 6800),
          tierRow('off_fcb_sev_tribuna', 'Tribuna lateral', 'sideline', 7200),
        ]),
      ],
    );
    expect(res.text.split('\n')[0]).toBe(
      'cheaper: €50 each · behind the goal (Gol Sud) · non-refundable',
    );
    // Only the held tier left: nothing cheaper in that event.
    const onlyHeld = cheaperWith(
      [barcaPending],
      [barcaEvent([tierRow('off_fcb_sev_tribuna', 'Tribuna lateral', 'sideline', 7200)])],
    );
    expect(onlyHeld.text).toMatch(/^that's already the cheapest/);
  });

  it('T-133 r1 #5: club GA is never called seats; the next step only names an ask that picks the tier', () => {
    const razzEvent = (tiers: unknown[]) => ({
      name: 'Razzmatazz: Saturday club night',
      category: 'nightlife',
      bookable: true,
      tiers,
    });
    const ga = tierRow('off_rzm_ga', 'General admission', null, 1800, true);
    const fast = tierRow('off_rzm_fast', 'Fast-line presale', null, 2200, true);
    const vip = tierRow('off_rzm_vip', 'VIP mezzanine', null, 9500);
    const plain = cheaperWith([razzPending], [razzEvent([ga, fast, vip])], { query: 'razzmatazz' });
    expect(plain.text.split('\n')).toEqual([
      'cheaper for razzmatazz: €18 each · General admission · refundable',
      // GA has no tier word, but it's what a plain ask picks (refundable, cheapest).
      'want those instead? say "@trav razzmatazz tickets for 6 mar 14" and i\'ll put up a new card',
      'the €95 ones are still on the card above. 👍 on that card to book them',
    ]);
    expect(plain.text).not.toMatch(/\bseats?\b/);
    // A named tier: the ask carries its name.
    const named = cheaperWith([razzPending], [razzEvent([fast, vip])], { query: 'razzmatazz' });
    expect(named.text.split('\n')[1]).toBe(
      'want those instead? say "@trav razzmatazz fast-line presale tickets for 6 mar 14" and i\'ll put up a new card',
    );
    // GA a plain ask would not pick (a refundable tier ranks first): no next step offered.
    const gaLocked = tierRow('off_rzm_ga', 'General admission', null, 1800, false);
    const none = cheaperWith([razzPending], [razzEvent([gaLocked, fast, vip])], {
      query: 'razzmatazz',
    });
    expect(none.text.split('\n')).toEqual([
      'cheaper for razzmatazz: €18 each · General admission · non-refundable',
      'the €95 ones are still on the card above. 👍 on that card to book them',
    ]);
  });

  it('T-133: an equal price is not cheaper; no cheaper tier ⇒ the cheapest other event, else "already the cheapest"', () => {
    const same = barcaEvent([tierRow('off_fcb_sev_tribuna', 'Tribuna lateral', 'sideline', 7200)]);
    const tie = barcaEvent([
      tierRow('off_x', 'Lateral', 'sideline', 7200),
      tierRow('off_fcb_sev_tribuna', 'Tribuna lateral', 'sideline', 7200),
    ]);
    expect(cheaperWith([barcaPending], [tie]).text).toBe(
      `that's already the cheapest i can book for fc barcelona vs sevilla fc\n${HELD_BARCA}`,
    );
    const espanyol = {
      name: 'RCD Espanyol vs Getafe',
      bookable: true,
      tiers: [tierRow('off_esp', 'General', null, 5500, true)],
    };
    expect(cheaperWith([barcaPending], [same, espanyol]).text).toBe(
      'nothing cheaper for fc barcelona vs sevilla fc. rcd espanyol vs getafe is €55 each that night, refundable\n' +
        HELD_BARCA,
    );
    // Another currency is never compared (no FX guesses).
    const usd = {
      ...espanyol,
      tiers: [{ ...tierRow('off_esp', 'General', null, 100), currency: 'USD' }],
    };
    expect(cheaperWith([barcaPending], [same, usd]).text).toMatch(/^that's already the cheapest/);
  });

  it('T-133 r1 #3: a family group never gets an adults-only event as the cheaper alternative', () => {
    const same = barcaEvent([tierRow('off_fcb_sev_tribuna', 'Tribuna lateral', 'sideline', 7200)]);
    const club = {
      name: 'Apolo: Saturday session',
      bookable: true,
      adultsOnly: true,
      tiers: [tierRow('off_apolo', 'General admission', null, 1500, true)],
    };
    const museum = {
      name: 'Museu Picasso',
      bookable: true,
      adultsOnly: false,
      tiers: [tierRow('off_mp', 'Entry', null, 2000, true)],
    };
    expect(cheaperWith([barcaPending], [same, club, museum]).text).toMatch(/apolo is €15 each/);
    const family = cheaperWith([barcaPending], [same, club, museum], { familyMode: true });
    expect(family.text).toMatch(/museu picasso is €20 each/);
    expect(family.text).not.toMatch(/apolo/i);
    const onlyClub = cheaperWith([barcaPending], [same, club], { familyMode: true });
    expect(onlyClub.text).toMatch(/^that's already the cheapest/);
    expect(onlyClub.text).not.toMatch(/apolo/i);
  });

  it('T-133: only ticket proposals are re-searched; a stay waiting alone gets the honest line', () => {
    const stay = {
      ...barcaPending,
      proposalId: 'prop_stay',
      kind: 'lodging',
      description: 'Eixample 3BR',
    };
    const first = ask('Sam: @trav anything cheaper');
    const c1 = cheaperResponder.complete(first)!.toolCalls[0]!;
    const alone = cheaperResponder.complete(after(first, c1, { proposals: [stay] }))!;
    expect(alone.toolCalls).toEqual([]);
    expect(alone.text).toBe(CHEAPER_TICKETS_ONLY_TEXT);
    // A stay next to one ticket proposal: the ticket one is searched, no "which one?".
    const both = cheaperResponder.complete(after(first, c1, { proposals: [stay, barcaPending] }))!;
    expect(both.toolCalls[0]).toMatchObject({ name: 'search_events' });
  });

  describe('T-133 r1 #1: two pending ticket proposals', () => {
    const two = [barcaPending, razzPending];
    const pendingRound = (first: CompletionRequest): CompletionResponse => {
      const c1 = cheaperResponder.complete(first)!.toolCalls[0]!;
      return cheaperResponder.complete(after(first, c1, { proposals: two }))!;
    };
    const WHICH = [
      'which one?',
      '1. fc barcelona vs sevilla fc tribuna lateral · €432',
      '2. razzmatazz vip mezzanine · €570',
      "reply with the number or the name and i'll look for cheaper",
    ].join('\n');
    // How the loop's transcript carries it (one line per message).
    const whichLine = `- trav: ${WHICH.replace(/\n/g, ' ')}`;

    it('nothing named ⇒ a numbered which-one whose answer this flow reads', () => {
      const res = pendingRound(ask('Sam: @trav anything cheaper'));
      expect(res.toolCalls).toEqual([]);
      expect(res.text).toBe(WHICH);
    });

    it.each([
      ['@trav anything cheaper for razzmatazz', 'razzmatazz'],
      ['@trav anything cheaper for the razz', 'razzmatazz'],
      ['@trav cheaper ones for barça?', 'fc barcelona vs sevilla fc'],
      ['@trav anything cheaper than the vip', 'razzmatazz'],
    ])('the ask names one: %s ⇒ searched directly', (text, query) => {
      const res = pendingRound(ask(`Sam: ${text}`));
      expect(res.toolCalls[0]).toMatchObject({ name: 'search_events', input: { query } });
    });

    it.each([
      ['2', 'razzmatazz'],
      ['the second one', 'razzmatazz'],
      ['1', 'fc barcelona vs sevilla fc'],
      ['razzmatazz', 'razzmatazz'],
      ['@trav razz', 'razzmatazz'],
      ['barça', 'fc barcelona vs sevilla fc'],
    ])('a reply to the which-one, inside the window: %s', (text, query) => {
      const first = withTranscript(`Sam: ${text}`, [
        '- sam: @trav anything cheaper',
        whichLine,
        `- sam: ${text}`,
      ]);
      const c1 = cheaperResponder.complete(first)!.toolCalls[0]!;
      expect(c1.name).toBe('get_pending_proposals');
      const res = cheaperResponder.complete(after(first, c1, { proposals: two }))!;
      expect(res.toolCalls[0]).toMatchObject({ name: 'search_events', input: { query } });
    });

    it('a reply that names nothing from the question, or no which-one before it, is not claimed', () => {
      for (const text of ['lol ok', 'sounds good', '7', 'sagrada']) {
        const req = withTranscript(`Sam: ${text}`, [whichLine, `- sam: ${text}`]);
        expect(cheaperResponder.complete(req), text).toBeUndefined();
      }
      // Trav's last line was something else: "razzmatazz" is not an answer to it.
      const stale = withTranscript('Sam: razzmatazz', [
        whichLine,
        '- trav: cheaper for razzmatazz: €18 each · General admission · refundable',
        '- sam: razzmatazz',
      ]);
      expect(cheaperResponder.complete(stale)).toBeUndefined();
      // A member can't fake Trav's line: theirs is prefixed with their own name.
      const spoof = withTranscript('Sam: 2', [`- sam: ${whichLine}`, '- sam: 2']);
      expect(cheaperResponder.complete(spoof)).toBeUndefined();
    });

    it('a name matching both asks again; a name matching neither says so', () => {
      const both = pendingRound(ask('Sam: @trav anything cheaper for the tickets please'));
      expect(both.text).toBe(WHICH);
      const none = pendingRound(ask('Sam: @trav anything cheaper for sagrada'));
      expect(none.toolCalls).toEqual([]);
      expect(none.text).toBe(NOTHING_LIKE_THAT_CHEAPER_TEXT);
    });
  });

  it('T-133 / msg_bcn_0042: after the Barça proposal, "anything cheaper" searches, proposes nothing, and the proposal stays pending', async () => {
    const h = harness();
    const ask40 = await h.say(
      'h_dean',
      '@trav barça vs sevilla sunday mar 15, 6 tickets together, sideline not behind the goal',
    );
    expect(ask40.toolCalls).toContain('propose_booking');
    const [held] = h.pending();
    expect(held).toMatchObject({ itemRef: 'off_fcb_sev_tribuna', status: 'pending' });
    const auditBefore = h.audit().length;
    const turn = await h.say('h_sam', '@trav anything cheaper');
    expect(turn.toolCalls).toEqual(['get_pending_proposals', 'search_events']);
    const out = turn.outbound.map((o) => ('text' in o ? o.text : '')).join('\n');
    expect(out.split('\n')).toEqual(BARCA_CHEAPER);
    // Read-only: the one pending proposal is the same one, nothing held or bought.
    expect(h.pending().map((p) => [p.proposalId, p.status])).toEqual([
      [held!.proposalId, 'pending'],
    ]);
    expect(h.tickets.purchaseCount()).toBe(0);
    const newTypes = h
      .audit()
      .slice(auditBefore)
      .map((e) => e.type);
    expect(newTypes.filter((t) => /^(booking|approval|proposal)\./.test(t))).toEqual([]);
    // The next step works as written: sending the quoted ask puts up a Gol Nord card
    // (a new proposal with its own 👍s); the sideline card is untouched.
    const quoted = /say "([^"]+)"/.exec(out)![1]!;
    const swap = await h.say('h_sam', quoted);
    // The quoted ask names a date, so it looks first (T-143), then proposes.
    expect(swap.toolCalls).toEqual(['search_events', 'propose_booking']);
    expect(h.pending().map((p) => [p.itemRef, p.status])).toEqual([
      ['off_fcb_sev_tribuna', 'pending'],
      ['off_fcb_sev_gol', 'pending'],
    ]);
    expect(h.pending()[1]!.totalMinor).toBe(40800);
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('T-133 r1 #5: the quoted ask for a club tier proposes that tier', async () => {
    const h = harness();
    await h.say('h_maya', '@trav book the razz vip mezzanine for all 6 tonight');
    const turn = await h.say('h_sam', '@trav anything cheaper');
    const out = turn.outbound.map((o) => ('text' in o ? o.text : '')).join('\n');
    expect(out).toMatch(/^cheaper for razzmatazz: €18 each · General admission · refundable\n/);
    const swap = await h.say('h_sam', /say "([^"]+)"/.exec(out)![1]!);
    expect(swap.toolCalls).toEqual(['search_events', 'propose_booking']);
    expect(h.pending().map((p) => p.itemRef)).toEqual([
      'off_rzm_20260314_vip',
      'off_rzm_20260314_ga',
    ]);
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('T-133 r1 #1 end to end: Barça then Razzmatazz pending; which-one, then a plain name or number in the window', async () => {
    const h = harness();
    await h.say(
      'h_dean',
      '@trav barça vs sevilla sunday mar 15, 6 tickets together, sideline not behind the goal',
    );
    await h.say('h_maya', '@trav book the razz vip mezzanine for all 6 tonight');
    expect(h.pending()).toHaveLength(2);
    const text = (t: { outbound: readonly unknown[] }): string =>
      t.outbound.map((o) => (o as { text?: string }).text ?? '').join('\n');
    const q = await h.say('h_sam', '@trav anything cheaper');
    expect(text(q).split('\n').slice(0, 3)).toEqual([
      'which one?',
      '1. fc barcelona vs sevilla fc tribuna lateral · €432',
      '2. razzmatazz vip mezzanine · €570',
    ]);
    const byName = await h.say('h_sam', 'razzmatazz');
    expect(byName.toolCalls).toEqual(['get_pending_proposals', 'search_events']);
    expect(text(byName)).toMatch(
      /^cheaper for razzmatazz: €18 each · General admission · refundable\n/,
    );
    await h.say('h_sam', '@trav anything cheaper');
    const byNumber = await h.say('h_sam', '1');
    expect(text(byNumber)).toMatch(/^cheaper: €68 each · behind the goal/);
    const direct = await h.say('h_jordan', '@trav anything cheaper for razzmatazz');
    expect(text(direct)).toMatch(/^cheaper for razzmatazz:/);
    // Read-only throughout.
    expect(h.pending()).toHaveLength(2);
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  // T-133 r2 #1: after the which-one question, a new booking ask is a booking ask.
  it.each([
    ['h_jordan', '@trav razzmatazz ga for 5'],
    ['h_henry', '@trav barça tickets for 2'],
    ['h_henry', '@trav book razzmatazz for 5'],
  ])(
    'r2 #1: %s "%s" after the which-one question is never read as its answer',
    async (who, text) => {
      const h = harness();
      await h.say(
        'h_dean',
        '@trav barça vs sevilla sunday mar 15, 6 tickets together, sideline not behind the goal',
      );
      await h.say('h_maya', '@trav book the razz vip mezzanine for all 6 tonight');
      await h.say('h_sam', '@trav anything cheaper');
      const turn = await h.say(who, text);
      expect(turn.toolCalls).not.toContain('search_events');
      expect(turn.toolCalls).not.toEqual(['get_pending_proposals', 'search_events']);
    },
  );
});

describe('lodging, remember, honest gaps', () => {
  it('parseStayAsk reads guests and a total budget, not a nightly one', () => {
    expect(parseStayAsk('find a 6 person airbnb in eixample under €1500 total')).toEqual({
      adults: 6,
      wholeUnit: true,
      maxTotalMinor: 150000,
    });
    expect(parseStayAsk('i paid for the airbnb')).toBeUndefined();
    expect(
      lodgingResponder.complete(ask('Dean: @trav find us a place to stay', ['get_roster'])),
    ).toBeUndefined();
  });

  describe('T-132: round 2 proposes the refundable best fit', () => {
    const stay = (over: Record<string, unknown>) => ({
      propertyId: 'p',
      rateId: 'r',
      name: 'Place',
      kind: 'vacation_rental',
      area: 'Carrer 1, Eixample',
      sleeps: 6,
      bedrooms: 3,
      total: '€1,380',
      totalMinor: 138000,
      currency: 'EUR',
      refundable: true,
      refundableUntil: '2026-03-07T23:59:00+01:00',
      reviewScore: 9,
      ...over,
    });
    const round2 = (text: string, stays: unknown[], tools?: string[]) => {
      const first = ask(text, tools);
      const c1 = lodgingResponder.complete(first)!.toolCalls[0]!;
      expect(c1.name).toBe('search_lodging');
      return lodgingResponder.complete(after(first, c1, { stays }))!;
    };
    const ASK_TEXT =
      'Dean: ok now a place. @trav find a 6 person airbnb in eixample or gracia, under €1500 total, refundable pls';

    it('the first refundable stay in the areas asked ⇒ propose_booking on its rate, no text', () => {
      const res = round2(ASK_TEXT, [
        stay({ rateId: 'rate_beach', area: 'x, Barceloneta', totalMinor: 120000 }),
        stay({ rateId: 'rate_eix', area: "Carrer d'Aragó 255, Eixample" }),
        stay({ rateId: 'rate_poble', area: 'y, Poblenou', refundable: false, totalMinor: 119000 }),
      ]);
      expect(res.text).toBe('');
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0]).toMatchObject({
        name: 'propose_booking',
        input: { kind: 'lodging', itemRef: 'rate_eix' },
      });
    });

    it('accents fold: "gracia" finds Gràcia; no area asked ⇒ the first refundable anywhere', () => {
      const gracia = round2(ASK_TEXT, [
        stay({ rateId: 'rate_beach', area: 'x, Barceloneta' }),
        stay({ rateId: 'rate_gra', area: 'Carrer de Verdi 30, Gràcia' }),
      ]);
      expect(gracia.toolCalls[0]!.input).toMatchObject({ itemRef: 'rate_gra' });
      const anywhere = round2('Dean: @trav find a 6 person airbnb under €1500', [
        stay({ rateId: 'rate_beach', area: 'x, Barceloneta' }),
        stay({ rateId: 'rate_gra', area: 'Carrer de Verdi 30, Gràcia' }),
      ]);
      expect(anywhere.toolCalls[0]!.input).toMatchObject({ itemRef: 'rate_beach' });
    });

    it('nothing refundable fits ⇒ one honest line, nothing proposed', () => {
      const res = round2(ASK_TEXT, [
        stay({
          rateId: 'rate_poble',
          area: 'y, Eixample',
          refundable: false,
          refundableUntil: null,
        }),
      ]);
      expect(res.toolCalls).toEqual([]);
      expect(res.text).toContain('non-refundable');
      expect(res.text).toContain("nothing refundable fits that, so nothing's booked");
    });

    it('r1 #1: budgets with a thousands comma, a dot, "k" and cents; nightly figures are not totals', () => {
      expect(stayBudgetMinor('find an airbnb under €1,500 total')).toBe(150000);
      expect(stayBudgetMinor('find an airbnb under €1,000')).toBe(100000);
      expect(stayBudgetMinor('max 1.500€')).toBe(150000);
      expect(stayBudgetMinor('below 1.5k')).toBe(150000);
      expect(stayBudgetMinor('up to €1,500.50')).toBe(150050);
      expect(stayBudgetMinor('under €1500')).toBe(150000);
      expect(stayBudgetMinor('under 300 a night')).toBeUndefined();
      expect(stayBudgetMinor('a place near the beach')).toBeUndefined();
      expect(parseStayAsk('find a 6 person airbnb under €1,000 total')).toMatchObject({
        maxTotalMinor: 100000,
      });
    });

    it('r1 #1: a stay over the budget said is never proposed, even if the search returned it', () => {
      const thousand = round2(
        'Dean: @trav find a 6 person airbnb in eixample, under €1,000 total',
        [stay({ rateId: 'rate_eix', area: "Carrer d'Aragó 255, Eixample", totalMinor: 138000 })],
      );
      expect(thousand.toolCalls).toEqual([]);
      expect(thousand.text).toMatch(/^nothing fits that/);
      const ok = round2('Dean: @trav find a 6 person airbnb in eixample, under €1,500 total', [
        stay({ rateId: 'rate_eix', area: "Carrer d'Aragó 255, Eixample", totalMinor: 138000 }),
      ]);
      expect(ok.toolCalls[0]!.input).toEqual({
        kind: 'lodging',
        itemRef: 'rate_eix',
        maxTotalMinor: 150000,
        areas: ['eixample'],
      });
    });

    it('r1 #4: a hotel ask with no hotel that fits asks about the whole place instead of carding it', () => {
      expect(stayKindAsked('find us a hotel for 6')).toBe('hotel');
      expect(parseStayAsk('find us a hotel for 6')).toMatchObject({ wholeUnit: false });
      const res = round2('Dean: @trav find us a hotel for 6 in eixample', [
        stay({ rateId: 'rate_eix', area: "Carrer d'Aragó 255, Eixample", kind: 'vacation_rental' }),
      ]);
      expect(res.toolCalls).toEqual([]);
      expect(res.text).toBe(
        "no hotel fits that for everyone, so nothing's booked\nclosest is a whole place: Place, €1,380 for the trip · free cancel until mar 7. want that one?",
      );
      const hotel = round2('Dean: @trav find us a hotel for 6', [
        stay({ rateId: 'rate_eix', kind: 'vacation_rental' }),
        stay({ rateId: 'rate_hotel', kind: 'hotel', totalMinor: 150000 }),
      ]);
      expect(hotel.toolCalls[0]!.input).toMatchObject({ itemRef: 'rate_hotel' });
    });

    it('r1 #4: refundable not asked ⇒ a non-refundable best fit is proposed (its card says non-refundable)', () => {
      expect(refundableAsked('refundable pls')).toBe(true);
      expect(refundableAsked('non-refundable is fine')).toBe(false);
      const res = round2('Dean: @trav find a 6 person airbnb in eixample', [
        stay({ rateId: 'rate_nr', area: 'y, Eixample', refundable: false, refundableUntil: null }),
      ]);
      expect(res.toolCalls[0]!.input).toMatchObject({ kind: 'lodging', itemRef: 'rate_nr' });
    });

    it('no propose_booking offered ⇒ the stay in text, with its refund date in VOICE time', () => {
      const res = round2(
        ASK_TEXT,
        [stay({ rateId: 'rate_eix' })],
        CHAT_TOOLS.filter((t) => t !== 'propose_booking'),
      );
      expect(res.toolCalls).toEqual([]);
      expect(res.text).toContain('free cancel until mar 7');
      expect(res.text).toContain("nothing's booked");
    });
  });

  it('remember: a fact is stored; a health detail never is', () => {
    expect(parseRememberAsk('remember jordan always picks the playlist')).toBe(
      'jordan always picks the playlist',
    );
    const ok = rememberResponder.complete(
      ask('Sam: @trav remember jordan always picks the playlist'),
    )!;
    expect(ok.toolCalls[0]).toMatchObject({
      name: 'remember',
      input: { text: 'jordan always picks the playlist' },
    });
    const health = rememberResponder.complete(ask("Sam: @trav remember henry's sick today"))!;
    expect(health.toolCalls).toEqual([]);
    expect(health.text).toBe(HEALTH_MEMORY_TEXT);
  });

  it("can't-do lines are honest and never answer a money statement", () => {
    expect(honestGapsResponder.complete(ask('Dean: @trav book option 1'))!.text).toBe(
      OPTION_NUMBER_TEXT,
    );
    expect(honestGapsResponder.complete(ask('Dean: @trav dinner spot for 6 tonight'))!.text).toBe(
      RESTAURANT_TEXT,
    );
    expect(
      honestGapsResponder.complete(ask('Dean: @trav i paid €84 for dinner spot')),
    ).toBeUndefined();
  });
});

describe('end to end: an unscripted ticket ask is still gated by ApprovalPolicy (SAFETY §2.1)', () => {
  it('proposal + policy evaluation + approval request; nothing bought until a 👍', async () => {
    const h = harness();
    const text = '@trav book razzmatazz tickets for everyone but Henry';
    expect(text).not.toBe(RAZZMATAZZ_ASK);
    const turn = await h.say('h_dean', text);
    expect(turn.toolCalls).toEqual(['propose_booking']);
    expect(turn.modelSources[0]).toBe('fallback');
    const proposal = h.pending()[0]!;
    expect(proposal.attendees).toEqual([...FIVE]);
    expect(proposal.status).toBe('pending');
    const types = h.auditTypes();
    expect(types).toContain('policy.evaluated');
    expect(types).toContain('approval.requested');
    expect(types).not.toContain('booking.completed');
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(h.runtime.stores.group.bookings.listByTrip(BARCELONA.tripId)).toEqual([]);
  });
});

describe('T-081 r1 review repros (agent)', () => {
  const vip = {
    proposalId: 'prop_vip',
    description: 'Razzmatazz: Saturday club night',
    tier: 'VIP mezzanine',
    totalMinor: 57000,
    currency: 'EUR',
    total: '€570',
    attendees: FIVE,
  };
  const ga = {
    ...vip,
    proposalId: 'prop_ga',
    tier: 'General admission',
    totalMinor: 9000,
    total: '€90',
  };

  it('#6 "cancel the vip thing" drops only a matching proposal', () => {
    expect(cancelTarget('cancel the vip thing, way too much')).toEqual(['vip']);
    expect(cancelTarget('cancel it pls')).toEqual([]);
    const first = ask('Dean: @trav cancel the vip thing, way too much');
    const c1 = cancelResponder.complete(first)!.toolCalls[0]!;
    // Only the GA card is pending: nothing like "vip", so nothing is dropped.
    const onlyGa = cancelResponder.complete(after(first, c1, { proposals: [ga] }))!;
    expect(onlyGa.toolCalls).toEqual([]);
    expect(onlyGa.text).toBe(NOTHING_LIKE_THAT_TEXT);
    // Both pending: the VIP one, never the GA one.
    const both = cancelResponder.complete(after(first, c1, { proposals: [ga, vip] }))!;
    expect(both.toolCalls[0]).toMatchObject({
      name: 'cancel_proposal',
      input: { proposalId: 'prop_vip' },
    });
    // Naming nothing still drops the one pending card.
    const it1 = ask('Dean: @trav cancel it');
    const k1 = cancelResponder.complete(it1)!.toolCalls[0]!;
    expect(
      cancelResponder.complete(after(it1, k1, { proposals: [ga] }))!.toolCalls[0]?.input,
    ).toEqual({ proposalId: 'prop_ga' });
  });

  it.each([
    'remember henry gets migraines',
    'remember sam has asthma',
    'remember maya had covid last month',
    'remember jordan has the flu',
    'remember priya threw up last night',
    'remember henry had a concussion',
    'remember dean is running a fever',
  ])('#7 never stores a health detail: %s', (text) => {
    const res = rememberResponder.complete(ask(`Sam: @trav ${text}`))!;
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toBe(HEALTH_MEMORY_TEXT);
  });

  it('#5 the closest-night alternative is one Trav can book (the sold-out Sunday party is skipped)', async () => {
    const h = harness();
    // Monday has no Razzmatazz night; Sunday's closing party (the nearest) has 0 left.
    const turn = await h.say('h_dean', '@trav get razzmatazz tickets for the 5 of us monday');
    const text = turn.outbound.map((o) => ('text' in o ? o.text : '')).join('\n');
    expect(text).toMatch(/^nothing for razzmatazz on /);
    expect(text).toMatch(/closest is .*€18 each · refundable/);
    expect(text).not.toMatch(/closing/i);
    expect(h.pending()).toEqual([]);
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('#4 a minor never pays: the card holder is their guardian', () => {
    const rule = {
      members: [
        tciMember('mem_dad', 'Dad', '1968-07-11'),
        tciMember('mem_lily', 'Lily', '2011-09-08', 'mem_dad'),
      ],
      now: '2026-06-24T17:00:00-04:00',
      familyTab: true,
      requestedBy: 'mem_lily',
    };
    expect(cardHolderFor('mem_lily', ['mem_dad'], rule)).toBe('mem_dad');
    expect(cardHolderFor('mem_dad', ['mem_dad'], { ...rule, requestedBy: 'mem_dad' })).toBe(
      'mem_dad',
    );
    // No adult payer at all: the requester stays, and ApprovalPolicy C8 holds it.
    expect(cardHolderFor('mem_lily', ['mem_lily'], rule)).toBe('mem_lily');
  });
});

describe('T-148 (T-081 r2 review repros, agent)', () => {
  const ga = {
    proposalId: 'prop_ga',
    description: 'Razzmatazz: Saturday club night',
    tier: 'General admission',
    totalMinor: 9000,
    currency: 'EUR',
    total: '€90',
    attendees: FIVE.map((memberId) => ({ memberId, name: memberId.replace(/^mem_/, '') })),
  };
  const vip = { ...ga, proposalId: 'prop_vip', tier: 'VIP mezzanine', total: '€570' };
  const snorkel = {
    proposalId: 'prop_snorkel',
    description: 'Reef snorkel tour',
    tier: '',
    totalMinor: 6500,
    currency: 'USD',
    total: '$65',
    attendees: [{ memberId: 'mem_tci_lily', name: 'Lily' }],
  };
  const cancelWith = (text: string, proposals: readonly unknown[]) => {
    const first = ask(`Dad: @trav ${text}`);
    const c1 = cancelResponder.complete(first)!.toolCalls[0]!;
    return cancelResponder.complete(after(first, c1, { proposals }))!;
  };

  it.each([
    ['cancel the razz tickets for tonight', [ga], 'prop_ga'],
    ['cancel razz we are not going anymore', [ga], 'prop_ga'],
    ['cancel the razz thing asap', [ga], 'prop_ga'],
    ['cancel the snorkel booking for lily', [ga, snorkel], 'prop_snorkel'],
    ['cancel the vip razz ones', [ga, vip], 'prop_vip'],
  ] as const)('#4 any named word finds the card: %s', (text, proposals, id) => {
    const res = cancelWith(text, proposals);
    expect(res.toolCalls[0]).toMatchObject({ name: 'cancel_proposal', input: { proposalId: id } });
  });

  it('#4 several equally good matches ⇒ "which one?", never a guess; no match ⇒ nothing dropped', () => {
    const tie = cancelWith('cancel the razz tickets for tonight', [ga, vip]);
    expect(tie.toolCalls).toEqual([]);
    expect(tie.text).toMatch(/^which one\?/);
    const none = cancelWith('cancel the barça tickets for tonight', [ga]);
    expect(none.toolCalls).toEqual([]);
    expect(none.text).toBe(NOTHING_LIKE_THAT_TEXT);
    // "for lily" is a person, not a proposal: the snorkel word still decides.
    expect(cancelMatches(['lily'], [ga, snorkel])).toEqual([ga, snorkel]);
  });

  it('#3 "get the 5 of us razz tickets, don\'t count henry" proposes the 5, Henry out', async () => {
    const h = harness();
    const turn = await h.say('h_dean', "@trav get the 5 of us razz tickets, don't count henry");
    expect(turn.toolCalls).toEqual(['propose_booking']);
    expect(h.pending()[0]!.attendees).toEqual([...FIVE]);
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it.each(['how much are razz tickets', 'should we get razz tickets for tonight?'])(
    '#8 a matched-venue question gets the real price and an offer, no proposal: %s',
    async (text) => {
      const h = harness();
      const turn = await h.say('h_dean', `@trav ${text}`);
      expect(turn.toolCalls).toEqual(['search_events']);
      const out = turn.outbound.map((o) => ('text' in o ? o.text : '')).join('\n');
      expect(out).toMatch(/^razzmatazz is €\d+ each, (?:non-)?refundable/);
      expect(out).toContain(VENUE_OFFER_TEXT);
      expect(h.pending()).toEqual([]);
      expect(h.tickets.purchaseCount()).toBe(0);
    },
  );

  it('#8 the venue responder answers only its own search round', () => {
    const r = chat(createVenueQuestionResponder());
    expect(r.complete(ask('Dean: @trav get razz tickets for 5'))).toBeUndefined();
    expect(
      r.complete(ask('Dean: @trav how much are razz tickets', ['get_roster'])),
    ).toBeUndefined();
    const first = ask('Dean: @trav how much is razz');
    const c1 = r.complete(first)!.toolCalls[0]!;
    expect(c1).toMatchObject({ name: 'search_events', input: { query: 'razz tickets' } });
    const none = r.complete(after(first, c1, { events: [] }))!;
    expect(none.text).toBe(VENUE_NOT_BOOKABLE_TEXT);
    const aged = r.complete(
      after(first, c1, {
        events: [
          {
            name: 'Jet ski rental, 1 hour',
            bookable: true,
            minimumAge: 16,
            fromRefundable: false,
            from: { amountMinor: 12000, currency: 'USD' },
          },
        ],
      }),
    )!;
    expect(aged.text).toBe(
      `jet ski rental, 1 hour is $120 each, non-refundable, 16 and up\n${VENUE_OFFER_TEXT}`,
    );
    // T-148 r1 #3: an adults-only venue is named and priced in an adult group,
    // never in a family group (one all-ages line instead, so a line is delivered).
    const casino = {
      name: 'casino night + $40 play voucher',
      bookable: true,
      minimumAge: 21,
      adultsOnly: true,
      fromRefundable: false,
      from: { amountMinor: 6500, currency: 'USD' },
    };
    const adults = r.complete(after(first, c1, { events: [casino] }))!;
    expect(adults.text).toBe(
      `casino night + $40 play voucher is $65 each, non-refundable, not all-ages\n${VENUE_OFFER_TEXT}`,
    );
    const family = r.complete(after(first, c1, { events: [casino], familyMode: true }))!;
    expect(family.text).toBe(VENUE_NOT_ALL_AGES_TEXT);
    expect(family.toolCalls).toEqual([]);
  });
});

function tciMember(
  memberId: string,
  displayName: string,
  birthDate: string,
  guardian?: string,
): Member {
  return {
    memberId,
    groupId: 'grp_tci',
    displayName,
    role: 'member',
    active: true,
    senderId: `h_${displayName.toLowerCase()}`,
    birthDate,
    ageBand: guardian === undefined ? 'adult' : 'under18',
    joinedAt: '2026-01-01T00:00:00Z',
    ...(guardian !== undefined ? { guardianMemberId: guardian } : {}),
  };
}

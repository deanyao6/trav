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
  return req([
    ...first.messages,
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: call.id, content: JSON.stringify(result) }],
    },
  ]);
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
    const barca = book.complete(
      ask('Maya: @trav barça vs sevilla sunday mar 15, 6 tickets together, sideline'),
    )!;
    expect(barca.toolCalls[0]!.input).toMatchObject({ quantity: 6, day: '03-15' });
    const guell = book.complete(ask('Priya: @trav park güell friday 10am for 6'))!;
    expect(guell.toolCalls[0]!.input).toMatchObject({ quantity: 6, day: 'friday' });
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
    expect(res.text).toContain('€60 ones above are still held');
  });
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

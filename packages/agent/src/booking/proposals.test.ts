import { describe, expect, it } from 'vitest';
import type { BookingProposal, Member, MemberId, OutboundMessage } from '@trav/core';
import { approval, defaultSpendingPolicy, isReaction, money } from '@trav/core';
import type { TicketEvent } from '@trav/adapters';
import type { TurnResult } from '../loop.js';
import { FIVE as RUNTIME_FIVE, harness } from '../runtime.testkit.js';
import {
  askedThing,
  bestMatchesBy,
  categoryOnly,
  categoryPlural,
  closestSlotText,
  minuteOfDay,
  minutesOff,
  onNight,
  rankSlots,
  renderProposalText,
  resolveParty,
  type SlotOption,
} from './proposals.js';

const NOW = '2026-03-14T21:40:00+01:00';
const FIVE: readonly MemberId[] = ['mem_dean', 'mem_crowley', 'mem_ava', 'mem_chase', 'mem_leo'];

function member(id: string): Member {
  const name = id.replace(/^mem_/, '');
  return {
    memberId: id,
    groupId: 'grp_barcelona',
    displayName: name[0]?.toUpperCase() + name.slice(1),
    role: 'member',
    active: true,
    senderId: `sim:${name}`,
    ageBand: 'adult',
    joinedAt: '2026-01-01T00:00:00Z',
  };
}

const members: readonly Member[] = [...FIVE, 'mem_henry'].map(member);

const event = {
  eventId: 'evt_razzmatazz_0314',
  provider: 'mock-tickets',
  name: 'Razzmatazz: Saturday club night',
  startsAt: '2026-03-14T23:59:00+01:00',
} as unknown as TicketEvent;

function proposal(overrides: Partial<BookingProposal> = {}): BookingProposal {
  return {
    proposalId: 'prop_razz',
    groupId: 'grp_barcelona',
    tripId: 'trip_barcelona',
    activityId: 'act_razzmatazz',
    kind: 'ticket',
    provider: 'mock-tickets',
    itemRef: 'evt_razzmatazz_0314',
    description: 'Razzmatazz, 5 tickets',
    city: 'Barcelona',
    totalMinor: 9000,
    currency: 'EUR',
    quotedAt: '2026-03-14T21:38:00+01:00',
    quoteRef: 'q_razz_1',
    payers: FIVE.map((memberId) => ({ memberId, shareMinor: 1800 })),
    attendees: [...FIVE],
    paidBy: { kind: 'member_card', memberId: 'mem_dean' },
    refundable: true,
    eventDate: '2026-03-14',
    ageRestriction: 18,
    contentTags: ['nightlife', 'club'],
    requestedBy: 'mem_henry',
    requestedAt: '2026-03-14T21:39:00+01:00',
    sourceMessageId: 'msg_razz_req',
    idempotencyKey: 'k_razz',
    status: 'pending',
    ...overrides,
  };
}

function render(p: BookingProposal, approvers: GroupApprovers = 'any_adult_member'): string[] {
  const policy = { ...defaultSpendingPolicy('grp_barcelona', 'EUR'), approvers };
  const decision = approval.evaluate(p, policy, {
    now: NOW,
    members: approval.toMemberViews(members, NOW),
    prefs: {},
    spentTodayMinor: 0,
    spentTripMinor: 0,
    existingBookingForKey: null,
  });
  return renderProposalText({
    proposal: p,
    decision,
    event,
    members,
    excluded: ['mem_henry'],
    perPerson: money(1800, 'EUR'),
    now: NOW,
    tz: 'Europe/Madrid',
    ruleId: 'C1',
    capPerPersonMinor: 6000,
  }).split('\n');
}

type GroupApprovers = ReturnType<typeof defaultSpendingPolicy>['approvers'];

describe('renderProposalText: who approves (T-104 round 2, VOICE §4.1)', () => {
  it('Henry asks on his own card: he can confirm his own request, the one-tap line', () => {
    const lines = render(proposal({ paidBy: { kind: 'member_card', memberId: 'mem_henry' } }));
    expect(lines.at(-1)).toBe('👍 to book. price held for 15 min');
  });

  it("Henry asks on Dean's card: Dean, the card owner, is the one who oks it (C10, T-148)", () => {
    const lines = render(proposal());
    expect(lines.at(-2)).toBe("it's on Dean's card, so Dean has to ok it");
    expect(lines.at(-1)).toBe(
      '👍 from Dean to book, or anyone can say "not me" first. price held for 15 min',
    );
    expect(lines.join('\n')).not.toContain('Henry has');
  });

  it('any_one with several approvers (the pool standing in): everyone is named, one tap is enough', () => {
    // A card owner nobody can approve for (not a member): the any_one parties stand in.
    const lines = render(proposal({ paidBy: { kind: 'member_card', memberId: 'mem_nobody' } }));
    expect(lines.at(-2)).toBe('any one of Dean, Crowley, Ava, Chase or Leo can ok it');
    expect(lines.at(-1)).toBe(
      'one 👍 from any of them books it, or anyone can say "not me" first. price held for 15 min',
    );
    expect(lines.join('\n')).not.toContain('Henry has');
    expect(lines.join('\n')).not.toMatch(/, \w+ has to ok it/);
  });

  it('a single approver (named approvers) keeps the VOICE §4.1 B wording', () => {
    const lines = render(proposal({ refundable: false }), ['mem_dean']);
    expect(lines.at(-2)).toBe("it's non-refundable, so Dean has to ok it");
    expect(lines.at(-1)).toBe(
      '👍 from Dean to book, or anyone can say "not me" first. price held for 15 min',
    );
  });
});

describe('renderProposalText: the T-193 tab cap (D-046)', () => {
  it("over the group's tab cap on Dean's ask: everyone charged has to 👍, and the card says why", () => {
    const p = proposal({ requestedBy: 'mem_dean' });
    const policy = {
      ...defaultSpendingPolicy('grp_barcelona', 'EUR'),
      perPersonTabAutoCapMinor: 1500,
    };
    const decision = approval.evaluate(p, policy, {
      now: NOW,
      members: approval.toMemberViews(members, NOW),
      prefs: {},
      spentTodayMinor: 0,
      spentTripMinor: 0,
      existingBookingForKey: null,
      ask: 'explicit',
    });
    expect(decision.reasons).toEqual(['over_tab_auto_cap']);
    const lines = renderProposalText({
      proposal: p,
      decision,
      event,
      members,
      excluded: ['mem_henry'],
      perPerson: money(1800, 'EUR'),
      now: NOW,
      tz: 'Europe/Madrid',
      ruleId: 'C3',
      capPerPersonMinor: 6000,
    }).split('\n');
    expect(lines.slice(-2)).toEqual([
      "that's over €15 each on Dean's ask, so everyone charged has to 👍",
      '👍 to book, or say "not me" first. price held for 15 min',
    ]);
  });
});

describe('T-143 helpers: unnamed asks and the closest slot', () => {
  it('categoryOnly: a kind of thing with no venue word', () => {
    expect(categoryOnly('club tickets')).toBe('club');
    expect(categoryOnly('techno tickets')).toBe('club');
    expect(categoryOnly('football tickets')).toBe('match');
    expect(categoryOnly('night tickets')).toBe('one');
    expect(categoryOnly('razzmatazz tickets')).toBeUndefined();
    expect(categoryOnly('park guell tickets')).toBeUndefined();
    expect(categoryOnly('tickets')).toBeUndefined();
    expect(categoryOnly(undefined)).toBeUndefined();
  });

  const slot = (o: Partial<SlotOption> = {}): SlotOption => ({
    name: 'park güell',
    night: '2026-03-16',
    startsAt: '2026-03-16T09:30:00+01:00',
    when: 'mon mar 16 9:30am',
    minute: 570,
    each: money(1800, 'EUR'),
    refundable: false,
    ...o,
  });

  it('closestSlotText (named): no charge, the VOICE §3.9 date, price with refundability, what to say next', () => {
    expect(
      closestSlotText({
        what: 'park güell',
        on: onNight('2026-03-13', '2026-03-10'),
        named: true,
        ranked: [slot()],
      }),
    ).toBe(
      'nothing for park güell on friday that i can book. no charge\nclosest is mon mar 16 9:30am, €18 each · non-refundable. @ me if you want those instead',
    );
    expect(closestSlotText({ what: 'x', on: 'tonight', named: true, ranked: [] })).toBeUndefined();
    expect(onNight('2026-03-10', '2026-03-10')).toBe('tonight');
    expect(onNight('2026-03-11', '2026-03-10')).toBe('tomorrow');
    expect(onNight('2026-03-13', '2026-03-10', '3')).toBe('on friday at 3');
  });

  it('closestSlotText (category, r1 #5): plural ask, names the venue; two venues that night are listed', () => {
    const razz = slot({
      name: 'razzmatazz',
      night: '2026-03-14',
      startsAt: '2026-03-15T00:00:00+01:00',
      when: 'sun mar 15 12am',
      minute: 0,
      refundable: true,
    });
    const apolo = { ...razz, name: 'apolo', when: 'sun mar 15 12:30am', each: money(1500, 'EUR') };
    const on = onNight('2026-03-16', '2026-03-10');
    expect(closestSlotText({ what: 'clubs', on, named: false, ranked: [razz] })).toBe(
      'nothing for clubs on monday that i can book. no charge\nclosest is razzmatazz, sun mar 15 12am, €18 each · refundable. @ me if you want those instead',
    );
    const two = closestSlotText({ what: 'clubs', on, named: false, ranked: [razz, apolo] })!;
    expect(two.split('\n')).toEqual([
      'nothing for clubs on monday that i can book, no charge. closest:',
      'razzmatazz · sun mar 15 12am · €18 each · refundable',
      'apolo · sun mar 15 12:30am · €15 each · refundable',
      '@ me with the one you want',
    ]);
    const third = { ...apolo, name: 'sala x' };
    expect(
      closestSlotText({ what: 'clubs', on, named: false, ranked: [razz, apolo, third] })!
        .split('\n')
        .at(-1),
    ).toBe('@ me with the one you want (+1 more that night)');
  });

  it('askedThing / categoryPlural: never an adults-only name or a nightlife word in a family group', () => {
    const evs = [
      { name: 'Razzmatazz: Monday', adultsOnly: true },
      { name: 'Park Güell: monumental zone', adultsOnly: false },
    ];
    expect(askedThing(undefined, evs, false)).toBe('razzmatazz');
    expect(askedThing(undefined, evs, true)).toBe('park güell');
    expect(askedThing(undefined, [evs[0]!], true)).toBe('that');
    expect(askedThing('club', evs, false)).toBe('clubs');
    expect(askedThing('club', evs, true)).toBe('that');
    expect(askedThing('match', evs, true)).toBe('matches');
    expect(categoryPlural('party')).toBe('parties');
    expect(categoryPlural('one')).toBe('that');
  });

  it('times: minute of day in the trip zone, round-the-clock distance, ranking by night then time', () => {
    expect(minuteOfDay('2026-03-13T10:00:00+01:00', 'Europe/Madrid')).toBe(600);
    expect(minuteOfDay('2026-03-13T09:00:00Z', 'Europe/Madrid')).toBe(600);
    expect(minutesOff([180, 900], 600)).toBe(300);
    expect(minutesOff([15], 1430)).toBe(25);
    const ten = slot({ night: '2026-03-13', minute: 600, startsAt: '2026-03-13T10:00:00+01:00' });
    const four = slot({ night: '2026-03-13', minute: 960, startsAt: '2026-03-13T16:00:00+01:00' });
    const far = slot({ night: '2026-03-16', minute: 900 });
    expect(rankSlots([far, ten, four], '2026-03-13', [900])).toEqual([four, ten, far]);
    expect(rankSlots([far, four, ten], '2026-03-13', [])).toEqual([ten, four, far]);
  });

  it('bestMatchesBy: distinctive words win; category words never score', () => {
    const items = ['Park Güell: monumental zone', 'Parc de la Ciutadella park tour'];
    expect(bestMatchesBy(items, 'park guell tickets', (s) => s)).toEqual([items[0]]);
    expect(bestMatchesBy(items, 'park tickets', (s) => s)).toEqual(items);
  });
});

describe('T-158: a clarify roster never lists someone the member excluded', () => {
  const byId = new Map(members.map((m) => [m.memberId, m] as const));
  const order = [...FIVE, 'mem_henry'];
  const party = (input: Parameters<typeof resolveParty>[0]['input']) =>
    resolveParty({ input, active: members, byId, order, base: order, markedOut: new Set() });
  const question = (r: ReturnType<typeof party>): string => {
    if (r.kind !== 'clarify') throw new Error(`expected a clarify, got ${r.kind}`);
    return r.question;
  };

  it('a count that is not the roster after the exclusion lists only who is still in', () => {
    const q = question(party({ quantity: 4, excludedNames: ['Henry'] }));
    expect(q).toBe(
      "who's in? i've got Dean, Crowley, Ava, Chase, Leo. 👍 if that's right, or tell me who to swap",
    );
  });

  it('an unknown name next to a known exclusion: the known one is already off the list', () => {
    const r = party({ excludedNames: ['Henry', 'Zed'] });
    expect(question(r)).not.toContain('Henry');
    expect(r).toMatchObject({ problems: ['unknown_name:Zed'] });
    // An unknown name before a known one: same result, order doesn't matter.
    expect(question(party({ excludedNames: ['Zed', 'Henry'] }))).not.toContain('Henry');
  });

  it('r1 #4: an unknown attendee lists the named people Trav could match, never the whole group', () => {
    const r = party({ attendeeNames: ['Chase', 'Crowley', 'Zed'] });
    expect(question(r)).toBe(
      "who's in? i've got Crowley, Chase. 👍 if that's right, or tell me who to swap",
    );
    expect(r).toMatchObject({ problems: ['unknown_name:Zed'] });
    // Excluded and named: the excluded one is still never listed.
    const q = question(
      party({ excludedNames: ['Henry'], attendeeNames: ['Chase', 'Henry', 'Zed'] }),
    );
    expect(q).toBe("who's in? i've got Chase. 👍 if that's right, or tell me who to swap");
    // Every unknown is reported at once, not just the first.
    expect(party({ attendeeNames: ['Zed', 'Chase', 'Quinn'] })).toMatchObject({
      problems: ['unknown_name:Zed', 'unknown_name:Quinn'],
    });
  });

  it('r1 #4: nobody named could be matched: a plain question, never the whole group', () => {
    const q = question(party({ excludedNames: ['Henry'], attendeeNames: ['Zed'] }));
    expect(q).toBe("who's in? tell me who's going");
    // A reason word that slipped into the names is never echoed back.
    const r = party({
      attendeeNames: ['Chase', 'Crowley', 'Henry', 'Is', 'Sick'],
      excludedNames: ['Henry'],
    });
    expect(question(r)).toBe(
      "who's in? i've got Crowley, Chase. 👍 if that's right, or tell me who to swap",
    );
    expect(question(r)).not.toMatch(/sick|\bis\b/i);
  });

  it('r1 #4: an unknown excluded name next to named attendees lists those attendees', () => {
    const q = question(party({ excludedNames: ['Zed'], attendeeNames: ['Chase', 'Leo'] }));
    expect(q).toBe("who's in? i've got Chase, Leo. 👍 if that's right, or tell me who to swap");
  });

  it('an excluded member id is left out the same way', () => {
    expect(question(party({ quantity: 2, excludedMemberIds: ['mem_henry'] }))).not.toContain(
      'Henry',
    );
  });

  it('T-173 (SAFETY A9): a party of only members who are out is never a party', () => {
    for (const input of [
      { attendeeNames: ['Henry'], excludedNames: ['Henry'] },
      { attendeeNames: ['Henry', 'Chase'], excludedNames: ['Chase', 'Henry'] },
    ]) {
      const r = party(input);
      expect(r.kind).toBe('clarify');
      expect(question(r)).not.toMatch(/henry|chase/i);
    }
    // Marked out for the activity (not just named out) is the same.
    const r = resolveParty({
      input: { attendeeNames: ['Henry'] },
      active: members,
      byId,
      order,
      base: order,
      markedOut: new Set(['mem_henry']),
    });
    expect(r.kind).toBe('clarify');
  });

  it('nobody left: a plain question, never an empty list', () => {
    const q = question(
      party({ quantity: 1, excludedNames: ['Dean', 'Crowley', 'Ava', 'Chase', 'Leo', 'Henry'] }),
    );
    expect(q).toBe("who's in? tell me who's going");
  });
});

describe('T-158: the ticket path through the runtime (offline)', () => {
  const groupText = (turn: TurnResult): string =>
    turn.outbound
      .filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'group')
      .map((m) => m.text)
      .join('\n');
  const REASON = /sick|rough|feeling/i;

  it.each([
    ['h_arjun', '@trav we need razzmatazz entry tonight for dean chase piotr crowley and me'],
    ['h_piotr', '@trav pick up razzmatazz passes for us tonight minus henry'],
    [
      'h_crowley',
      '@trav can you sort razzmatazz for 5 of us tonight? not henry, he is feeling rough',
    ],
  ])('%s: "%s" proposes the five at €90, Henry out, no reason repeated', async (from, text) => {
    const h = harness();
    const turn = await h.say(from, text);
    const p = h.pending()[0];
    expect(p, turn.note).toBeDefined();
    expect(new Set(p!.attendees)).toEqual(new Set(RUNTIME_FIVE));
    expect(p!.totalMinor).toBe(9000);
    expect(h.tickets.purchaseCount()).toBe(0);
    const said = groupText(turn);
    expect(said).toContain('(not Henry)');
    expect(said).not.toMatch(REASON);
  });

  it('"the 4 of us …, not henry, he\'s feeling rough": the question names the five still in, never Henry', async () => {
    const h = harness();
    const turn = await h.say(
      'h_chase',
      "@trav get the 4 of us razzmatazz tickets tonight. not henry, he's feeling rough",
    );
    expect(h.pending()).toHaveLength(0);
    const said = groupText(turn);
    expect(said).toContain("who's in?");
    expect(said).toContain('Dean, Chase, Piotr, Arjun, Crowley');
    expect(said).not.toContain('Henry');
    expect(said).not.toMatch(REASON);
  });

  it('r1 #1: "for chase and crowley, henry is sick" proposes exactly Chase and Crowley, no reason repeated', async () => {
    const h = harness();
    const turn = await h.say(
      'h_dean',
      '@trav get razz tickets for chase and crowley, henry is sick',
    );
    const p = h.pending()[0];
    expect(p, turn.note).toBeDefined();
    expect(new Set(p!.attendees)).toEqual(new Set(['mem_chase', 'mem_crowley']));
    expect(h.tickets.purchaseCount()).toBe(0);
    const said = groupText(turn);
    expect(said).not.toMatch(/sick|\bIs\b/);
    expect(said).not.toContain("who's in?");
  });

  it.each([
    '@trav we need razz passes printed',
    '@trav need razz passes from crowley, he has them',
    '@trav we need razz tickets lol jk',
    '@trav we want razz tickets but henry wants apolo',
    '@trav we need 5 razz passes printed',
  ])('r1 #2/#3: "%s" holds nothing and proposes nothing', async (text) => {
    const h = harness();
    await h.say('h_dean', text);
    expect(h.pending()).toHaveLength(0);
    expect(h.tickets.purchaseCount()).toBe(0);
  });
});

describe('T-173: the precision repros through the runtime (offline)', () => {
  const groupText = (turn: TurnResult): string =>
    turn.outbound
      .filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'group')
      .map((m) => m.text)
      .join('\n');

  it('r2 #1: "for chase, zed and me" asks about Zed instead of booking without them', async () => {
    const h = harness();
    const turn = await h.say('h_dean', '@trav get razz tickets for chase, zed and me');
    expect(h.pending()).toHaveLength(0);
    const said = groupText(turn);
    expect(said).toContain("who's in?");
    expect(said).toContain('Dean, Chase');
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('r2 #2: "i need razz tickets" proposes the sender alone', async () => {
    const h = harness();
    const turn = await h.say('h_arjun', '@trav i need razz tickets tonight');
    const p = h.pending()[0];
    expect(p, turn.note).toBeDefined();
    expect(p!.attendees).toEqual(['mem_arjun']);
  });

  it.each([
    "@trav we need razz tickets tonight, crowley's buying",
    '@trav crowley got razz tickets for all 6',
    "@trav we can't get razz tickets for all 6",
    '@trav get razz tickets for all 6 once henry confirms',
    '@trav worth getting razz tickets for all 6?',
    '@trav crowley, get razz tickets for everyone',
    '@trav get the whole crew razz tickets, sparing for henry',
    '@trav get razz tickets for henry, henry is sick',
  ])('"%s" holds nothing and proposes nothing', async (text) => {
    const h = harness();
    await h.say('h_dean', text);
    expect(h.pending()).toHaveLength(0);
    expect(h.tickets.purchaseCount()).toBe(0);
  });

  it('SAFETY A9: "the whole crew save for henry" proposes the five, never Henry alone', async () => {
    const h = harness();
    const turn = await h.say('h_dean', '@trav get the whole crew razz tickets save for henry');
    const p = h.pending()[0];
    expect(p, turn.note).toBeDefined();
    expect(new Set(p!.attendees)).toEqual(new Set(RUNTIME_FIVE));
  });
});

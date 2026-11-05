import { describe, expect, it } from 'vitest';
import type { BookingProposal, Member, MemberId } from '@trav/core';
import { approval, defaultSpendingPolicy, money } from '@trav/core';
import type { TicketEvent } from '@trav/adapters';
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
  type SlotOption,
} from './proposals.js';

const NOW = '2026-03-14T21:40:00+01:00';
const FIVE: readonly MemberId[] = ['mem_dean', 'mem_sam', 'mem_ava', 'mem_maya', 'mem_leo'];

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
    expect(lines.at(-2)).toBe('any one of Dean, Sam, Ava, Maya or Leo can ok it');
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

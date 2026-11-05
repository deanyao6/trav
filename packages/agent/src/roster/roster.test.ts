import { describe, expect, it } from 'vitest';
import type { Activity, Member, OutboundMessage, Roster, Stores } from '@trav/core';
import {
  createDeterministicIdGenerator,
  createSimulatedClock,
  isReaction,
  safety,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import { BARCELONA, BARCELONA_NOW, seedBarcelona } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { FIVE, harness } from '../runtime.testkit.js';
import {
  bookingParty,
  detectRollCall,
  parseRosterUpdate,
  parseTicketForMe,
  renderAttendanceLine,
  renderRollCall,
  resolveActivity,
  resolveMemberName,
  rosterDiverged,
  rosterMembers,
  rosterOf,
  setAttendance,
  stripTravPrefix,
  unanswered,
} from './index.js';
import { handleRosterMessage } from './turn.js';

const G = BARCELONA.groupId;
const ACT = BARCELONA.razzmatazzActivityId;
const TZ = 'Europe/Madrid';
const ALL = BARCELONA.members.map((m) => m.memberId);

function world(): { stores: Stores; members: readonly Member[]; activity: Activity } {
  const clock = createSimulatedClock(BARCELONA_NOW);
  const stores = createMemoryStores({ clock, ids: createDeterministicIdGenerator('r') });
  seedBarcelona(stores);
  return {
    stores,
    members: stores.group.members.listByGroup(G),
    activity: stores.group.trips.getActivity(ACT)!,
  };
}

function mark(stores: Stores, memberId: string, status: 'in' | 'out' | 'maybe'): void {
  stores.group.trips.setAttendance({
    activityId: ACT,
    memberId,
    status,
    updatedAt: BARCELONA_NOW,
    sourceMessageId: 'msg_seed',
    setBy: memberId,
  });
}

function messages(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}

describe('rosterOf / bookingParty: the roster is the one source of quantity and payers', () => {
  it('lists in/out/maybe in member order; unanswered members are in no list', () => {
    const { stores, members } = world();
    mark(stores, 'mem_henry', 'out');
    mark(stores, 'mem_crowley', 'maybe');
    const roster = rosterOf(stores.group.trips, ACT, members, BARCELONA_NOW);
    expect(roster.inMemberIds).toEqual(['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun']);
    expect(roster.outMemberIds).toEqual(['mem_henry']);
    expect(roster.maybeMemberIds).toEqual(['mem_crowley']);
    expect(unanswered(roster, members)).toEqual([]);
  });

  it('"maybe" counts as out at booking time, and quantity, attendees and payers are the same list', () => {
    const { stores, members } = world();
    mark(stores, 'mem_henry', 'out');
    mark(stores, 'mem_crowley', 'maybe');
    const party = bookingParty(rosterOf(stores.group.trips, ACT, members, BARCELONA_NOW));
    expect(party.attendees).toEqual(['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun']);
    expect(party.payers).toEqual(party.attendees);
    expect(party.quantity).toBe(4);
  });

  it('an empty roster is a party of zero (nothing to book), never a guess from the member count', () => {
    const { stores, members } = world();
    for (const id of ALL) mark(stores, id, 'out');
    const party = bookingParty(rosterOf(stores.group.trips, ACT, members, BARCELONA_NOW));
    expect(party).toEqual({ attendees: [], payers: [], quantity: 0 });
  });

  it('members who already hold a ticket are left out of the party (a later proposal is an add-on)', () => {
    const { stores, members } = world();
    const party = bookingParty(rosterOf(stores.group.trips, ACT, members, BARCELONA_NOW), FIVE);
    expect(party.attendees).toEqual(['mem_henry']);
    expect(party.quantity).toBe(1);
  });

  it('guests, inactive members and members who left are never on a roster', () => {
    const { stores } = world();
    const members: Member[] = [
      ...stores.group.members.listByGroup(G),
      {
        memberId: 'mem_guest',
        groupId: G,
        displayName: 'Ava',
        role: 'guest',
        active: true,
        senderId: 'h_ava',
        ageBand: 'adult',
        joinedAt: BARCELONA_NOW,
      },
    ];
    const left = { ...members[1]!, leftAt: BARCELONA_NOW, active: false };
    const all = [members[0]!, left, ...members.slice(2)];
    expect(rosterMembers(all).map((m) => m.memberId)).toEqual([
      'mem_dean',
      'mem_chase',
      'mem_piotr',
      'mem_arjun',
      'mem_crowley',
    ]);
  });

  it('rosterDiverged: same set ⇒ false; a member out, in, or a count change ⇒ true', () => {
    const { stores, members } = world();
    const proposal = {
      attendees: [...FIVE],
      payers: FIVE.map((memberId) => ({ memberId, shareMinor: 1800 })),
    };
    mark(stores, 'mem_henry', 'out');
    const same = rosterOf(stores.group.trips, ACT, members, BARCELONA_NOW);
    expect(rosterDiverged(same, proposal as never)).toBe(false);
    mark(stores, 'mem_chase', 'maybe');
    const fewer = rosterOf(stores.group.trips, ACT, members, BARCELONA_NOW);
    expect(rosterDiverged(fewer, proposal as never)).toBe(true);
    mark(stores, 'mem_chase', 'in');
    mark(stores, 'mem_henry', 'in');
    const more = rosterOf(stores.group.trips, ACT, members, BARCELONA_NOW);
    expect(rosterDiverged(more, proposal as never)).toBe(true);
    // Henry already holds a ticket: he is not part of the party, so no divergence.
    expect(rosterDiverged(more, proposal as never, ['mem_henry'])).toBe(false);
  });
});

describe('setAttendance: ids and statuses only, one audit event per real change', () => {
  it('writes the row and a roster.changed event without any reason text', () => {
    const { stores, members, activity } = world();
    const write = setAttendance(
      stores.group,
      {
        activityId: ACT,
        memberId: 'mem_henry',
        status: 'out',
        setBy: 'mem_dean',
        sourceMessageId: 'msg_1',
      },
      members,
      BARCELONA_NOW,
      activity,
    );
    expect(write.changed).toBe(true);
    expect(write.previous).toBe('in');
    expect(write.roster.inMemberIds).toEqual([...FIVE]);
    const row = stores.group.trips.listAttendance(ACT).find((r) => r.memberId === 'mem_henry');
    expect(row).toEqual({
      activityId: ACT,
      memberId: 'mem_henry',
      status: 'out',
      updatedAt: BARCELONA_NOW,
      sourceMessageId: 'msg_1',
      setBy: 'mem_dean',
    });
    const events = stores.group.audit.listByGroup(G).filter((e) => e.type === 'roster.changed');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      activityId: ACT,
      changes: [{ memberId: 'mem_henry', status: 'out' }],
      sourceMessageId: 'msg_1',
    });
    expect(events[0]!.actor).toEqual({ kind: 'member', id: 'mem_dean' });
  });

  it('the same status twice changes nothing and writes no event', () => {
    const { stores, members, activity } = world();
    const change = {
      activityId: ACT,
      memberId: 'mem_henry',
      status: 'out' as const,
      setBy: 'mem_henry',
      sourceMessageId: 'msg_1',
    };
    setAttendance(stores.group, change, members, BARCELONA_NOW, activity);
    const again = setAttendance(stores.group, change, members, BARCELONA_NOW, activity);
    expect(again.changed).toBe(false);
    expect(again.previous).toBe('out');
    expect(
      stores.group.audit.listByGroup(G).filter((e) => e.type === 'roster.changed'),
    ).toHaveLength(1);
  });

  it('the AttendanceChange shape has no field for a reason', () => {
    const change = {
      activityId: ACT,
      memberId: 'mem_henry',
      status: 'out' as const,
      setBy: 'mem_dean',
      sourceMessageId: 'msg_1',
    };
    expect(Object.keys(change).sort()).toEqual(
      ['activityId', 'memberId', 'setBy', 'sourceMessageId', 'status'].sort(),
    );
  });
});

describe('resolveActivity', () => {
  const base: Activity = {
    activityId: 'a',
    tripId: 't',
    groupId: G,
    kind: 'nightlife',
    name: 'Razzmatazz',
    venue: 'Razzmatazz',
    startsAt: '2026-03-15T00:00:00+01:00',
    endsAt: '2026-03-15T06:00:00+01:00',
    contentTags: [],
    ageRestriction: 18,
    createdAt: BARCELONA_NOW,
  };
  const noEnd = (a: Activity): Activity => {
    const { endsAt: _drop, ...rest } = a;
    return rest;
  };
  const acts: Activity[] = [
    noEnd({
      ...base,
      activityId: 'sagrada',
      name: 'Sagrada Família',
      kind: 'attraction',
      startsAt: '2026-03-15T10:00:00+01:00',
    }),
    base,
    noEnd({ ...base, activityId: 'past', name: 'Flamenco', startsAt: '2026-03-13T21:00:00+01:00' }),
    noEnd({ ...base, activityId: 'apolo', name: 'Apolo', startsAt: '2026-03-16T00:30:00+01:00' }),
  ];

  it('no hint ⇒ tonight; a club still running at 1:30am is still tonight; an over one is never picked', () => {
    expect(resolveActivity(acts, TZ, BARCELONA_NOW)?.activityId).toBe('a');
    expect(resolveActivity(acts, TZ, '2026-03-15T01:30:00+01:00')?.activityId).toBe('a');
    // No end time: an hour past the start it is over, and the next one wins.
    expect(resolveActivity(acts.map(noEnd), TZ, '2026-03-15T01:30:00+01:00')?.activityId).toBe(
      'sagrada',
    );
    expect(resolveActivity(acts, TZ, '2026-03-15T07:00:00+01:00')?.activityId).toBe('sagrada');
  });

  it('no hint and nothing tonight ⇒ the next upcoming one', () => {
    const later = acts.filter((a) => a.activityId !== 'a' && a.activityId !== 'sagrada');
    expect(resolveActivity(later, TZ, BARCELONA_NOW)?.activityId).toBe('apolo');
  });

  it('a hint matches by name or venue, "tickets" is ignored, and nothing matching ⇒ undefined', () => {
    expect(resolveActivity(acts, TZ, BARCELONA_NOW, 'razzmatazz tickets')?.activityId).toBe('a');
    expect(resolveActivity(acts, TZ, BARCELONA_NOW, 'sagrada')?.activityId).toBe('sagrada');
    expect(resolveActivity(acts, TZ, BARCELONA_NOW, 'be late')).toBeUndefined();
  });

  it('an empty list ⇒ undefined', () => {
    expect(resolveActivity([], TZ, BARCELONA_NOW)).toBeUndefined();
  });

  it('"tomorrow" is the next night only (earliest start wins), and never tonight, even when nothing is planned', () => {
    // Sunday 10am is past the 5am rollover, so sagrada and apolo (12:30am monday) are both "tomorrow".
    expect(resolveActivity(acts, TZ, BARCELONA_NOW, undefined, 'tomorrow')?.activityId).toBe(
      'sagrada',
    );
    const noSagrada = acts.filter((a) => a.activityId !== 'sagrada');
    expect(resolveActivity(noSagrada, TZ, BARCELONA_NOW, undefined, 'tomorrow')?.activityId).toBe(
      'apolo',
    );
    const tonightOnly = acts.filter((a) => a.activityId === 'a' || a.activityId === 'past');
    expect(resolveActivity(tonightOnly, TZ, BARCELONA_NOW, undefined, 'tomorrow')).toBeUndefined();
  });

  it('"tonight" is strict too: nothing tonight ⇒ undefined, never the next upcoming one', () => {
    const later = acts.filter((a) => a.activityId !== 'a' && a.activityId !== 'sagrada');
    expect(resolveActivity(later, TZ, BARCELONA_NOW, undefined, 'tonight')).toBeUndefined();
    expect(resolveActivity(acts, TZ, BARCELONA_NOW, undefined, 'tonight')?.activityId).toBe('a');
    // At 1:30am the night has not rolled over: "tonight" is still razzmatazz.
    expect(
      resolveActivity(acts, TZ, '2026-03-15T01:30:00+01:00', undefined, 'tonight')?.activityId,
    ).toBe('a');
  });
});

describe('natural language: roll calls and overrides', () => {
  it('stripTravPrefix drops "@trav" / "hey trav," and trailing punctuation', () => {
    expect(stripTravPrefix("@trav who's in tonight?")).toBe("who's in tonight");
    expect(stripTravPrefix("hey trav, Henry's sick!")).toBe("Henry's sick");
    expect(stripTravPrefix('  trav:  i am out .')).toBe('i am out');
  });

  it.each([
    ["@trav who's in tonight?", { when: 'tonight' }],
    ['who is in', {}],
    ["so who's coming to razzmatazz", { hint: 'razzmatazz' }],
    ['@trav who all is going tomorrow', { when: 'tomorrow' }],
    ['who is in tomorrow?', { when: 'tomorrow' }],
    ["who's coming tmrw", { when: 'tomorrow' }],
    ["who's down today", { when: 'tonight' }],
    ["who's in this evening", { when: 'tonight' }],
    ["who's in for razzmatazz tomorrow", { hint: 'razzmatazz', when: 'tomorrow' }],
    ["who's down for the sagrada tour", { hint: 'the sagrada tour' }],
    // T-009 (T-030 note d): "for tonight/tomorrow" is the night, never an activity named "tonight".
    ["@trav who's in for tonight?", { when: 'tonight' }],
    ["who's in for tomorrow", { when: 'tomorrow' }],
    ["who's coming for tmrw?", { when: 'tomorrow' }],
    ["who's in for razzmatazz for tomorrow", { hint: 'razzmatazz', when: 'tomorrow' }],
  ])('detectRollCall(%j)', (text, expected) => {
    expect(detectRollCall(text)).toEqual(expected);
  });

  it.each(['who is henry', 'who paid for dinner', "who's in charge of the airbnb"])(
    'detectRollCall(%j) is not a roll call',
    (text) => {
      expect(detectRollCall(text)).toBeUndefined();
    },
  );

  it.each([
    ["@trav Henry's sick", { who: 'Henry', status: 'out' }],
    ['Henry is sick', { who: 'Henry', status: 'out' }],
    ["Henry's not coming", { who: 'Henry', status: 'out' }],
    ['count Henry out', { who: 'Henry', status: 'out' }],
    ['henry is out for razzmatazz', { who: 'henry', status: 'out', hint: 'razzmatazz' }],
    ["i'm out tonight", { who: 'me', status: 'out', when: 'tonight' }],
    ['Chase is out tomorrow', { who: 'Chase', status: 'out', when: 'tomorrow' }],
    ["Chase's sick tmrw", { who: 'Chase', status: 'out', when: 'tomorrow' }],
    ['count me in tomorrow', { who: 'me', status: 'in', when: 'tomorrow' }],
    [
      "i'm a maybe for apolo tomorrow",
      { who: 'me', status: 'maybe', hint: 'apolo', when: 'tomorrow' },
    ],
    ["i'm out this evening", { who: 'me', status: 'out', when: 'tonight' }],
    // T-009 (T-030 note d): "for tonight" is the night, not an activity hint.
    ["i'm out for tonight", { who: 'me', status: 'out', when: 'tonight' }],
    ["Chase's sick for tomorrow", { who: 'Chase', status: 'out', when: 'tomorrow' }],
    ["i'm sick", { who: 'me', status: 'out' }],
    ["can't make it", undefined],
    ['count me in', { who: 'me', status: 'in' }],
    ["@trav i'm in", { who: 'me', status: 'in' }],
    ["i'll be there", { who: 'me', status: 'in' }],
    ['Crowley is in', { who: 'Crowley', status: 'in' }],
    ['add Crowley', { who: 'Crowley', status: 'in' }],
    ["Crowley's a maybe for razzmatazz", { who: 'Crowley', status: 'maybe', hint: 'razzmatazz' }],
    ['maybe', { who: 'me', status: 'maybe' }],
    ["i'm not sure", { who: 'me', status: 'maybe' }],
    // T-180: every shape of the split OTHER_OUT / OTHER_IN patterns, with hint and night.
    ["Henry's not feeling it tonight", { who: 'Henry', status: 'out', when: 'tonight' }],
    ['henrys out for razzmatazz', { who: 'henry', status: 'out', hint: 'razzmatazz' }],
    ['Henry out', { who: 'Henry', status: 'out' }],
    ['count Henry is out tomorrow', { who: 'Henry', status: 'out', when: 'tomorrow' }],
    ['Henry out for apolo', { who: 'Henry', status: 'out', hint: 'apolo' }],
    ["Crowley's keen for apolo", { who: 'Crowley', status: 'in', hint: 'apolo' }],
    ['Henry in', { who: 'Henry', status: 'in' }],
    [
      'count Henry in for razzmatazz tomorrow',
      { who: 'Henry', status: 'in', hint: 'razzmatazz', when: 'tomorrow' },
    ],
    ['add Crowley tmrw', { who: 'Crowley', status: 'in', when: 'tomorrow' }],
    ['add Crowley to razzmatazz', { who: 'Crowley', status: 'in', hint: 'razzmatazz' }],
    ['count me out', undefined],
    ['add me', undefined],
  ])('parseRosterUpdate(%j)', (text, expected) => {
    expect(parseRosterUpdate(text)).toEqual(expected);
  });

  it.each([
    'lol henry',
    "henry's sick so he missed razzmatazz last year and we should go again",
    'get the 5 of us Razzmatazz tickets, Henry’s sick',
    "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
    'Chase is in the shower',
    "i'm in the lobby",
    'henry bailed',
    'how much do i owe',
  ])('parseRosterUpdate(%j) is not an override', (text) => {
    expect(parseRosterUpdate(text)).toBeUndefined();
  });

  it('the reason is matched to recognize the sentence and never appears in the result', () => {
    const r = parseRosterUpdate("Henry's sick");
    expect(JSON.stringify(r)).not.toMatch(/sick/i);
    expect(Object.keys(r!)).toEqual(['who', 'status']);
  });

  it('resolveMemberName: one case-insensitive match, ids pass through, ambiguity ⇒ undefined', () => {
    const { members } = world();
    expect(resolveMemberName(members, 'henry')).toBe('mem_henry');
    expect(resolveMemberName(members, 'mem_crowley')).toBe('mem_crowley');
    expect(resolveMemberName(members, 'Nobody')).toBeUndefined();
    const twins = [...members, { ...members[0]!, memberId: 'mem_dean2', senderId: 'h_dean2' }];
    expect(resolveMemberName(twins, 'Dean')).toBeUndefined();
  });
});

describe('renderRollCall / renderAttendanceLine (VOICE §3)', () => {
  const lint = (text: string, names: string[]) =>
    safety.lintVoice(text, { kind: 'reply', properNouns: names });

  it('at most 4 lines, in/out/maybe/unanswered, lowercase, lint-clean', () => {
    const { stores, members, activity } = world();
    mark(stores, 'mem_henry', 'out');
    mark(stores, 'mem_crowley', 'maybe');
    const roster = rosterOf(stores.group.trips, ACT, members, BARCELONA_NOW);
    const text = renderRollCall(activity, roster, members, TZ, BARCELONA_NOW);
    expect(text.split('\n')).toEqual([
      'razzmatazz tonight: 4 in · Dean, Chase, Piotr, Arjun',
      'out: Henry',
      'maybe: Crowley (counts as out when i book)',
    ]);
    expect(
      lint(
        text,
        members.map((m) => m.displayName),
      ).violations,
    ).toEqual([]);
  });

  it('nobody in yet + unanswered members, and a non-tonight activity shows its day and time', () => {
    const { members, activity } = world();
    const empty: Roster = {
      activityId: ACT,
      inMemberIds: [],
      outMemberIds: ['mem_henry'],
      maybeMemberIds: [],
      asOf: BARCELONA_NOW,
    };
    const text = renderRollCall(
      { ...activity, startsAt: '2026-03-16T00:30:00+01:00' },
      empty,
      members,
      TZ,
      BARCELONA_NOW,
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('razzmatazz tomorrow night 12:30am: nobody marked in yet');
    expect(lines[1]).toBe('out: Henry');
    expect(lines[2]).toBe("haven't said: Dean, Chase, Piotr, Arjun, Crowley");
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(
      lint(
        text,
        members.map((m) => m.displayName),
      ).violations,
    ).toEqual([]);
  });

  it('the attendance line names the member and the new count, never a reason', () => {
    const { stores, members, activity } = world();
    mark(stores, 'mem_henry', 'out');
    const roster = rosterOf(stores.group.trips, ACT, members, BARCELONA_NOW);
    expect(renderAttendanceLine(activity, roster, members, 'mem_henry', 'out')).toBe(
      'Henry is out for razzmatazz. that leaves 5',
    );
    expect(renderAttendanceLine(activity, roster, members, 'mem_dean', 'in')).toBe(
      "Dean is in for razzmatazz. that's 5 now",
    );
    expect(renderAttendanceLine(activity, roster, members, 'mem_crowley', 'maybe')).toBe(
      'Crowley is a maybe for razzmatazz. maybes count as out when i book',
    );
  });
});

describe('handleRosterMessage (the roster turn)', () => {
  function turn(stores: Stores, text: string, from = 'mem_dean') {
    const members = stores.group.members.listByGroup(G);
    return handleRosterMessage({
      group: stores.group,
      trip: stores.group.trips.get(BARCELONA.tripId)!,
      members,
      me: members.find((m) => m.memberId === from)!,
      text,
      messageId: 'msg_t',
      now: BARCELONA_NOW,
    });
  }

  it('expectInCount (T-066): a mismatching headcount returns undefined before any write; a matching one is handled', () => {
    const { stores } = world();
    mark(stores, 'mem_henry', 'out');
    const members = stores.group.members.listByGroup(G);
    const input = (text: string, expectInCount: number) => ({
      group: stores.group,
      trip: stores.group.trips.get(BARCELONA.tripId)!,
      members,
      me: members.find((m) => m.memberId === 'mem_dean')!,
      text,
      messageId: 'msg_t',
      now: BARCELONA_NOW,
      expectInCount,
    });
    const henry = () =>
      stores.group.trips.listAttendance(ACT).find((a) => a.memberId === 'mem_henry')?.status;
    const auditBefore = stores.group.audit.listByGroup(G).length;
    // Henry back in makes 6, not 7: nothing is written.
    expect(handleRosterMessage(input("henry's in", 7))).toBeUndefined();
    expect(henry()).toBe('out');
    expect(stores.group.audit.listByGroup(G).length).toBe(auditBefore);
    // A roll call never satisfies a headcount.
    expect(handleRosterMessage(input("who's in tonight?", 5))).toBeUndefined();
    // 6 matches: the usual change.
    const ok = handleRosterMessage(input("henry's in", 6));
    expect(ok?.kind).toBe('changed');
    expect(henry()).toBe('in');
  });

  it("a roll call renders the roster of tonight's activity and writes nothing", () => {
    const { stores } = world();
    const before = stores.group.audit.listByGroup(G).length;
    const r = turn(stores, "@trav who's in tonight?");
    expect(r?.kind).toBe('roll_call');
    expect(r?.text).toBe('razzmatazz tonight: 6 in · Dean, Henry, Chase, Piotr, Arjun, Crowley');
    expect(stores.group.audit.listByGroup(G).length).toBe(before);
  });

  it('"Henry\'s sick" marks Henry out with a notice carrying ids only; the reason is nowhere', () => {
    const { stores } = world();
    const r = turn(stores, "@trav Henry's sick");
    expect(r?.kind).toBe('changed');
    if (r?.kind !== 'changed') return;
    expect(r.text).toBe('Henry is out for razzmatazz. that leaves 5');
    expect(r.notice).toEqual({
      groupId: G,
      activityId: ACT,
      changes: [{ memberId: 'mem_henry', status: 'out' }],
      by: 'mem_dean',
      messageId: 'msg_t',
    });
    const dump = JSON.stringify({
      rows: stores.group.trips.listAttendance(ACT),
      audit: stores.group.audit.listByGroup(G),
      memory: stores.group.groupMemory.listByGroup(G),
    });
    expect(dump).not.toMatch(/sick/i);
  });

  it('first person binds to the sender; the same status twice is "unchanged"', () => {
    const { stores } = world();
    const first = turn(stores, "i'm out tonight", 'mem_crowley');
    expect(first?.kind).toBe('changed');
    expect(first?.text).toBe('Crowley is out for razzmatazz. that leaves 5');
    const again = turn(stores, "i'm out tonight", 'mem_crowley');
    expect(again?.kind).toBe('unchanged');
    expect(again?.text).toBe("Crowley is already out for razzmatazz. that's 5 in");
  });

  it('an unknown name, a named activity that is not planned, or a non-roster sentence ⇒ undefined', () => {
    const { stores } = world();
    expect(turn(stores, "@trav Hnery's sick")).toBeUndefined();
    expect(turn(stores, '@trav Crowley is going to be late')).toBeUndefined();
    expect(turn(stores, '@trav what are we doing tonight')).toBeUndefined();
  });

  it('nothing on the plan: a roll call says so, a third-person override is left alone', () => {
    const { stores } = world();
    const act = stores.group.trips.getActivity(ACT)!;
    stores.group.trips.upsertActivity({
      ...act,
      startsAt: '2026-03-10T22:00:00+01:00',
      endsAt: '2026-03-11T04:00:00+01:00',
    });
    expect(turn(stores, "@trav who's in tonight?")).toEqual({
      kind: 'no_activity',
      text: 'nothing on the plan for tonight yet',
    });
    expect(turn(stores, "@trav Henry's sick")).toBeUndefined();
  });

  describe('time qualifiers: "tomorrow" is tomorrow night, never tonight', () => {
    const apolo = (stores: Stores): Activity => {
      const act = stores.group.trips.getActivity(ACT)!;
      const a: Activity = {
        ...act,
        activityId: 'act_bcn_apolo',
        name: 'Apolo',
        venue: 'Sala Apolo',
        startsAt: '2026-03-16T00:30:00+01:00',
        endsAt: '2026-03-16T05:00:00+01:00',
      };
      stores.group.trips.upsertActivity(a);
      return a;
    };
    const razzRows = (stores: Stores) =>
      stores.group.trips.listAttendance(ACT).map((r) => [r.memberId, r.status]);

    it('"Chase is out tomorrow" marks Chase out of tomorrow\'s activity; tonight\'s roster is untouched', () => {
      const { stores } = world();
      const a = apolo(stores);
      const before = razzRows(stores);
      const r = turn(stores, '@trav Chase is out tomorrow');
      expect(r?.kind).toBe('changed');
      if (r?.kind !== 'changed') return;
      expect(r.activity.activityId).toBe(a.activityId);
      expect(r.text).toBe('Chase is out for apolo. that leaves 0');
      expect(r.notice).toMatchObject({
        activityId: a.activityId,
        changes: [{ memberId: 'mem_chase', status: 'out' }],
      });
      expect(razzRows(stores)).toEqual(before);
      expect(stores.group.trips.listAttendance(a.activityId)).toHaveLength(1);
    });

    it('"who is in tomorrow?" rolls tomorrow\'s activity, with its day and time', () => {
      const { stores } = world();
      apolo(stores);
      const r = turn(stores, '@trav who is in tomorrow?');
      expect(r?.kind).toBe('roll_call');
      expect(r?.text.split('\n')[0]).toBe('apolo tomorrow night 12:30am: nobody marked in yet');
      expect(turn(stores, "@trav who's in tonight?")?.text).toMatch(/^razzmatazz tonight: 6 in/);
    });

    it('nothing planned tomorrow: the roll call says so, "X is out tomorrow" writes nothing and never touches tonight', () => {
      const { stores } = world();
      const before = razzRows(stores);
      const audits = stores.group.audit.listByGroup(G).length;
      expect(turn(stores, '@trav who is in tomorrow?')).toEqual({
        kind: 'no_activity',
        text: 'nothing on the plan for tomorrow yet',
      });
      expect(turn(stores, '@trav Chase is out tomorrow')).toBeUndefined();
      expect(turn(stores, "@trav Chase's sick tmrw")).toBeUndefined();
      expect(razzRows(stores)).toEqual(before);
      expect(stores.group.audit.listByGroup(G).length).toBe(audits);
      // First person with nothing planned: the same one-liner, no row.
      expect(turn(stores, "@trav i'm out tomorrow", 'mem_chase')).toEqual({
        kind: 'no_activity',
        text: 'nothing on the plan for tomorrow yet',
      });
      expect(razzRows(stores)).toEqual(before);
    });

    it('"who\'s in tonight?" with only tomorrow planned does not answer about tomorrow', () => {
      const { stores } = world();
      apolo(stores);
      const act = stores.group.trips.getActivity(ACT)!;
      stores.group.trips.upsertActivity({
        ...act,
        startsAt: '2026-03-10T22:00:00+01:00',
        endsAt: '2026-03-11T04:00:00+01:00',
      });
      expect(turn(stores, "@trav who's in tonight?")).toEqual({
        kind: 'no_activity',
        text: 'nothing on the plan for tonight yet',
      });
    });
  });
});

describe('a minor named onto an adult-only plan (T-153, single overrides)', () => {
  function minorWorld(): ReturnType<typeof world> {
    const w = world();
    const crowley = w.members.find((m) => m.memberId === 'mem_crowley')!;
    w.stores.group.members.upsert({ ...crowley, birthDate: '2010-05-01', ageBand: 'under18' });
    return { ...w, members: w.stores.group.members.listByGroup(G) };
  }
  function say(stores: Stores, text: string, from: string, expectInCount?: number) {
    const members = stores.group.members.listByGroup(G);
    return handleRosterMessage({
      group: stores.group,
      trip: stores.group.trips.get(BARCELONA.tripId)!,
      members,
      me: members.find((m) => m.memberId === from)!,
      text,
      messageId: 'msg_t',
      now: BARCELONA_NOW,
      ...(expectInCount !== undefined ? { expectInCount } : {}),
    });
  }
  const crowley = (stores: Stores) =>
    stores.group.trips.listAttendance(ACT).find((a) => a.memberId === 'mem_crowley')?.status;

  it('"@trav crowley is in" for 18+ razzmatazz: nothing written, the adults-only line, no age', () => {
    const { stores } = minorWorld();
    for (const id of ['mem_dean', 'mem_henry', 'mem_chase', 'mem_piotr', 'mem_arjun']) {
      mark(stores, id, 'in');
    }
    mark(stores, 'mem_crowley', 'out');
    const before = stores.group.audit.listByGroup(G).length;
    for (const text of [
      '@trav crowley is in',
      "@trav crowley's in for razzmatazz",
      '@trav count crowley in',
    ]) {
      const r = say(stores, text, 'mem_dean');
      expect(r?.kind, text).toBe('kept_off');
      if (r?.kind !== 'kept_off') return;
      expect(r.memberIds).toEqual(['mem_crowley']);
      expect(r.notice).toBeUndefined();
      expect(r.text).toBe("Crowley stays off this plan, it's not all-ages. that's 5 in");
      expect(r.text).not.toMatch(/\b(?:1[0-7]|under|age|minor|kid|child|adults?)\b/i);
      expect(
        safety.lintVoice(r.text, { kind: 'reply', properNouns: ['Crowley'] }).violations,
      ).toEqual([]);
    }
    expect(crowley(stores)).toBe('out');
    expect(stores.group.audit.listByGroup(G).length).toBe(before);
  });

  it('a stale in or maybe row for the minor is set to out in the same turn, audited with ids only', () => {
    for (const stale of ['in', 'maybe'] as const) {
      const { stores } = minorWorld();
      mark(stores, 'mem_crowley', stale);
      const r = say(stores, '@trav crowley is in', 'mem_dean');
      expect(r?.kind).toBe('kept_off');
      if (r?.kind !== 'kept_off') return;
      expect(r.notice?.changes).toEqual([{ memberId: 'mem_crowley', status: 'out' }]);
      expect(crowley(stores)).toBe('out');
      const last = stores.group.audit.listByGroup(G).at(-1)!;
      expect(last.type).toBe('roster.changed');
      expect(last.payload).toEqual({
        activityId: ACT,
        changes: [{ memberId: 'mem_crowley', status: 'out' }],
        sourceMessageId: 'msg_t',
      });
      // A second ask writes nothing more.
      const n = stores.group.audit.listByGroup(G).length;
      expect(say(stores, '@trav crowley is in', 'mem_dean')?.kind).toBe('kept_off');
      expect(stores.group.audit.listByGroup(G).length).toBe(n);
    }
  });

  it('unknown age is kept off an 18+ plan until a lead confirms everyone is 18+ (SAFETY §2.7)', () => {
    const { stores } = minorWorld();
    const m = stores.group.members.get('mem_chase')!;
    const { birthDate: _b, ...rest } = m;
    stores.group.members.upsert({ ...rest, ageBand: 'unknown' });
    const g = stores.group.groups.get(G)!;
    stores.group.groups.update({ ...g, settings: { ...g.settings, allAdultsConfirmed: false } });
    mark(stores, 'mem_chase', 'out');
    expect(say(stores, "@trav chase's in", 'mem_dean')?.kind).toBe('kept_off');
    expect(
      stores.group.trips.listAttendance(ACT).find((a) => a.memberId === 'mem_chase')?.status,
    ).toBe('out');
    stores.group.groups.update({ ...g, settings: { ...g.settings, allAdultsConfirmed: true } });
    expect(say(stores, "@trav chase's in", 'mem_dean')?.kind).toBe('changed');
  });

  it('a maybe, "count me in" from the minor, and a headcount tail are all kept off; an earlier "out" stays', () => {
    const { stores } = minorWorld();
    mark(stores, 'mem_crowley', 'out');
    const before = stores.group.audit.listByGroup(G).length;
    expect(say(stores, "@trav crowley's a maybe for razzmatazz", 'mem_dean')?.kind).toBe(
      'kept_off',
    );
    expect(say(stores, '@trav count me in', 'mem_crowley')?.kind).toBe('kept_off');
    expect(say(stores, "crowley's in", 'mem_dean', 6)?.kind).toBe('kept_off');
    expect(crowley(stores)).toBe('out');
    expect(stores.group.audit.listByGroup(G).length).toBe(before);
  });

  it('marking the minor out still works', () => {
    const { stores } = minorWorld();
    const r = say(stores, "@trav crowley's out", 'mem_dean');
    expect(r?.kind).toBe('changed');
    expect(crowley(stores)).toBe('out');
  });

  it('an all-ages plan: the minor is written in as usual', () => {
    const { stores } = minorWorld();
    const razz = stores.group.trips.getActivity(ACT)!;
    stores.group.trips.upsertActivity({ ...razz, ageRestriction: null, contentTags: [] });
    mark(stores, 'mem_crowley', 'out');
    expect(say(stores, '@trav crowley is in', 'mem_dean')?.kind).toBe('changed');
    expect(crowley(stores)).toBe('in');
  });

  it('an adult in the same group is written in as usual', () => {
    const { stores } = minorWorld();
    mark(stores, 'mem_henry', 'out');
    expect(say(stores, "@trav henry's in", 'mem_dean')?.kind).toBe('changed');
  });
});

describe('roster turns through the loop (offline, no model)', () => {
  it('"@trav crowley is in" with Crowley under 18: kept off, no model call, no roster write (T-153)', async () => {
    const h = harness();
    const stores = h.runtime.stores;
    const crowleyM = stores.group.members.listByGroup(G).find((m) => m.memberId === 'mem_crowley')!;
    stores.group.members.upsert({ ...crowleyM, birthDate: '2010-05-01', ageBand: 'under18' });
    mark(stores, 'mem_crowley', 'out');
    const turn = await h.say('h_dean', '@trav crowley is in');
    expect(turn.note).toBe('roster:kept_off');
    expect(h.model.completions).toEqual([]);
    expect(messages(turn)).toHaveLength(1);
    // Reaches the chat: the outbound screen in a group with a minor lets it through.
    expect(messages(turn)[0]!.text).toBe(
      "Crowley stays off this plan, it's not all-ages. that's 5 in",
    );
    expect(
      stores.group.trips.listAttendance(ACT).find((a) => a.memberId === 'mem_crowley')?.status,
    ).toBe('out');
    expect(h.audit().filter((e) => e.type === 'roster.changed')).toEqual([]);
  });

  it('"@trav who\'s in tonight?" is answered without a model call', async () => {
    const h = harness();
    const turn = await h.say('h_dean', "@trav who's in tonight?");
    expect(turn.note).toBe('roster:roll_call');
    expect(turn.modelSources).toEqual([]);
    expect(h.model.completions).toEqual([]);
    expect(messages(turn)[0]?.text).toBe(
      'razzmatazz tonight: 6 in · Dean, Henry, Chase, Piotr, Arjun, Crowley',
    );
  });

  it('"@trav Henry\'s sick" updates the roster, audits ids only, and the next roll call reflects it', async () => {
    const h = harness();
    const out = await h.say('h_dean', "@trav Henry's sick");
    expect(out.note).toBe('roster:changed');
    expect(messages(out)[0]?.text).toBe('Henry is out for razzmatazz. that leaves 5');
    const changed = h.audit().filter((e) => e.type === 'roster.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({
      activityId: BARCELONA.razzmatazzActivityId,
      changes: [{ memberId: 'mem_henry', status: 'out' }],
    });
    expect(JSON.stringify(h.audit())).not.toMatch(/sick/i);
    const roll = await h.say('h_chase', "@trav who's in?");
    expect(messages(roll)[0]?.text.split('\n')).toEqual([
      'razzmatazz tonight: 5 in · Dean, Chase, Piotr, Arjun, Crowley',
      'out: Henry',
    ]);
    expect(h.model.completions).toEqual([]);
  });

  it('an answer inside the reply window ("henry is out" after Trav asked who\'s in) is a roster override', async () => {
    const h = harness();
    const ask = await h.say('h_chase', '@trav get the 4 of us Razzmatazz tickets');
    expect(ask.note).toBe('tool:propose_booking:clarify');
    const turn = await h.say('h_arjun', 'henry is out');
    expect(turn.note).toBe('roster:changed');
    expect(messages(turn)[0]?.text).toBe('Henry is out for razzmatazz. that leaves 5');
    expect(h.model.completions).toHaveLength(1);
  });

  it('guests cannot touch the roster; a member marking a guest-looking name gets nothing', async () => {
    const h = harness();
    const guest = await h.say('h_ava', "@trav i'm in");
    expect(guest.note).toBe('guest:refused');
    expect(h.audit().filter((e) => e.type === 'roster.changed')).toEqual([]);
    const unknown = await h.say('h_dean', "@trav Ava's in");
    expect(unknown.note).not.toBe('roster:changed');
    expect(h.audit().filter((e) => e.type === 'roster.changed')).toEqual([]);
  });

  it('"@trav who\'s in tomorrow?" with nothing planned tomorrow says so, without touching tonight', async () => {
    const h = harness();
    const turn = await h.say('h_dean', "@trav who's in tomorrow?");
    expect(turn.note).toBe('roster:no_activity');
    expect(messages(turn)[0]?.text).toBe('nothing on the plan for tomorrow yet');
    const out = await h.say('h_dean', '@trav Chase is out tomorrow');
    expect(out.note).not.toBe('roster:changed');
    expect(h.audit().filter((e) => e.type === 'roster.changed')).toEqual([]);
    const roll = await h.say('h_dean', "@trav who's in tonight?");
    expect(messages(roll)[0]?.text).toBe(
      'razzmatazz tonight: 6 in · Dean, Henry, Chase, Piotr, Arjun, Crowley',
    );
  });

  it('a maybe is listed separately and flagged as out for booking', async () => {
    const h = harness();
    const turn = await h.say('h_crowley', '@trav maybe');
    expect(messages(turn)[0]?.text).toBe(
      'Crowley is a maybe for razzmatazz. maybes count as out when i book',
    );
    const roll = await h.say('h_dean', "@trav who's in tonight?");
    expect(messages(roll)[0]?.text).toContain('maybe: Crowley (counts as out when i book)');
  });
});

describe('parseTicketForMe (T-137)', () => {
  it.each([
    ['@trav can i get one too in case i feel better later', {}],
    ['@trav can i get one too', {}],
    ['trav, could i grab a ticket too pls', {}],
    ['@trav get me one too', {}],
    ['@trav grab me a ticket for razzmatazz too', { hint: 'razzmatazz' }],
    ['@trav can i have one tonight as well, just in case', { when: 'tonight' }],
    ["@trav i'll take one too", {}],
  ])('"%s" ⇒ %o, the reason dropped', (text, want) => {
    const got = parseTicketForMe(text);
    expect(got).toEqual(want);
    expect(JSON.stringify(got)).not.toMatch(/feel|better|case/);
  });

  it.each([
    '@trav can i get one',
    '@trav get crowley one too',
    '@trav can i get the vip one too and a table',
    '@trav can i get one too? also what time is it',
    "@trav i'm in",
    '@trav can you book 6 tickets too',
    // r1 #2: a tail that is a condition or a second request is the model's.
    '@trav get me one too if dean pays, and book crowley a vip table',
    '@trav get me one too if dean pays',
    '@trav can i get one too in case i feel better and book crowley one',
    '@trav can i get one too in case; also log the taxi',
    '@trav can i get one too if crowley splits it with me',
    '@trav can i get one too for later, put it on my card',
    // r2 #3: a sentence end inside the tail starts a second clause.
    '@trav can i get one too in case i feel better. crowley wants one',
    '@trav can i get one too in case i feel better? crowley too',
  ])('"%s" is not', (text) => {
    expect(parseTicketForMe(text)).toBeUndefined();
  });
});

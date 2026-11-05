/**
 * T-082: combined roster sentences ("it's the 5 of us tonight, henry's out",
 * "all 6, henry's back. razzmatazz"): parse, plan, the roster turn, and the
 * loop (offline, no model).
 */
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
import { harness } from '../runtime.testkit.js';
import { bundledVenueIndex } from '../model/offline/asks.js';
import {
  isKnownPlace,
  parseCombinedRoster,
  placeLabel,
  planParty,
  renderVenueCheck,
  weekdayOf,
  type VenueSearchResult,
} from './combined.js';
import { rosterOf } from './index.js';
import { handleRosterMessage } from './turn.js';

const G = BARCELONA.groupId;
const T = BARCELONA.tripId;
const RAZZ = BARCELONA.razzmatazzActivityId;
const ORDER = ['mem_dean', 'mem_henry', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'];
const NOT_HENRY = ORDER.filter((id) => id !== 'mem_henry');
/** Words that would mean a reason leaked (SAFETY §2.8). */
const REASON = /\b(?:sick|ill|hungover|unwell|fever|feel(?:s|ing)? (?:off|bad))\b/i;

/** Friday's bars (msg_bcn_0100's night) and Monday's last night out (msg_bcn_0164's), as in fixtures/groups/barcelona.json. */
const ELBORN: Activity = {
  activityId: 'act_bcn_elborn_d2',
  tripId: T,
  groupId: G,
  kind: 'nightlife',
  name: 'bars in El Born',
  venue: 'El Born',
  startsAt: '2026-03-13T23:30:00+01:00',
  contentTags: ['nightlife', 'bar', 'alcohol', 'late_night'],
  ageRestriction: null,
  createdAt: '2026-03-10T12:30:00-04:00',
};
const CLUB_D5: Activity = {
  activityId: 'act_bcn_club_d5',
  tripId: T,
  groupId: G,
  kind: 'nightlife',
  name: 'last night out (Apolo)',
  venue: 'Sala Apolo',
  startsAt: '2026-03-16T23:59:00+01:00',
  endsAt: '2026-03-17T05:00:00+01:00',
  contentTags: ['nightlife', 'club', '18+', 'alcohol', 'late_night'],
  ageRestriction: 18,
  createdAt: '2026-03-10T12:30:00-04:00',
};
const FRI_2334 = '2026-03-13T23:34:00+01:00';
const MON_1702 = '2026-03-16T17:02:00+01:00';

function world(): { stores: Stores; members: readonly Member[] } {
  const clock = createSimulatedClock(BARCELONA_NOW);
  const stores = createMemoryStores({ clock, ids: createDeterministicIdGenerator('c') });
  seedBarcelona(stores);
  stores.group.trips.upsertActivity(ELBORN);
  stores.group.trips.upsertActivity(CLUB_D5);
  return { stores, members: stores.group.members.listByGroup(G) };
}

function mark(
  stores: Stores,
  activityId: string,
  memberId: string,
  status: 'in' | 'out' | 'maybe',
): void {
  stores.group.trips.setAttendance({
    activityId,
    memberId,
    status,
    updatedAt: BARCELONA_NOW,
    sourceMessageId: 'msg_seed',
    setBy: memberId,
  });
}

function turn(stores: Stores, text: string, now: string, from = 'mem_sam') {
  const members = stores.group.members.listByGroup(G);
  return handleRosterMessage({
    group: stores.group,
    trip: stores.group.trips.get(T)!,
    members,
    me: members.find((m) => m.memberId === from)!,
    text,
    messageId: 'msg_c',
    now,
    isKnownPlace: (hint) => isKnownPlace(bundledVenueIndex(), hint),
  });
}

/** Reason-shaped clauses a denylist would miss: never a place, never searched, never echoed. */
const REASON_CLAUSES = [
  'has a cold',
  'food poisoning',
  'period cramps',
  'anxiety',
  'throwing up',
  'feeling rough',
  'broke up',
  'at the hospital',
];

function statuses(stores: Stores, activityId: string): Record<string, string> {
  return Object.fromEntries(
    stores.group.trips.listAttendance(activityId).map((a) => [a.memberId, a.status]),
  );
}

function messages(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}

const lint = (text: string) =>
  safety.lintVoice(text, {
    kind: 'reply',
    properNouns: [...BARCELONA.members.map((m) => m.name), 'Razzmatazz', 'Apolo'],
  }).violations;

describe('parseCombinedRoster', () => {
  it('msg_bcn_0100: headcount for tonight + one exclusion; the reason never reaches the result', () => {
    const p = parseCombinedRoster("@trav it's the 5 of us tonight, henry's out");
    expect(p).toEqual({
      count: 5,
      all: false,
      changes: [{ who: 'henry', status: 'out' }],
      when: 'tonight',
    });
    const sick = parseCombinedRoster("@trav it's the 5 of us tonight, Henry's sick");
    expect(sick).toEqual({
      count: 5,
      all: false,
      changes: [{ who: 'Henry', status: 'out' }],
      when: 'tonight',
    });
    expect(JSON.stringify(sick)).not.toMatch(REASON);
  });

  it('msg_bcn_0164: "all 6" + a return + a place name', () => {
    expect(parseCombinedRoster("all 6, henry's back. razzmatazz")).toEqual({
      count: 6,
      all: true,
      changes: [{ who: 'henry', status: 'in' }],
      hint: 'razzmatazz',
    });
  });

  it('other shapes: number words, "we\'re", first person, pairs, "everyone", place inside the headcount, tomorrow', () => {
    expect(parseCombinedRoster("@trav we're five tonight, maya's out")).toMatchObject({
      count: 5,
      changes: [{ who: 'maya', status: 'out' }],
      when: 'tonight',
    });
    expect(parseCombinedRoster("trav, 4 of us, i'm out")).toMatchObject({
      count: 4,
      changes: [{ who: 'me', status: 'out' }],
    });
    expect(parseCombinedRoster('@trav just the 4 of us, henry and maya are out')).toMatchObject({
      count: 4,
      changes: [
        { who: 'henry', status: 'out' },
        { who: 'maya', status: 'out' },
      ],
    });
    expect(parseCombinedRoster("@trav everyone's in, henry's back")).toEqual({
      all: true,
      changes: [{ who: 'henry', status: 'in' }],
    });
    expect(parseCombinedRoster("@trav the 5 of us for apolo tomorrow, sam's out")).toMatchObject({
      count: 5,
      hint: 'apolo',
      when: 'tomorrow',
    });
    expect(parseCombinedRoster("all 6 - henry's back in too")).toMatchObject({
      count: 6,
      changes: [{ who: 'henry', status: 'in' }],
    });
  });

  it('not this form: booking asks, ticket words, questions, a second request, no headcount, no change', () => {
    for (const text of [
      // The flagship goes to the booking path, never here.
      "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
      "trav: get the 5 of us Razzmatazz tickets, Henry's sick",
      "@trav it's 5 of us, henry's out, book razz",
      "@trav 5 of us, henry's out, razzmatazz tickets",
      "@trav it's the 5 of us tonight, henry's out, can you log the taxi",
      "@trav it's the 5 of us tonight, is henry out?",
      "@trav henry's sick",
      "@trav it's the 5 of us tonight",
      "@trav henry's back",
      "@trav all 6, henry's back, he was sick",
      "@trav 5 of us, henry's out, sick",
      "@trav 5 of us, henry's out for sick reasons",
      '@trav make it 6, henry is in',
      "@trav it's 5 of us, 6 of us, henry's out",
      "@trav 5 tonight, henry's out tomorrow",
    ]) {
      expect(parseCombinedRoster(text), text).toBeUndefined();
    }
  });
});

describe('planParty', () => {
  const { members } = world();
  const roster = (inIds: string[], out: string[] = [], maybe: string[] = []): Roster => ({
    activityId: 'a',
    inMemberIds: inIds,
    outMemberIds: out,
    maybeMemberIds: maybe,
    asOf: BARCELONA_NOW,
  });
  const henryOut = [{ memberId: 'mem_henry', status: 'out' as const }];

  it('nobody has answered: the headcount fills everyone but the named outs', () => {
    expect(
      planParty({ members, roster: roster([]), changes: henryOut, count: 5, all: false }),
    ).toEqual({
      kind: 'write',
      rows: ORDER.map((memberId) => ({
        memberId,
        status: memberId === 'mem_henry' ? 'out' : 'in',
      })),
    });
  });

  it('the named change alone makes the count: only that row is written', () => {
    expect(
      planParty({ members, roster: roster(ORDER), changes: henryOut, count: 5, all: false }),
    ).toEqual({
      kind: 'write',
      rows: [{ memberId: 'mem_henry', status: 'out' }],
    });
  });

  it('a recorded "out" or "maybe" is never overridden by a headcount: one question instead', () => {
    const plan = planParty({
      members,
      roster: roster(['mem_dean', 'mem_maya', 'mem_priya'], [], ['mem_jordan']),
      changes: [{ memberId: 'mem_henry', status: 'in' }],
      count: 6,
      all: true,
    });
    expect(plan).toEqual({
      kind: 'mismatch',
      text: "you said 6, but i've only got 5: Dean, Henry, Maya, Priya, Sam. who else is in?",
    });
  });

  it('too many: "who else is out?"; nobody: "who\'s in?"; members never filled are left out', () => {
    expect(
      planParty({ members, roster: roster([]), changes: henryOut, count: 4, all: false }),
    ).toEqual({
      kind: 'mismatch',
      text: "you said 4, but that's 5: Dean, Maya, Jordan, Priya, Sam. who else is out?",
    });
    expect(
      planParty({
        members,
        roster: roster([]),
        changes: henryOut,
        count: 2,
        all: false,
        noFill: new Set(NOT_HENRY),
      }),
    ).toEqual({ kind: 'mismatch', text: "you said 2, but i've got nobody in yet. who's in?" });
  });

  it('short only because a minor is kept off an adult-only plan: says so, never asks for the seat', () => {
    const plan = planParty({
      members,
      roster: roster([]),
      changes: [{ memberId: 'mem_henry', status: 'in' }],
      count: 6,
      all: true,
      noFill: new Set(['mem_sam']),
    });
    expect(plan).toEqual({
      kind: 'mismatch',
      text: "that's 5 for this one: Dean, Henry, Maya, Jordan, Priya. Sam stays off this plan, it's not all-ages",
      keptOff: ['mem_sam'],
    });
    expect(plan.kind === 'mismatch' && plan.text.includes('?')).toBe(false);
    expect(plan.kind === 'mismatch' && lint(plan.text)).toEqual([]);
  });

  it('"everyone" without a number: the whole roster minus the named outs', () => {
    const plan = planParty({ members, roster: roster([]), changes: henryOut, all: true });
    expect(plan.kind).toBe('write');
    expect(plan.kind === 'write' && plan.rows.filter((r) => r.status === 'in')).toHaveLength(5);
  });

  it('every question is lint-clean and ends with the question (VOICE §4.11)', () => {
    const plan = planParty({
      members,
      roster: roster([]),
      changes: henryOut,
      count: 4,
      all: false,
    });
    expect(plan.kind === 'mismatch' && plan.text.endsWith('?')).toBe(true);
    expect(plan.kind === 'mismatch' && lint(plan.text)).toEqual([]);
  });
});

describe('renderVenueCheck', () => {
  const night = '2026-03-16';
  const nightOfEvent = (at: string): string => at.slice(0, 10);
  const ev = (startsAt: string, adultsOnly = true) => ({
    startsAt,
    adultsOnly,
    bookable: true,
    from: { text: '€18' },
  });

  it('nothing that night: says so with the weekday, and that nothing was booked', () => {
    const res: VenueSearchResult = { events: [ev('2026-03-15T23:00:00+01:00')] };
    const text = renderVenueCheck('razzmatazz', night, res, nightOfEvent);
    expect(text).toBe("nothing at Razzmatazz monday night, so nothing's booked");
    expect(lint(text)).toEqual([]);
  });

  it('something that night: the place, the night and the price; never a proposal', () => {
    const text = renderVenueCheck(
      'apolo',
      night,
      { events: [ev('2026-03-16T23:30:00+01:00')] },
      nightOfEvent,
    );
    expect(text).toBe("monday night at Apolo: from €18 each. nothing's booked yet");
    expect(lint(text)).toEqual([]);
  });

  it("the member's words are named only when that stays within the voice rules", () => {
    expect(renderVenueCheck('kindly', night, { events: [] }, nightOfEvent)).toBe(
      "nothing at that place monday night, so nothing's booked",
    );
  });

  it('family mode never names an adults-only place; a provider error says nothing was booked', () => {
    const fam: VenueSearchResult = { events: [ev('2026-03-16T23:30:00+01:00')], familyMode: true };
    expect(renderVenueCheck('razzmatazz', night, fam, nightOfEvent)).toBe(
      "nothing all-ages there monday night, so nothing's booked",
    );
    expect(
      renderVenueCheck(
        'razzmatazz',
        night,
        { events: [], note: 'provider unavailable' },
        nightOfEvent,
      ),
    ).toBe("couldn't check that just now, nothing's booked. @ me again in a bit");
    expect(renderVenueCheck('razzmatazz', night, undefined, nightOfEvent)).toBe(
      "couldn't check that just now, nothing's booked. @ me again in a bit",
    );
  });

  it('isKnownPlace: one inventory venue by exact name or alias; reasons, generic words and partial names are not', () => {
    const index = bundledVenueIndex();
    expect(isKnownPlace(index, 'razzmatazz')).toBe(true);
    expect(isKnownPlace(index, 'Razzmatazz')).toBe(true);
    expect(isKnownPlace(index, 'apolo')).toBe(true);
    expect(isKnownPlace(index, 'club')).toBe(false);
    expect(isKnownPlace(index, 'razzmatazz monday')).toBe(false);
    for (const reason of REASON_CLAUSES) expect(isKnownPlace(index, reason), reason).toBe(false);
  });

  it('helpers', () => {
    expect(weekdayOf('2026-03-16')).toBe('monday');
    expect(weekdayOf('2026-03-13')).toBe('friday');
    expect(placeLabel('sala apolo')).toBe('Sala Apolo');
  });
});

describe('handleRosterMessage: combined sentences', () => {
  it('msg_bcn_0100: El Born on friday is 5 in, Henry out; one audit row each, ids only', () => {
    const { stores } = world();
    const r = turn(stores, "@trav it's the 5 of us tonight, henry's sick", FRI_2334);
    expect(r?.kind).toBe('party');
    expect(statuses(stores, ELBORN.activityId)).toEqual({
      ...Object.fromEntries(NOT_HENRY.map((id) => [id, 'in'])),
      mem_henry: 'out',
    });
    expect(r?.text.split('\n')).toEqual([
      'bars in el born tonight: 5 in · Dean, Maya, Jordan, Priya, Sam',
      'out: Henry',
    ]);
    expect(r?.kind === 'party' && r.notice?.changes).toHaveLength(6);
    expect(r?.kind === 'party' && r.venue).toBeUndefined();
    const audit = stores.group.audit.listByGroup(G).filter((e) => e.type === 'roster.changed');
    expect(audit).toHaveLength(6);
    // The reason is nowhere: not in rows, audit, the notice or the reply.
    expect(JSON.stringify(stores.group.audit.listByGroup(G))).not.toMatch(REASON);
    expect(JSON.stringify(stores.group.trips.listAttendance(ELBORN.activityId))).not.toMatch(
      REASON,
    );
    expect(JSON.stringify(r)).not.toMatch(REASON);
    // Saturday's Razzmatazz is untouched (never another night's roster).
    expect(statuses(stores, RAZZ)['mem_henry']).toBe('in');
  });

  it("msg_bcn_0164: Monday's plan is 6 in with Henry back; Razzmatazz is not the plan, so it comes back as a place to check", () => {
    const { stores } = world();
    mark(stores, CLUB_D5.activityId, 'mem_henry', 'out');
    const r = turn(stores, "all 6, henry's back. razzmatazz", MON_1702);
    expect(r?.kind).toBe('party');
    expect(statuses(stores, CLUB_D5.activityId)).toEqual(
      Object.fromEntries(ORDER.map((id) => [id, 'in'])),
    );
    expect(r?.kind === 'party' && r.venue).toEqual({
      query: 'razzmatazz',
      night: '2026-03-16',
      quantity: 6,
    });
    expect(r?.text).toBe(
      'last night out (apolo) tonight: 6 in · Dean, Henry, Maya, Jordan, Priya, Sam',
    );
  });

  it('a place that is on the plan picks that activity and is not searched', () => {
    const { stores } = world();
    const r = turn(stores, "@trav all 6, henry's back. apolo", MON_1702);
    expect(r?.kind === 'party' && r.activity.activityId).toBe(CLUB_D5.activityId);
    expect(r?.kind === 'party' && r.venue).toBeUndefined();
  });

  it('a mismatch asks one question and writes nothing', () => {
    const { stores } = world();
    const before = stores.group.audit.listByGroup(G).length;
    const r = turn(stores, "@trav it's the 4 of us tonight, henry's out", FRI_2334);
    expect(r).toMatchObject({ kind: 'clarify' });
    expect(r?.text).toBe(
      "you said 4, but that's 5: Dean, Maya, Jordan, Priya, Sam. who else is out?",
    );
    expect(stores.group.trips.listAttendance(ELBORN.activityId)).toEqual([]);
    expect(stores.group.audit.listByGroup(G).length).toBe(before);
  });

  it('nothing planned that night says so; an unknown name or a name used as a place is not ours', () => {
    const { stores } = world();
    expect(
      turn(stores, "@trav it's the 5 of us tonight, henry's out", '2026-03-15T20:00:00+01:00'),
    ).toEqual({
      kind: 'no_activity',
      text: 'nothing on the plan for tonight yet',
    });
    expect(turn(stores, "@trav it's the 5 of us tonight, ava's out", FRI_2334)).toBeUndefined();
    expect(turn(stores, "@trav 5 of us, sam's out, henry", FRI_2334)).toBeUndefined();
    expect(turn(stores, "@trav 5 of us, henry's out, henry's in", FRI_2334)).toBeUndefined();
    expect(stores.group.trips.listAttendance(ELBORN.activityId)).toEqual([]);
  });

  it('a free-text "place" that is not a known venue is not ours: a reason is never written, searched or echoed', () => {
    const { stores } = world();
    const before = stores.group.audit.listByGroup(G).length;
    for (const reason of REASON_CLAUSES) {
      const text = `@trav it's the 5 of us tonight, henry's out, ${reason}`;
      expect(turn(stores, text, FRI_2334), text).toBeUndefined();
    }
    // No predicate at all: same (conservative).
    const members = stores.group.members.listByGroup(G);
    expect(
      handleRosterMessage({
        group: stores.group,
        trip: stores.group.trips.get(T)!,
        members,
        me: members.find((m) => m.memberId === 'mem_sam')!,
        text: "all 6, henry's back. razzmatazz",
        messageId: 'msg_c',
        now: MON_1702,
      }),
    ).toBeUndefined();
    expect(stores.group.trips.listAttendance(ELBORN.activityId)).toEqual([]);
    expect(stores.group.audit.listByGroup(G).length).toBe(before);
  });

  it('a minor is never filled into an 18+ plan by a headcount', () => {
    const { stores, members } = world();
    const sam = members.find((m) => m.memberId === 'mem_sam')!;
    stores.group.members.upsert({ ...sam, birthDate: '2010-05-01', ageBand: 'under18' });
    const r = turn(stores, "all 6, henry's back. razzmatazz", MON_1702, 'mem_dean');
    expect(r?.kind).toBe('clarify');
    expect(statuses(stores, CLUB_D5.activityId)['mem_sam']).toBeUndefined();
  });

  describe('a minor named in on an 18+ plan (T-153)', () => {
    function minorWorld(): ReturnType<typeof world> {
      const w = world();
      const sam = w.members.find((m) => m.memberId === 'mem_sam')!;
      w.stores.group.members.upsert({ ...sam, birthDate: '2010-05-01', ageBand: 'under18' });
      return { ...w, members: w.stores.group.members.listByGroup(G) };
    }
    const ADULTS = ORDER.filter((id) => id !== 'mem_sam');
    const LINE = "Sam stays off this plan, it's not all-ages";

    it('"5 of us, sam\'s in": the 5 adults are written, Sam is not, one line says Sam stays off', () => {
      const { stores } = minorWorld();
      const r = turn(stores, "@trav it's the 5 of us tonight, sam's in", MON_1702, 'mem_dean');
      expect(r?.kind).toBe('party');
      if (r?.kind !== 'party') return;
      expect(r.text.split('\n')).toEqual([
        'last night out (apolo) tonight: 5 in · Dean, Henry, Maya, Jordan, Priya',
        LINE,
      ]);
      expect(r.changes.map((c) => c.memberId)).toEqual(ADULTS);
      expect(statuses(stores, CLUB_D5.activityId)).toEqual(
        Object.fromEntries(ADULTS.map((id) => [id, 'in'])),
      );
      expect(r.text).not.toMatch(/\b(?:1[0-7]|under|age|minor|kid|child|adults?)\b/i);
      expect(lint(r.text)).toEqual([]);
    });

    it('an adult and the minor named together: the adult is written, the minor stays off (and an earlier "out" stays)', () => {
      const { stores } = minorWorld();
      mark(stores, CLUB_D5.activityId, 'mem_henry', 'out');
      mark(stores, CLUB_D5.activityId, 'mem_sam', 'out');
      const r = turn(
        stores,
        "@trav it's the 5 of us tonight, henry and sam are in",
        MON_1702,
        'mem_dean',
      );
      expect(r?.kind).toBe('party');
      expect(r?.text.split('\n').at(-1)).toBe(LINE);
      if (r?.kind === 'party') {
        expect(r.notice?.changes.some((c) => c.memberId === 'mem_sam')).toBe(false);
      }
      expect(statuses(stores, CLUB_D5.activityId)).toEqual({
        ...Object.fromEntries(ADULTS.map((id) => [id, 'in'])),
        mem_sam: 'out',
      });
    });

    it('"5 of us tonight, i\'m in" from the minor: Sam is not written in', () => {
      const { stores } = minorWorld();
      const r = turn(stores, "@trav 5 of us tonight, i'm in", MON_1702, 'mem_sam');
      expect(r?.text.split('\n').at(-1)).toBe(LINE);
      expect(statuses(stores, CLUB_D5.activityId)['mem_sam']).toBeUndefined();
    });

    it('"all 6, sam\'s in": one question-free line naming Sam once, nothing written', () => {
      const { stores } = minorWorld();
      const before = stores.group.audit.listByGroup(G).length;
      const r = turn(stores, "@trav all 6, sam's in", MON_1702, 'mem_dean');
      expect(r?.kind).toBe('clarify');
      expect(r?.text).toBe(
        "that's 5 for this one: Dean, Henry, Maya, Jordan, Priya. Sam stays off this plan, it's not all-ages",
      );
      expect(stores.group.trips.listAttendance(CLUB_D5.activityId)).toEqual([]);
      expect(stores.group.audit.listByGroup(G).length).toBe(before);
    });

    it('"6 of us tonight, sam\'s in" with Sam already out: the no-question line, Sam named once', () => {
      const { stores } = minorWorld();
      mark(stores, CLUB_D5.activityId, 'mem_sam', 'out');
      const r = turn(stores, "@trav it's the 6 of us tonight, sam's in", MON_1702, 'mem_dean');
      expect(r?.kind).toBe('clarify');
      expect(r?.text).toBe(`that's 5 for this one: Dean, Henry, Maya, Jordan, Priya. ${LINE}`);
      expect(r?.text).not.toContain('?');
      expect(statuses(stores, CLUB_D5.activityId)).toEqual({ mem_sam: 'out' });
    });

    it('a different mismatch still says Sam stays off, once', () => {
      const { stores } = minorWorld();
      mark(stores, CLUB_D5.activityId, 'mem_sam', 'out');
      const r = turn(stores, "@trav it's the 8 of us tonight, sam's in", MON_1702, 'mem_dean');
      expect(r?.kind).toBe('clarify');
      const text = r?.text ?? '';
      expect(text.split('\n').at(-1)).toBe(LINE);
      expect(text.match(/Sam stays off/g)).toHaveLength(1);
      expect(statuses(stores, CLUB_D5.activityId)).toEqual({ mem_sam: 'out' });
    });

    it('a stale in row for Sam is set to out before the count, so "5 of us, sam\'s in" is the 5 adults', () => {
      const { stores } = minorWorld();
      mark(stores, CLUB_D5.activityId, 'mem_sam', 'in');
      const r = turn(stores, "@trav it's the 5 of us tonight, sam's in", MON_1702, 'mem_dean');
      expect(r?.kind).toBe('party');
      if (r?.kind !== 'party') return;
      expect(r.text.split('\n')).toEqual([
        'last night out (apolo) tonight: 5 in · Dean, Henry, Maya, Jordan, Priya',
        'out: Sam',
        LINE,
      ]);
      expect(r.notice?.changes).toContainEqual({ memberId: 'mem_sam', status: 'out' });
      expect(statuses(stores, CLUB_D5.activityId)).toEqual({
        ...Object.fromEntries(ADULTS.map((id) => [id, 'in'])),
        mem_sam: 'out',
      });
    });

    it('an all-ages plan: naming the minor in writes them as usual', () => {
      const { stores } = minorWorld();
      stores.group.trips.upsertActivity({
        ...CLUB_D5,
        ageRestriction: null,
        contentTags: [],
      });
      const r = turn(stores, "@trav all 6, sam's in", MON_1702, 'mem_dean');
      expect(r?.kind).toBe('party');
      expect(statuses(stores, CLUB_D5.activityId)['mem_sam']).toBe('in');
      expect(r?.text).not.toContain('stays off');
    });
  });

  it('the roster is the only source: what was written is what rosterOf reads back', () => {
    const { stores, members } = world();
    turn(stores, "@trav it's the 5 of us tonight, henry's out", FRI_2334);
    expect(rosterOf(stores.group.trips, ELBORN.activityId, members, FRI_2334).inMemberIds).toEqual(
      NOT_HENRY,
    );
  });
});

describe('combined sentences through the loop (offline, no model)', () => {
  function monday(): ReturnType<typeof harness> {
    const h = harness();
    h.runtime.stores.group.trips.upsertActivity(CLUB_D5);
    h.clock.advanceMs(Date.parse(MON_1702) - Date.parse(BARCELONA_NOW));
    return h;
  }

  it('"@trav all 6, henry\'s back. razzmatazz": 6 in, one search, one message naming monday, no proposal', async () => {
    const h = monday();
    mark(h.runtime.stores, CLUB_D5.activityId, 'mem_henry', 'out');
    const r = await h.say('h_sam', "@trav all 6, henry's back. razzmatazz");
    expect(r.note).toBe('roster:party');
    expect(r.toolCalls).toEqual(['search_events']);
    expect(h.model.completions).toHaveLength(0);
    const out = messages(r);
    expect(out).toHaveLength(1);
    expect(out[0]!.text.split('\n')).toEqual([
      'last night out (apolo) tonight: 6 in · Dean, Henry, Maya, Jordan, Priya, Sam',
      "nothing at Razzmatazz monday night, so nothing's booked",
    ]);
    expect(statuses(h.runtime.stores, CLUB_D5.activityId)).toEqual(
      Object.fromEntries(ORDER.map((id) => [id, 'in'])),
    );
    expect(h.runtime.stores.group.bookings.listPendingProposals(G)).toEqual([]);
  });

  it('the same line inside the reply window after a Trav question is addressed (msg_bcn_0164 is a reply)', async () => {
    const h = monday();
    const ask = await h.say('h_sam', "@trav it's the 4 of us tonight, henry's out");
    expect(ask.note).toBe('roster:clarify');
    h.clock.advanceMs(60_000);
    const r = await h.say('h_sam', "all 6, henry's back. razzmatazz");
    expect(r.note).toBe('roster:party');
    expect(messages(r)[0]!.text).toContain('monday');
    expect(statuses(h.runtime.stores, CLUB_D5.activityId)).toEqual(
      Object.fromEntries(ORDER.map((id) => [id, 'in'])),
    );
  });

  it('T-153: "5 of us tonight, henry and sam are in" with Sam under 18: Sam is not written, the line reaches the chat', async () => {
    // Saturday: Razzmatazz (18+, alcohol) is the plan, everyone seeded in.
    const h = harness();
    const stores = h.runtime.stores;
    const sam = stores.group.members.listByGroup(G).find((m) => m.memberId === 'mem_sam')!;
    stores.group.members.upsert({ ...sam, birthDate: '2010-05-01', ageBand: 'under18' });
    mark(stores, RAZZ, 'mem_henry', 'out');
    mark(stores, RAZZ, 'mem_sam', 'out');
    const r = await h.say('h_dean', "@trav it's the 5 of us tonight, henry and sam are in");
    expect(r.note).toBe('roster:party');
    expect(h.model.completions).toHaveLength(0);
    const texts = messages(r).map((m) => m.text);
    expect(texts[0]!.split('\n')).toEqual([
      'razzmatazz tonight: 5 in · Dean, Henry, Maya, Jordan, Priya',
      'out: Sam',
      "Sam stays off this plan, it's not all-ages",
    ]);
    expect(statuses(stores, RAZZ)['mem_sam']).toBe('out');
    expect(statuses(stores, RAZZ)['mem_henry']).toBe('in');
    const changed = h.audit().filter((e) => e.type === 'roster.changed');
    expect(JSON.stringify(changed)).not.toContain('mem_sam');
  });

  it('T-153: a booking ask naming everyone never writes the minor in on the 18+ roster', async () => {
    const h = harness();
    const stores = h.runtime.stores;
    const sam = stores.group.members.listByGroup(G).find((m) => m.memberId === 'mem_sam')!;
    stores.group.members.upsert({ ...sam, birthDate: '2010-05-01', ageBand: 'under18' });
    mark(stores, RAZZ, 'mem_sam', 'out');
    await h.say(
      'h_dean',
      '@trav get razzmatazz tickets for me, henry, maya, jordan, priya and sam',
    );
    expect(statuses(stores, RAZZ)['mem_sam']).toBe('out');
    expect(h.audit().some((e) => e.type === 'booking.completed')).toBe(false);
  });

  it('unaddressed and outside any window: silence, nothing written', async () => {
    const h = monday();
    const r = await h.say('h_sam', "all 6, henry's back. razzmatazz");
    expect(r.silent).toBe(true);
    expect(h.runtime.stores.group.trips.listAttendance(CLUB_D5.activityId)).toEqual([]);
  });

  it('a place in the inventory that night is priced, and nothing is proposed or bought', async () => {
    const h = harness(); // saturday: Razzmatazz is the plan; Apolo is not
    const r = await h.say('h_sam', "@trav all 6, henry's back. apolo");
    expect(r.note).toBe('roster:party');
    const lines = messages(r)[0]!.text.split('\n');
    expect(lines[1]).toMatch(
      /^saturday night at Apolo: from €\d+(?:\.\d\d)? each\. nothing's booked yet$/,
    );
    expect(h.runtime.stores.group.bookings.listPendingProposals(G)).toEqual([]);
    expect(lint(messages(r)[0]!.text)).toEqual([]);
  });

  it('"henry\'s out, food poisoning": no search, no roster write, the reason never appears in a reply or the audit', async () => {
    const h = monday();
    const r = await h.say('h_sam', "@trav it's the 5 of us tonight, henry's out, food poisoning");
    expect(r.note).not.toMatch(/^roster:/);
    expect(r.toolCalls).not.toContain('search_events');
    expect(h.runtime.stores.group.trips.listAttendance(CLUB_D5.activityId)).toEqual([]);
    for (const m of messages(r)) expect(m.text).not.toMatch(/food|poisoning/i);
    expect(JSON.stringify(h.audit())).not.toMatch(/food poisoning/i);
  });

  it('the flagship "get the 5 of us Razzmatazz tickets, Henry\'s sick" still goes to the booking path', async () => {
    const h = harness();
    const r = await h.say('h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
    expect(r.note).not.toMatch(/^roster:/);
    expect(r.note).toMatch(/^tool:propose_booking/);
    for (const m of messages(r)) expect(m.text).not.toMatch(REASON);
  });
});

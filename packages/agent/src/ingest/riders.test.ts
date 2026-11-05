/**
 * T-135 / T-075: a ride receipt's rider count next to that night's roster
 * (`applyRiders`), the "left the group" read of the thread (`leftTheGroup`),
 * and the owner's typed answer naming who rode (`parseRiderNames`).
 * End-to-end coverage (card, 👍, DM answer, ledger) is in `email.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { GroupMessageSummary, Member, MemberId } from '@trav/core';
import { ridersQuestion } from '../render/expenseConfirm.js';
import type { SharePlan } from './pending.js';
import {
  applyRiders,
  leftTheGroup,
  LEFT_LOOKBACK_MIN,
  LEFT_MIN_LEAD_MIN,
  LOST_MIN_LEAD_MIN,
  MAX_RIDERS,
  parseRiderNames,
  validRiders,
} from './riders.js';

const NAMES = ['Dean', 'Henry', 'Maya', 'Jordan', 'Priya', 'Sam'] as const;
const id = (name: string): MemberId => `mem_${name.toLowerCase()}`;

function member(name: string, over: Partial<Member> = {}): Member {
  return {
    memberId: id(name),
    groupId: 'grp_test',
    displayName: name,
    role: 'member',
    active: true,
    senderId: `h_${name.toLowerCase()}`,
    ageBand: 'adult',
    joinedAt: '2026-02-01T00:00:00+01:00',
    ...over,
  } as Member;
}

const MEMBERS: readonly Member[] = NAMES.map((n) => member(n));
const EVERYONE = NAMES.map(id);
const FIVE = EVERYONE.filter((m) => m !== 'mem_henry');
const PRIYA = id('Priya');
const RIDE_END = '2026-03-14T01:52:00+01:00';

let seq = 0;
function line(at: string, who: string | null, text: string, fromTrav = false): GroupMessageSummary {
  seq += 1;
  return {
    messageId: `msg_${String(seq)}`,
    senderMemberId: who === null ? null : id(who),
    senderDisplayName: who ?? 'trav',
    text,
    at,
    fromTrav,
  };
}

/** The El Born thread (fixtures/chats/barcelona.jsonl msg_bcn_0094..0102). */
const NIGHT: readonly GroupMessageSummary[] = [
  line('2026-03-13T23:30:00+01:00', 'Sam', "bar crawl in el born?? who's in"),
  line('2026-03-13T23:31:00+01:00', 'Maya', 'me'),
  line('2026-03-13T23:31:00+01:00', 'Jordan', 'ya'),
  line('2026-03-13T23:32:00+01:00', 'Henry', 'im beat, heading back. feel kinda off'),
  line('2026-03-13T23:32:00+01:00', 'Priya', 'in'),
  line('2026-03-13T23:33:00+01:00', 'Dean', 'in'),
  line('2026-03-14T00:40:00+01:00', 'Maya', 'where r u guys'),
  line('2026-03-14T00:41:00+01:00', 'Priya', 'bar with the green door'),
];

const everyonePlan: SharePlan = { participants: EVERYONE, label: 'everyone' };
const rosterPlan: SharePlan = {
  participants: FIVE,
  label: 'the 5 who went',
  guess: 'that the ride back from bars in el born?',
  activityId: 'act_bcn_elborn_d2',
};
const ctx = (groupMessages: readonly GroupMessageSummary[] = NIGHT) => ({
  ownerMemberId: PRIYA,
  occurredAt: RIDE_END,
  groupMessages,
});

describe('validRiders', () => {
  it('believes 1..12 whole riders only', () => {
    expect([1, 4, MAX_RIDERS].every((n) => validRiders(n))).toBe(true);
    for (const n of [undefined, 0, -1, 13, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validRiders(n), String(n)).toBe(false);
    }
  });
});

describe('applyRiders', () => {
  it('no usable count: the plan as it was', () => {
    expect(applyRiders(rosterPlan, undefined, ctx())).toBe(rosterPlan);
    expect(applyRiders(rosterPlan, 0, ctx())).toBe(rosterPlan);
    expect(applyRiders(rosterPlan, 40, ctx())).toBe(rosterPlan);
  });

  it('count matches the roster: the plan as it was (label, guess, plan link kept)', () => {
    // Plus the count, so the card takes a names correction (T-135 r1 #3).
    expect(applyRiders(rosterPlan, 5, ctx())).toEqual({ ...rosterPlan, riders: 5 });
  });

  it("Priya's Uber, roster of 5: Maya lost the group, so the 4 are Dean, Jordan, Priya, Sam", () => {
    const plan = applyRiders(rosterPlan, 4, ctx());
    expect(plan).toEqual({
      participants: ['mem_dean', 'mem_jordan', 'mem_priya', 'mem_sam'],
      riders: 4,
      guess: 'that the ride back from bars in el born?',
      activityId: 'act_bcn_elborn_d2',
    });
    // No "the 5 who went" label: the card lists the names.
    expect(plan.label).toBeUndefined();
    expect(plan.askRiders).toBeUndefined();
  });

  it('no roster (everyone, 6): Henry went back and Maya lost the group, so the same 4', () => {
    expect(applyRiders(everyonePlan, 4, ctx()).participants).toEqual([
      'mem_dean',
      'mem_jordan',
      'mem_priya',
      'mem_sam',
    ]);
  });

  it('nothing in the thread: no guess, the card asks (no participants, the plan link kept)', () => {
    expect(applyRiders(rosterPlan, 4, ctx([]))).toEqual({
      participants: [],
      askRiders: 4,
      activityId: 'act_bcn_elborn_d2',
    });
    expect(applyRiders(everyonePlan, 4)).toEqual({ participants: [], askRiders: 4 });
  });

  it('the thread leaves out too many or too few: ask', () => {
    // 6 could ride, only Maya left ⇒ 5 ≠ 4
    const onlyMaya = NIGHT.filter((m) => m.senderMemberId !== 'mem_henry');
    expect(applyRiders(everyonePlan, 4, ctx(onlyMaya)).askRiders).toBe(4);
    // 3 riders but only Maya left the 5 ⇒ 4 ≠ 3
    expect(applyRiders(rosterPlan, 3, ctx()).askRiders).toBe(3);
  });

  it('more riders than the roster: ask (someone rode who was not on it)', () => {
    expect(applyRiders(rosterPlan, 6, ctx()).askRiders).toBe(6);
  });

  it('one rider on a shared-looking ride: ask, never "just the owner" by arithmetic', () => {
    expect(applyRiders(rosterPlan, 1, ctx()).askRiders).toBe(1);
  });

  it('the owner\'s own "where r u guys" never takes the owner out', () => {
    const own = [
      ...NIGHT.filter((m) => m.senderMemberId !== 'mem_maya'),
      line('2026-03-14T00:40:00+01:00', 'Priya', 'where r u guys'),
    ];
    expect(applyRiders(rosterPlan, 4, ctx(own)).askRiders).toBe(4);
  });
});

describe('leftTheGroup', () => {
  const left = (msgs: readonly GroupMessageSummary[], candidates = EVERYONE) =>
    [...leftTheGroup(msgs, candidates, PRIYA, RIDE_END)].sort();

  it('reads the El Born night: Henry and Maya', () => {
    expect(left(NIGHT)).toEqual(['mem_henry', 'mem_maya']);
    expect(left(NIGHT, FIVE)).toEqual(['mem_maya']);
  });

  it.each([
    'heading home',
    'going back to the hotel now',
    'where are you all',
    "where'd everyone go",
    'where is everyone??',
    "can't find you guys",
    'getting my own uber',
    "i'm out for the night",
    'calling it a night',
    'made it home',
    'ok im heading back',
    'im beat, heading back. feel kinda off',
  ])('"%s" is leaving the others', (text) => {
    expect(left([line('2026-03-14T00:00:00+01:00', 'Sam', text)])).toEqual(['mem_sam']);
  });

  it.each([
    'going back to the bar',
    'where r we going next',
    'heading to the next bar',
    'who wants to get a cab',
    "i'm in",
    'in',
  ])('"%s" is not', (text) => {
    expect(left([line('2026-03-14T00:00:00+01:00', 'Sam', text)])).toEqual([]);
  });

  // T-135 r1 #1: one regression per case the reviewer found.
  it.each([
    // about someone else
    ['jordan is heading back, he said bye', 'another member named'],
    ["he's heading home", 'he/she/they'],
    ['they went back', 'he/she/they'],
    ["we're heading back", 'we (the whole group)'],
    // negations
    ['not going home now', 'negation'],
    ["i'm not out", 'negation'],
    ["don't think im heading back", 'negation'],
    // questions
    ['where are you all sitting', 'a question that is not just "where are you"'],
    ['should we all share an uber or get my own cab?', 'question'],
    ['calling it a night soon? no way', 'question + negation'],
    ['heading back?', 'question'],
    // past tense
    ['i got home safe last night', 'past'],
    ['made it home yesterday', 'past'],
    // same-line back
    ['where r u guys? omw', 'same-line omw'],
    ['where r u guys, coming', 'same-line coming'],
    ['heading back to you guys', 'same-line with/you'],
    // T-135 r2 #5: sarcasm and past tense
    ['sure, im going home. totally', 'sarcasm'],
    ['heading home jk', 'joke'],
    ['went back', 'past (maybe back inside)'],
  ])('"%s" does not take the sender out (%s)', (text) => {
    expect(left([line('2026-03-14T00:00:00+01:00', 'Sam', text)])).toEqual([]);
  });

  it.each(['coming', 'found them', 'here', 'with you guys now', 'omw', 'be there in 5'])(
    'a later "%s" from the same member cancels it',
    (text) => {
      expect(left([...NIGHT, line('2026-03-14T00:45:00+01:00', 'Maya', text)])).toEqual([
        'mem_henry',
      ]);
    },
  );

  it('a line naming another member never takes the sender out (members given)', () => {
    const msgs = [line('2026-03-14T00:00:00+01:00', 'Sam', 'jordan heading back')];
    expect([...leftTheGroup(msgs, EVERYONE, PRIYA, RIDE_END, MEMBERS)]).toEqual([]);
    // and Jordan isn't taken out either: only a member's own line counts
  });

  it('"where r u guys" counts up to 30 min before the ride ended; "heading back" up to 60', () => {
    const at = (min: number) => new Date(Date.parse(RIDE_END) - min * 60_000).toISOString();
    expect(left([line(at(LOST_MIN_LEAD_MIN + 1), 'Sam', 'where r u guys')])).toEqual(['mem_sam']);
    expect(left([line(at(LOST_MIN_LEAD_MIN - 1), 'Sam', 'where r u guys')])).toEqual([]);
    expect(left([line(at(LEFT_MIN_LEAD_MIN - 1), 'Sam', 'heading back')])).toEqual([]);
  });

  it('within the last hour before the ride ended, "heading back" is likely the ride itself', () => {
    const at = new Date(Date.parse(RIDE_END) - (LEFT_MIN_LEAD_MIN - 5) * 60_000).toISOString();
    expect(left([line(at, 'Sam', 'heading back')])).toEqual([]);
  });

  it('a line from before the night (over the lookback) does not count', () => {
    const at = new Date(Date.parse(RIDE_END) - (LEFT_LOOKBACK_MIN + 5) * 60_000).toISOString();
    expect(left([line(at, 'Sam', 'heading back')])).toEqual([]);
  });

  it('a later "omw" / "found you guys" from the same member cancels it', () => {
    expect(left([...NIGHT, line('2026-03-14T00:45:00+01:00', 'Maya', 'omw')])).toEqual([
      'mem_henry',
    ]);
    expect(left([...NIGHT, line('2026-03-14T01:30:00+01:00', 'Maya', 'found you guys!')])).toEqual([
      'mem_henry',
    ]);
    // Someone else's "omw" does not.
    expect(left([...NIGHT, line('2026-03-14T00:45:00+01:00', 'Dean', 'omw')])).toEqual([
      'mem_henry',
      'mem_maya',
    ]);
  });

  it("Trav's lines, guest/marker lines and non-candidates never count", () => {
    expect(
      left([
        line('2026-03-14T00:00:00+01:00', null, 'heading back', true),
        line('2026-03-14T00:00:00+01:00', null, 'where r u guys'),
      ]),
    ).toEqual([]);
    expect(left(NIGHT, ['mem_dean', 'mem_priya'])).toEqual([]);
  });
});

describe('parseRiderNames', () => {
  const read = (text: string, members: readonly Member[] = MEMBERS) =>
    parseRiderNames(text, members, PRIYA);
  const FOUR = ['mem_dean', 'mem_jordan', 'mem_priya', 'mem_sam'];

  it.each([
    'dean, jordan and sam',
    'Dean Jordan Sam',
    'me dean jordan & sam',
    'it was dean, jordan and sam',
    'dean + jordan + sam!',
    'everyone but maya and henry',
    'all except henry, maya',
    'not maya or henry',
  ])('"%s" ⇒ Dean, Jordan, Priya, Sam (owner always in, group order)', (text) => {
    expect(read(text)).toEqual({ kind: 'names', memberIds: FOUR });
  });

  it('"everyone" is the whole active group', () => {
    expect(read('everyone')).toEqual({ kind: 'names', memberIds: EVERYONE });
  });

  it.each([
    '',
    'what time is dinner',
    'dean and bob',
    'yes',
    'no',
    'just me',
    'priya',
    'everyone else',
    // T-135 r1 #2: the owner paid and is on the receipt; taking themself out is no answer
    'all except me',
    'everyone but me',
    'not me',
    'not',
    // T-135 r2 #3, #4: questions, mixed lists, a trailing negator
    'wait was it dean jordan and maya?',
    'sam?',
    'was it sam?',
    'dean, not jordan, sam',
    'jordan not',
  ])('"%s" is not an answer naming riders', (text) => {
    expect(read(text)).toEqual({ kind: 'none' });
  });

  describe('corrections to a proposed split (T-135 r1 #3)', () => {
    const PROPOSED = FOUR; // Dean, Jordan, Priya, Sam
    const fix = (text: string) => parseRiderNames(text, MEMBERS, PRIYA, PROPOSED);

    it.each([
      ['no it was maya not jordan', ['mem_dean', 'mem_maya', 'mem_priya', 'mem_sam']],
      ['maya instead of jordan', ['mem_dean', 'mem_maya', 'mem_priya', 'mem_sam']],
      ['not jordan', ['mem_dean', 'mem_priya', 'mem_sam']],
      ['minus jordan', ['mem_dean', 'mem_priya', 'mem_sam']],
      // a plain list replaces the proposal
      ['dean, maya and sam', ['mem_dean', 'mem_maya', 'mem_priya', 'mem_sam']],
      ['dean', ['mem_dean', 'mem_priya']],
    ])('"%s" on the 4-way card', (text, want) => {
      expect(fix(text)).toEqual({ kind: 'names', memberIds: want });
    });

    it('without a proposal, "not maya" is everyone but Maya', () => {
      expect(read('not maya')).toEqual({
        kind: 'names',
        memberIds: EVERYONE.filter((id) => id !== 'mem_maya'),
      });
    });
  });

  it('a name two members share is no answer; a guest or departed member is never matched', () => {
    const twoSams = [...MEMBERS, member('Sam', { memberId: 'mem_sam2' })];
    expect(read('dean and sam', twoSams)).toEqual({ kind: 'none' });
    const withGuest = [
      ...MEMBERS.filter((m) => m.memberId !== 'mem_sam'),
      member('Sam', { role: 'guest' }),
    ];
    expect(read('dean and sam', withGuest)).toEqual({ kind: 'none' });
    const departed = MEMBERS.map((m) =>
      m.memberId === 'mem_sam' ? { ...m, leftAt: '2026-03-13T00:00:00+01:00' } : m,
    );
    expect(read('dean and sam', departed)).toEqual({ kind: 'none' });
  });

  it('longest names first: "Mary Jo" is one person, not Mary', () => {
    const ms = [member('Priya'), member('Mary'), member('Mary Jo', { memberId: 'mem_maryjo' })];
    expect(read('mary jo', ms)).toEqual({ kind: 'names', memberIds: ['mem_priya', 'mem_maryjo'] });
  });

  it('a possessive is the name: "sam\'s"', () => {
    expect(read("dean's, jordan's and sam's")).toEqual({ kind: 'names', memberIds: FOUR });
  });
});

describe('ridersQuestion (VOICE §4.11: one question, the last line)', () => {
  it('asks for the others by count, with the keep-private way out', () => {
    expect(ridersQuestion(4)).toBe(
      'who were the other 3? send me their names, or 👎 to keep it just yours',
    );
    expect(ridersQuestion(2)).toBe(
      'who was the other rider? send me their name, or 👎 to keep it just yours',
    );
    expect(ridersQuestion(1)).toBe(
      "who's splitting it with you? send me their names, or 👎 to keep it just yours",
    );
  });
});

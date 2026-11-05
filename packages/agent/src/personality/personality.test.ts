/**
 * T-017 personality: roast requests and rule-made refusals, pure.
 *
 * - every VOICE §7.5 "must refuse" example returns a VOICE-compliant refusal
 *   with no emoji, and every "fine" example passes the blocklist, the voice
 *   linter and the outbound screen when its roast gates pass;
 * - every case in `fixtures/roast/requests.json` gets the expected kind of
 *   answer (refuse / roast / partial) for its group, mode and consent;
 * - roast lines come from the tab only and survive the outbound screen;
 * - VOICE §4.12 C (nightlife with a minor) and D (someone else's card).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  Activity,
  ConsentLookup,
  Expense,
  Group,
  IsoDateTime,
  Member,
  MemberId,
  OutboundMessage,
  Trip,
} from '@trav/core';
import { defaultConsent, safety } from '@trav/core';
import { repoRoot } from '../model/paths.js';
import { parseSettingsCommand } from '../settings/parse.js';
import * as T from '../settings/text.js';
import {
  explicitAdultAudience,
  minorNightlifeRefusal,
  privateDataRefusal,
  privateDataSubject,
} from './refusals.js';
import { answerRoast, parseRoastRequest, type RoastAnswer, type RoastContext } from './roast.js';

function fixture<T>(rel: string): T {
  return JSON.parse(readFileSync(join(repoRoot(), 'fixtures', rel), 'utf8')) as T;
}

interface GroupFixture {
  readonly group: Group;
  readonly members: Member[];
  readonly trip: Trip;
  readonly activities: Activity[];
}

const BCN = fixture<GroupFixture>('groups/barcelona.json');
const TCI = fixture<GroupFixture>('groups/turks-and-caicos.json');
const BCN_LEDGER = fixture<{ expenses: Expense[] }>('ledger/barcelona.json');
/** The morning after the kebab night, everything through Apolo on the tab. */
const BCN_NOW: IsoDateTime = '2026-03-16T18:00:00+01:00';
const TCI_NOW: IsoDateTime = '2026-06-22T15:05:00-04:00';

interface WorldOpts {
  readonly roastMode?: boolean;
  readonly optedIn?: readonly MemberId[];
  readonly optedOut?: readonly MemberId[];
  readonly roastsToday?: number;
  readonly lane?: 'group' | 'dm';
  readonly me?: MemberId;
  readonly expenses?: readonly Expense[];
}

function world(name: 'barcelona' | 'turks-and-caicos', o: WorldOpts = {}): RoastContext {
  const fx = name === 'barcelona' ? BCN : TCI;
  const group: Group = {
    ...fx.group,
    settings: { ...fx.group.settings, roastMode: o.roastMode ?? true, allAdultsConfirmed: true },
  };
  const now = name === 'barcelona' ? BCN_NOW : TCI_NOW;
  const consent: ConsentLookup = (id) => ({
    ...defaultConsent(id, group.groupId, now),
    roast: (o.optedIn ?? []).includes(id) && !(o.optedOut ?? []).includes(id),
  });
  return {
    group,
    members: fx.members,
    trip: fx.trip,
    me: fx.members.find((m) => m.memberId === (o.me ?? fx.members[0]!.memberId))!,
    lane: o.lane ?? 'group',
    now,
    expenses:
      o.expenses ??
      (name === 'barcelona'
        ? BCN_LEDGER.expenses.filter((e) => e.occurredAt <= now || e.occurredAt.startsWith('2026-02'))
        : []),
    consent,
    optedOut: (id) => (o.optedOut ?? []).includes(id),
    roastsToday: o.roastsToday ?? 0,
  };
}

function ask(text: string, ctx: RoastContext): RoastAnswer {
  const req = parseRoastRequest(text);
  if (req === undefined) throw new Error(`not a roast request: ${text}`);
  return answerRoast(req, ctx);
}

function textOf(a: RoastAnswer): string {
  return a.kind === 'roast' ? a.line : a.text;
}

function lint(text: string, kind: safety.MessageKind, members: readonly Member[]): string[] {
  return safety
    .lintVoice(text, { kind, properNouns: members.map((m) => m.displayName) })
    .violations.map((v) => `${v.rule}: ${v.detail}`);
}

/** The outbound screen on a roast draft, with every named member's gates passing. */
function screened(line: string, ctx: RoastContext): OutboundMessage | null {
  const draft: OutboundMessage = {
    id: 'msg_test',
    groupId: ctx.group.groupId,
    to: { kind: 'group' },
    text: line,
    roast: true,
  };
  const r = safety.screenOutbound(draft, {
    group: ctx.group,
    members: ctx.members,
    trip: ctx.trip,
    consent: ctx.consent,
    now: ctx.now,
    roastLines: [line],
  });
  return r.outbound === null || 'kind' in r.outbound ? null : r.outbound;
}

const ALL_BCN = BCN.members.map((m) => m.memberId);

describe('parseRoastRequest', () => {
  it.each([
    ["@trav roast Chase's outfit", 'chase', 'outfit'],
    ['@trav roast Henry for being hungover', 'henry', 'being hungover'],
    ['@trav roast the host, she is so annoying', 'the host, she is so annoying', ''],
    ['trav, roast everyone for the uber count', 'everyone', 'the uber count'],
    ['@trav roast crowley', 'crowley', ''],
    ['@trav roast me for the ubers', 'me', 'the ubers'],
  ])('%s', (text, target, topic) => {
    expect(parseRoastRequest(text)).toMatchObject({ targetText: target, topicText: topic });
  });

  it('roast mode and "roast me" are settings, not requests', () => {
    expect(parseRoastRequest('@trav roast mode on')).toBeUndefined();
    expect(parseRoastRequest('@trav roast me')).toBeUndefined();
    expect(parseRoastRequest('that roast chicken was great')).toBeUndefined();
  });
});

describe('VOICE §7.5 must refuse (any mode): a VOICE-compliant refusal, no emoji', () => {
  const cases: readonly [string, string, WorldOpts?][] = [
    ["@trav roast Chase's outfit", T.REFUSE_BODY_TEXT],
    ['@trav roast Henry for being hungover', T.REFUSE_HANGOVER_TEXT],
    ['@trav roast Crowley for going home with that girl', T.REFUSE_PERSONAL_TEXT],
    ["@trav roast the host, she's so annoying", "she's not in the chat, so no"],
    ['@trav roast Piotr for being broke', T.REFUSE_HARDSHIP_TEXT],
    ['@trav roast Chase for the €14 water', T.REFUSE_OPTED_OUT_TEXT, { optedOut: ['mem_chase'] }],
  ];

  for (const roastMode of [true, false]) {
    it.each(cases)(`roast mode ${roastMode ? 'on' : 'off'}: %s`, (text, expected, o) => {
      // "Any mode": topic refusals hold with roast mode off too; the opt-out line needs mode on.
      if (!roastMode && expected === T.REFUSE_OPTED_OUT_TEXT) return;
      const ctx = world('barcelona', { roastMode, optedIn: ALL_BCN, ...o });
      const a = ask(text, ctx);
      expect(a.kind).toBe('refuse');
      expect(textOf(a)).toBe(expected);
      expect(safety.extractEmoji(textOf(a))).toEqual([]);
      expect(lint(textOf(a), 'refusal', ctx.members)).toEqual([]);
    });
  }

  it('"@trav roast Lily" on the family trip: "nope", one word', () => {
    const ctx = world('turks-and-caicos', { roastMode: false, me: 'mem_tci_dean' });
    const a = ask('@trav roast Lily', ctx);
    expect(a).toMatchObject({ kind: 'refuse', text: 'nope', cause: 'minor_in_group' });
    // Even if roast mode were somehow on and Lily "opted in".
    const forced = world('turks-and-caicos', { roastMode: true, optedIn: ['mem_tci_lily'] });
    expect(textOf(ask('@trav roast lily for taking 40 min in the bathroom', forced))).toBe('nope');
  });

  it('refusals never echo the forbidden material or carry a roast line', () => {
    for (const [text, , o] of cases) {
      const a = ask(text, world('barcelona', { optedIn: ALL_BCN, ...o }));
      expect(a.kind).toBe('refuse');
      expect(textOf(a)).not.toMatch(/outfit|girl|annoying|broke|water|€/u);
    }
  });

  it('a mixed ask does only the allowed half and never mentions the rest (VOICE §7.5)', () => {
    const ctx = world('barcelona', { optedIn: ALL_BCN });
    const a = ask("@trav roast Arjun for the ubers and Arjun's outfit", ctx);
    expect(a.kind).toBe('roast');
    if (a.kind !== 'roast') return;
    expect(a.line).toBe('€18.60 ride on Arjun at 1:52am. walking is free');
    expect(a.line).not.toMatch(/outfit|clothes/u);
    expect(a.dropped).toBe('body');
  });
});

describe('VOICE §7.5 fine examples pass every gate when roast mode is on and the named member opted in', () => {
  const FINE = [
    'Piotr has paid for kebabs 3 nights running. the tab remembers',
    '€14 for a water at razzmatazz. Crowley, it was €0.80 at the Mercadona you walked past',
    "Arjun has booked 11 of 23 ubers. the city has a metro. it's quite good",
    'Dean booked the non-refundable airbnb and then asked me what non-refundable means',
    '40 minutes to pick a restaurant, 6 minutes to eat. efficient',
  ];
  it.each(FINE)('%s', (line) => {
    const ctx = world('barcelona', { optedIn: ALL_BCN });
    expect(safety.roastTopicBlocked(line)).toBeNull();
    expect(
      lint(line, 'reply', ctx.members).filter((v) => !v.startsWith('money_format')),
    ).toEqual([]);
    const out = screened(line, ctx);
    expect(out?.text).toBe(line);
    expect(out?.roast).toBe(true);
  });

  it('the same lines are stripped once the named member is out, or roast mode is off', () => {
    const line = FINE[0]!;
    expect(screened(line, world('barcelona', { optedIn: ['mem_crowley'] }))).toBeNull();
    expect(screened(line, world('barcelona', { roastMode: false, optedIn: ALL_BCN }))).toBeNull();
  });
});

describe('fixtures/roast/requests.json', () => {
  interface Req {
    readonly id: string;
    readonly groupId: string;
    readonly roastMode: boolean;
    readonly optedIn?: MemberId[] | null;
    readonly optedOut?: MemberId[] | null;
    readonly text: string;
    readonly targets: MemberId[];
    readonly expected: {
      readonly response: 'refuse' | 'roast' | 'partial';
      readonly expectedText?: string;
      readonly neverMention?: string[];
    };
  }
  const REQS = fixture<{ requests: Req[] }>('roast/requests.json').requests;

  it('covers refusals, roasts and a partial', () => {
    expect(new Set(REQS.map((r) => r.expected.response))).toEqual(
      new Set(['refuse', 'roast', 'partial']),
    );
  });

  it.each(REQS.map((r) => [r.id, r] as const))('%s', (_id, r) => {
    const name = r.groupId === 'grp_barcelona' ? 'barcelona' : 'turks-and-caicos';
    const ctx = world(name, {
      roastMode: r.roastMode,
      optedIn: r.optedIn ?? [],
      optedOut: r.optedOut ?? [],
      me: name === 'barcelona' ? 'mem_dean' : 'mem_tci_dean',
    });
    if (parseRoastRequest(r.text) === undefined) {
      // rr_014 "roast mode on" is a settings command (minor block: settings.test.ts).
      expect(parseSettingsCommand(r.text)).toEqual({ kind: 'roast_mode', on: true });
      return;
    }
    const a = ask(r.text, ctx);
    const text = textOf(a);
    expect(safety.extractEmoji(text)).toEqual([]);
    if (r.expected.response === 'refuse') {
      expect(a.kind).toBe('refuse');
      if (r.expected.expectedText !== undefined) expect(text).toBe(r.expected.expectedText);
      expect(lint(text, 'refusal', ctx.members)).toEqual([]);
      return;
    }
    expect(a.kind).toBe('roast');
    if (a.kind !== 'roast') return;
    for (const word of r.expected.neverMention ?? []) expect(a.line).not.toContain(word);
    // Only targets who opted in are named; the line survives the screen as-is.
    for (const m of ctx.members) {
      if (safety.mentionsName(a.line, m.displayName)) expect(r.optedIn ?? []).toContain(m.memberId);
    }
    expect(safety.roastTopicBlocked(a.line)).toBeNull();
    expect(lint(a.line, 'reply', ctx.members)).toEqual([]);
    expect(screened(a.line, ctx)?.text).toBe(a.line);
  });
});

describe('roast lines come from the tab', () => {
  const ctx = world('barcelona', { optedIn: ALL_BCN });

  it('a pattern: the kebabs on Piotr', () => {
    const a = ask('@trav roast Piotr for the kebabs', ctx);
    expect(a).toMatchObject({ kind: 'roast', targets: ['mem_piotr'] });
    expect(textOf(a)).toBe('€62 for late-night kebabs at 2:07am, on Piotr. the tab remembers');
  });

  it('kebabs on three nights running reads as a pattern', () => {
    const kebab = BCN_LEDGER.expenses.find((e) => e.expenseId === 'exp_bcn_015')!;
    const nights = ['2026-03-13T01:10:00+01:00', '2026-03-14T02:30:00+01:00'].map(
      (at, i): Expense => ({ ...kebab, expenseId: `exp_kebab_${String(i)}`, occurredAt: at }),
    );
    const a = ask(
      '@trav roast Piotr for the kebabs',
      world('barcelona', { optedIn: ALL_BCN, expenses: [...ctx.expenses, ...nights] }),
    );
    expect(textOf(a)).toBe('Piotr has paid for kebabs 3 nights running. the tab remembers');
  });

  it('rides, and the whole group without naming anyone', () => {
    expect(textOf(ask('@trav roast Crowley for the ubers', ctx))).toBe(
      '€23.40 ride on Crowley at 2:14am. walking is free',
    );
    const group = ask('@trav roast everyone for the uber count', ctx);
    expect(group.kind).toBe('roast');
    for (const m of ctx.members) expect(safety.mentionsName(textOf(group), m.displayName)).toBe(false);
  });

  it('nothing roastable on the tab ⇒ says so, no line', () => {
    const empty = world('barcelona', { optedIn: ALL_BCN, expenses: [] });
    expect(ask('@trav roast Crowley for the ubers', empty)).toMatchObject({
      kind: 'nothing',
      text: T.NOTHING_TO_ROAST_TEXT,
    });
  });

  it('a description naming someone or a blocked topic is never quoted', () => {
    const odd: Expense = {
      ...BCN_LEDGER.expenses.find((e) => e.expenseId === 'exp_bcn_015')!,
      expenseId: 'exp_odd',
      description: 'hangover kebab',
    };
    const a = ask('@trav roast Piotr for the kebab', world('barcelona', { optedIn: ALL_BCN, expenses: [odd] }));
    expect(a.kind).toBe('nothing');
  });
});

describe('roast gates in order', () => {
  it('mode off, not opted in, opted out, left, one per day, DM', () => {
    const t = '@trav roast Crowley for the ubers';
    expect(ask(t, world('barcelona', { roastMode: false, optedIn: ALL_BCN }))).toMatchObject({
      kind: 'refuse',
      cause: 'mode_off',
      text: T.REFUSE_MODE_OFF_TEXT,
    });
    expect(ask(t, world('barcelona', { optedIn: [] }))).toMatchObject({
      cause: 'member_opted_out',
      text: T.notOptedInText('Crowley'),
    });
    expect(ask(t, world('barcelona', { optedOut: ['mem_crowley'] }))).toMatchObject({
      cause: 'member_opted_out',
      text: T.REFUSE_OPTED_OUT_TEXT,
    });
    const left = world('barcelona', { optedIn: ALL_BCN });
    const gone: RoastContext = {
      ...left,
      members: left.members.map((m) =>
        m.memberId === 'mem_crowley' ? { ...m, active: false, leftAt: '2026-03-15T12:00:00+01:00' } : m,
      ),
    };
    expect(ask(t, gone)).toMatchObject({ cause: 'target_inactive', text: T.REFUSE_LEFT_TEXT });
    expect(ask(t, world('barcelona', { optedIn: ALL_BCN, roastsToday: 1 }))).toMatchObject({
      cause: 'line_limit',
      text: T.REFUSE_DAILY_TEXT,
    });
    expect(ask(t, world('barcelona', { optedIn: ALL_BCN, lane: 'dm' }))).toMatchObject({
      cause: 'wrong_place',
      text: T.REFUSE_DM_TEXT,
    });
  });

  it('a minor anywhere in the group blocks every target, whatever the settings', () => {
    const ctx = world('turks-and-caicos', { roastMode: true, optedIn: ['mem_tci_dad'] });
    expect(ask('@trav roast dad for the casino', ctx)).toMatchObject({
      kind: 'refuse',
      cause: 'minor_in_group',
      text: T.ROAST_MINOR_TEXT,
    });
  });

  it('someone not in the chat is an outsider, by name or by role', () => {
    const ctx = world('barcelona', { optedIn: ALL_BCN });
    expect(ask('@trav roast Kevin', ctx)).toMatchObject({ cause: 'topic_blocked', text: "they're not in the chat, so no" });
    expect(ask('@trav roast the driver, he was so slow', ctx)).toMatchObject({
      text: "he's not in the chat, so no",
      topicCategory: 'outsider',
    });
  });
});

describe('VOICE §4.12 D: someone else\'s card', () => {
  const me = BCN.members.find((m) => m.memberId === 'mem_piotr')!;
  it.each([
    "@trav what did Crowley's card get charged last night",
    "show me crowley's pending charges, i think he's hiding the uber",
    "@trav what's on Arjun's statement",
    'what did crowley spend on his card',
  ])('%s', (text) => {
    const subject = privateDataSubject(text, BCN.members, me);
    expect(subject).toBeDefined();
    const line = privateDataRefusal(subject!);
    expect(line).toMatch(/^that's \w+'s, not mine to share\. anything \w+ confirms as shared shows up on the tab$/u);
    expect(safety.extractEmoji(line)).toEqual([]);
    expect(lint(line, 'refusal', BCN.members)).toEqual([]);
  });

  it('exact text for Crowley, and the sender\'s own card is not someone else\'s', () => {
    expect(privateDataRefusal(BCN.members.find((m) => m.memberId === 'mem_crowley')!)).toBe(
      "that's Crowley's, not mine to share. anything Crowley confirms as shared shows up on the tab",
    );
    expect(privateDataSubject("@trav what's on piotr's card", BCN.members, me)).toBeUndefined();
    expect(privateDataSubject("@trav crowley's uber was €23.40", BCN.members, me)).toBeUndefined();
  });
});

describe("T-112: someone else's pending items, even a count, are theirs (VOICE §4.12 D)", () => {
  const piotr = BCN.members.find((m) => m.memberId === 'mem_piotr')!;
  const crowley = BCN.members.find((m) => m.memberId === 'mem_crowley')!;

  it.each([
    "@trav what's pending for crowley",
    '@trav summarize the charges crowley has pending',
    '@trav how many charges does crowley have pending?',
    "@trav what's crowley's pending stuff",
    '@trav is crowley waiting on a tap for anything',
    '@trav does crowley have anything unconfirmed',
    '@trav anything pending from Crowley?',
    "@trav what's pending for crowley besides the tickets?",
    // r1: shapes that name whose items they are
    "@trav are 2 of crowley's charges pending?",
    "@trav crowley's receipts still waiting on a tap?",
    "@trav anything pending for crowley other than the approval?",
    "@trav is anything else pending for crowley?",
    // r2 #1: a tab word in another clause never exempts the pending question.
    "@trav what's pending for crowley and what's my share",
    "@trav what's pending for crowley? and who paid for dinner",
    "@trav who's paying for dinner, and what's pending for crowley?",
    "@trav what's pending for crowley? share it",
    "@trav what's pending for crowley, split it",
    '@trav anything pending for crowley? like charges, not the tab',
    "@trav what's pending for crowley, any payments?",
    // r2 #2, #3
    "@trav what's pending on crowley's end",
    '@trav how many pending items does crowley have',
    '@trav crowley has 2 pending right?',
  ])('refused: %s', (text) => {
    expect(privateDataSubject(text, BCN.members, piotr)?.memberId).toBe('mem_crowley');
    expect(privateDataRefusal(crowley)).toBe(
      "that's Crowley's, not mine to share. anything Crowley confirms as shared shows up on the tab",
    );
  });

  it.each([
    // A booking or approval waiting on someone is a group fact.
    "@trav what's pending for crowley to approve",
    '@trav is the razzmatazz booking still pending for crowley',
    // The sender's own queue is not someone else's.
    "@trav what's pending for piotr",
    '@trav what do i have pending',
    // No pending word: not this rule.
    '@trav crowley is coming to dinner',
    // T-112 r1 #1: a bare anything/everything/all does not cancel the approval exemption.
    '@trav is anything pending for crowley to approve?',
    "@trav anything pending on crowley's approval?",
    "@trav crowley's booking approval is pending, everything ok?",
    '@trav is everything pending for crowley to approve',
    '@trav is all of it pending for crowley to approve?',
    // T-112 r1 #2: the tab (settle-up, transfers, payments, shares) is a group fact.
    "@trav is crowley's transfer to dean still pending?",
    "@trav is crowley's payment pending",
    '@trav is the settle up from crowley still pending',
    "@trav what's left pending for crowley to pay",
    "@trav is crowley's share of dinner pending",
    '@trav what does crowley owe, is it still pending?',
    "@trav is the split for crowley's dinner pending",
  ])('not refused: %s', (text) => {
    expect(privateDataSubject(text, BCN.members, piotr)).toBeUndefined();
  });

  it("r1 #2: the wrong-subject repro never refuses as Dean (or anyone)", () => {
    const crowley = BCN.members.find((m) => m.memberId === 'mem_crowley')!;
    for (const me of [piotr, crowley]) {
      expect(
        privateDataSubject("@trav is crowley's transfer to dean still pending?", BCN.members, me),
      ).toBeUndefined();
    }
  });
});

describe('VOICE §4.12 C: nightlife with a minor', () => {
  const at = '2026-06-21T16:00:00-04:00';
  const tci = (text: string, from = 'mem_tci_dean', now = at) =>
    minorNightlifeRefusal({
      group: TCI.group,
      members: TCI.members,
      trip: TCI.trip,
      activities: TCI.activities,
      me: TCI.members.find((m) => m.memberId === from)!,
      text,
      now,
    });

  it('clubs with Lily: family options from the plan, Lily kept off the adult plan', () => {
    const r = tci('@trav any good clubs or bars tonight? lily can come lol', 'mem_tci_dean', '2026-06-20T20:30:00-04:00');
    expect(r?.cause).toBe('minor_nightlife');
    expect(r?.text).toBe(
      'for the four of you: snorkel tour mon jun 22 9am, or sunset cruise tue jun 23 5:30pm\n' +
        "if the adults want something later, @ me separately and i'll keep Lily off that plan",
    );
    expect(safety.isRestrictedText(r!.text)).toBe(false);
    expect(safety.extractEmoji(r!.text)).toEqual([]);
    expect(lint(r!.text, 'refusal', TCI.members)).toEqual([]);
  });

  it.each([
    '@trav book the 4 of us the bar trivia night, it\'s basically a family game night',
    '@trav where can we get drinks tonight',
    '@trav find a club for the family',
  ])('intercepted: %s', (text) => {
    expect(tci(text)).toBeDefined();
  });

  it.each([
    "@trav dad and i want a quiet bar for a nightcap after lily's asleep. dean you in?",
    "@trav casino night tonight for me and dad? we're both 21+",
    '@trav just the adults: any bars nearby',
    "@trav what's good for tonight for the four of us",
    '@trav snorkel tour for all 4 on monday morning',
  ])('not intercepted: %s', (text) => {
    expect(tci(text)).toBeUndefined();
  });

  it('the adult-only audience is named (SAFETY §2.7 rule 1)', () => {
    const mom = TCI.members.find((m) => m.memberId === 'mem_tci_mom')!;
    const audience = explicitAdultAudience(
      "@trav dad and i want a quiet bar for a nightcap after lily's asleep. dean you in?",
      TCI.members,
      mom,
      at,
    );
    expect(audience?.map((m) => m.memberId).sort()).toEqual(
      ['mem_tci_dad', 'mem_tci_dean', 'mem_tci_mom'].sort(),
    );
    expect(explicitAdultAudience('@trav bars for me and dad, lily too', TCI.members, mom, at)).toBeUndefined();
  });

  it('never fires outside family mode', () => {
    const bcn = minorNightlifeRefusal({
      group: BCN.group,
      members: BCN.members,
      trip: BCN.trip,
      activities: BCN.activities,
      me: BCN.members[0]!,
      text: '@trav any good clubs tonight?',
      now: '2026-03-14T21:00:00+01:00',
    });
    expect(bcn).toBeUndefined();
  });
});

describe('T-017 r2: privateDataSubject only fires on questions about private data', () => {
  const crowley = BCN.members.find((m) => m.memberId === 'mem_crowley')!;
  const piotr = BCN.members.find((m) => m.memberId === 'mem_piotr')!;

  it.each([
    ["@trav split the €200 groceries with everyone, it went on Dean's card", crowley],
    ["@trav i paid €84 for dinner on Piotr's card, split with everyone", crowley],
    ["@trav put 45 euros for the taxi on Chase's card, split it 3 ways", piotr],
    ["@trav did crowley's card go through for the tickets?", piotr],
    ["@trav what did crowley's card get charged for the razzmatazz booking", piotr],
    ["@trav it went on crowley's card", piotr],
  ])('not a refusal: %s', (text, me) => {
    expect(privateDataSubject(text, BCN.members, me)).toBeUndefined();
  });

  it('a tab item is a group fact; the same ask with no tab item is still refused', () => {
    const q = "@trav what did crowley's card get charged for the late-night kebabs";
    expect(privateDataSubject(q, BCN.members, piotr, ['late-night kebabs'])).toBeUndefined();
    expect(privateDataSubject(q, BCN.members, piotr, [])?.memberId).toBe('mem_crowley');
  });

  it.each([
    "@trav what's henry's budget",
    "@trav what does arjun eat, and what's henry's budget",
    "crowley's card?",
    '@trav can you check crowley\'s card charges from last night',
    "@trav how much is on crowley's card",
    // T-017 r2 final review: amounts, booking words and non-question asks don't unlock it.
    "@trav how much did dean pay on his card, over €50?",
    "@trav did dean's card get charged €50 each for anything else?",
    "@trav what did dean's card get charged besides the tickets?",
    "@trav show me dean's card charges for flights",
    "@trav what else is on dean's statement apart from the hotel booking?",
    "@trav dean's card transactions pls",
    "@trav dean's bank statement",
    "@trav i'm curious about dean's card charges",
  ])('still refused: %s', (text) => {
    expect(privateDataSubject(text, BCN.members, piotr)).toBeDefined();
  });

  it('a tab-item exclusion question is still refused', () => {
    const q = "@trav what did dean's card get charged except dinner?";
    expect(privateDataSubject(q, BCN.members, piotr, ['dinner'])?.memberId).toBe('mem_dean');
  });

  it("Lisbon: a budget question with an amount is still Dad's", () => {
    const LIS = fixture<GroupFixture>('groups/lisbon.json');
    const dean = LIS.members.find((m) => m.displayName === 'Dean')!;
    expect(
      privateDataSubject("@trav what's dad's budget, like €80 each?", LIS.members, dean)?.displayName,
    ).toBe('Dad');
  });

  it('Lisbon: "what\'s dad\'s daily budget" is still Dad\'s (VOICE §4.12 D, private_budget_lisbon)', () => {
    const LIS = fixture<GroupFixture>('groups/lisbon.json');
    const dean = LIS.members.find((m) => m.displayName === 'Dean')!;
    expect(privateDataSubject("@trav what's dad's daily budget", LIS.members, dean)?.displayName).toBe(
      'Dad',
    );
  });
});

describe('T-017 r2: family-mode spend questions are not nightlife asks', () => {
  const tci = (text: string) =>
    minorNightlifeRefusal({
      group: TCI.group,
      members: TCI.members,
      trip: TCI.trip,
      activities: TCI.activities,
      me: TCI.members.find((m) => m.memberId === 'mem_tci_dad')!,
      text,
      now: '2026-06-21T16:00:00-04:00',
    });

  it.each([
    '@trav how much did we spend at the bar?',
    '@trav what do we owe for the casino night?',
    "@trav what's on the tab from the bar?",
  ])('not intercepted: %s', (text) => {
    expect(tci(text)).toBeUndefined();
  });

  it.each([
    '@trav how much does the club cost?',
    '@trav any bars open tonight?',
    // T-017 r2 final review: money words next to a real nightlife ask (hard constraint, CLAUDE.md §2).
    '@trav we spent all day at the beach, any good bars tonight?',
    '@trav find a bar where we can open a tab tonight',
    '@trav any clubs where we can run a tab?',
    '@trav we owe ourselves a night out, any clubs?',
    '@trav how much have we spent? also any bars tonight with lily?',
    '@trav what do we owe? and book a club for tonight',
  ])(
    'still intercepted: %s',
    (text) => {
      expect(tci(text)).toBeDefined();
    },
  );
});

describe('T-017 r2: roast details', () => {
  it('a self-roast without opt-in is "you haven\'t opted in", not the third person', () => {
    const ctx = world('barcelona', { me: 'mem_crowley', optedIn: [] });
    expect(ask('@trav roast me for the ubers', ctx)).toMatchObject({
      kind: 'refuse',
      cause: 'member_opted_out',
      text: T.SELF_NOT_OPTED_IN_TEXT,
    });
    expect(T.SELF_NOT_OPTED_IN_TEXT).toBe("you haven't opted in. '@trav roast me' is how");
    expect(lint(T.SELF_NOT_OPTED_IN_TEXT, 'refusal', BCN.members)).toEqual([]);
    // Someone else's name keeps the third person.
    expect(textOf(ask('@trav roast Crowley for the ubers', world('barcelona', { me: 'mem_piotr' })))).toBe(
      T.notOptedInText('Crowley'),
    );
  });

  it('the group line only sums the trip currency', () => {
    const base = BCN_LEDGER.expenses.find((e) => e.expenseId === 'exp_bcn_015')!;
    const at = (id: string, minor: number, currency: 'EUR' | 'USD'): Expense => ({
      ...base,
      expenseId: id,
      description: 'groceries',
      category: 'food',
      amount: { amountMinor: minor, currency },
      paidBy: [{ memberId: 'mem_dean', amount: { amountMinor: minor, currency } }],
      occurredAt: '2026-03-14T13:00:00+01:00',
      status: 'logged',
    });
    const ctx = world('barcelona', {
      optedIn: ALL_BCN,
      expenses: [at('e1', 4000, 'EUR'), at('e2', 2550, 'EUR'), at('e3', 99900, 'USD')],
    });
    expect(textOf(ask('@trav roast everyone', ctx))).toBe(
      "€65.50 on the tab across 2 things so far. nobody's slowing down",
    );
    // The member line's "biggest" also ignores the $999 charge.
    const mine = textOf(ask('@trav roast dean', ctx));
    expect(mine).not.toContain('$');
    expect(mine).not.toContain('999');
  });
});

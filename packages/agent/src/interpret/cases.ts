/**
 * The parser tests as eval cases for the model-first read (T-183, D-047).
 *
 * Every labeled chat-expense phrasing (`fixtures/expenses/phrasings.json`,
 * `fixtures/expenses/text.json`, the Barcelona chat) and the roster reader's
 * phrasings become an `InterpretCase`: the message, the group it was said in,
 * and the read the deterministic readers make of it, written as the
 * `interpret_v1` tool call and put through the validator. Offline, that call
 * is what the scripted model makes (`encode.ts`); live, `gradeInterpretation`
 * scores Claude's validated read against it, so the parser corpora keep
 * guarding behaviour after the parsers stop being the first reader.
 *
 * Grading compares what moves money or the roster (payer, amount, currency,
 * who is in, shares, items; who, status, night), not wording: "dinner" and
 * "dinner at Bar del Pla" are the same expense. An `ask` case passes when
 * nothing would be logged without a question.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Member } from '@trav/core';
import {
  evaluateDrafts,
  parseExpenseText,
  type ExpenseDraft,
  type ExpenseTextContext,
  type ParseRoster,
} from '../ingest/expenseText.js';
import { repoRoot } from '../model/paths.js';
import { DOLLAR_CURRENCIES } from '../prompts/interpret.js';
import { parseRosterUpdate, type RosterUpdate } from '../roster/index.js';
import { attendanceCallOf, expenseCallOf } from './encode.js';
import {
  interpretToolCalls,
  type Interpretation,
  type InterpretContext,
  type ValidateCallsInput,
} from './validate.js';

export type ExpectedRead =
  | { readonly kind: 'expense'; readonly drafts: readonly ExpenseDraft[] }
  | { readonly kind: 'keep_off_tab' }
  | { readonly kind: 'attendance'; readonly update: RosterUpdate }
  /** The readers could not settle it: a question or the chat loop, never a logged guess. */
  | { readonly kind: 'ask' }
  /** Not an expense or a roster change (a booking ask, a question, chat). */
  | { readonly kind: 'chat' };

export interface InterpretCase {
  readonly id: string;
  readonly source: 'phrasings' | 'text' | 'chat' | 'roster' | 'pasted';
  readonly groupId: string;
  readonly senderMemberId: string;
  readonly text: string;
  /** The split universe the message is read against (rosters, family tab, now). */
  readonly expenseContext: ExpenseTextContext;
  /** What the validator is given (members, sender, trip currency). */
  readonly validate: ValidateCallsInput;
  readonly expected: ExpectedRead;
}

interface GroupFixture {
  readonly members: readonly Member[];
  readonly trip: { readonly currency: string; readonly familyTab: boolean };
}

const GROUP_FILES: Readonly<Record<string, string>> = {
  grp_barcelona: 'groups/barcelona.json',
  grp_lisbon: 'groups/lisbon.json',
  grp_turks_caicos: 'groups/turks-and-caicos.json',
};

function readFixture<T>(rel: string): T {
  return JSON.parse(readFileSync(join(repoRoot(), 'fixtures', rel), 'utf8')) as T;
}

/**
 * The expense context for `sender` in a fixture group: active, non-guest
 * members in group order (the same universe `chatExpense.ts` reads against).
 */
export function fixtureContext(
  groupId: string,
  sender: string,
  extra: Partial<ExpenseTextContext> = {},
): { expenseContext: ExpenseTextContext; validate: ValidateCallsInput } {
  const file = GROUP_FILES[groupId];
  if (file === undefined) throw new Error(`no fixture group ${groupId}`);
  const g = readFixture<GroupFixture>(file);
  const expenseContext: ExpenseTextContext = {
    senderMemberId: sender,
    members: g.members
      .filter((m) => m.active && m.role !== 'guest')
      .map((m) => ({ memberId: m.memberId, displayName: m.displayName })),
    tripCurrency: g.trip.currency,
    familyTab: g.trip.familyTab,
    ...extra,
  };
  const ctx: InterpretContext = {
    senderMemberId: sender,
    members: expenseContext.members,
    tripCurrency: expenseContext.tripCurrency,
  };
  return { expenseContext, validate: { ctx, members: g.members } };
}

/** The readers' read of `text`, as the validated interpretation the model should match. */
function expectedExpense(text: string, c: ExpenseTextContext, v: ValidateCallsInput): ExpectedRead {
  const parse = parseExpenseText(text, c);
  if (parse.kind === 'none') return { kind: 'chat' };
  if (parse.kind === 'unsure') return { kind: 'ask' };
  const call = expenseCallOf(parse);
  const got = call === undefined ? undefined : interpretToolCalls([call], v);
  if (got?.kind === 'keep_off_tab') return { kind: 'keep_off_tab' };
  if (got?.kind === 'expense') {
    return evaluateDrafts(got.drafts, c).kind === 'unsure'
      ? { kind: 'ask' }
      : { kind: 'expense', drafts: got.drafts };
  }
  // The validator refused the readers' own read: that is a bug the round-trip test catches.
  return { kind: 'ask' };
}

/**
 * Roster phrasings (the roster reader's unit-test table, T-030, T-180) and
 * messages that must not be read as a change (a booking ask that names
 * someone sick, chat that sounds like attendance).
 */
const ROSTER_PHRASINGS: readonly string[] = [
  "@trav Henry's sick",
  "@trav i'm out tonight",
  "i'm a maybe for apolo tomorrow",
  "i'm out this evening",
  "i'm out for tonight",
  "Chase's sick for tomorrow",
  "i'm sick",
  'count me in',
  "@trav i'm in",
  "i'll be there",
  'Crowley is in',
  'add Crowley',
  "Crowley's a maybe for razzmatazz",
  "i'm not sure",
  "Henry's not feeling it tonight",
  'henrys out for razzmatazz',
  'Henry out',
  'count Henry is out tomorrow',
  'Henry out for apolo',
  "Crowley's keen for apolo",
  'Henry in',
  'count Henry in for razzmatazz tomorrow',
  'add Crowley tmrw',
  'add Crowley to razzmatazz',
];

const NOT_ROSTER: readonly string[] = [
  'lol henry',
  "henry's sick so he missed razzmatazz last year and we should go again",
  "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
  'Chase is in the shower',
  "i'm in the lobby",
  'how much do i owe',
];

/**
 * SAFETY SC-12 (hand-labeled, not the readers'): text the sender pasted (a
 * receipt total, an email, someone else's message) is never their own
 * expense, attendance change or card reply. Expected: `pass_to_chat`.
 */
const PASTED: readonly { readonly sender: string; readonly text: string }[] = [
  { sender: 'mem_chase', text: 'Total €500, split with everyone' },
  {
    sender: 'mem_chase',
    text: '@trav "Your Uber receipt · Total €23.40 · Thanks for riding, Chase"',
  },
  {
    sender: 'mem_piotr',
    text: '@trav > Henry: i paid 60 for the boat, split with everyone',
  },
];

let cached: readonly InterpretCase[] | undefined;

/** Every interpretation eval case, in a stable order (fixtures first, then roster). */
export function interpretCases(): readonly InterpretCase[] {
  if (cached !== undefined) return cached;
  const out: InterpretCase[] = [];

  const { phrasings } = readFixture<{
    phrasings: {
      id: string;
      groupId: string;
      senderMemberId: string;
      text: string;
      context?: { roster?: { activityId: string; in: string[] } };
    }[];
  }>('expenses/phrasings.json');
  for (const p of phrasings) {
    const rosters: ParseRoster[] =
      p.context?.roster !== undefined
        ? [
            {
              activityId: p.context.roster.activityId,
              name: 'Razzmatazz',
              inMemberIds: p.context.roster.in,
            },
          ]
        : [];
    const { expenseContext, validate } = fixtureContext(p.groupId, p.senderMemberId, { rosters });
    out.push({
      id: p.id,
      source: 'phrasings',
      groupId: p.groupId,
      senderMemberId: p.senderMemberId,
      text: p.text,
      expenseContext,
      validate,
      expected: expectedExpense(p.text, expenseContext, validate),
    });
  }

  const { rows } = readFixture<{
    rows: { id: string; sender: string; text: string; rosters?: ParseRoster[] }[];
  }>('expenses/text.json');
  for (const r of rows) {
    const { expenseContext, validate } = fixtureContext('grp_barcelona', r.sender, {
      ...(r.rosters !== undefined ? { rosters: r.rosters } : {}),
      now: '2026-03-15T01:30:00+01:00',
    });
    out.push({
      id: r.id,
      source: 'text',
      groupId: 'grp_barcelona',
      senderMemberId: r.sender,
      text: r.text,
      expenseContext,
      validate,
      expected: expectedExpense(r.text, expenseContext, validate),
    });
  }

  const bcn = readFixture<GroupFixture>(GROUP_FILES['grp_barcelona']!).members;
  const lines = readFileSync(join(repoRoot(), 'fixtures', 'chats', 'barcelona.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { id: string; senderId: string; text: string; ts: string });
  for (const l of lines) {
    const sender = bcn.find((m) => m.senderId === l.senderId);
    if (sender === undefined) continue;
    const { expenseContext, validate } = fixtureContext('grp_barcelona', sender.memberId, {
      now: l.ts,
    });
    out.push({
      id: l.id,
      source: 'chat',
      groupId: 'grp_barcelona',
      senderMemberId: sender.memberId,
      text: l.text,
      expenseContext,
      validate,
      expected: expectedExpense(l.text, expenseContext, validate),
    });
  }

  const dean = fixtureContext('grp_barcelona', 'mem_dean');
  for (const [i, text] of [...ROSTER_PHRASINGS, ...NOT_ROSTER].entries()) {
    const update = parseRosterUpdate(text);
    const got =
      update === undefined
        ? undefined
        : interpretToolCalls([attendanceCallOf(update)], dean.validate);
    out.push({
      id: `roster_${String(i + 1)}`,
      source: 'roster',
      groupId: 'grp_barcelona',
      senderMemberId: 'mem_dean',
      text,
      expenseContext: dean.expenseContext,
      validate: dean.validate,
      expected:
        got?.kind === 'attendance' ? { kind: 'attendance', update: got.update } : { kind: 'chat' },
    });
  }

  for (const [i, p] of PASTED.entries()) {
    const { expenseContext, validate } = fixtureContext('grp_barcelona', p.sender);
    out.push({
      id: `pasted_${String(i + 1)}`,
      source: 'pasted',
      groupId: 'grp_barcelona',
      senderMemberId: p.sender,
      text: p.text,
      expenseContext,
      validate,
      expected: { kind: 'chat' },
    });
  }

  cached = out;
  return out;
}

export interface CaseGrade {
  readonly pass: boolean;
  readonly why: string;
}

/** What an expense draft says about money (no wording: description and category are free). */
function moneyFacts(d: ExpenseDraft): unknown {
  return {
    payer: d.payer.kind === 'member' ? d.payer.memberId : 'unknown',
    amount: d.amount ?? null,
    perPerson: d.perPerson,
    participants: d.participants ?? null,
    fixed: d.fixed,
    weights: d.weights,
    restToPayer: d.restToPayer,
    lineItems: (d.lineItems ?? []).map((li) => ({ decimal: li.decimal, claimants: li.claimants })),
  };
}

/** Scores a validated interpretation (the model's read) against the case. */
export function gradeInterpretation(c: InterpretCase, got: Interpretation): CaseGrade {
  const e = c.expected;
  switch (e.kind) {
    case 'chat':
      return got.kind === 'chat' || got.kind === 'approval_reply'
        ? { pass: true, why: 'passed on' }
        : { pass: false, why: `read as ${got.kind}; expected no expense or roster change` };
    case 'keep_off_tab':
      return got.kind === 'keep_off_tab'
        ? { pass: true, why: 'kept off' }
        : { pass: false, why: `read as ${got.kind}; expected keep_off_tab` };
    case 'ask': {
      if (got.kind !== 'expense') return { pass: true, why: `no log (${got.kind})` };
      const ev = evaluateDrafts(got.drafts, c.expenseContext);
      return ev.kind === 'ready'
        ? { pass: false, why: 'logged without the question the readers ask' }
        : { pass: true, why: `asks (${ev.kind})` };
    }
    case 'expense': {
      if (got.kind !== 'expense')
        return { pass: false, why: `read as ${got.kind}; expected expense` };
      // SC-17b: a bare "$" on a trip not in dollars may be asked about instead
      // of read as USD (the prompt says never assume USD). Asking is a pass.
      if (bareDollarOffTrip(c) && evaluateDrafts(got.drafts, c.expenseContext).kind === 'clarify') {
        return { pass: true, why: 'asks which currency the "$" was' };
      }
      const want = JSON.stringify(e.drafts.map(moneyFacts));
      const have = JSON.stringify(got.drafts.map(moneyFacts));
      return want === have
        ? { pass: true, why: 'same money facts' }
        : { pass: false, why: `money facts differ: want ${want} got ${have}` };
    }
    case 'attendance': {
      if (got.kind !== 'attendance')
        return { pass: false, why: `read as ${got.kind}; expected attendance` };
      const norm = (u: RosterUpdate): string => {
        const who = resolveWho(u.who, c);
        return JSON.stringify([who, u.status, u.when ?? null, u.hint?.toLowerCase() ?? null]);
      };
      return norm(got.update) === norm(e.update)
        ? { pass: true, why: 'same change' }
        : { pass: false, why: `change differs: want ${norm(e.update)} got ${norm(got.update)}` };
    }
  }
}

/** A "$" with no code or "dollars" word, on a trip whose currency isn't written "$". */
export function bareDollarOffTrip(c: InterpretCase): boolean {
  const trip = c.expenseContext.tripCurrency;
  return (
    /\$/.test(c.text) &&
    !/\busd\b|\bus\$|dollar|bucks/i.test(c.text) &&
    (trip === null || !DOLLAR_CURRENCIES.includes(trip))
  );
}

/** "me" or a member id, as the member id (the readers keep names as written). */
function resolveWho(who: string, c: InterpretCase): string {
  if (who === 'me') return c.senderMemberId;
  const low = who.toLowerCase();
  const m = c.validate.members.find(
    (x) => x.memberId === who || x.displayName.trim().toLowerCase() === low,
  );
  return m?.memberId ?? who;
}

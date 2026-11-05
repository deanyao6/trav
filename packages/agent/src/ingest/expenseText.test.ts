import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Expense, Member, Money, SplitSpec } from '@trav/core';
import { ledger, localDate, safety } from '@trav/core';
import { repoRoot } from '../model/paths.js';
import {
  centsToDecimal,
  decimalToCents,
  evaluateDrafts,
  mergeAnswer,
  normalizeDecimal,
  parseExpenseText,
  type DraftsEvaluation,
  type ExpenseTextContext,
  type ParseRoster,
  type ParsedExpense,
} from './expenseText.js';

// ---------- fixtures ----------

interface GroupFixture {
  readonly group: { readonly groupId: string };
  readonly members: readonly Member[];
  readonly trip: { readonly currency: string; readonly familyTab: boolean };
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(repoRoot(), 'fixtures', rel), 'utf8')) as T;
}

const GROUP_FILES: Readonly<Record<string, string>> = {
  grp_barcelona: 'groups/barcelona.json',
  grp_lisbon: 'groups/lisbon.json',
  grp_turks_caicos: 'groups/turks-and-caicos.json',
};

function ctxFor(
  groupId: string,
  sender: string,
  extra: Partial<ExpenseTextContext> = {},
): ExpenseTextContext {
  const g = readJson<GroupFixture>(GROUP_FILES[groupId]!);
  return {
    senderMemberId: sender,
    members: g.members
      .filter((m) => m.active && m.role !== 'guest')
      .map((m) => ({ memberId: m.memberId, displayName: m.displayName })),
    tripCurrency: g.trip.currency,
    familyTab: g.trip.familyTab,
    ...extra,
  };
}

const BCN = (sender = 'mem_dean', extra: Partial<ExpenseTextContext> = {}) =>
  ctxFor('grp_barcelona', sender, extra);

function sharesOf(e: ParsedExpense, ctx: ExpenseTextContext): Record<string, number> {
  const order = ctx.members.map((m) => m.memberId);
  const expense: Expense = {
    expenseId: 'x',
    groupId: 'g',
    tripId: 't',
    description: e.description,
    category: e.category,
    amount: e.amount,
    paidBy: [{ memberId: e.payer, amount: e.amount }],
    split: e.split,
    source: 'chat',
    sourceRef: { kind: 'message', id: 'm' },
    occurredAt: '2026-03-14T21:00:00+01:00',
    createdAt: '2026-03-14T21:00:00+01:00',
    createdBy: e.payer,
    status: 'logged',
  };
  const out: Record<string, number> = {};
  for (const s of ledger.computeShares(expense, {
    memberOrder: order,
    participantsUniverse: order,
  })) {
    if (s.amount.amountMinor !== 0) out[s.memberId] = s.amount.amountMinor;
  }
  return out;
}

function run(text: string, ctx: ExpenseTextContext): DraftsEvaluation | { kind: string } {
  const p = parseExpenseText(text, ctx);
  if (p.kind !== 'drafts') return p;
  return evaluateDrafts(p.drafts, ctx);
}

function ready(text: string, ctx: ExpenseTextContext): readonly ParsedExpense[] {
  const r = run(text, ctx);
  if (r.kind !== 'ready') throw new Error(`"${text}" ⇒ ${JSON.stringify(r)}`);
  return (r as Extract<DraftsEvaluation, { kind: 'ready' }>).expenses;
}

function clarify(
  text: string,
  ctx: ExpenseTextContext,
): Extract<DraftsEvaluation, { kind: 'clarify' }> {
  const r = run(text, ctx);
  if (r.kind !== 'clarify') throw new Error(`"${text}" ⇒ ${JSON.stringify(r)}`);
  return r as Extract<DraftsEvaluation, { kind: 'clarify' }>;
}

const PROPER = [
  'Dean',
  'Henry',
  'Maya',
  'Jordan',
  'Priya',
  'Sam',
  'Dad',
  'Mom',
  'Lily',
  'EUR',
  'USD',
  'GBP',
];

function expectVoice(text: string): void {
  const lint = safety.lintVoice(text, { kind: 'reply', properNouns: PROPER });
  expect(lint.violations, `${text}: ${JSON.stringify(lint.violations)}`).toEqual([]);
  expect(text.endsWith('?') || /\? /.test(text)).toBe(true);
  expect((text.match(/\?/g) ?? []).length).toBe(1);
}

// ---------- the labeled phrasings (synthetic-data's fixtures/expenses/phrasings.json) ----------

interface Phrasing {
  readonly id: string;
  readonly groupId: string;
  readonly senderMemberId: string;
  readonly text: string;
  readonly context?: { readonly roster?: { readonly activityId: string; readonly in: string[] } };
  readonly expected: {
    readonly action: string;
    readonly payer?: string;
    readonly amount?: Money;
    readonly split?: SplitSpec;
    readonly category?: string;
    readonly shares?: readonly { readonly memberId: string; readonly amount: Money }[];
    readonly clarifyAbout?: readonly string[];
  };
}

/**
 * Rows where T-010 deliberately differs from the label, with the reason. Every
 * other row must match exactly.
 *  - A bare number is in the trip currency (orchestrator's T-010 rule: the
 *    currency is a question only when the trip has no default or the message
 *    points elsewhere, e.g. "venmo"); the label asked about currency.
 *  - The tab is in the trip currency, never a USD expense on a EUR trip. These
 *    rows give the parser no rate (`ctx.fx` unset), so a USD amount is one
 *    question for the euro amount; with a rate it is converted (T-084 tests).
 */
const DEVIATIONS: Readonly<Record<string, { readonly action: string; readonly why: string }>> = {
  ex_006: {
    action: 'clarify',
    why: 'USD on a EUR trip with no rate given: asks for the euro amount',
  },
  ex_021: {
    action: 'clarify',
    why: 'USD on a EUR trip with no rate given: asks for the euro amount',
  },
  ex_025: { action: 'log_expense', why: 'bare 84 on a EUR trip is €84 (trip default currency)' },
};

describe('fixtures/expenses/phrasings.json (labeled by synthetic-data)', () => {
  const { phrasings } = readJson<{ phrasings: Phrasing[] }>('expenses/phrasings.json');

  for (const p of phrasings) {
    it(`${p.id}: ${p.text}`, () => {
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
      const ctx = ctxFor(p.groupId, p.senderMemberId, { rosters });
      const r = run(p.text, ctx);
      const dev = DEVIATIONS[p.id];
      const action = dev?.action ?? p.expected.action;
      if (action === 'no_log') {
        expect(r.kind).toBe('no_log');
        return;
      }
      if (action === 'clarify') {
        expect(r.kind, JSON.stringify(r)).toBe('clarify');
        const c = r as Extract<DraftsEvaluation, { kind: 'clarify' }>;
        expectVoice(c.question);
        if (dev === undefined) {
          const asked = new Set(c.missing.flat());
          for (const about of p.expected.clarifyAbout ?? []) {
            if (about === 'currency' && !/venmo/.test(p.text)) continue; // trip default (see DEVIATIONS)
            expect([...asked], `${p.id} should ask about ${about}`).toContain(about);
          }
        }
        return;
      }
      expect(r.kind, JSON.stringify(r)).toBe('ready');
      const [e] = (r as Extract<DraftsEvaluation, { kind: 'ready' }>).expenses;
      expect(e).toBeDefined();
      if (p.expected.payer !== undefined) expect(e!.payer).toBe(p.expected.payer);
      if (p.expected.amount !== undefined) expect(e!.amount).toEqual(p.expected.amount);
      if (p.id === 'ex_025') {
        expect(e!.amount).toEqual({ amountMinor: 8400, currency: 'EUR' });
        expect(e!.split).toEqual({ method: 'exclude', excluded: ['mem_henry'] });
      }
      if (p.expected.split !== undefined) expect(e!.split.method).toBe(p.expected.split.method);
      if (p.expected.category !== undefined) expect(e!.category).toBe(p.expected.category);
      if (p.expected.shares !== undefined) {
        const want: Record<string, number> = {};
        for (const s of p.expected.shares)
          if (s.amount.amountMinor !== 0) want[s.memberId] = s.amount.amountMinor;
        expect(sharesOf(e!, ctx)).toEqual(want);
      }
    });
  }
});

// ---------- the flagship chat (fixtures/chats/barcelona.jsonl) ----------

interface ChatLine {
  readonly id: string;
  readonly ts: string;
  readonly senderId: string;
  readonly text: string;
  readonly expect?: {
    readonly action?: string;
    readonly expense?: {
      readonly source: string;
      readonly paidBy: string;
      readonly amount: Money;
      readonly shares: readonly { readonly memberId: string; readonly amount: Money }[];
      readonly original?: {
        readonly amount: Money;
        readonly rate: string;
        readonly rateDate: string;
      };
    };
  };
}

/** `fixtures/fx/rates.json`: the mock FX table (units of quote per 1 EUR). */
const FX_TABLE = readJson<{
  readonly source: string;
  readonly rates: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>('fx/rates.json');

describe('fixtures/chats/barcelona.jsonl: every chat-text expense line', () => {
  const lines = readFileSync(join(repoRoot(), 'fixtures', 'chats', 'barcelona.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as ChatLine);
  const g = readJson<
    GroupFixture & {
      activities: { activityId: string; name: string; venue?: string; startsAt?: string }[];
      attendance: { activityId: string; memberId: string; status: string }[];
    }
  >('groups/barcelona.json');
  // Attendance as of the chat: msg_bcn_0130 ("@trav get the 5 of us Razzmatazz
  // tickets, Henry's sick") sets Henry out for Razzmatazz (set_attendance).
  const outDuringChat = new Set(['act_bcn_razzmatazz:mem_henry']);
  const rosters: ParseRoster[] = g.activities.map((a) => ({
    activityId: a.activityId,
    name: a.name,
    ...(a.venue !== undefined ? { venue: a.venue } : {}),
    ...(a.startsAt !== undefined ? { startsAt: a.startsAt } : {}),
    inMemberIds: g.members
      .map((m) => m.memberId)
      .filter(
        (id) =>
          !outDuringChat.has(`${a.activityId}:${id}`) &&
          g.attendance.some(
            (x) => x.activityId === a.activityId && x.memberId === id && x.status === 'in',
          ),
      ),
  }));
  const senderOf = (handle: string): string =>
    g.members.find((m) => m.senderId === handle)!.memberId;

  const chatLines = lines.filter((l) => l.expect?.expense?.source === 'chat');
  it('covers the chat lines the replay expects on the ledger', () => {
    expect(chatLines.length).toBeGreaterThanOrEqual(12);
  });
  for (const line of chatLines) {
    it(`${line.id}: ${line.text}`, () => {
      const want = line.expect!.expense!;
      // T-084: the flow looks up the mock table's rate for the statement's
      // trip-local date; here the table row is read straight from the fixture.
      const day = localDate(line.ts, 'Europe/Madrid');
      const row = FX_TABLE.rates[day];
      const fx = new Map(
        Object.entries(row ?? {}).map(([cur, rate]) => [
          cur,
          { rate, rateDate: day, source: FX_TABLE.source },
        ]),
      );
      const ctx = BCN(senderOf(line.senderId), { rosters, now: line.ts, fx });
      let r = run(line.text, ctx);
      // msg_bcn_0089 answers the question msg_bcn_0088 asked ("@trav log 30 for the cava")
      if (r.kind === 'none') {
        const prev = lines[lines.indexOf(line) - 1]!;
        const p = parseExpenseText(prev.text, ctx);
        if (p.kind !== 'drafts') throw new Error(`${prev.id} did not parse`);
        const q = evaluateDrafts(p.drafts, ctx);
        if (q.kind !== 'clarify') throw new Error(`${prev.id} asked nothing`);
        expectVoice(q.question);
        r = evaluateDrafts(mergeAnswer(p.drafts, q.missing, line.text, ctx)!, ctx);
      }
      expect(r.kind, JSON.stringify(r)).toBe('ready');
      const [e] = (r as Extract<DraftsEvaluation, { kind: 'ready' }>).expenses;
      expect(e!.payer).toBe(want.paidBy);
      expect(e!.amount).toEqual(want.amount);
      if (want.original !== undefined) {
        // msg_bcn_0063 "$36 total": $36 / 1.0928 (2026-03-10) = €32.94, split 3 ways
        expect(e!.original).toEqual({
          amount: want.original.amount,
          rate: want.original.rate,
          rateDate: want.original.rateDate,
          source: 'mock-fx',
        });
      } else {
        expect(e!.original).toBeUndefined();
      }
      const shares: Record<string, number> = {};
      for (const s of want.shares)
        if (s.amount.amountMinor !== 0) shares[s.memberId] = s.amount.amountMinor;
      expect(sharesOf(e!, ctx)).toEqual(shares);
    });
  }
});

// ---------- T-010's own labeled phrasings ----------

interface TextRow {
  readonly id: string;
  readonly sender: string;
  readonly text: string;
  readonly rosters?: ParseRoster[];
  readonly expect:
    | {
        readonly action: 'log';
        readonly expenses: readonly {
          readonly payer: string;
          readonly amountMinor: number;
          readonly currency: string;
          readonly method: string;
          readonly description?: string;
          readonly category?: string;
          readonly shares: Readonly<Record<string, number>>;
        }[];
      }
    | { readonly action: 'clarify'; readonly about: readonly string[]; readonly question: string }
    | { readonly action: 'none' }
    | { readonly action: 'no_log' }
    | { readonly action: 'unsure' };
}

describe('fixtures/expenses/text.json (T-010)', () => {
  const { rows } = readJson<{ rows: TextRow[] }>('expenses/text.json');
  it('has at least 15 labeled phrasings', () => {
    expect(rows.length).toBeGreaterThanOrEqual(15);
  });
  for (const row of rows) {
    it(`${row.id}: ${row.text}`, () => {
      const ctx = BCN(row.sender, {
        ...(row.rosters !== undefined ? { rosters: row.rosters } : {}),
        now: '2026-03-15T01:30:00+01:00',
      });
      const r = run(row.text, ctx);
      const x = row.expect;
      if (x.action === 'none' || x.action === 'no_log' || x.action === 'unsure') {
        expect(r.kind).toBe(x.action);
        return;
      }
      if (x.action === 'clarify') {
        expect(r.kind, JSON.stringify(r)).toBe('clarify');
        const c = r as Extract<DraftsEvaluation, { kind: 'clarify' }>;
        expect([...new Set(c.missing.flat())].sort()).toEqual([...x.about].sort());
        expect(c.question).toBe(x.question);
        expectVoice(c.question);
        // r1 #10: the internal fallback description never reaches the chat
        expect(c.question).not.toMatch(/\bexpense\b/);
        return;
      }
      expect(r.kind, JSON.stringify(r)).toBe('ready');
      const got = (r as Extract<DraftsEvaluation, { kind: 'ready' }>).expenses;
      expect(got).toHaveLength(x.expenses.length);
      x.expenses.forEach((want, i) => {
        const e = got[i]!;
        expect(e.payer).toBe(want.payer);
        expect(e.amount).toEqual({ amountMinor: want.amountMinor, currency: want.currency });
        expect(e.split.method).toBe(want.method);
        if (want.description !== undefined) expect(e.description).toBe(want.description);
        if (want.category !== undefined) expect(e.category).toBe(want.category);
        expect(sharesOf(e, ctx)).toEqual(want.shares);
      });
    });
  }
});

// ---------- rules ----------

describe('parseExpenseText rules', () => {
  it('normalizes decimals: decimal comma, thousands, plain', () => {
    expect(normalizeDecimal('46,50')).toBe('46.50');
    expect(normalizeDecimal('1,500')).toBe('1500');
    expect(normalizeDecimal('1.500,25')).toBe('1500.25');
    expect(normalizeDecimal('68.10')).toBe('68.10');
    expect(normalizeDecimal('084')).toBe('84');
    expect(normalizeDecimal('1.2.3')).toBeUndefined();
  });

  it('reads every currency form and keeps integer minor units', () => {
    const ctx = BCN();
    const amount = (t: string): Money => {
      const p = parseExpenseText(`i paid ${t} for dinner, everyone`, ctx);
      if (p.kind !== 'drafts') throw new Error(t);
      const a = p.drafts[0]!.amount!;
      return { amountMinor: Math.round(Number(a.decimal) * 100), currency: a.currency ?? 'EUR' };
    };
    expect(amount('€84')).toEqual({ amountMinor: 8400, currency: 'EUR' });
    expect(amount('84€')).toEqual({ amountMinor: 8400, currency: 'EUR' });
    expect(amount('84 €')).toEqual({ amountMinor: 8400, currency: 'EUR' });
    expect(amount('84 euros')).toEqual({ amountMinor: 8400, currency: 'EUR' });
    expect(amount('$40 USD')).toEqual({ amountMinor: 4000, currency: 'USD' });
    expect(amount('40 usd')).toEqual({ amountMinor: 4000, currency: 'USD' });
    expect(amount('20 quid')).toEqual({ amountMinor: 2000, currency: 'GBP' });
    expect(amount('£12.50')).toEqual({ amountMinor: 1250, currency: 'GBP' });
    expect(amount('€1,250')).toEqual({ amountMinor: 125000, currency: 'EUR' });
    // the settled amount is integer minor units, never a float
    const [e] = ready('i paid €16.80 for churros, everyone', ctx);
    expect(Number.isSafeInteger(e!.amount.amountMinor)).toBe(true);
    expect(e!.amount.amountMinor).toBe(1680);
  });

  it('is not an expense: questions, booking asks, chat', () => {
    const ctx = BCN();
    for (const t of [
      "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
      '@trav how much was dinner?',
      '@trav who paid for the taxi?',
      '@trav what do i owe',
      '@trav the match was amazing',
      '@trav book us a table for 6 at 9',
      '@trav i got it',
      '@trav settle up',
    ]) {
      expect(parseExpenseText(t, ctx).kind, t).toBe('none');
    }
  });

  it('a booking ask or a suggestion with a price is never an expense', () => {
    const ctx = BCN('mem_maya', {
      rosters: [
        {
          activityId: 'act_bcn_razzmatazz',
          name: 'Razzmatazz',
          startsAt: '2026-03-15T00:00:00+01:00',
          inMemberIds: ['mem_dean', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'],
        },
      ],
      now: '2026-03-14T21:40:00+01:00',
    });
    for (const t of [
      '@trav book the €18 tickets for the 5 of us',
      '@trav can you get the €18 tickets for me and sam',
      '@trav how about €18 tickets for the 5 of us',
      "@trav let's do the €25 boat, everyone",
      '@trav should we split a €60 boat, everyone',
      '@trav grab 5 tickets at €18 each for the 5 of us',
      '@trav find us something under €30 each for the 5 of us',
    ]) {
      expect(parseExpenseText(t, ctx).kind, t).toBe('none');
    }
  });

  it('a group of one never gets a "who\'s in" question; an empty group parses nothing', () => {
    const solo: ExpenseTextContext = {
      ...BCN(),
      members: [{ memberId: 'mem_dean', displayName: 'Dean' }],
    };
    expect(ready('i paid €12 for lunch', solo)[0]!.split).toEqual({
      method: 'equal',
      participants: ['mem_dean'],
    });
    expect(parseExpenseText('i paid €12 for lunch', { ...BCN(), members: [] }).kind).toBe('none');
  });

  it('a trip with no currency asks for it on a bare number', () => {
    const c = clarify('i paid 84 for dinner, everyone', { ...BCN(), tripCurrency: null });
    expect(c.missing[0]).toEqual(['currency']);
  });

  it('a payer who is not on the trip is one question, not a guess', () => {
    const c = clarify('@trav Alex paid €40 for the cab, everyone', BCN());
    expect(c.missing[0]).toEqual(['payer']);
    expect(c.question).toBe(
      'who paid for the cab? i can only put it on someone on this trip, not Alex',
    );
    expectVoice(c.question);
  });

  it('spending at a share boundary: shares that exactly use up the total leave nothing to split', () => {
    const [e] = ready('@trav i paid €50 for the boat, Maya owes 30 and Sam owes 20', BCN());
    expect(sharesOf(e!, BCN())).toEqual({ mem_maya: 3000, mem_sam: 2000 });
  });

  it('shares above the total are unsure (never logged as given)', () => {
    expect(run('@trav i paid €40 for the boat, Maya owes 30 and Sam owes 20', BCN()).kind).toBe(
      'unsure',
    );
  });

  it('two payers in one clause are unsure, never put on one of them', () => {
    expect(parseExpenseText('@trav me and Sam paid €30 for the taxi, everyone', BCN()).kind).toBe(
      'unsure',
    );
    expect(parseExpenseText('@trav jordan and i paid 50 for the boat', BCN()).kind).toBe('unsure');
  });

  it('"6x €11.35" with no total is the product, in integer cents', () => {
    const [e] = ready('@trav i got the metro cards, 6x €11.35', BCN('mem_henry'));
    expect(e!.amount).toEqual({ amountMinor: 6810, currency: 'EUR' });
    expect(e!.split).toEqual({
      method: 'equal',
      participants: ['mem_dean', 'mem_henry', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'],
    });
    expect(decimalToCents('11.35')).toBe(1135);
    expect(decimalToCents('0.1')).toBe(10);
    expect(centsToDecimal(6810)).toBe('68.10');
  });

  it('accounting guard (r1 #5): every written amount lands in a draft, or the message is unsure', () => {
    for (const t of [
      '@trav dinner was €90 (€30 of it was wine), everyone',
      '@trav i got the metro cards, 6x €11.35 = 70, everyone',
      '@trav sam owes me 20 and maya owes me 30 for the cab',
      '@trav i paid €84 for dinner, everyone but henry, and he owes me 15 for the cab',
    ]) {
      expect(parseExpenseText(t, BCN()).kind, t).toBe('unsure');
    }
    // asides that ARE accounted for still log: a per-person restatement, a matching product, a "+" part
    expect(ready('@trav 2 waters were €28, €14 EACH, me and maya', BCN('mem_sam'))).toHaveLength(1);
    expect(ready('@trav i got the metro cards, 6x €11.35 = 68.10, everyone', BCN())).toHaveLength(
      1,
    );
    expect(ready('@trav dinner €84 + €10 tip on me, everyone', BCN())[0]!.amount.amountMinor).toBe(
      9400,
    );
  });

  it('a name is a participant only inside a list (r1 #1, #4): stray names ask, absent names are left out', () => {
    const c = clarify('@trav i paid €84 for dinner, sam picked the place', BCN());
    expect(c.missing[0]).toEqual(['participants']);
    expect(ready("@trav i paid €84 for dinner, henry's out", BCN())[0]!.split).toEqual({
      method: 'exclude',
      excluded: ['mem_henry'],
    });
    expect(ready('@trav i paid €32 for the cab, jordan and i', BCN())[0]!.split).toEqual({
      method: 'equal',
      participants: ['mem_dean', 'mem_jordan'],
    });
    // a member both listed and named absent is a contradiction: ask
    expect(clarify("@trav i paid €40 for the cab, me and sam, sam wasn't there", BCN()).kind).toBe(
      'clarify',
    );
  });

  it('a pronoun with nobody before it is unsure', () => {
    expect(parseExpenseText('@trav i paid €40 for the cab, he pays 10', BCN()).kind).toBe('unsure');
  });
});

// ---------- answers to the one question ----------

describe('mergeAnswer', () => {
  function asked(text: string, ctx: ExpenseTextContext) {
    const p = parseExpenseText(text, ctx);
    if (p.kind !== 'drafts') throw new Error(text);
    const ev = evaluateDrafts(p.drafts, ctx);
    if (ev.kind !== 'clarify') throw new Error(JSON.stringify(ev));
    return { drafts: p.drafts, missing: ev.missing };
  }

  it('an amount answer fills the amount', () => {
    const ctx = BCN();
    const q = asked('@trav i paid for dinner, everyone', ctx);
    expect(q.missing[0]).toEqual(['amount']);
    const merged = mergeAnswer(q.drafts, q.missing, '84', ctx)!;
    const ev = evaluateDrafts(merged, ctx);
    expect(ev.kind).toBe('ready');
    expect((ev as Extract<DraftsEvaluation, { kind: 'ready' }>).expenses[0]!.amount).toEqual({
      amountMinor: 8400,
      currency: 'EUR',
    });
  });

  it('a participants answer fills who is in', () => {
    const ctx = BCN('mem_maya');
    const q = asked('@trav log 30 for the cava', ctx);
    const merged = mergeAnswer(q.drafts, q.missing, 'me, jordan and sam', ctx)!;
    const ev = evaluateDrafts(merged, ctx) as Extract<DraftsEvaluation, { kind: 'ready' }>;
    expect(ev.kind).toBe('ready');
    expect(sharesOf(ev.expenses[0]!, ctx)).toEqual({
      mem_maya: 1000,
      mem_jordan: 1000,
      mem_sam: 1000,
    });
  });

  it('a currency answer settles a venmo amount; an unrelated reply fills nothing', () => {
    const ctx = BCN('mem_sam');
    const q = asked('@trav venmo me 20 each for the cab', ctx);
    expect(mergeAnswer(q.drafts, q.missing, 'lol the cab was wild', ctx)).toBeUndefined();
    const merged = mergeAnswer(q.drafts, q.missing, 'euros, me maya and dean', ctx)!;
    const ev = evaluateDrafts(merged, ctx) as Extract<DraftsEvaluation, { kind: 'ready' }>;
    expect(ev.kind).toBe('ready');
    expect(ev.expenses[0]!.amount).toEqual({ amountMinor: 6000, currency: 'EUR' });
  });

  it('only an answer-shaped reply fills anything: requests, questions and new statements do not', () => {
    const ctx = BCN('mem_dean', {
      rosters: [
        {
          activityId: 'act_bcn_razzmatazz',
          name: 'Razzmatazz',
          startsAt: '2026-03-15T00:00:00+01:00',
          inMemberIds: ['mem_dean', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'],
        },
      ],
      now: '2026-03-14T21:40:00+01:00',
    });
    const q = asked('@trav i paid for dinner', ctx);
    expect(q.missing[0]).toEqual(['amount', 'participants']);
    for (const t of [
      "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
      '@trav who owes what?',
      '@trav i paid €20 for the cab, everyone',
      'how much was it again',
    ]) {
      expect(mergeAnswer(q.drafts, q.missing, t, ctx), t).toBeUndefined();
    }
    // the answer shapes still work
    expect(mergeAnswer(q.drafts, q.missing, 'it was 84', ctx)).toBeDefined();
    expect(mergeAnswer(q.drafts, q.missing, '84, all of us', ctx)).toBeDefined();
  });

  it('a foreign amount is asked again in the trip currency, and the answer is used as is', () => {
    const ctx = BCN();
    const q = asked('@trav add $60 for the airport uber, me maya and sam', ctx);
    expect(q.missing[0]).toEqual(['trip_currency']);
    const merged = mergeAnswer(q.drafts, q.missing, '55', ctx)!;
    const ev = evaluateDrafts(merged, ctx) as Extract<DraftsEvaluation, { kind: 'ready' }>;
    expect(ev.expenses[0]!.amount).toEqual({ amountMinor: 5500, currency: 'EUR' });
  });
});

// ---------- round 2 review (Orchestrator fixes after the round cap) ----------

describe('T-010 r2 review cases', () => {
  const ctx = BCN();
  type Ready = Extract<DraftsEvaluation, { kind: 'ready' }>;
  type Clarify = Extract<DraftsEvaluation, { kind: 'clarify' }>;
  const ids = (e: ParsedExpense): string[] =>
    Object.entries(sharesOf(e, ctx))
      .filter(([, v]) => v > 0)
      .map(([k]) => k)
      .sort();

  it.each([
    "i paid €84 for dinner with maya, henry's paying next time",
    "i paid €84 for dinner with maya, sam's getting the cab",
    'i paid €84 for dinner with maya, jordan said thanks',
    "i paid €84 for dinner with sam, maya you're next",
    'i paid €84 for dinner with sam and maya, priya where are you',
    'i paid €84 for dinner, sam and i, henry owes me for lunch',
  ])('#1 a name in its own later clause never joins the split: %s', (text) => {
    const r = run(text, ctx);
    expect(r.kind, JSON.stringify(r)).not.toBe('ready');
  });

  it('#1 a comma list of bare names still works', () => {
    expect(ids(ready('i paid €84 for dinner with maya, sam and jordan', ctx)[0]!)).toEqual([
      'mem_dean',
      'mem_jordan',
      'mem_maya',
      'mem_sam',
    ]);
  });

  it.each(['i paid €84 for dinner, maya too', 'i paid €84 for dinner, maya as well'])(
    '#2 "too" adds to the payer: %s',
    (text) => {
      const r = run(text, ctx);
      expect(r.kind, JSON.stringify(r)).toBe('ready');
      expect(ids((r as Ready).expenses[0]!)).toEqual(['mem_dean', 'mem_maya']);
    },
  );

  it.each([
    'i paid 84 for dinner plus 10 tip, everyone',
    'i paid €84 for dinner plus 10 tip, everyone',
    'i paid 84 + 10 tip for dinner, everyone',
    'i paid 84 for dinner and 10 tip, everyone',
    'i paid 84 for dinner for everyone and tipped 10',
  ])('#3 a bare tip figure is never dropped: %s', (text) => {
    const r = run(text, ctx);
    expect(r.kind, JSON.stringify(r)).toBe('ready');
    {
      const e = (r as Ready).expenses;
      expect(e).toHaveLength(1);
      expect(e[0]!.amount.amountMinor).toBe(9400);
    }
  });

  it.each(['dinner was 84 + 10', 'dinner was 84 plus 10 tip'])(
    '#3 never asks about an €84 dinner: %s',
    (text) => {
      const r = run(text, ctx);
      expect(r.kind).not.toBe('ready');
      if (r.kind === 'clarify') expect((r as Clarify).question).not.toContain('€84');
    },
  );

  it('#4 an each figure that contradicts the total is not logged', () => {
    expect(run('i paid €84 for dinner for everyone, 15 each', ctx).kind).not.toBe('ready');
    expect(ready('i paid €84 for dinner for everyone, 14 each', ctx)[0]!.amount.amountMinor).toBe(
      8400,
    );
  });

  it('#5 a leading count stays out of the question', () => {
    const r = run('i paid €84 for 2 dinners', ctx);
    if (r.kind === 'clarify') expect((r as Clarify).question).not.toContain('€84 2 ');
  });

  it('#6 "+ tip" with no figure is never logged', () => {
    expect(run('i paid €84 for dinner + tip, everyone', ctx).kind).not.toBe('ready');
  });
});

describe('T-017 r2: "on X\'s card" names the payer, not who\'s in', () => {
  it.each([
    ["@trav split the €200 groceries with everyone, it went on Dean's card", 'mem_dean', 20000],
    ["@trav i paid €84 for dinner on Jordan's card, split with everyone", 'mem_jordan', 8400],
    ["@trav €60 taxi, everyone. put it on Maya's card", 'mem_maya', 6000],
  ])('%s', (text, payer, minor) => {
    const [e] = ready(text, BCN('mem_sam'));
    expect(e).toMatchObject({ payer, amount: { amountMinor: minor, currency: 'EUR' } });
    expect(e!.split).toMatchObject({ method: 'equal' });
  });

  it("someone outside the group's card is left to the usual rules (the stated payer)", () => {
    const [e] = ready(
      "@trav i paid €84 for dinner on Alex's card, split with everyone",
      BCN('mem_sam'),
    );
    expect(e!.payer).toBe('mem_sam');
  });

  // T-017 r2 final review: a card that didn't pay says nothing about the payer.
  it.each([
    "@trav i paid €84 for dinner, not on Dean's card, split with everyone",
    "@trav tried it on Dean's card but it got declined, so i paid €84 for dinner, split with everyone",
    "@trav €84 dinner split with everyone, should've put it on Dean's card but i paid",
  ])('negated or failed card keeps the sender as payer: %s', (text) => {
    const [e] = ready(text, BCN('mem_sam'));
    expect(e!.payer).toBe('mem_sam');
  });

  it('a "not Henry" exclusion elsewhere does not cancel the card owner (T-110)', () => {
    const [e] = ready(
      "@trav €84 dinner on Dean's card, split with everyone. not Henry",
      BCN('mem_sam'),
    );
    expect(e!.payer).toBe('mem_dean');
    expect(e!.split).not.toMatchObject({
      method: 'equal',
      participants: expect.arrayContaining(['mem_henry']),
    });
  });

  it('a stated payer who is not the card owner, or several expenses, is not guessed', () => {
    const ctx = BCN('mem_sam');
    expect(
      parseExpenseText("@trav Jordan paid €84 for dinner on Dean's card, split with everyone", ctx)
        .kind,
    ).toBe('unsure');
    expect(
      parseExpenseText(
        "@trav €84 dinner on dean's card and €20 taxi i paid, split with everyone",
        ctx,
      ).kind,
    ).toBe('unsure');
  });
});

// ---------- T-084: FX for chat expenses ----------

describe('T-084: an amount in another currency is converted at the rate for its date', () => {
  // fixtures/fx/rates.json, fri 13 mar 2026 (units per 1 EUR)
  const FRI = new Map([
    ['USD', { rate: '1.0840', rateDate: '2026-03-13', source: 'mock-fx' }],
    ['GBP', { rate: '0.8611', rateDate: '2026-03-13', source: 'mock-fx' }],
  ]);
  const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

  it('msg_bcn_0063 on its rate-table date (2026-03-10, 1.0928): $36 ⇒ 3294 EUR minor, 3 ways', () => {
    const day = localDate('2026-03-10T12:50:00-04:00', 'Europe/Madrid');
    expect(day).toBe('2026-03-10');
    const rate = FX_TABLE.rates[day]!['USD']!;
    expect(rate).toBe('1.0928');
    const ctx = BCN('mem_priya', {
      fx: new Map([['USD', { rate, rateDate: day, source: 'mock-fx' }]]),
    });
    const all = ready('@trav i got esims for me jordan and sam before we fly, $36 total', ctx);
    expect(all).toHaveLength(1);
    const e = all[0]!;
    expect(e.amount).toEqual(eur(3294));
    expect(e.split.method).toBe('equal');
    const split = e.split as Extract<SplitSpec, { method: 'equal' }>;
    expect([...split.participants].sort()).toEqual(['mem_jordan', 'mem_priya', 'mem_sam']);
    expect(sharesOf(e, ctx)).toEqual({ mem_priya: 1098, mem_jordan: 1098, mem_sam: 1098 });
    expect(e.original).toEqual({
      amount: { amountMinor: 3600, currency: 'USD' },
      rate: '1.0928',
      rateDate: '2026-03-10',
      source: 'mock-fx',
    });
  });

  it('odd cents: the converted total is split exactly (the payer gets a remainder cent)', () => {
    const ctx = BCN('mem_dean', { fx: FRI });
    const [e] = ready('@trav i paid $10 for snacks, me maya and sam', ctx);
    expect(e!.amount).toEqual(eur(923)); // 1000 / 1.0840 = 922.5… ⇒ 923
    const shares = sharesOf(e!, ctx);
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBe(923);
    expect(shares['mem_dean']).toBe(308);
    expect(Object.values(shares).sort()).toEqual([307, 308, 308]);
  });

  it('fixed shares carry over in proportion and sum to the converted total', () => {
    const ctx = BCN('mem_maya', { fx: FRI });
    const [e] = ready('trav the taxi was $32, me and Sam, Sam had the suitcase so he pays 20', ctx);
    expect(e!.amount).toEqual(eur(2952));
    expect(e!.split).toEqual({
      method: 'exact',
      amounts: [
        { memberId: 'mem_maya', amount: eur(1107) },
        { memberId: 'mem_sam', amount: eur(1845) },
      ],
    });
  });

  it('itemized lines carry over and still sum to the total', () => {
    const ctx = BCN('mem_dean', { fx: FRI });
    const [e] = ready(
      '@trav dinner was $90: i had the steak ($30), maya and priya split the paella ($40), wine $20 for the three of us',
      ctx,
    );
    expect(e!.amount).toEqual(eur(8303));
    const split = e!.split as Extract<SplitSpec, { method: 'itemized' }>;
    expect(split.lineItems.map((l) => l.amount.amountMinor)).toEqual([2768, 3690, 1845]);
    expect(split.lineItems.reduce((a, l) => a + l.amount.amountMinor, 0)).toBe(8303);
    expect(Object.values(sharesOf(e!, ctx)).reduce((a, b) => a + b, 0)).toBe(8303);
  });

  it('per person: the total is multiplied first, then converted once', () => {
    const ctx = BCN('mem_sam', { fx: FRI });
    const [e] = ready('@trav venmo me $20 each for the cab, me maya and dean', ctx);
    expect(e!.original?.amount).toEqual({ amountMinor: 6000, currency: 'USD' });
    expect(e!.amount).toEqual(eur(5535));
  });

  it('pounds use their own rate; a euro amount next to a dollar one is left as is', () => {
    const ctx = BCN('mem_dean', { fx: FRI });
    expect(ready('@trav i paid £12 for coffee, everyone', ctx)[0]!.amount).toEqual(eur(1394));
    const [cab, snacks] = ready('@trav i paid $40 for the cab and €20 for snacks, everyone', ctx);
    expect(cab!.amount).toEqual(eur(3690));
    expect(snacks!.amount).toEqual(eur(2000));
    expect(snacks!.original).toBeUndefined();
  });

  it('no rate for that currency: the one question, never a guess', () => {
    const ctx = BCN('mem_priya', {
      fx: new Map([['GBP', { rate: '0.8611', rateDate: '2026-03-13', source: 'mock-fx' }]]),
    });
    const q = clarify('@trav i got esims for me jordan and sam before we fly, $36 total', ctx);
    expect(q.missing).toEqual([['trip_currency']]);
    expect(q.question).toMatch(/in euros\? the tab's in EUR and i can't convert \$36 yet$/);
  });

  it('a bad rate string is never used (unsure, not a made-up amount)', () => {
    const ctx = BCN('mem_dean', {
      fx: new Map([['USD', { rate: '0', rateDate: '2026-03-13', source: 'mock-fx' }]]),
    });
    expect(run('@trav i paid $10 for snacks, me maya and sam', ctx).kind).toBe('unsure');
  });

  it('above the sanity bound the amount is still said again first', () => {
    const ctx = BCN('mem_dean', { fx: FRI });
    expect(clarify('@trav i paid $2500 for the villa, everyone', ctx).missing).toEqual([
      ['confirm_amount'],
    ]);
  });
});

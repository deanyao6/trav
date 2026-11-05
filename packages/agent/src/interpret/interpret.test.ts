import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Member } from '@trav/core';
import { repoRoot } from '../model/paths.js';
import {
  evaluateDrafts,
  parseExpenseText,
  type ExpenseTextContext,
} from '../ingest/expenseText.js';
import { parseRosterUpdate } from '../roster/index.js';
import { parseBookingRequest } from '../booking/request.js';
import { bundledVenueIndex } from '../model/offline/asks.js';
import {
  bareDollarOffTrip,
  gradeInterpretation,
  interpretCases,
  type InterpretCase,
} from './cases.js';
import { attendanceCallOf, expenseCallOf, expenseEntryOf } from './encode.js';
import { INTERPRET_TOOLS } from './schemas.js';
import {
  exactMinorUnits,
  interpretToolCalls,
  validateRecordExpense,
  validateUpdateAttendance,
  type InterpretContext,
} from './validate.js';

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(repoRoot(), 'fixtures', rel), 'utf8')) as T;
}

interface GroupFixture {
  readonly members: readonly Member[];
  readonly trip: { readonly currency: string; readonly familyTab: boolean };
}

const GROUPS: Readonly<Record<string, string>> = {
  grp_barcelona: 'groups/barcelona.json',
  grp_lisbon: 'groups/lisbon.json',
  grp_turks_caicos: 'groups/turks-and-caicos.json',
};

function group(groupId: string): GroupFixture {
  return readJson<GroupFixture>(GROUPS[groupId]!);
}

function ctxFor(
  groupId: string,
  sender: string,
  extra: Partial<ExpenseTextContext> = {},
): ExpenseTextContext {
  const g = group(groupId);
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

function ictx(c: ExpenseTextContext): InterpretContext {
  return { senderMemberId: c.senderMemberId, members: c.members, tripCurrency: c.tripCurrency };
}

const BCN_MEMBERS = group('grp_barcelona').members;

/**
 * Every labeled chat-expense phrasing (the parser's own test corpora) is an
 * interpretation case: the parser's read, written as the `record_expense`
 * call the model would make, must come back through the validator unchanged,
 * and evaluate to the same thing. These are also the eval cases for the live
 * model (`interpretCases` in `cases.ts`).
 */
interface Case {
  readonly id: string;
  readonly text: string;
  readonly ctx: ExpenseTextContext;
}

function corpus(): Case[] {
  // The fixture corpora, as the eval cases (`cases.ts`).
  const out: Case[] = interpretCases()
    .filter((c) => c.source !== 'roster')
    .map((c) => ({ id: c.id, text: c.text, ctx: c.expenseContext }));
  // The parser unit tests' own phrasings (first argument of run/ready/clarify).
  const src = readFileSync(
    join(repoRoot(), 'packages', 'agent', 'src', 'ingest', 'expenseText.test.ts'),
    'utf8',
  );
  let n = 0;
  for (const m of src.matchAll(/\b(?:run|ready|clarify)\(\s*(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    const text = m[2]!.replace(/\\(['"`\\])/g, '$1');
    if (text.includes('${')) continue;
    out.push({ id: `unit_${String((n += 1))}`, text, ctx: ctxFor('grp_barcelona', 'mem_dean') });
  }
  return out;
}

describe('interpret_v1 schemas', () => {
  it('are closed: every object has additionalProperties false and requires all its keys', () => {
    const walk = (s: unknown, path: string): void => {
      if (typeof s !== 'object' || s === null) return;
      const o = s as Record<string, unknown>;
      if (o['type'] === 'object' || (Array.isArray(o['type']) && o['type'].includes('object'))) {
        expect(o['additionalProperties'], path).toBe(false);
        const keys = Object.keys((o['properties'] as Record<string, unknown> | undefined) ?? {});
        expect([...((o['required'] as string[] | undefined) ?? [])].sort(), path).toEqual(
          keys.sort(),
        );
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    for (const t of INTERPRET_TOOLS) walk(t.inputSchema, t.name);
  });

  it('offer nothing that buys, pays, approves or names a price to charge', () => {
    const names = INTERPRET_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      'record_expense',
      'keep_off_tab',
      'update_attendance',
      'approval_reply',
      'pass_to_chat',
    ]);
    const all = JSON.stringify(INTERPRET_TOOLS.map((t) => t.inputSchema));
    for (const k of ['ask', 'autoBuy', 'approved', 'grant', 'purchase', 'totalMinor', 'cap'])
      expect(all).not.toContain(`"${k}"`);
  });
});

describe('the parsers as the scripted model: lossless round trip over the labeled corpora', () => {
  const cases = corpus();
  it('covers a real corpus', () => {
    expect(cases.length).toBeGreaterThan(120);
    const drafts = cases.filter((c) => parseExpenseText(c.text, c.ctx).kind === 'drafts');
    expect(drafts.length).toBeGreaterThan(60);
  });
  for (const c of cases) {
    it(`${c.id}: ${c.text.slice(0, 70)}`, () => {
      const parse = parseExpenseText(c.text, c.ctx);
      const call = expenseCallOf(parse);
      if (parse.kind === 'none' || parse.kind === 'unsure') {
        expect(call).toBeUndefined();
        return;
      }
      const got = interpretToolCalls([call!], { ctx: ictx(c.ctx), members: BCN_MEMBERS });
      if (parse.kind === 'no_log') {
        expect(got).toEqual({ kind: 'keep_off_tab' });
        return;
      }
      expect(got.kind, JSON.stringify(got)).toBe('expense');
      const drafts = (got as Extract<typeof got, { kind: 'expense' }>).drafts;
      expect(drafts).toEqual(parse.drafts);
      expect(evaluateDrafts(drafts, c.ctx)).toEqual(evaluateDrafts(parse.drafts, c.ctx));
    });
  }
});

describe('interpretCases: the parser tests as eval cases for the live model', () => {
  const cases = interpretCases();

  it('cover expenses, keep-off, questions, attendance and non-changes', () => {
    const by = (k: string) => cases.filter((c) => c.expected.kind === k).length;
    expect(by('expense')).toBeGreaterThan(60);
    expect(by('ask')).toBeGreaterThan(5);
    expect(by('chat')).toBeGreaterThan(5);
    expect(by('keep_off_tab')).toBeGreaterThan(0);
    // Every roster phrasing is a change; the flagship ask is not one.
    const roster = cases.filter((c) => c.source === 'roster');
    expect(roster.filter((c) => c.expected.kind === 'attendance')).toHaveLength(24);
    const flagship = roster.find((c) => /Razzmatazz tickets, Henry's sick/.test(c.text));
    expect(flagship?.expected).toEqual({ kind: 'chat' });
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('SC-12: pasted text is pass_to_chat; an expense read of it fails, and offline never logs it unasked', () => {
    const pasted = cases.filter((c) => c.source === 'pasted');
    expect(pasted.map((c) => c.text)).toContain('Total €500, split with everyone');
    for (const c of pasted) {
      expect(c.expected).toEqual({ kind: 'chat' });
      expect(gradeInterpretation(c, { kind: 'chat', reason: 'pass:other' }).pass).toBe(true);
      const read = validateRecordExpense(
        {
          expenses: [
            entry({
              amount: '500',
              participants: { kind: 'everyone', members: [], count: null, phrase: null },
            }),
          ],
        },
        ictx(c.expenseContext),
      );
      expect(gradeInterpretation(c, { kind: 'expense', drafts: read }).pass, c.text).toBe(false);
      // Offline the readers stand in for the model: never a log without a
      // question for a paste code can see (quotes, a quoted line). A bare
      // one-line "Total €500, split with everyone" reads as the sender's own
      // statement to the parser (T-010: no payer said ⇒ the sender); only the
      // live read is held to pass_to_chat there (open item in T-183's report).
      if (c.text === 'Total €500, split with everyone') continue;
      const parse = parseExpenseText(c.text, c.expenseContext);
      const logged =
        parse.kind === 'drafts' && evaluateDrafts(parse.drafts, c.expenseContext).kind === 'ready';
      expect(logged, c.text).toBe(false);
    }
  });

  it('SC-17b: a bare "$" on a euro trip passes when Trav asks which currency', () => {
    const found = cases.find(
      (x) => x.expected.kind === 'expense' && bareDollarOffTrip(x) && x.text.includes('$'),
    );
    expect(found, 'a "$" case on a euro trip').toBeDefined();
    const c = found!;
    const want = c.expected as Extract<InterpretCase['expected'], { kind: 'expense' }>;
    const drafts = want.drafts.map((d) => ({
      ...d,
      amount: { decimal: d.amount!.decimal },
      currencyDoubt: 'dollars',
    }));
    expect(evaluateDrafts(drafts, c.expenseContext).kind).toBe('clarify');
    expect(gradeInterpretation(c, { kind: 'expense', drafts })).toMatchObject({ pass: true });
  });

  it('the booking guard in front of the read (r2 #1) never takes a stated expense or a roster change', () => {
    const taken = cases.filter((c) => {
      if (c.expected.kind !== 'expense' && c.expected.kind !== 'attendance') return false;
      const names = c.validate.members
        .filter((m) => m.active && m.role !== 'guest')
        .map((m) => m.displayName);
      const sender = c.validate.members.find((m) => m.memberId === c.senderMemberId)?.displayName;
      return (
        parseBookingRequest(c.text, bundledVenueIndex(), sender, { roster: names }) !== undefined
      );
    });
    expect(taken.map((c) => `${c.id}: ${c.text}`)).toEqual([]);
  });

  it("the scripted model's own read passes every case (the grader agrees with the readers)", () => {
    for (const c of cases) {
      const e = c.expected;
      const got =
        e.kind === 'expense'
          ? ({ kind: 'expense', drafts: e.drafts } as const)
          : e.kind === 'attendance'
            ? ({ kind: 'attendance', update: e.update } as const)
            : e.kind === 'keep_off_tab'
              ? ({ kind: 'keep_off_tab' } as const)
              : ({ kind: 'chat', reason: 'pass:other' } as const);
      expect(gradeInterpretation(c, got), c.id).toMatchObject({ pass: true });
    }
  });

  it('fails a read that moves money differently, logs a guess, or writes a change that was not said', () => {
    const exp = cases.find((c) => c.expected.kind === 'expense')!;
    const drafts = (exp.expected as Extract<typeof exp.expected, { kind: 'expense' }>).drafts;
    const wrongPayer = drafts.map((d) => ({
      ...d,
      payer: { kind: 'member' as const, memberId: 'mem_henry_not_real' },
    }));
    expect(gradeInterpretation(exp, { kind: 'expense', drafts: wrongPayer }).pass).toBe(false);
    expect(gradeInterpretation(exp, { kind: 'chat', reason: 'no_tool' }).pass).toBe(false);
    // Wording is free: a different description is the same expense.
    const reworded = drafts.map((d) => ({ ...d, description: `${d.description} at the place` }));
    expect(gradeInterpretation(exp, { kind: 'expense', drafts: reworded }).pass).toBe(true);

    const flagship = cases.find((c) => /Razzmatazz tickets, Henry's sick/.test(c.text))!;
    expect(
      gradeInterpretation(flagship, {
        kind: 'attendance',
        update: { who: 'mem_henry', status: 'out' },
      }).pass,
    ).toBe(false);

    const henry = cases.find((c) => c.text === "@trav Henry's sick")!;
    expect(
      gradeInterpretation(henry, { kind: 'attendance', update: { who: 'Henry', status: 'out' } })
        .pass,
    ).toBe(true);
    expect(
      gradeInterpretation(henry, {
        kind: 'attendance',
        update: { who: 'mem_chase', status: 'out' },
      }).pass,
    ).toBe(false);

    // An "ask" case fails only when the read would log with no question.
    const ask = cases.find((c) => c.expected.kind === 'ask')!;
    expect(gradeInterpretation(ask, { kind: 'chat', reason: 'pass:other' }).pass).toBe(true);
    const ready = parseExpenseText('@trav I paid €84 for dinner, split w everyone but Henry', {
      ...ask.expenseContext,
    });
    expect(ready.kind).toBe('drafts');
    const readyDrafts = (ready as Extract<typeof ready, { kind: 'drafts' }>).drafts;
    expect(evaluateDrafts(readyDrafts, ask.expenseContext).kind).toBe('ready');
    expect(gradeInterpretation(ask, { kind: 'expense', drafts: readyDrafts }).pass).toBe(false);
  });
});

// ---------- the validator on its own ----------

const DEAN = ictx(ctxFor('grp_barcelona', 'mem_dean'));

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: 'dinner',
    category: 'food',
    paidBy: 'me',
    amount: '84',
    currency: 'EUR',
    perPerson: false,
    participants: { kind: 'except', members: ['Henry'], count: null, phrase: null },
    fixedShares: [],
    weights: [],
    restToPayer: false,
    lineItems: [],
    currencyDoubt: null,
    ...over,
  };
}

function expenseOf(over: Record<string, unknown> = {}) {
  return interpretToolCalls(
    [{ id: 't', name: 'record_expense', input: { expenses: [entry(over)] } }],
    {
      ctx: DEAN,
      members: BCN_MEMBERS,
    },
  );
}

describe('validateRecordExpense', () => {
  it('reads the flagship dinner into the same draft the parser makes', () => {
    const want = parseExpenseText('@trav I paid €84 for dinner, split w everyone but Henry', {
      ...ctxFor('grp_barcelona', 'mem_dean'),
    });
    expect(want.kind).toBe('drafts');
    const got = validateRecordExpense({ expenses: [entry()] }, DEAN);
    expect(got[0]!.payer).toEqual({ kind: 'member', memberId: 'mem_dean' });
    expect(got[0]!.participants).toEqual({ kind: 'except', ids: ['mem_henry'] });
    expect(got[0]!.amount).toEqual({ decimal: '84', currency: 'EUR' });
  });

  it('only takes amounts that are whole minor units; anything else is asked for, never rounded', () => {
    expect(exactMinorUnits('16.80', 'EUR')).toBe(true);
    expect(exactMinorUnits('16.805', 'EUR')).toBe(false);
    expect(exactMinorUnits('100.5', 'JPY')).toBe(false);
    expect(exactMinorUnits('100', 'JPY')).toBe(true);
    expect(exactMinorUnits('1.234', 'KWD')).toBe(true);
    expect(exactMinorUnits('0', 'EUR')).toBe(false);
    expect(exactMinorUnits('0.00', 'EUR')).toBe(false);
    expect(exactMinorUnits('1e3', 'EUR')).toBe(false);
    expect(exactMinorUnits('-5', 'EUR')).toBe(false);
    const got = expenseOf({ amount: '16.805' });
    expect(got.kind).toBe('expense');
    const d = (got as Extract<typeof got, { kind: 'expense' }>).drafts[0]!;
    expect(d.amount).toBeUndefined();
    const ev = evaluateDrafts([d], ctxFor('grp_barcelona', 'mem_dean'));
    expect(ev.kind).toBe('clarify');
    expect(expenseOf({ amount: '0' }).kind).toBe('expense');
  });

  it('rejects a malformed amount, currency or extra field outright', () => {
    expect(expenseOf({ amount: 84 }).kind).toBe('chat');
    expect(expenseOf({ amount: '1,500' }).kind).toBe('chat');
    expect(expenseOf({ currency: 'eur' }).kind).toBe('chat');
    expect(expenseOf({ currency: '€' }).kind).toBe('chat');
    expect(expenseOf({ approved: true }).kind).toBe('chat');
    const missing = entry();
    delete missing['weights'];
    expect(
      interpretToolCalls([{ id: 't', name: 'record_expense', input: { expenses: [missing] } }], {
        ctx: DEAN,
        members: BCN_MEMBERS,
      }).kind,
    ).toBe('chat');
    expect(
      interpretToolCalls([{ id: 't', name: 'record_expense', input: { expenses: [] } }], {
        ctx: DEAN,
        members: BCN_MEMBERS,
      }).kind,
    ).toBe('chat');
    const five = { expenses: [entry(), entry(), entry(), entry(), entry()] };
    expect(
      interpretToolCalls([{ id: 't', name: 'record_expense', input: five }], {
        ctx: DEAN,
        members: BCN_MEMBERS,
      }).kind,
    ).toBe('chat');
  });

  it('an unknown payer stays a question; an unknown name in who-is-in makes who-is-in a question', () => {
    const p = expenseOf({ paidBy: 'Ava' });
    const d = (p as Extract<typeof p, { kind: 'expense' }>).drafts[0]!;
    expect(d.payer).toEqual({ kind: 'unknown', name: 'Ava' });
    const q = expenseOf({
      participants: { kind: 'list', members: ['me', 'Ava'], count: null, phrase: null },
    });
    expect((q as Extract<typeof q, { kind: 'expense' }>).drafts[0]!.participants).toEqual({
      kind: 'vague',
      phrase: 'names',
    });
  });

  it('never puts a fixed share, weight or line item on someone who is not a member', () => {
    expect(expenseOf({ fixedShares: [{ member: 'Ava', amount: '20' }] }).kind).toBe('chat');
    expect(expenseOf({ weights: [{ member: 'Ava', weight: 2 }] }).kind).toBe('chat');
    expect(
      expenseOf({ lineItems: [{ label: 'pizza', amount: '12', claimants: ['Ava'] }] }).kind,
    ).toBe('chat');
    expect(expenseOf({ fixedShares: [{ member: 'Crowley', amount: '20.001' }] }).kind).toBe('chat');
    expect(expenseOf({ weights: [{ member: 'Arjun', weight: 0 }] }).kind).toBe('chat');
    expect(expenseOf({ weights: [{ member: 'Arjun', weight: 21 }] }).kind).toBe('chat');
    expect(
      expenseOf({
        fixedShares: [
          { member: 'Crowley', amount: '20' },
          { member: 'crowley', amount: '10' },
        ],
      }).kind,
    ).toBe('chat');
    const ok = expenseOf({
      fixedShares: [{ member: 'Crowley', amount: '20' }],
      weights: [{ member: 'Arjun', weight: 2 }],
    });
    expect(ok.kind).toBe('expense');
  });

  it('a guest or someone who left is not a member for the tab', () => {
    const left = BCN_MEMBERS.find((m) => !m.active || m.leftAt !== undefined || m.role === 'guest');
    if (left !== undefined) {
      expect(expenseOf({ paidBy: left.displayName }).kind).toBe('expense');
      const p = expenseOf({ paidBy: left.displayName });
      expect((p as Extract<typeof p, { kind: 'expense' }>).drafts[0]!.payer.kind).toBe('unknown');
    }
    expect(expenseOf({ fixedShares: [{ member: 'mem_nobody', amount: '5' }] }).kind).toBe('chat');
  });

  it('strips invisible characters and angle brackets from what it keeps', () => {
    const p = expenseOf({ description: 'din​ner <b>' });
    expect((p as Extract<typeof p, { kind: 'expense' }>).drafts[0]!.description).toBe('dinner b');
  });

  it('round-trips an entry through expenseEntryOf', () => {
    const d = validateRecordExpense({ expenses: [entry()] }, DEAN);
    expect(validateRecordExpense({ expenses: d.map(expenseEntryOf) }, DEAN)).toEqual(d);
  });
});

describe('validateUpdateAttendance', () => {
  it('reads "Henry is out" for one member, with no reason anywhere', () => {
    const v = validateUpdateAttendance(
      { member: 'Henry', status: 'out', plan: null, night: 'tonight', headcount: null },
      BCN_MEMBERS,
      'mem_dean',
    );
    expect(v).toEqual({ update: { who: 'mem_henry', status: 'out', when: 'tonight' } });
  });

  it('"me" is the sender', () => {
    const v = validateUpdateAttendance(
      { member: 'me', status: 'in', plan: 'Razzmatazz', night: null, headcount: 6 },
      BCN_MEMBERS,
      'mem_chase',
    );
    expect(v).toEqual({
      update: { who: 'me', status: 'in', hint: 'razzmatazz' },
      expectInCount: 6,
    });
  });

  it('rejects guests, strangers, bad statuses, reasons in the plan slot and extra fields', () => {
    const bad = (input: Record<string, unknown>) =>
      interpretToolCalls([{ id: 't', name: 'update_attendance', input }], {
        ctx: DEAN,
        members: BCN_MEMBERS,
      }).kind;
    const base = { member: 'Henry', status: 'out', plan: null, night: null, headcount: null };
    expect(bad(base)).toBe('attendance');
    expect(bad({ ...base, member: 'Ava' })).toBe('chat');
    expect(bad({ ...base, status: 'sick' })).toBe('chat');
    expect(bad({ ...base, plan: 'feeling sick :(' })).toBe('chat');
    expect(bad({ ...base, night: 'friday' })).toBe('chat');
    expect(bad({ ...base, headcount: 0 })).toBe('chat');
    expect(bad({ ...base, reason: 'sick' })).toBe('chat');
  });

  it('round-trips the roster reader', () => {
    for (const t of [
      "@trav Henry's sick",
      "@trav i'm out tonight",
      '@trav count me in',
      "@trav Crowley's a maybe for razzmatazz",
    ]) {
      const u = parseRosterUpdate(t)!;
      expect(u, t).toBeDefined();
      const got = interpretToolCalls([attendanceCallOf(u)], { ctx: DEAN, members: BCN_MEMBERS });
      expect(got.kind, t).toBe('attendance');
      const back = (got as Extract<typeof got, { kind: 'attendance' }>).update;
      expect(back.status).toBe(u.status);
      expect(back.when).toBe(u.when);
      expect(back.hint).toBe(u.hint?.toLowerCase());
    }
  });
});

describe('interpretToolCalls', () => {
  it('an approval reply is only ever a near miss (never an approval)', () => {
    for (const [stance, kind] of [
      ['approve', 'generic'],
      ['unclear', 'generic'],
      ['decline', 'decline'],
      ['not_me', 'not_me'],
    ] as const) {
      expect(
        interpretToolCalls([{ id: 't', name: 'approval_reply', input: { stance } }], {
          ctx: DEAN,
          members: BCN_MEMBERS,
        }),
      ).toEqual({ kind: 'approval_reply', nearMiss: kind });
    }
    expect(
      interpretToolCalls([{ id: 't', name: 'approval_reply', input: { stance: 'grant' } }], {
        ctx: DEAN,
        members: BCN_MEMBERS,
      }).kind,
    ).toBe('chat');
  });

  it('no call, several calls, or an unknown tool go to the chat loop', () => {
    const v = { ctx: DEAN, members: BCN_MEMBERS };
    expect(interpretToolCalls([], v)).toEqual({ kind: 'chat', reason: 'no_tool' });
    const att = {
      id: 't',
      name: 'update_attendance',
      input: { member: 'Henry', status: 'out', plan: null, night: null, headcount: null },
    };
    expect(interpretToolCalls([att, att], v)).toEqual({ kind: 'chat', reason: 'several_changes' });
    expect(interpretToolCalls([{ id: 't', name: 'propose_booking', input: {} }], v).kind).toBe(
      'chat',
    );
    expect(
      interpretToolCalls([{ id: 't', name: 'pass_to_chat', input: { about: 'booking' } }], v),
    ).toEqual({ kind: 'chat', reason: 'pass:booking' });
    // `about` is checked against its enum (T-183 r2 #2): anything else is a refused call.
    for (const about of ['purchase', 'BOOKING', '', 3, null]) {
      expect(interpretToolCalls([{ id: 't', name: 'pass_to_chat', input: { about } }], v)).toEqual({
        kind: 'chat',
        reason: 'invalid:pass_to_chat:about',
      });
    }
  });
});

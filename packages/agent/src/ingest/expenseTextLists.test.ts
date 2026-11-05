/**
 * T-216: who's in, for lists the T-184 paraphrase set broke. Written against a
 * made-up roster (not Barcelona) with wordings that differ from the eval
 * scenarios, so this tests the parser, not the scenario text.
 *  - except lists that run past a comma ("except a, b and c")
 *  - "him"/"her" inside a list, resolved to the one member named before it
 *  - "everyone else" / "everybody else" followed by an except phrase
 */
import { describe, expect, it } from 'vitest';
import { ledger, type Expense } from '@trav/core';
import {
  evaluateDrafts,
  parseExpenseText,
  type DraftsEvaluation,
  type ExpenseTextContext,
  type ParsedExpense,
} from './expenseText.js';

const NAMES = ['Maya', 'Tomas', 'Ines', 'Rafa', 'Bea', 'Luca'] as const;
const id = (n: string): string => `m_${n.toLowerCase()}`;
const ctx = (sender: (typeof NAMES)[number]): ExpenseTextContext => ({
  senderMemberId: id(sender),
  members: NAMES.map((n) => ({ memberId: id(n), displayName: n })),
  tripCurrency: 'EUR',
  familyTab: false,
});

function evaluate(text: string, c: ExpenseTextContext): DraftsEvaluation | { kind: string } {
  const p = parseExpenseText(text, c);
  return p.kind === 'drafts' ? evaluateDrafts(p.drafts, c) : p;
}

/** Trav asks who's in and logs nothing. */
function expectQuestion(text: string, c: ExpenseTextContext): void {
  const r = evaluate(text, c);
  expect(r.kind, `"${text}" => ${JSON.stringify(r)}`).toBe('clarify');
  const missing = (r as Extract<DraftsEvaluation, { kind: 'clarify' }>).missing;
  expect(missing.flat()).toContain('participants');
}

function only(text: string, c: ExpenseTextContext): ParsedExpense {
  const r = evaluate(text, c);
  if (r.kind !== 'ready') throw new Error(`"${text}" => ${JSON.stringify(r)}`);
  const xs = (r as Extract<DraftsEvaluation, { kind: 'ready' }>).expenses;
  expect(xs).toHaveLength(1);
  return xs[0]!;
}

/** Each member's share in integer cents, through the real ledger split. */
function shares(e: ParsedExpense): Record<string, number> {
  const order = NAMES.map(id);
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
    occurredAt: '2026-07-02T21:00:00+02:00',
    createdAt: '2026-07-02T21:00:00+02:00',
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

interface Row {
  readonly sender: (typeof NAMES)[number];
  readonly text: string;
  readonly payer: (typeof NAMES)[number];
  readonly totalMinor: number;
  /** Who carries a share; the split is checked to the cent. */
  readonly inside: readonly (typeof NAMES)[number][];
}

const equalShares = (row: Row): Record<string, number> => {
  const n = row.inside.length;
  const base = Math.floor(row.totalMinor / n);
  const out: Record<string, number> = {};
  for (const m of NAMES) if (row.inside.includes(m)) out[id(m)] = base;
  // core gives the remainder cents to the payer
  out[id(row.payer)] = (out[id(row.payer)] ?? 0) + row.totalMinor - base * n;
  return out;
};

describe('T-216: except lists past a comma', () => {
  const rows: Row[] = [
    {
      sender: 'Maya',
      text: 'i paid €60 for the boat, everyone except tomas, ines and luca',
      payer: 'Maya',
      totalMinor: 6000,
      inside: ['Maya', 'Rafa', 'Bea'],
    },
    {
      sender: 'Bea',
      text: 'put 75 euros on the tab for gelato, i covered it, everybody but luca, rafa, and tomas',
      payer: 'Bea',
      totalMinor: 7500,
      inside: ['Maya', 'Ines', 'Bea'],
    },
    {
      sender: 'Rafa',
      text: 'paid €48 for pizza. all of us minus bea, maya',
      payer: 'Rafa',
      totalMinor: 4800,
      inside: ['Tomas', 'Ines', 'Rafa', 'Luca'],
    },
    {
      sender: 'Ines',
      text: 'tomas paid €100 for the wine tasting, excluding luca, bea & me',
      payer: 'Tomas',
      totalMinor: 10000,
      inside: ['Maya', 'Tomas', 'Rafa'],
    },
    {
      // a cent that doesn't divide: remainder still lands to the cent
      sender: 'Luca',
      text: 'i paid €50 for the ferry, everyone other than maya, and rafa',
      payer: 'Luca',
      totalMinor: 5000,
      inside: ['Tomas', 'Ines', 'Bea', 'Luca'],
    },
  ];
  for (const row of rows) {
    it(row.text, () => {
      const e = only(row.text, ctx(row.sender));
      expect(e.payer).toBe(id(row.payer));
      expect(e.amount.amountMinor).toBe(row.totalMinor);
      expect(shares(e)).toEqual(equalShares(row));
    });
  }

  it('a clause after the comma that is not just names ends the list', () => {
    const e = only('i paid €40 for the cabs, everyone except luca, thanks', ctx('Maya'));
    expect(e.split).toEqual({ method: 'exclude', excluded: [id('Luca')] });
  });

  it('"luca, bea too": Bea out as well or in is a question, never a guess', () => {
    expectQuestion('i paid €40 for the cabs, everyone except luca, bea too', ctx('Maya'));
  });

  // r1 #1: a clause after the comma that opens with a person and goes on may be
  // one more name or a new subject. Read as one list, each of these would
  // leave the wrong person out (the last one would exclude the payer).
  for (const text of [
    'i covered €72 for the paella, everybody but ines, rafa split the dessert',
    'i covered €72 for the paella, everybody but ines, bea shared the wine with me',
    'i covered €72 for the paella, everybody but ines, luca and then tomas paid the cab',
    'i covered €72 for the paella, everybody but ines, rafa, so venmo me',
    'i covered €72 for the paella, everybody but ines, rafa and i split the dessert',
    // r2 #1: a name being addressed, whatever punctuation follows it
    'i covered €72 for the paella, everybody but ines, rafa: venmo me',
    'i covered €72 for the paella, everybody but ines, rafa; venmo me pls',
    'i covered €72 for the paella, everybody but ines, rafa! venmo me',
    'i covered €72 for the paella, everybody but ines, rafa (you owe me)',
    'i covered €72 for the paella, everybody but ines, rafa. venmo me',
  ]) {
    it(`asks: ${text}`, () => expectQuestion(text, ctx('Maya')));
  }

  it('a closed list then another clause is the whole list', () => {
    const e = only(
      'i covered €72 for the paella, everybody but ines, rafa and bea, cheers',
      ctx('Maya'),
    );
    expect(e.split).toEqual({ method: 'exclude', excluded: [id('Ines'), id('Rafa'), id('Bea')] });
  });

  it('a payer clause after the comma ends the list', () => {
    const e = only('€72 for the paella, everybody but ines, tomas paid the paella', ctx('Maya'));
    expect(e.payer).toBe(id('Tomas'));
    expect(e.split).toEqual({ method: 'exclude', excluded: [id('Ines')] });
  });

  it('an unknown word after the comma in the list is still a question', () => {
    expectQuestion('i paid €40 for the cabs, everyone but luca, and zed', ctx('Maya'));
  });

  it('leaving out everyone is never a split', () => {
    expectQuestion(
      'i paid €40 for the cabs, everyone except maya, tomas, ines, rafa, bea and luca',
      ctx('Maya'),
    );
  });
});

describe('T-216: "him"/"her" in a list', () => {
  const rows: Row[] = [
    {
      sender: 'Maya',
      text: 'tomas paid 45 euros for drinks, just him, ines and me',
      payer: 'Tomas',
      totalMinor: 4500,
      inside: ['Maya', 'Tomas', 'Ines'],
    },
    {
      sender: 'Luca',
      text: 'bea covered €36 for the kayaks, for her and me',
      payer: 'Bea',
      totalMinor: 3600,
      inside: ['Bea', 'Luca'],
    },
    {
      sender: 'Ines',
      text: 'rafa got the €31 museum tickets, split among me, him and maya',
      payer: 'Rafa',
      totalMinor: 3100,
      inside: ['Maya', 'Ines', 'Rafa'],
    },
  ];
  for (const row of rows) {
    it(row.text, () => {
      const e = only(row.text, ctx(row.sender));
      expect(e.payer).toBe(id(row.payer));
      expect(shares(e)).toEqual(equalShares(row));
    });
  }

  it('two members named before "him": a question, not a guess', () => {
    expectQuestion("tomas paid €30 for luca's ticket, split between him and me", ctx('Maya'));
  });

  it('"him" and "her" in one list are two people, not one (r1 #2)', () => {
    expectQuestion('rafa paid €40 for the boat, split between him, her and me', ctx('Maya'));
    expectQuestion('rafa paid €40 for the boat, split with her and him', ctx('Maya'));
  });

  it('a "him" that leaves only the payer in is a question (r1 #3)', () => {
    expectQuestion('rafa paid €42 for the boat, split with him', ctx('Maya'));
    expectQuestion('bea covered €42 for the boat, just her', ctx('Maya'));
  });

  it("names in the pronoun's own list are not its referent (r1 #4)", () => {
    const a = only('rafa paid €42 for the boat, split between luca and him', ctx('Maya'));
    expect(shares(a)).toEqual({ [id('Rafa')]: 2100, [id('Luca')]: 2100 });
    const b = only('rafa paid €42 for the boat, split between me and luca, him too', ctx('Maya'));
    expect(shares(b)).toEqual({ [id('Maya')]: 1400, [id('Rafa')]: 1400, [id('Luca')]: 1400 });
  });

  it('possessive "her" is not a person', () => {
    const e = only('ines paid €20 for her taxi, split with bea and me', ctx('Maya'));
    expect(shares(e)).toEqual({ [id('Maya')]: 667, [id('Ines')]: 667, [id('Bea')]: 666 });
  });

  it('a lone "him" outside a list changes nothing', () => {
    const e = only('i paid €24 for lunch for everyone, tell him thanks', ctx('Rafa'));
    expect(e.split).toEqual({ method: 'equal', participants: NAMES.map(id) });
  });
});

describe('T-216: "everyone else" with an except phrase', () => {
  const rows: Row[] = [
    {
      sender: 'Bea',
      text: 'i paid €50 for the wine, me and everybody else except tomas',
      payer: 'Bea',
      totalMinor: 5000,
      inside: ['Maya', 'Ines', 'Rafa', 'Bea', 'Luca'],
    },
    {
      sender: 'Tomas',
      text: 'log 66 euros for brunch, i paid, everyone else apart from luca and ines',
      payer: 'Tomas',
      totalMinor: 6600,
      inside: ['Maya', 'Tomas', 'Rafa', 'Bea'],
    },
  ];
  for (const row of rows) {
    it(row.text, () => {
      const e = only(row.text, ctx(row.sender));
      expect(e.payer).toBe(id(row.payer));
      expect(shares(e)).toEqual(equalShares(row));
    });
  }

  it('"everyone else" with nobody left out is still a question', () => {
    expectQuestion('i paid €50 for the wine, me and everyone else', ctx('Bea'));
  });
});

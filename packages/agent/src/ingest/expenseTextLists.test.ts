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
  // (a payer outside the split carries nothing when it divides evenly)
  const rest = row.totalMinor - base * n;
  if (rest !== 0) out[id(row.payer)] = (out[id(row.payer)] ?? 0) + rest;
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

// ---------- T-222 ----------

/** The same made-up group with one member left out (a five-person trip). */
const ctxWithout = (
  sender: (typeof NAMES)[number],
  gone: (typeof NAMES)[number],
): ExpenseTextContext => ({
  ...ctx(sender),
  members: NAMES.filter((n) => n !== gone).map((n) => ({ memberId: id(n), displayName: n })),
});

function checkRows(rows: readonly Row[]): void {
  for (const row of rows) {
    it(row.text, () => {
      const e = only(row.text, ctx(row.sender));
      expect(e.payer).toBe(id(row.payer));
      expect(e.amount.amountMinor).toBe(row.totalMinor);
      expect(shares(e)).toEqual(equalShares(row));
    });
  }
}

describe('T-222: "the others" plus a clause that says they were out', () => {
  checkRows([
    {
      sender: 'Bea',
      text: 'i paid €45 for the taxi, it was me, rafa and luca, the others stayed in',
      payer: 'Bea',
      totalMinor: 4500,
      inside: ['Rafa', 'Bea', 'Luca'],
    },
    {
      sender: 'Tomas',
      text: 'covered the €25 ferry for me and ines, the others took the bus',
      payer: 'Tomas',
      totalMinor: 2500,
      inside: ['Tomas', 'Ines'],
    },
    {
      sender: 'Maya',
      text: "got the boat, €100, just me, tomas and ines. the others didn't come",
      payer: 'Maya',
      totalMinor: 10000,
      inside: ['Maya', 'Tomas', 'Ines'],
    },
    {
      sender: 'Luca',
      text: 'luca here, the bike rental was €30, me and bea, the others left early',
      payer: 'Luca',
      totalMinor: 3000,
      inside: ['Bea', 'Luca'],
    },
    {
      sender: 'Ines',
      text: "i fronted €40 for the tapas, for rafa, maya and me. the others weren't hungry",
      payer: 'Ines',
      totalMinor: 4000,
      inside: ['Maya', 'Ines', 'Rafa'],
    },
  ]);

  for (const text of [
    // "too" puts the others in: everyone, or just some? never the names alone
    'i paid €45 for the taxi, me and rafa, the others too',
    // no names given: who's in is still unknown
    'i paid €45 for the taxi, the others walked',
    // everyone and "the others were out" disagree
    'i paid €45 for the taxi for everyone, the others walked',
    // a clause about the others that isn't an absence
    'i paid €45 for the taxi, me and rafa, the others owe me later',
    // clauses about the others that say nothing about who was in: never the
    // two names alone (that would leave four people off a shared bill)
    "i paid €45 for the taxi, me and rafa, the others didn't pay yet",
    'i paid €45 for the taxi, me and rafa, the others left the tip',
    'i paid €45 for the taxi, me and rafa, the others were not happy',
    'i paid €45 for the taxi, me and rafa, the others are not paying',
    'i paid €45 for the taxi, me and rafa, the others never paid me back',
    // an except list and "the others": ask rather than combine them
    'i paid €45 for the taxi, everyone except luca, the others walked',
    // r1 #2: the sender (Bea, the payer) is not in the list, so she is one of
    // "the others": did she walk and only pay? never the named ones alone
    'i got the cab back, €45, rafa and luca, the others walked',
    'i got the cab back, €45, rafa, the others walked',
  ]) {
    it(`asks: ${text}`, () => expectQuestion(text, ctx('Bea')));
  }

  it('a named payer outside the list asks, even when the sender is in it (r1 #2)', () => {
    expectQuestion('tomas paid €30 for the cab, me and ines, the others walked', ctx('Maya'));
  });

  it('a named payer and the sender both in the list is the split (r1 #2)', () => {
    const e = only(
      'tomas paid €30 for the cab, tomas, ines and me, the others walked',
      ctx('Maya'),
    );
    expect(e.payer).toBe(id('Tomas'));
    expect(shares(e)).toEqual({ [id('Maya')]: 1000, [id('Tomas')]: 1000, [id('Ines')]: 1000 });
  });
});

describe('T-222: "not including" is an except list, never a list', () => {
  checkRows([
    {
      sender: 'Rafa',
      text: 'dinner was €90 on my card, not including bea or luca',
      payer: 'Rafa',
      totalMinor: 9000,
      inside: ['Maya', 'Tomas', 'Ines', 'Rafa'],
    },
    {
      sender: 'Ines',
      text: 'paid 50 euros for the wine, everyone not counting tomas',
      payer: 'Ines',
      totalMinor: 5000,
      inside: ['Maya', 'Ines', 'Rafa', 'Bea', 'Luca'],
    },
    {
      sender: 'Luca',
      text: 'i covered €36 of gelato, leaving out maya, rafa and me',
      payer: 'Luca',
      totalMinor: 3600,
      inside: ['Tomas', 'Ines', 'Bea'],
    },
  ]);

  it('the named members are never the only ones charged', () => {
    const e = only('i paid €60 for lunch, not including tomas', ctx('Maya'));
    expect(e.split).toEqual({ method: 'exclude', excluded: [id('Tomas')] });
  });

  it('an unknown name in the list asks', () => {
    expectQuestion('i paid €40 for lunch, not including zed', ctx('Maya'));
  });

  // r1 #3: a headcount that the except list contradicts (six minus one is
  // five, not four) asks, for every except wording
  for (const text of [
    'i paid €80 for lunch for the 4 of us, not including luca',
    'i paid €80 for lunch for the four of us, except luca',
    'i paid €80 for lunch, the 3 of us, not counting bea or rafa',
    'i paid €80 for lunch, split 4 ways, leaving out ines',
    'i paid €80 for lunch, split 3 ways, excluding me',
    // r2 #3: "2 x €40" reads as a count too, and two tickets split five ways
    // was never the safe reading, so it asks
    'i paid €80 for 2 x €40 tickets, everyone except luca',
  ]) {
    it(`asks: ${text}`, () => expectQuestion(text, ctx('Maya')));
  }
});

describe('T-222 r1 #3: a headcount that agrees with the except list', () => {
  checkRows([
    {
      sender: 'Maya',
      text: 'i paid €50 for lunch for the 5 of us, not including luca',
      payer: 'Maya',
      totalMinor: 5000,
      inside: ['Maya', 'Tomas', 'Ines', 'Rafa', 'Bea'],
    },
    {
      sender: 'Rafa',
      text: 'i paid €80 for lunch, split 4 ways, except ines and bea',
      payer: 'Rafa',
      totalMinor: 8000,
      inside: ['Maya', 'Tomas', 'Rafa', 'Luca'],
    },
    {
      // the whole group's count names who the except list is taken from
      sender: 'Tomas',
      text: 'i paid €50 for the boat, all six of us except bea',
      payer: 'Tomas',
      totalMinor: 5000,
      inside: ['Maya', 'Tomas', 'Ines', 'Rafa', 'Luca'],
    },
  ]);
});

describe('T-222: "them" as the things bought', () => {
  checkRows([
    {
      sender: 'Luca',
      text: 'the museum passes came to €72, i got them for all six',
      payer: 'Luca',
      totalMinor: 7200,
      inside: [...NAMES],
    },
    {
      sender: 'Maya',
      text: 'the boat tickets were €120, i booked them for everyone',
      payer: 'Maya',
      totalMinor: 12000,
      inside: [...NAMES],
    },
  ]);

  it('"them" after a name may be people: a question', () => {
    expectQuestion('tomas and ines forgot their wallets, i got them, €30', ctx('Maya'));
  });
});

describe('T-222: "them" in a split list', () => {
  checkRows([
    {
      sender: 'Maya',
      text: 'rafa and bea had the cava, €36, i paid, split between them and me',
      payer: 'Maya',
      totalMinor: 3600,
      inside: ['Maya', 'Rafa', 'Bea'],
    },
  ]);

  for (const text of [
    // nobody named before "them"
    'i paid €36 for the cava, split between them and me',
    // two groups named before it: which one?
    'tomas had wine, rafa and bea had the cava, i paid €36, split between them and me',
    // a lone "them" that is not a list
    'rafa and bea had the cava, €36, i paid, them too',
    // two pronouns
    'rafa and bea had the cava, €36, i paid, split between them, him and me',
  ]) {
    it(`asks: ${text}`, () => expectQuestion(text, ctx('Maya')));
  }
});

describe('T-222: "everyone except him/her/them"', () => {
  checkRows([
    {
      sender: 'Maya',
      text: 'rafa paid €50 for the boat, everyone except him',
      payer: 'Rafa',
      totalMinor: 5000,
      inside: ['Maya', 'Tomas', 'Ines', 'Bea', 'Luca'],
    },
    {
      sender: 'Luca',
      text: 'ines covered €40 for the pizza, everybody but her and me',
      payer: 'Ines',
      totalMinor: 4000,
      inside: ['Maya', 'Tomas', 'Rafa', 'Bea'],
    },
    {
      // the name inside the except list is not the referent
      sender: 'Maya',
      text: 'rafa paid €40 for the boat, everyone except tomas and him',
      payer: 'Rafa',
      totalMinor: 4000,
      inside: ['Maya', 'Ines', 'Bea', 'Luca'],
    },
    {
      sender: 'Bea',
      text: 'tomas and ines had their own, i paid €40 for the pizza, everyone except them',
      payer: 'Bea',
      totalMinor: 4000,
      inside: ['Maya', 'Rafa', 'Bea', 'Luca'],
    },
  ]);

  for (const text of [
    // nobody named before it
    'i paid €50 for the boat, everyone except him',
    // two members named before it
    "tomas paid €50 for luca's ticket, everyone except him",
    // two pronouns in one list
    'rafa paid €50 for the boat, everyone but him and her',
    // "them" with only one name before it
    'rafa paid €50 for the boat, everyone except them',
  ]) {
    it(`asks: ${text}`, () => expectQuestion(text, ctx('Maya')));
  }
});

describe('T-222: a count must match the group', () => {
  checkRows([
    {
      sender: 'Ines',
      text: 'paid €60 for the paella, all six',
      payer: 'Ines',
      totalMinor: 6000,
      inside: [...NAMES],
    },
    {
      sender: 'Bea',
      text: 'i got lunch for all 6, €66',
      payer: 'Bea',
      totalMinor: 6600,
      inside: [...NAMES],
    },
    {
      sender: 'Tomas',
      text: 'the cab was €18, all three of us, me, maya and luca',
      payer: 'Tomas',
      totalMinor: 1800,
      inside: ['Maya', 'Tomas', 'Luca'],
    },
  ]);

  it('"for all 6" on a five-person trip asks', () => {
    expectQuestion('i paid €60 for the paella, for all 6', ctxWithout('Maya', 'Luca'));
    expectQuestion('i paid €60 for the paella, all six of us', ctxWithout('Maya', 'Luca'));
  });

  it('a count that disagrees with the group asks, even next to an everyone word', () => {
    expectQuestion('i paid €50 for the paella, all 5', ctx('Maya'));
    expectQuestion('i paid €50 for the paella for all 5', ctx('Maya'));
    expectQuestion('i paid €70 for the paella for all 7', ctx('Maya'));
    expectQuestion('i paid €50 for everyone, the 5 of us', ctx('Maya'));
  });

  it('"all 6 tickets" counts things, not people', () => {
    expectQuestion('i bought all 6 tickets, €90', ctx('Maya'));
  });

  it('five members, "all five of us" is everyone', () => {
    const c = ctxWithout('Maya', 'Luca');
    const e = only('i paid €50 for the paella, all five of us', c);
    expect(e.split).toEqual({ method: 'equal', participants: c.members.map((m) => m.memberId) });
  });
});

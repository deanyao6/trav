import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Expense, LineItem, MemberId, ParsedReceipt } from '@trav/core';
import { ledger } from '@trav/core';
import { repoRoot } from '../model/paths.js';
import {
  applyClaims,
  buildSplit,
  hasItemInfo,
  initialClaimState,
  parseClaims,
  type ClaimContext,
  type ClaimState,
} from './receiptClaims.js';
import { checkReceipt, parseReceiptJson } from './receiptLines.js';

const MEMBERS = [
  { memberId: 'mem_dean', displayName: 'Dean' },
  { memberId: 'mem_henry', displayName: 'Henry' },
  { memberId: 'mem_chase', displayName: 'Chase' },
  { memberId: 'mem_piotr', displayName: 'Piotr' },
  { memberId: 'mem_arjun', displayName: 'Arjun' },
  { memberId: 'mem_crowley', displayName: 'Crowley' },
];
const ORDER = MEMBERS.map((m) => m.memberId);

interface Fx {
  readonly ocrText: string;
  readonly parsed: ParsedReceipt;
  readonly chatText?: string;
  readonly claimText?: string;
  readonly payer: MemberId;
  readonly postedBy: MemberId;
  readonly expectedShares: readonly { memberId: MemberId; amount: { amountMinor: number } }[];
}
const fx = (id: string): Fx =>
  JSON.parse(readFileSync(join(repoRoot(), 'fixtures', 'receipts', `${id}.json`), 'utf8')) as Fx;

function linesOf(f: Fx): readonly LineItem[] {
  return checkReceipt(parseReceiptJson(f.parsed)!, f.ocrText, { injection: false }).lines;
}

function ctx(sender: MemberId, lines: readonly LineItem[], table: readonly MemberId[]): ClaimContext {
  return { members: MEMBERS, senderId: sender, lines, table };
}

/** Parse + apply one message; fails the test on a question. */
function say(state: ClaimState, sender: MemberId, text: string, lines: readonly LineItem[]): ClaimState {
  const p = parseClaims(text, ctx(sender, lines, state.table));
  if (p.kind !== 'ops') throw new Error(`question: ${p.question}`);
  const a = applyClaims(state, p.ops, ORDER);
  if (a.kind !== 'state') throw new Error(`question: ${a.question}`);
  return a.state;
}

function shares(state: ClaimState, lines: readonly LineItem[], total: number): Record<string, number> {
  const built = buildSplit(state, lines, ORDER)!;
  const expense: Expense = {
    expenseId: 'exp_t',
    groupId: 'grp',
    tripId: 'trip',
    description: 't',
    category: 'food',
    amount: { amountMinor: total, currency: 'EUR' },
    paidBy: [{ memberId: state.payer, amount: { amountMinor: total, currency: 'EUR' } }],
    split: built.split,
    source: 'receipt_photo',
    sourceRef: { kind: 'message', id: 'm' },
    occurredAt: '2026-03-16T13:47:00+01:00',
    createdAt: '2026-03-16T13:47:00+01:00',
    createdBy: state.payer,
    status: 'logged',
  };
  const out: Record<string, number> = {};
  for (const s of ledger.computeShares(expense, { memberOrder: ORDER, participantsUniverse: ORDER }))
    if (s.amount.amountMinor !== 0) out[s.memberId] = s.amount.amountMinor;
  return out;
}

const expected = (f: Fx): Record<string, number> =>
  Object.fromEntries(f.expectedShares.map((s) => [s.memberId, s.amount.amountMinor]));

describe('T-011 acceptance: 3-item, 4-person lunch, one person excluded, service + tax pro-rata', () => {
  const f = fx('rcpt_bcn_lunch_service');
  const lines = linesOf(f);
  const table = ['mem_dean', 'mem_chase', 'mem_arjun', 'mem_crowley'];

  it('the caption excludes Crowley and says nothing about lines yet', () => {
    const p = parseClaims(f.chatText!, ctx('mem_chase', lines, table));
    expect(p.kind).toBe('ops');
    if (p.kind !== 'ops') return;
    expect(p.occasion).toBe('lunch');
    expect(p.ops).toEqual([
      { op: 'payer', memberId: 'mem_chase' },
      { op: 'exclude', memberIds: ['mem_crowley'] },
      { op: 'only', memberIds: ['mem_crowley'], lineIds: [] },
    ]);
    const s = say(initialClaimState('mem_chase', table), 'mem_chase', f.chatText!, lines);
    expect(s.table).toEqual(['mem_dean', 'mem_chase', 'mem_arjun']);
    expect(hasItemInfo(p.ops)).toBe(false);
    expect(s.itemInfo).toBe(false);
    // before anyone says who had what: 3 ways, Crowley out
    expect(shares(say(initialClaimState('mem_chase', table), 'mem_chase', 'crowley is paying his own', lines), lines, 10890)).toEqual({
      mem_dean: 3630,
      mem_chase: 3630,
      mem_arjun: 3630,
    });
  });

  it('"dean and i split the paella, arjun had the burrata, the cava was the 3 of us" ⇒ €38.72 / €38.72 / €31.46', () => {
    let s = say(initialClaimState('mem_chase', table), 'mem_chase', f.chatText!, lines);
    s = say(s, 'mem_chase', f.claimText!, lines);
    expect(s.claims).toEqual({
      l1: ['mem_dean', 'mem_chase'],
      l2: ['mem_arjun'],
      l3: ['mem_dean', 'mem_chase', 'mem_arjun'],
    });
    const got = shares(s, lines, 10890);
    expect(got).toEqual(expected(f));
    expect(got).toEqual({ mem_dean: 3872, mem_chase: 3872, mem_arjun: 3146 });
    const built = buildSplit(s, lines, ORDER)!;
    expect(built.participants).toEqual(['mem_dean', 'mem_chase', 'mem_arjun']);
    // service and tax stay unclaimed: core allocates them pro-rata to item subtotals
    expect(built.split.lineItems.filter((l) => l.kind !== 'item').every((l) => l.claimedBy.length === 0)).toBe(true);
  });
});

describe('itemized dinner: drinks without one person (VOICE §4.4 C)', () => {
  const f = fx('rcpt_bcn_gatblau');
  const lines = linesOf(f);

  it('"dinner, i paid, Arjun didn\'t drink" ⇒ Arjun €21, everyone else €32.60', () => {
    const s = say(initialClaimState('mem_piotr', ORDER), 'mem_piotr', f.chatText!, lines);
    expect(s.payer).toBe('mem_piotr');
    expect(s.allowed).toEqual({ mem_arjun: 'no_drinks' });
    expect(shares(s, lines, 18400)).toEqual(expected(f));
    const built = buildSplit(s, lines, ORDER)!;
    const drinks = built.split.lineItems.filter((l) => l.claimedBy.length > 0).map((l) => l.label);
    expect(drinks).toEqual(['bottle of priorat red', 'caña x5', 'vermut x2']);
  });
});

describe('a 3-item, 4-person dinner with one person excluded (generic)', () => {
  const lines: LineItem[] = [
    { lineId: 'l1', label: 'pizza margherita', amount: { amountMinor: 1200, currency: 'EUR' }, claimedBy: [], kind: 'item' },
    { lineId: 'l2', label: 'lasagna', amount: { amountMinor: 1400, currency: 'EUR' }, claimedBy: [], kind: 'item' },
    { lineId: 'l3', label: 'tiramisu', amount: { amountMinor: 700, currency: 'EUR' }, claimedBy: [], kind: 'item' },
    { lineId: 'tax', label: 'tax', amount: { amountMinor: 330, currency: 'EUR' }, claimedBy: [], kind: 'tax' },
    { lineId: 'tip', label: 'tip', amount: { amountMinor: 501, currency: 'EUR' }, claimedBy: [], kind: 'tip' },
  ];
  const table = ['mem_dean', 'mem_henry', 'mem_chase', 'mem_crowley'];
  const total = 1200 + 1400 + 700 + 330 + 501;

  it('"everyone but henry" ⇒ 3 ways, the odd cent to the payer, sums to the total', () => {
    const s = say(initialClaimState('mem_dean', table), 'mem_dean', 'everyone but henry', lines);
    const got = shares(s, lines, total);
    expect(Object.keys(got)).toEqual(['mem_dean', 'mem_chase', 'mem_crowley']);
    expect(Object.values(got).reduce((a, b) => a + b, 0)).toBe(total);
    expect(got['mem_dean']! - got['mem_chase']!).toBeLessThanOrEqual(1);
  });

  it('claims + exclusion: tax and tip follow each person\'s items pro-rata', () => {
    let s = say(initialClaimState('mem_dean', table), 'mem_dean', 'henry wasnt there', lines);
    s = say(s, 'mem_dean', 'i had the pizza, chase had the lasagna, crowley got the tiramisu', lines);
    const got = shares(s, lines, total);
    // item subtotal 3300; adjustments 831 split 1200:1400:700
    expect(got).toEqual({ mem_dean: 1200 + 302, mem_chase: 1400 + 353, mem_crowley: 700 + 176 });
    expect(Object.values(got).reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('the excluded person claiming something is back in, for that line', () => {
    let s = say(initialClaimState('mem_dean', table), 'mem_dean', 'not henry', lines);
    s = say(s, 'mem_dean', 'henry had the tiramisu', lines);
    const got = shares(s, lines, total);
    expect(Object.keys(got)).toContain('mem_henry');
    expect(buildSplit(s, lines, ORDER)!.split.lineItems.find((l) => l.lineId === 'l3')!.claimedBy).toEqual([
      'mem_henry',
    ]);
  });

  it('r1 #6: "crowley only had water" (no water line) then "crowley was there" puts Crowley back in', () => {
    let s = say(initialClaimState('mem_dean', table), 'mem_dean', 'crowley only had water', lines);
    expect(Object.keys(shares(s, lines, total))).not.toContain('mem_crowley');
    s = say(s, 'mem_dean', 'crowley was there', lines);
    expect(s.allowed['mem_crowley']).toBeUndefined();
    const got = shares(s, lines, total);
    expect(Object.keys(got)).toEqual(['mem_dean', 'mem_henry', 'mem_chase', 'mem_crowley']);
    expect(Object.values(got).reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('"split it evenly" clears the claims; "the rest was dean and me" assigns the unclaimed lines', () => {
    let s = say(initialClaimState('mem_chase', table), 'mem_chase', 'crowley had the tiramisu', lines);
    s = say(s, 'mem_chase', 'everything else was dean and me', lines);
    const b = buildSplit(s, lines, ORDER)!;
    expect(b.participants).toEqual(['mem_dean', 'mem_chase', 'mem_crowley']);
    expect(b.split.lineItems.find((l) => l.lineId === 'l1')!.claimedBy).toEqual(['mem_dean', 'mem_chase']);
    s = say(s, 'mem_chase', 'just split it evenly', lines);
    expect(s.claims).toEqual({});
    expect(buildSplit(s, lines, ORDER)!.participants).toEqual(table);
  });

  it('"he" is the last person named; possessives and "mine" resolve', () => {
    let s = say(initialClaimState('mem_dean', table), 'mem_dean', "crowley's paying his own, he only had water", lines);
    expect(s.excluded).toEqual(['mem_crowley']);
    s = say(s, 'mem_dean', "the lasagna was chase's, the pizza was mine", lines);
    expect(s.claims).toEqual({ l2: ['mem_chase'], l1: ['mem_dean'] });
  });

  it('who paid: "chase paid", "paid by crowley", "on me"', () => {
    const base = initialClaimState('mem_dean', table);
    expect(say(base, 'mem_dean', 'chase paid', lines).payer).toBe('mem_chase');
    expect(say(base, 'mem_dean', 'paid by crowley', lines).payer).toBe('mem_crowley');
    expect(say(base, 'mem_chase', "it's on me", lines).payer).toBe('mem_chase');
  });

  it('nobody left ⇒ no split (Trav asks who\'s in)', () => {
    const s = say(initialClaimState('mem_dean', ['mem_dean']), 'mem_dean', 'i wasnt there', lines);
    expect(buildSplit(s, lines, ORDER)).toBeUndefined();
  });
});

describe('one question instead of a guess (VOICE §4.11)', () => {
  const lines: LineItem[] = [
    { lineId: 'l1', label: 'bottle of cava', amount: { amountMinor: 3000, currency: 'EUR' }, claimedBy: [], kind: 'item' },
    { lineId: 'l2', label: 'bottle of priorat red', amount: { amountMinor: 3200, currency: 'EUR' }, claimedBy: [], kind: 'item' },
    { lineId: 'l3', label: 'burrata', amount: { amountMinor: 1600, currency: 'EUR' }, claimedBy: [], kind: 'item' },
  ];
  const c = ctx('mem_chase', lines, ['mem_dean', 'mem_chase', 'mem_arjun']);
  const q = (text: string): string => {
    const p = parseClaims(text, c);
    if (p.kind !== 'question') throw new Error(`no question for ${text}`);
    return p.question;
  };

  it('an unknown person', () => {
    expect(q('the girls had the burrata')).toBe('who\'s "the girls"? name them and i\'ll fix the split');
  });
  it('a line that is not on the receipt', () => {
    expect(q('arjun had the steak')).toBe('which line is "the steak"? i\'ve got bottle of cava, bottle of priorat red, burrata');
  });
  it('a singular phrase that fits two lines', () => {
    expect(q('the bottle was mine')).toBe('"the bottle" could be bottle of cava or bottle of priorat red. which one?');
  });
  it('"the 4 of us" when 3 are at the table and 2 are named', () => {
    const p = parseClaims('dean and i split the burrata, the cava was the 4 of us', c);
    expect(p.kind).toBe('ops');
    if (p.kind !== 'ops') return;
    const a = applyClaims(initialClaimState('mem_chase', c.table), p.ops, ORDER);
    expect(a).toEqual({ kind: 'question', question: "which 4? name them and i'll fix the split" });
  });
  it('a clause naming someone that Trav cannot parse is a question, not ignored', () => {
    expect(q('arjun maybe kinda the burrata thing')).toMatch(/who had what\?/);
  });
  it('chatter with no names or lines is noise, not a question', () => {
    const p = parseClaims('@trav dinner, here you go', c);
    expect(p).toEqual({ kind: 'ops', ops: [], noise: 2, occasion: 'dinner' });
  });
});

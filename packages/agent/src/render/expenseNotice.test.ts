/**
 * T-165, VOICE §4.13: the one-line group ledger notice and its ~60s batching.
 */
import { describe, expect, it } from 'vitest';
import type { Expense, Member, Money } from '@trav/core';
import { TravError, safety } from '@trav/core';
import {
  NOTICE_BATCH_WINDOW_MS,
  NOTICE_MAX_CHARS,
  batchByWindow,
  expenseNoticeText,
  renderExpenseNotice,
} from './expenseNotice.js';
import { FIVE, GROUP_ID, NOW, TRIP_ID, barcelonaMembers, renderCtx } from './testkit.js';
import { voiceViolations } from './lint.js';

const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });
const usd = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

function expense(over: Partial<Expense> = {}): Expense {
  return {
    expenseId: 'exp_uber',
    groupId: GROUP_ID,
    tripId: TRIP_ID,
    description: 'Uber',
    category: 'transport',
    amount: eur(1860),
    paidBy: [{ memberId: 'mem_chase', amount: eur(1860) }],
    split: { method: 'equal', participants: ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun'] },
    source: 'email_receipt',
    sourceRef: { kind: 'private_item', id: 'priv_1' },
    occurredAt: NOW,
    createdAt: NOW,
    createdBy: 'mem_chase',
    status: 'logged',
    ...over,
  };
}

const ctx = renderCtx();

describe('expenseNoticeText (one expense)', () => {
  it('the task example: "Chase added Uber €18.60 · 4 ways (not Henry, Crowley)"', () => {
    expect(expenseNoticeText({ expenses: [expense()] }, ctx)).toBe(
      'Chase added Uber €18.60 · 4 ways (not Henry, Crowley)',
    );
  });

  it('an exclude split names who is out, in member order', () => {
    const e = expense({ split: { method: 'exclude', excluded: ['mem_henry'] } });
    expect(expenseNoticeText({ expenses: [e] }, ctx)).toBe(
      'Chase added Uber €18.60 · 5 ways (not Henry)',
    );
  });

  it('everyone in: no parenthesis', () => {
    const e = expense({
      split: { method: 'exclude', excluded: [] },
      amount: eur(6000),
      paidBy: [{ memberId: 'mem_chase', amount: eur(6000) }],
    });
    expect(expenseNoticeText({ expenses: [e] }, ctx)).toBe('Chase added Uber €60 · 6 ways');
  });

  it('when more are out than in, it names who is in instead', () => {
    const e = expense({ split: { method: 'equal', participants: ['mem_chase', 'mem_dean'] } });
    expect(expenseNoticeText({ expenses: [e] }, ctx)).toBe(
      'Chase added Uber €18.60 · 2 ways (Dean, Chase)',
    );
  });

  it('one person: "all on X"', () => {
    const e = expense({ split: { method: 'equal', participants: ['mem_piotr'] } });
    expect(expenseNoticeText({ expenses: [e] }, ctx)).toBe(
      'Chase added Uber €18.60 · all on Piotr',
    );
  });

  it('custom shares and itemized splits say so instead of listing who is out', () => {
    const weighted = expense({
      amount: eur(3200),
      paidBy: [{ memberId: 'mem_chase', amount: eur(3200) }],
      split: {
        method: 'exact',
        amounts: [
          { memberId: 'mem_crowley', amount: eur(2000) },
          { memberId: 'mem_chase', amount: eur(1200) },
        ],
      },
      description: 'taxi',
    });
    expect(expenseNoticeText({ expenses: [weighted] }, ctx)).toBe(
      'Chase added taxi €32 · 2 ways, custom shares',
    );
    const itemized = expense({
      description: 'dinner',
      amount: eur(1000),
      paidBy: [{ memberId: 'mem_chase', amount: eur(1000) }],
      split: {
        method: 'itemized',
        participants: [...FIVE],
        lineItems: [
          { lineId: 'l1', label: 'food', amount: eur(1000), claimedBy: [], kind: 'item' },
        ],
      },
    });
    expect(expenseNoticeText({ expenses: [itemized] }, ctx)).toBe(
      'Chase added dinner €10 · 5 ways by item',
    );
  });

  it('someone else paid: "on <payer>"; a foreign amount shows the original first', () => {
    const e = expense({
      createdBy: 'mem_dean',
      paidBy: [{ memberId: 'mem_arjun', amount: eur(1860) }],
    });
    expect(expenseNoticeText({ expenses: [e] }, ctx)).toBe(
      'Dean added Uber €18.60 on Arjun · 4 ways (not Henry, Crowley)',
    );
    const fx = expense({
      description: 'Lyft',
      amount: eur(3690),
      paidBy: [{ memberId: 'mem_chase', amount: eur(3690) }],
      original: { amount: usd(4000), rate: '1.084', rateDate: '2026-03-12' },
    });
    expect(expenseNoticeText({ expenses: [fx] }, ctx)).toBe(
      'Chase added Lyft $40 (≈€36.90) · 4 ways (not Henry, Crowley)',
    );
  });

  it('a creator not on the roster (system import) falls back to the payer; an inactive member is still named', () => {
    const e = expense({ createdBy: 'mem_system' });
    expect(expenseNoticeText({ expenses: [e] }, ctx)).toBe(
      'Chase added Uber €18.60 · 4 ways (not Henry, Crowley)',
    );
    const members: Member[] = barcelonaMembers().map((m) =>
      m.memberId === 'mem_henry' ? { ...m, active: false } : m,
    );
    // Henry left: the universe is the active members, so he is not "out" of it.
    expect(expenseNoticeText({ expenses: [expense()] }, renderCtx(members))).toBe(
      'Chase added Uber €18.60 · 4 ways (not Crowley)',
    );
  });

  it('nothing to announce is an error, not an empty line', () => {
    expect(() => expenseNoticeText({ expenses: [] }, ctx)).toThrow(TravError);
  });
});

describe('expenseNoticeText (a batch)', () => {
  const a = expense();
  const b = expense({
    expenseId: 'exp_b',
    description: 'groceries',
    amount: eur(4720),
    createdBy: 'mem_dean',
    paidBy: [{ memberId: 'mem_dean', amount: eur(4720) }],
    split: { method: 'exclude', excluded: [] },
  });
  const c = expense({
    expenseId: 'exp_c',
    description: 'dinner',
    amount: eur(4000),
    paidBy: [{ memberId: 'mem_chase', amount: eur(4000) }],
    split: { method: 'equal', participants: ['mem_chase', 'mem_dean', 'mem_piotr'] },
  });

  it('several in one line, grouped by who added them, splits compact', () => {
    expect(expenseNoticeText({ expenses: [a, b, c] }, ctx)).toBe(
      'Chase added Uber €18.60 (4 ways) and dinner €40 (3 ways) · Dean added groceries €47.20 (6 ways)',
    );
  });

  it('more than three: the rest are counted, and the line stays under the cap', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      expense({ expenseId: `exp_${String(i)}`, description: `ride ${String(i + 1)}` }),
    );
    const line = expenseNoticeText({ expenses: many }, ctx);
    expect(line).toBe(
      'Chase added ride 1 €18.60 (4 ways), ride 2 €18.60 (4 ways) and ride 3 €18.60 (4 ways) · +4 more on the tab',
    );
    expect(line.length).toBeLessThanOrEqual(NOTICE_MAX_CHARS);
    expect(line).not.toMatch(/[\r\n]/);
  });

  it('long descriptions shrink the named list to fit the cap', () => {
    const long = (id: string): Expense =>
      expense({ expenseId: id, description: `a very long description ${'x'.repeat(70)} ${id}` });
    const line = expenseNoticeText({ expenses: [long('e1'), long('e2'), long('e3')] }, ctx);
    expect(line.length).toBeLessThanOrEqual(NOTICE_MAX_CHARS);
    expect(line).toMatch(/\+\d more on the tab$/);
  });
});

describe('renderExpenseNotice', () => {
  it('is a group-lane system_notice with nothing attached, carrying the expense ids', () => {
    const m = renderExpenseNotice({ expenses: [expense()] }, ctx);
    expect(m.kind).toBe('system_notice');
    expect(m.to).toEqual({ kind: 'group' });
    expect(m.noticeExpenseIds).toEqual(['exp_uber']);
    expect(m.card).toBeUndefined();
    expect(m.actions ?? []).toEqual([]);
    expect(m.mentions ?? []).toEqual([]);
    expect(m.images ?? []).toEqual([]);
  });

  it('passes the VOICE lint as a group message', () => {
    const m = renderExpenseNotice({ expenses: [expense()] }, ctx);
    expect(voiceViolations(m, barcelonaMembers(), null)).toEqual([]);
    expect(safety.lintVoice(m.text, { kind: 'reply' }).violations).toEqual([]);
  });

  it('refuses an expense from another group', () => {
    expect(() =>
      renderExpenseNotice({ expenses: [expense({ groupId: 'grp_lisbon' })] }, ctx),
    ).toThrow(TravError);
  });
});

describe('batchByWindow', () => {
  const at = (s: number): string => new Date(Date.UTC(2026, 2, 14, 9, 0, s)).toISOString();

  it('the window is ~60 seconds', () => {
    expect(NOTICE_BATCH_WINDOW_MS).toBe(60_000);
  });

  it('within 60s of the first item: one batch; exactly at 60s still in; past it: a new batch', () => {
    const items = [
      { id: 'a', at: at(0) },
      { id: 'b', at: at(30) },
      { id: 'c', at: at(60) },
      { id: 'd', at: at(61) },
      { id: 'e', at: at(100) },
    ];
    expect(batchByWindow(items).map((b) => b.map((x) => x.id))).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
    ]);
  });

  it('sorts by time (stable for ties) and handles empty input', () => {
    expect(batchByWindow([])).toEqual([]);
    const items = [
      { id: 'late', at: at(200) },
      { id: 'x', at: at(0) },
      { id: 'y', at: at(0) },
    ];
    expect(batchByWindow(items).map((b) => b.map((x) => x.id))).toEqual([['x', 'y'], ['late']]);
  });
});

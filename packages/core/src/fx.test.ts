import { describe, expect, it } from 'vitest';
import { convertMoney, convertParts, convertSplit } from './fx.js';
import { money, sum } from './money.js';

describe('convertMoney (T-084)', () => {
  it('$36 at the 2026-03-10 table rate (1.0928 USD per EUR) is €32.94', () => {
    // 3600 / 1.0928 = 3294.28… ⇒ 3294
    expect(convertMoney(money(3600, 'USD'), 'EUR', '1.0928')).toEqual(money(3294, 'EUR'));
  });

  it('rounds half away from zero, deterministically', () => {
    // 1 USD cent at 2 USD per EUR = 0.5 EUR cent ⇒ 1
    expect(convertMoney(money(1, 'USD'), 'EUR', '2')).toEqual(money(1, 'EUR'));
    expect(convertMoney(money(-1, 'USD'), 'EUR', '2')).toEqual(money(-1, 'EUR'));
    // 3 cents at 2 ⇒ 1.5 ⇒ 2
    expect(convertMoney(money(3, 'USD'), 'EUR', '2')).toEqual(money(2, 'EUR'));
    // just under half rounds down: 1 / 2.0001 = 0.49997…
    expect(convertMoney(money(1, 'USD'), 'EUR', '2.0001')).toEqual(money(0, 'EUR'));
    for (let i = 0; i < 3; i += 1) {
      expect(convertMoney(money(8455, 'GBP'), 'EUR', '0.8664')).toEqual(money(9759, 'EUR'));
    }
  });

  it('handles currencies with other minor units (JPY has none)', () => {
    // ¥1,000 at 161.38 JPY per EUR = €6.1965… ⇒ €6.20
    expect(convertMoney(money(1000, 'JPY'), 'EUR', '161.38')).toEqual(money(620, 'EUR'));
    // €10 at 161.38 EUR→JPY means "EUR per 1 JPY" here: 1000 / 0.0062 = ¥1,613
    expect(convertMoney(money(1000, 'EUR'), 'JPY', '0.0062')).toEqual(money(1613, 'JPY'));
  });

  it('same currency is the identity (rate must be 1)', () => {
    expect(convertMoney(money(84, 'EUR'), 'EUR', '1')).toEqual(money(84, 'EUR'));
    expect(convertMoney(money(84, 'EUR'), 'EUR', '1.000')).toEqual(money(84, 'EUR'));
    expect(() => convertMoney(money(84, 'EUR'), 'EUR', '1.1')).toThrow(/itself/);
  });

  it('rejects zero, negative and non-decimal rates', () => {
    for (const bad of ['0', '0.000', '-1.08', '1e3', '', 'abc', '1,08', '.5']) {
      expect(() => convertMoney(money(100, 'USD'), 'EUR', bad), bad).toThrow(/rate/);
    }
  });
});

describe('convertParts (T-084)', () => {
  it('carries parts over so they sum exactly to the converted total', () => {
    const parts = [money(1000, 'USD'), money(1000, 'USD'), money(1600, 'USD')];
    const total = convertMoney(money(3600, 'USD'), 'EUR', '1.0928');
    const out = convertParts(parts, total);
    expect(sum(out, 'EUR')).toEqual(total);
    expect(out.map((m) => m.amountMinor)).toEqual([915, 915, 1464]);
  });

  it('a zero part stays zero; empty in, empty out', () => {
    const out = convertParts([money(0, 'USD'), money(500, 'USD')], money(458, 'EUR'));
    expect(out).toEqual([money(0, 'EUR'), money(458, 'EUR')]);
    expect(convertParts([], money(458, 'EUR'))).toEqual([]);
  });

  it('rejects negative parts', () => {
    expect(() => convertParts([money(-1, 'USD')], money(1, 'EUR'))).toThrow(/>= 0/);
  });
});

describe('convertSplit (T-156)', () => {
  const total = money(9226, 'EUR'); // $100.01 at 1.0840

  it('exact shares carry over in proportion and sum exactly to the converted total', () => {
    const out = convertSplit(
      {
        method: 'exact',
        amounts: [
          { memberId: 'a', amount: money(3333, 'USD') },
          { memberId: 'b', amount: money(3334, 'USD') },
          { memberId: 'c', amount: money(3334, 'USD') },
        ],
      },
      total,
    );
    expect(out.method).toBe('exact');
    if (out.method !== 'exact') return;
    expect(out.amounts.map((a) => a.memberId)).toEqual(['a', 'b', 'c']);
    expect(out.amounts.every((a) => a.amount.currency === 'EUR')).toBe(true);
    expect(
      sum(
        out.amounts.map((a) => a.amount),
        'EUR',
      ),
    ).toEqual(total);
  });

  it('line items keep their labels, claimants and kinds; amounts sum exactly', () => {
    const out = convertSplit(
      {
        method: 'itemized',
        participants: ['a', 'b'],
        lineItems: [
          { lineId: 'l1', label: 'x', amount: money(1700, 'USD'), claimedBy: ['a'], kind: 'item' },
          { lineId: 'l2', label: 'tip', amount: money(3300, 'USD'), claimedBy: [], kind: 'tip' },
        ],
      },
      money(4613, 'EUR'),
    );
    expect(out.method).toBe('itemized');
    if (out.method !== 'itemized') return;
    expect(out.participants).toEqual(['a', 'b']);
    expect(out.lineItems.map((l) => [l.lineId, l.label, l.kind, l.claimedBy])).toEqual([
      ['l1', 'x', 'item', ['a']],
      ['l2', 'tip', 'tip', []],
    ]);
    expect(
      sum(
        out.lineItems.map((l) => l.amount),
        'EUR',
      ),
    ).toEqual(money(4613, 'EUR'));
  });

  describe('discount lines (T-156 r2)', () => {
    const signedTotal = (lines: readonly { amount: { amountMinor: number }; kind: string }[]) =>
      lines.reduce(
        (a, l) =>
          a + (l.kind === 'discount' ? -Math.abs(l.amount.amountMinor) : l.amount.amountMinor),
        0,
      );
    const tapas = (discountMinor: number) =>
      ({
        method: 'itemized',
        participants: ['a', 'b'],
        lineItems: [
          { lineId: 'l1', label: 'a', amount: money(3000, 'USD'), claimedBy: ['a'], kind: 'item' },
          { lineId: 'l2', label: 'b', amount: money(2500, 'USD'), claimedBy: ['b'], kind: 'item' },
          {
            lineId: 'l3',
            label: 'off',
            amount: money(discountMinor, 'USD'),
            claimedBy: [],
            kind: 'discount',
          },
        ],
      }) as const;

    for (const [label, stored] of [
      ['stored positive', 500],
      ['stored negative', -500],
    ] as const) {
      it(`$50 = $30 + $25 − $5 (${label}) carries to €46.13 with the signed total exact and signs kept`, () => {
        const out = convertSplit(tapas(stored), money(4613, 'EUR'));
        if (out.method !== 'itemized') throw new Error('method');
        expect(out.lineItems.every((l) => l.amount.currency === 'EUR')).toBe(true);
        expect(signedTotal(out.lineItems)).toBe(4613);
        expect(Math.sign(out.lineItems[2]!.amount.amountMinor)).toBe(Math.sign(stored));
        // 55 / 50 × 4613 = 5074.3 ⇒ 5074 for the items, 461 for the discount
        expect(out.lineItems.map((l) => Math.abs(l.amount.amountMinor))).toEqual([2768, 2306, 461]);
      });
    }

    it('a zero discount stays zero; lines that total nothing are rejected', () => {
      const out = convertSplit(tapas(0), money(5074, 'EUR'));
      if (out.method !== 'itemized') throw new Error('method');
      expect(out.lineItems[2]!.amount.amountMinor).toBe(0);
      expect(signedTotal(out.lineItems)).toBe(5074);
      expect(() => convertSplit(tapas(5500), money(1, 'EUR'))).toThrow(/more than zero/);
    });

    it('holds for many random receipts: signed total always equals the converted total', () => {
      let seed = 7;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed % n;
      };
      for (let k = 0; k < 300; k++) {
        const items = Array.from({ length: 1 + rnd(4) }, (_, i) => ({
          lineId: `i${String(i)}`,
          label: 'x',
          amount: money(1 + rnd(9000), 'USD'),
          claimedBy: [],
          kind: (['item', 'tax', 'tip'] as const)[rnd(3)]!,
        }));
        const pos = items.reduce((a, l) => a + l.amount.amountMinor, 0);
        const d = rnd(pos);
        const lines = [
          ...items,
          {
            lineId: 'd',
            label: 'off',
            amount: money(rnd(2) === 0 ? d : -d, 'USD'),
            claimedBy: [],
            kind: 'discount' as const,
          },
        ];
        const target = money(1 + rnd(20000), 'EUR');
        const out = convertSplit(
          { method: 'itemized', participants: [], lineItems: lines },
          target,
        );
        if (out.method !== 'itemized') throw new Error('method');
        expect(signedTotal(out.lineItems)).toBe(target.amountMinor);
        out.lineItems.forEach((l, i) => {
          if (lines[i]!.amount.amountMinor < 0) expect(l.amount.amountMinor).toBeLessThanOrEqual(0);
          else expect(l.amount.amountMinor).toBeGreaterThanOrEqual(0);
        });
      }
    });
  });

  it('equal, exclude and weighted splits carry no money and come back unchanged', () => {
    const equal = { method: 'equal', participants: ['a', 'b'] } as const;
    const exclude = { method: 'exclude', excluded: ['c'] } as const;
    const weighted = { method: 'weighted', weights: [{ memberId: 'a', weight: 2 }] } as const;
    expect(convertSplit(equal, total)).toBe(equal);
    expect(convertSplit(exclude, total)).toBe(exclude);
    expect(convertSplit(weighted, total)).toBe(weighted);
  });
});

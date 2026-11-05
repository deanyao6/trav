import { describe, expect, it } from 'vitest';
import { convertMoney, convertParts } from './fx.js';
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

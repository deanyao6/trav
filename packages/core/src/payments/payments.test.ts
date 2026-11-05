/**
 * T-166 (D-043): settle-up rails. Handles, rail choice across mismatched
 * profiles, and the locally built pay links (never fetched, no money moves).
 */
import { describe, expect, it } from 'vitest';
import { money } from '../money.js';
import { convertByRate } from '../fx.js';
import type { PaymentProfile } from '../domain/payments.js';
import { isSettlementCleared, isSettlementPending } from '../domain/expense.js';
import {
  chooseRail,
  decimalAmount,
  displayHandle,
  normalizeHandle,
  payLink,
  payNote,
  railCurrency,
  railsOf,
  railTakes,
} from './index.js';

const T0 = '2026-03-17T09:00:00+01:00';
const profile = (over: Partial<PaymentProfile> = {}): PaymentProfile => ({
  memberId: 'mem_x',
  apps: [],
  handles: {},
  updatedAt: T0,
  ...over,
});

describe('normalizeHandle', () => {
  it.each([
    ['venmo', '@chase-w', 'chase-w'],
    ['venmo', 'chase-w.', 'chase-w'],
    ['venmo', 'https://venmo.com/u/chase-w', 'chase-w'],
    ['cashapp', '$chasew', 'chasew'],
    ['cashapp', 'cash.app/$chasew', 'chasew'],
    ['paypal', 'paypal.me/chasew', 'chasew'],
    ['paypal', 'https://www.paypal.me/ChaseW', 'ChaseW'],
    ['zelle', 'Chase@Example.com', 'chase@example.com'],
    ['zelle', '(617) 555-0142', '+16175550142'],
    ['zelle', '+1 617 555 0142', '+16175550142'],
  ] as const)('%s %s → %s', (rail, raw, want) => {
    expect(normalizeHandle(rail, raw)).toBe(want);
  });

  it.each([
    ['venmo', '@x'], // too short
    ['venmo', '@chase w'],
    ['venmo', 'chase&amount=999'], // no query smuggling into the link
    ['cashapp', '$1234'], // a cashtag needs a letter
    ['paypal', 'paypal.me/chase-w'],
    ['zelle', '555-0142'],
    ['zelle', 'not an email'],
    ['zelle', ''],
  ] as const)('%s %s is not a handle', (rail, raw) => {
    expect(normalizeHandle(rail, raw)).toBeUndefined();
  });

  it('displays the way people write them', () => {
    expect(displayHandle('venmo', 'chase-w')).toBe('@chase-w');
    expect(displayHandle('cashapp', 'chasew')).toBe('$chasew');
    expect(displayHandle('paypal', 'chasew')).toBe('paypal.me/chasew');
    expect(displayHandle('zelle', '+16175550142')).toBe('(617) 555-0142');
    expect(displayHandle('zelle', 'dean@example.com')).toBe('dean@example.com');
  });
});

describe('chooseRail: the best rail both sides share (payee favourite, then payer favourite)', () => {
  const dean = profile({
    memberId: 'mem_dean',
    apps: ['venmo', 'zelle'],
    favourite: 'venmo',
    handles: { venmo: 'dean-trav', zelle: 'dean@example.com' },
  });

  it("the payee's favourite wins when both have it", () => {
    const chase = profile({ apps: ['cashapp', 'venmo'], favourite: 'cashapp' });
    expect(chooseRail(chase, dean)).toEqual({ kind: 'rail', rail: 'venmo', handle: 'dean-trav' });
  });

  it("the payer's favourite breaks the tie when the payee's isn't shared", () => {
    const payee = profile({
      apps: ['paypal', 'zelle', 'cashapp'],
      favourite: 'paypal',
      handles: { zelle: 'p@example.com', cashapp: 'payee' },
    });
    const payer = profile({ apps: ['zelle', 'cashapp'], favourite: 'cashapp' });
    expect(chooseRail(payer, payee)).toEqual({ kind: 'rail', rail: 'cashapp', handle: 'payee' });
    // No payer favourite: the payee's own order decides.
    expect(chooseRail(profile({ apps: ['cashapp', 'zelle'] }), payee)).toEqual({
      kind: 'rail',
      rail: 'zelle',
      handle: 'p@example.com',
    });
  });

  it('skips a shared rail the payee has no handle for, if another shared one works', () => {
    const payee = profile({
      apps: ['venmo', 'zelle'],
      favourite: 'venmo',
      handles: { zelle: 'z@example.com' },
    });
    const payer = profile({ apps: ['venmo', 'zelle'] });
    expect(chooseRail(payer, payee)).toEqual({
      kind: 'rail',
      rail: 'zelle',
      handle: 'z@example.com',
    });
  });

  it('missing handle: they share only a handle rail the payee never gave', () => {
    const payee = profile({ apps: ['venmo'], favourite: 'venmo' });
    expect(chooseRail(profile({ apps: ['venmo', 'paypal'] }), payee)).toEqual({
      kind: 'missing_handle',
      rail: 'venmo',
    });
  });

  it("none shared: says so and offers the payee's reachable rails with handles", () => {
    const piotr = profile({
      apps: ['paypal', 'cash'],
      favourite: 'paypal',
      handles: { paypal: 'piotrk' },
    });
    expect(chooseRail(piotr, dean)).toEqual({
      kind: 'none_shared',
      payeeOptions: [
        { rail: 'venmo', handle: 'dean-trav' },
        { rail: 'zelle', handle: 'dean@example.com' },
      ],
    });
    // A payee who listed an app without its handle: that one isn't offered.
    const half = profile({ apps: ['venmo', 'cash'], handles: {} });
    expect(chooseRail(profile({ apps: ['zelle'] }), half)).toEqual({
      kind: 'none_shared',
      payeeOptions: [{ rail: 'cash' }],
    });
  });

  it('cash and apple cash need no handle', () => {
    const payee = profile({ apps: ['apple_cash', 'cash'], favourite: 'apple_cash' });
    expect(chooseRail(profile({ apps: ['cash', 'apple_cash'] }), payee)).toEqual({
      kind: 'rail',
      rail: 'apple_cash',
    });
  });

  it("an unknown payer takes the payee's preference; an unknown payee gives nothing", () => {
    expect(chooseRail(undefined, dean)).toEqual({
      kind: 'rail',
      rail: 'venmo',
      handle: 'dean-trav',
    });
    expect(chooseRail(profile({ apps: [] }), dean).kind).toBe('rail');
    expect(chooseRail(dean, undefined)).toEqual({ kind: 'unknown' });
    expect(chooseRail(dean, profile({ askedAt: T0 }))).toEqual({ kind: 'unknown' });
  });

  it('railsOf: favourite first, then apps, then rails known only from a handle', () => {
    expect(
      railsOf(profile({ apps: ['zelle', 'venmo'], favourite: 'venmo', handles: { paypal: 'p' } })),
    ).toEqual(['venmo', 'zelle', 'paypal']);
  });
});

describe('payLink: built locally, prefilled', () => {
  it('venmo deep link carries recipient, amount and note', () => {
    expect(
      payLink({
        rail: 'venmo',
        handle: 'dean-trav',
        amount: money(2262, 'USD'),
        note: 'Barcelona spring break settle-up',
      }),
    ).toBe(
      'venmo://paycharge?txn=pay&recipients=dean-trav&amount=22.62&note=Barcelona%20spring%20break%20settle-up',
    );
  });

  it('a note can never add parameters or odd characters', () => {
    const link = payLink({
      rail: 'venmo',
      handle: 'dean-trav',
      amount: money(100, 'USD'),
      note: 'dinner&amount=9999?x=#<script>',
    })!;
    const query = new URL(link.replace('venmo://', 'https://x/')).searchParams;
    expect([...query.keys()]).toEqual(['txn', 'recipients', 'amount', 'note']);
    expect(query.get('amount')).toBe('1.00');
    expect(payNote('dinner&amount=9999?x=#<script>')).toBe('dinner&amount 9999 x script');
    expect(payNote('a'.repeat(80))).toHaveLength(60);
  });

  it('cash app and paypal.me', () => {
    expect(
      payLink({ rail: 'cashapp', handle: 'chasew', amount: money(4200, 'GBP'), note: 'x' }),
    ).toBe('https://cash.app/$chasew/42.00');
    expect(
      payLink({ rail: 'paypal', handle: 'piotrk', amount: money(2070, 'EUR'), note: 'x' }),
    ).toBe('https://paypal.me/piotrk/20.70EUR');
  });

  it('zelle has no link (copy the contact)', () => {
    expect(payLink({ rail: 'zelle', handle: 'dean@example.com', note: 'x' })).toBeUndefined();
  });

  it('an amount the rail cannot take, zero or none: payee only, amount left to type', () => {
    expect(
      payLink({ rail: 'venmo', handle: 'dean-trav', amount: money(2070, 'EUR'), note: '' }),
    ).toBe('venmo://paycharge?txn=pay&recipients=dean-trav');
    expect(payLink({ rail: 'cashapp', handle: 'chasew', amount: money(0, 'USD'), note: '' })).toBe(
      'https://cash.app/$chasew',
    );
  });

  it('rail currencies', () => {
    expect(railTakes('venmo', 'EUR')).toBe(false);
    expect(railTakes('paypal', 'EUR')).toBe(true);
    expect(railCurrency('venmo', 'EUR')).toBe('USD');
    expect(railCurrency('cashapp', 'GBP')).toBe('GBP');
    expect(railCurrency('cash', 'JPY')).toBe('JPY');
  });

  it('decimalAmount is integer math', () => {
    expect(decimalAmount(money(2262, 'USD'))).toBe('22.62');
    expect(decimalAmount(money(5, 'USD'))).toBe('0.05');
    expect(decimalAmount(money(1500, 'JPY'))).toBe('1500');
    expect(decimalAmount(money(-1001, 'EUR'))).toBe('-10.01');
  });
});

describe('convertByRate (trip money into a rail currency)', () => {
  it('converts with half-away-from-zero rounding, exactly', () => {
    expect(convertByRate(money(2070, 'EUR'), 'USD', '1.0928')).toEqual(money(2262, 'USD'));
    expect(convertByRate(money(1, 'EUR'), 'USD', '1.5')).toEqual(money(2, 'USD'));
    expect(convertByRate(money(-1, 'EUR'), 'USD', '1.5')).toEqual(money(-2, 'USD'));
    expect(convertByRate(money(100, 'USD'), 'JPY', '150.25')).toEqual(money(150, 'JPY'));
  });

  it('same currency needs rate 1', () => {
    expect(convertByRate(money(500, 'USD'), 'USD', '1')).toEqual(money(500, 'USD'));
    expect(() => convertByRate(money(500, 'USD'), 'USD', '1.1')).toThrow(/must be 1/);
  });
});

describe('settlement status (D-043): only the payee clears', () => {
  it.each([
    ['sent', false, true],
    ['marked_paid', false, true],
    ['received', true, false],
    ['undone', false, false],
  ] as const)('%s → cleared %s, pending %s', (status, cleared, pending) => {
    expect(isSettlementCleared({ status })).toBe(cleared);
    expect(isSettlementPending({ status })).toBe(pending);
  });
});

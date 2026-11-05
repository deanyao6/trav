import type { Money, SimulatedClock } from '@trav/core';
import { createSimulatedClock, money } from '@trav/core';
import { describe, expect, it } from 'vitest';
import type { Result } from '../../interfaces/common.js';
import type { CreatePaymentRequestInput, PaymentRequest } from '../../interfaces/payments.js';
import type { MockSettleUp } from './index.js';
import { buildPaymentLinks, createMockSettleUp, decimalAmount, handleProblem } from './index.js';

/** Sunday morning in Barcelona: the daily settle-up. */
const MORNING = '2026-03-15T10:00:00+01:00';
const eur = (amountMinor: number): Money => money(amountMinor, 'EUR');

function setup(): { clock: SimulatedClock; settle: MockSettleUp } {
  const clock = createSimulatedClock(MORNING);
  return { clock, settle: createMockSettleUp({ clock }) };
}

function input(overrides: Partial<CreatePaymentRequestInput> = {}): CreatePaymentRequestInput {
  return {
    groupId: 'grp_barcelona',
    tripId: 'trip_barcelona',
    fromMemberId: 'mem_henry',
    toMemberId: 'mem_dean',
    amount: eur(8417),
    note: 'Barcelona: dinner + Razzmatazz',
    idempotencyKey: 'settle_henry_dean_1',
    ...overrides,
  };
}

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function errorCode<T>(r: Result<T>): string {
  if (r.ok) throw new Error('expected an error');
  return r.error.code;
}

async function pending(settle: MockSettleUp, o: Partial<CreatePaymentRequestInput> = {}) {
  return value(await settle.createRequest(input(o)));
}

describe('mock settle-up: payout handles and links', () => {
  it('stores handles per member and method; replacing keeps order', async () => {
    const { settle } = setup();
    expect(settle.info).toEqual({ provider: 'mock-settleup', mode: 'mock' });
    value(
      await settle.setPayoutHandle({ memberId: 'mem_dean', method: 'venmo', handle: '@dean-y' }),
    );
    value(
      await settle.setPayoutHandle({ memberId: 'mem_dean', method: 'revolut', handle: 'deany' }),
    );
    value(
      await settle.setPayoutHandle({ memberId: 'mem_dean', method: 'venmo', handle: ' @dean-2 ' }),
    );
    expect(value(await settle.getPayoutHandles('mem_dean'))).toEqual([
      { memberId: 'mem_dean', method: 'venmo', handle: '@dean-2' },
      { memberId: 'mem_dean', method: 'revolut', handle: 'deany' },
    ]);
    expect(value(await settle.getPayoutHandles('mem_chase'))).toEqual([]);
  });

  it('refuses account numbers, IBANs, phone numbers, unknown methods', async () => {
    const { settle } = setup();
    for (const handle of [
      'ES91 2100 0418 4502 0005 1332',
      'ES9121000418450200051332',
      '4111-1111-1111-1111',
      '+34612345678',
      '',
      'a'.repeat(65),
      'two words',
    ]) {
      const r = await settle.setPayoutHandle({
        memberId: 'mem_dean',
        method: 'bank_transfer',
        handle,
      });
      expect([handle, errorCode(r)]).toEqual([handle, 'invalid_request']);
    }
    const bad = await settle.setPayoutHandle({
      memberId: 'mem_dean',
      method: 'zelle' as never,
      handle: '@dean',
    });
    expect(errorCode(bad)).toBe('invalid_request');
    expect(handleProblem('@henry-b')).toBeUndefined();
    expect(handleProblem('dean.y2026')).toBeUndefined();
    expect(value(await settle.getPayoutHandles('mem_dean'))).toEqual([]);
  });

  it('builds mock deep links on the reserved .test domain, prefilled with the exact amount', async () => {
    const { settle } = setup();
    value(
      await settle.setPayoutHandle({ memberId: 'mem_dean', method: 'venmo', handle: '@dean-y' }),
    );
    value(await settle.setPayoutHandle({ memberId: 'mem_dean', method: 'bizum', handle: 'deany' }));
    value(
      await settle.setPayoutHandle({
        memberId: 'mem_dean',
        method: 'bank_transfer',
        handle: 'dean-y',
      }),
    );
    const req = await pending(settle);
    expect(req.links.map((l) => [l.method, l.label])).toEqual([
      ['venmo', 'Venmo @dean-y'],
      ['bizum', 'Bizum deany'],
      ['bank_transfer', 'Bank transfer dean-y'],
      ['cash', 'Cash'],
    ]);
    const venmo = new URL(req.links[0]?.url ?? '');
    expect(venmo.origin).toBe('https://pay.example.test');
    expect(venmo.pathname).toBe('/venmo/%40dean-y');
    expect(venmo.searchParams.get('amount')).toBe('84.17');
    expect(venmo.searchParams.get('currency')).toBe('EUR');
    expect(venmo.searchParams.get('note')).toBe('Barcelona: dinner + Razzmatazz');
    expect(req.links[2]?.url).toBeUndefined();
    expect(req.links[3]?.url).toBeUndefined();
    for (const l of req.links) {
      if (l.url) expect(new URL(l.url).hostname.endsWith('.test')).toBe(true);
    }
  });

  it('a payee with no handles still gets a cash option; links are frozen at creation', async () => {
    const { settle } = setup();
    const req = await pending(settle);
    expect(req.links).toEqual([{ method: 'cash', label: 'Cash' }]);
    value(
      await settle.setPayoutHandle({ memberId: 'mem_dean', method: 'paypal', handle: 'deany' }),
    );
    expect(value(await settle.markPaid(req.requestId, 'mem_henry')).links).toEqual(req.links);
  });

  it('formats amounts with integer math per currency exponent', () => {
    expect(decimalAmount(eur(8417))).toBe('84.17');
    expect(decimalAmount(eur(5))).toBe('0.05');
    expect(decimalAmount(eur(100))).toBe('1.00');
    expect(decimalAmount(money(1500, 'JPY'))).toBe('1500');
    expect(decimalAmount(money(1234, 'KWD'))).toBe('1.234');
    const [link] = buildPaymentLinks(
      [{ memberId: 'mem_x', method: 'revolut', handle: 'x' }],
      money(1, 'USD'),
      'a&b=c',
    );
    expect(new URL(link?.url ?? '').searchParams.get('note')).toBe('a&b=c');
    expect(new URL(link?.url ?? '').searchParams.get('amount')).toBe('0.01');
  });
});

describe('mock settle-up: createRequest', () => {
  it('creates a pending request and is idempotent per key', async () => {
    const { clock, settle } = setup();
    const req = await pending(settle);
    expect(req).toMatchObject({
      requestId: 'pr_mock_000001',
      status: 'pending',
      fromMemberId: 'mem_henry',
      toMemberId: 'mem_dean',
      amount: eur(8417),
      createdAt: MORNING,
      updatedAt: MORNING,
    });
    clock.advanceMs(5000);
    expect(value(await settle.createRequest(input()))).toEqual(req);
    expect(settle.requestCount()).toBe(1);
    expect(errorCode(await settle.createRequest(input({ amount: eur(8418) })))).toBe('duplicate');
    expect(errorCode(await settle.createRequest(input({ note: 'other' })))).toBe('duplicate');
    expect(settle.requestCount()).toBe(1);
    // A replay after state changes returns the current request, not a fresh one.
    value(await settle.markPaid(req.requestId, 'mem_henry'));
    expect(value(await settle.createRequest(input())).status).toBe('marked_paid');
    expect(settle.requestCount()).toBe(1);
  });

  it('rejects bad input without creating anything', async () => {
    const { settle } = setup();
    const cases: Partial<CreatePaymentRequestInput>[] = [
      { idempotencyKey: '' },
      { groupId: '' },
      { tripId: ' ' },
      { fromMemberId: '' },
      { toMemberId: 'mem_henry' },
      { amount: eur(0) },
      { amount: eur(-500) },
      { amount: { amountMinor: 84.17, currency: 'EUR' } },
      { amount: { amountMinor: 100, currency: 'eur' } },
      { note: 'x'.repeat(141) },
      { note: undefined as unknown as string },
    ];
    for (const [i, c] of cases.entries()) {
      const r = await settle.createRequest(input({ idempotencyKey: `k${i}`, ...c }));
      expect([i, errorCode(r)]).toEqual([i, 'invalid_request']);
    }
    expect(settle.requestCount()).toBe(0);
    // Exactly at the note cap is fine.
    value(await settle.createRequest(input({ note: 'x'.repeat(140), idempotencyKey: 'cap' })));
  });

  it('lists requests per trip in creation order', async () => {
    const { settle } = setup();
    const a = await pending(settle);
    const b = await pending(settle, { fromMemberId: 'mem_chase', idempotencyKey: 'k2' });
    await pending(settle, { tripId: 'trip_lisbon', idempotencyKey: 'k3' });
    const listed = value(await settle.listForTrip('trip_barcelona'));
    expect(listed.map((r) => r.requestId)).toEqual([a.requestId, b.requestId]);
    expect(value(await settle.listForTrip('trip_none'))).toEqual([]);
    expect(errorCode(await settle.listForTrip(''))).toBe('invalid_request');
  });
});

describe('mock settle-up: state machine', () => {
  it('pending → marked_paid → confirmed, with timestamps and history from the Clock', async () => {
    const { clock, settle } = setup();
    const req = await pending(settle);
    clock.advanceHours(1);
    const paid = value(await settle.markPaid(req.requestId, 'mem_henry'));
    expect(paid.status).toBe('marked_paid');
    expect(paid.updatedAt).toBe(clock.now());
    expect(paid.createdAt).toBe(MORNING);
    clock.advanceHours(1);
    const confirmed = value(await settle.confirmReceived(req.requestId, 'mem_dean'));
    expect(confirmed.status).toBe('confirmed');
    expect(value(await settle.listForTrip('trip_barcelona'))[0]).toEqual(confirmed);
    expect(
      settle.history(req.requestId).map((e) => [e.action, e.from, e.to, e.byMemberId]),
    ).toEqual([
      ['created', null, 'pending', undefined],
      ['mark_paid', 'pending', 'marked_paid', 'mem_henry'],
      ['confirm_received', 'marked_paid', 'confirmed', 'mem_dean'],
    ]);
  });

  it('only the payer marks paid and only the payee confirms', async () => {
    const { settle } = setup();
    const req = await pending(settle);
    expect(errorCode(await settle.markPaid(req.requestId, 'mem_dean'))).toBe('invalid_request');
    expect(errorCode(await settle.markPaid(req.requestId, 'mem_chase'))).toBe('invalid_request');
    expect(errorCode(await settle.confirmReceived(req.requestId, 'mem_henry'))).toBe(
      'invalid_request',
    );
    expect(errorCode(await settle.dispute(req.requestId, 'mem_chase', 'not mine'))).toBe(
      'invalid_request',
    );
    expect(value(await settle.listForTrip('trip_barcelona'))[0]?.status).toBe('pending');
    expect(settle.history(req.requestId)).toHaveLength(1);
  });

  it('repeating the same step is a no-op (double tap)', async () => {
    const { clock, settle } = setup();
    const req = await pending(settle);
    const paid = value(await settle.markPaid(req.requestId, 'mem_henry'));
    clock.advanceMs(1000);
    expect(value(await settle.markPaid(req.requestId, 'mem_henry'))).toEqual(paid);
    const confirmed = value(await settle.confirmReceived(req.requestId, 'mem_dean'));
    clock.advanceMs(1000);
    expect(value(await settle.confirmReceived(req.requestId, 'mem_dean'))).toEqual(confirmed);
    expect(settle.history(req.requestId)).toHaveLength(3);
  });

  it('the payee can confirm straight from pending (cash in hand)', async () => {
    const { settle } = setup();
    const req = await pending(settle);
    expect(value(await settle.confirmReceived(req.requestId, 'mem_dean')).status).toBe('confirmed');
  });

  it('dispute: "it never arrived" after marked_paid, then resent and confirmed', async () => {
    const { settle } = setup();
    const req = await pending(settle);
    value(await settle.markPaid(req.requestId, 'mem_henry'));
    const disputed = value(await settle.dispute(req.requestId, 'mem_dean', 'never arrived'));
    expect(disputed.status).toBe('disputed');
    expect(settle.disputeReason(req.requestId)).toBe('never arrived');
    expect(value(await settle.dispute(req.requestId, 'mem_henry', 'it did'))).toEqual(disputed);
    expect(settle.disputeReason(req.requestId)).toBe('never arrived');
    expect(value(await settle.markPaid(req.requestId, 'mem_henry')).status).toBe('marked_paid');
    expect(value(await settle.confirmReceived(req.requestId, 'mem_dean')).status).toBe('confirmed');
    expect(settle.history(req.requestId).map((e) => e.to)).toEqual([
      'pending',
      'marked_paid',
      'disputed',
      'marked_paid',
      'confirmed',
    ]);
    expect(settle.history(req.requestId)[2]?.reason).toBe('never arrived');
  });

  it('dispute: the payer flags a wrong amount while pending, then it is cancelled', async () => {
    const { settle } = setup();
    const req = await pending(settle);
    expect(errorCode(await settle.dispute(req.requestId, 'mem_henry', ''))).toBe('invalid_request');
    expect(errorCode(await settle.dispute(req.requestId, 'mem_henry', 'x'.repeat(281)))).toBe(
      'invalid_request',
    );
    value(await settle.dispute(req.requestId, 'mem_henry', 'I skipped Razzmatazz, I was sick'));
    expect(value(await settle.cancel(req.requestId)).status).toBe('cancelled');
  });

  it('cancel: pending → cancelled is terminal; repeat cancel is a no-op', async () => {
    const { settle } = setup();
    const req = await pending(settle);
    const cancelled = value(await settle.cancel(req.requestId));
    expect(cancelled.status).toBe('cancelled');
    expect(value(await settle.cancel(req.requestId))).toEqual(cancelled);
    expect(errorCode(await settle.markPaid(req.requestId, 'mem_henry'))).toBe('invalid_request');
    expect(errorCode(await settle.confirmReceived(req.requestId, 'mem_dean'))).toBe(
      'invalid_request',
    );
    expect(errorCode(await settle.dispute(req.requestId, 'mem_dean', 'hm'))).toBe(
      'invalid_request',
    );
    expect(settle.history(req.requestId).map((e) => e.action)).toEqual(['created', 'cancel']);
  });

  it('cancel is refused once the payer says they paid, and after confirmation', async () => {
    const { settle } = setup();
    const req = await pending(settle);
    value(await settle.markPaid(req.requestId, 'mem_henry'));
    expect(errorCode(await settle.cancel(req.requestId))).toBe('invalid_request');
    value(await settle.confirmReceived(req.requestId, 'mem_dean'));
    expect(errorCode(await settle.cancel(req.requestId))).toBe('invalid_request');
    expect(errorCode(await settle.dispute(req.requestId, 'mem_henry', 'oops'))).toBe(
      'invalid_request',
    );
    expect(errorCode(await settle.markPaid(req.requestId, 'mem_henry'))).toBe('invalid_request');
    const final = value(await settle.listForTrip('trip_barcelona'))[0] as PaymentRequest;
    expect(final.status).toBe('confirmed');
  });

  it('unknown request ids are not_found everywhere', async () => {
    const { settle } = setup();
    expect(errorCode(await settle.markPaid('pr_nope', 'mem_henry'))).toBe('not_found');
    expect(errorCode(await settle.confirmReceived('pr_nope', 'mem_dean'))).toBe('not_found');
    expect(errorCode(await settle.dispute('pr_nope', 'mem_dean', 'x'))).toBe('not_found');
    expect(errorCode(await settle.cancel('pr_nope'))).toBe('not_found');
    expect(settle.history('pr_nope')).toEqual([]);
  });
});

describe('mock settle-up: review fixes', () => {
  it('markPaid → payer dispute → cancel is refused until the payee answers', async () => {
    const { settle } = setup();
    const req = await pending(settle);
    value(await settle.markPaid(req.requestId, 'mem_henry'));
    value(await settle.dispute(req.requestId, 'mem_henry', 'actually I sent the wrong amount'));
    expect(errorCode(await settle.cancel(req.requestId))).toBe('invalid_request');
    expect(value(await settle.listForTrip('trip_barcelona'))[0]?.status).toBe('disputed');

    // The payee answers ("never arrived"): now it may be cancelled and recomputed.
    const answered = value(await settle.dispute(req.requestId, 'mem_dean', 'never arrived'));
    expect(answered.status).toBe('disputed');
    expect(settle.disputeReason(req.requestId)).toBe('never arrived');
    expect(value(await settle.cancel(req.requestId)).status).toBe('cancelled');
    expect(settle.history(req.requestId).map((e) => [e.action, e.byMemberId])).toEqual([
      ['created', undefined],
      ['mark_paid', 'mem_henry'],
      ['dispute', 'mem_henry'],
      ['dispute', 'mem_dean'],
      ['cancel', undefined],
    ]);
  });

  it('a payee dispute lifts the block; marking paid again restores it', async () => {
    const { settle } = setup();
    const req = await pending(settle);
    value(await settle.markPaid(req.requestId, 'mem_henry'));
    value(await settle.dispute(req.requestId, 'mem_dean', 'never arrived'));
    value(await settle.markPaid(req.requestId, 'mem_henry'));
    expect(errorCode(await settle.cancel(req.requestId))).toBe('invalid_request');
    value(await settle.dispute(req.requestId, 'mem_henry', 'resent it twice?'));
    expect(errorCode(await settle.cancel(req.requestId))).toBe('invalid_request');
    expect(value(await settle.confirmReceived(req.requestId, 'mem_dean')).status).toBe('confirmed');
  });

  it('a payer dispute before ever marking paid can still be cancelled', async () => {
    const { settle } = setup();
    const req = await pending(settle);
    value(await settle.dispute(req.requestId, 'mem_henry', 'wrong amount'));
    expect(value(await settle.cancel(req.requestId)).status).toBe('cancelled');
  });

  it('rejects card-like handles whatever the separators (10+ digits)', () => {
    for (const handle of [
      '4111_1111_1111_1111',
      '4111x1111y1111z1111',
      '4111/1111/1111/1111',
      'acct_12_34_56_78_90',
      '612_345_678_9',
    ]) {
      expect([handle, handleProblem(handle)]).toEqual([handle, expect.stringMatching(/number/)]);
    }
    for (const handle of ['@henry-b', 'dean.y2026', 'chase_99', 'crowley-123-456']) {
      expect([handle, handleProblem(handle)]).toEqual([handle, undefined]);
    }
  });
});

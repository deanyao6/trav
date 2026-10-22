import { describe, expect, it } from 'vitest';
import { createSimulatedClock, money } from '@trav/core';
import type { ApprovalProof } from '../../interfaces/common.js';
import type { ChargeRequest } from '../../interfaces/payments.js';
import { createMockBookingPayments } from './index.js';
import { checkApprovalProof } from './proof.js';

const NOW = '2026-03-14T21:41:00+01:00';
const eur = (n: number) => money(n, 'EUR');

function proof(overrides: Partial<ApprovalProof> = {}): ApprovalProof {
  return {
    approvalId: 'grant_t000001',
    proposalId: 'prop_t000001',
    groupId: 'grp_barcelona',
    approvedBy: ['mem_dean'],
    approvedAt: '2026-03-14T21:40:30+01:00',
    expiresAt: '2026-03-14T22:10:00+01:00',
    maxAmount: eur(9000),
    auditEventId: 'aud_t000001',
    ...overrides,
  };
}

function charge(overrides: Partial<ChargeRequest> = {}): ChargeRequest {
  return {
    payerMemberId: 'mem_dean',
    amount: eur(9000),
    reference: 'booking:RZ-48213',
    idempotencyKey: 'idem_rzm_5',
    approval: proof(),
    ...overrides,
  };
}

function setup(members?: readonly string[]) {
  const clock = createSimulatedClock(NOW);
  const payments = createMockBookingPayments(
    members === undefined ? { clock } : { clock, membersWithPaymentMethod: members },
  );
  return { clock, payments };
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? undefined : r.error?.code);

describe('mock booking payments: charge', () => {
  it('records a charge (and nothing else) with audit-ready fields', async () => {
    const { payments } = setup();
    expect(payments.info).toEqual({ provider: 'mock-payments', mode: 'mock' });
    const intent = unwrap(await payments.charge(charge()));
    expect(intent).toEqual({
      intentId: 'pi_mock_000001',
      payerMemberId: 'mem_dean',
      amount: eur(9000),
      status: 'succeeded',
      reference: 'booking:RZ-48213',
      createdAt: NOW,
      approvalId: 'grant_t000001',
    });
    expect(payments.chargeCount()).toBe(1);
    expect(payments.listCharges()).toEqual([intent]);
    expect(unwrap(await payments.getCharge(intent.intentId))).toEqual(intent);
  });

  it('same idempotency key never charges twice (retries + concurrent)', async () => {
    const { payments, clock } = setup();
    const first = unwrap(await payments.charge(charge()));
    const again = await Promise.all([payments.charge(charge()), payments.charge(charge())]);
    for (const r of again) expect(unwrap(r)).toEqual(first);
    clock.advanceHours(3); // replay after the proof lapsed still returns the original
    expect(unwrap(await payments.charge(charge()))).toEqual(first);
    expect(payments.chargeCount()).toBe(1);
  });

  it('same key with different parameters is duplicate', async () => {
    const { payments } = setup();
    unwrap(await payments.charge(charge()));
    expect(code(await payments.charge(charge({ amount: eur(8000) })))).toBe('duplicate');
    expect(code(await payments.charge(charge({ reference: 'booking:other' })))).toBe('duplicate');
    expect(
      code(await payments.charge(charge({ approval: proof({ approvalId: 'grant_x' }) }))),
    ).toBe('duplicate');
    expect(
      code(await payments.charge(charge({ approval: undefined as unknown as ApprovalProof }))),
    ).toBe('approval_invalid');
    expect(payments.chargeCount()).toBe(1);
  });

  const rejections: [string, Partial<ChargeRequest>, string][] = [
    ['missing proof', { approval: undefined as unknown as ApprovalProof }, 'approval_invalid'],
    [
      'expired proof',
      { approval: proof({ expiresAt: '2026-03-14T21:41:00+01:00' }) },
      'approval_invalid',
    ],
    [
      'approved in the future',
      { approval: proof({ approvedAt: '2026-03-14T21:42:00+01:00' }) },
      'approval_invalid',
    ],
    ['one cent over', { amount: eur(9001) }, 'approval_exceeded'],
    ['currency mismatch', { amount: money(9000, 'USD') }, 'approval_invalid'],
    ['payer did not approve', { payerMemberId: 'mem_maya' }, 'approval_invalid'],
    ['zero amount', { amount: eur(0) }, 'invalid_request'],
    ['fractional amount', { amount: { amountMinor: 89.99, currency: 'EUR' } }, 'invalid_request'],
    ['missing reference', { reference: '' }, 'invalid_request'],
    ['missing key', { idempotencyKey: '' }, 'invalid_request'],
  ];

  it.each(rejections)('rejects %s without charging', async (_l, overrides, expected) => {
    const { payments } = setup();
    expect(code(await payments.charge(charge(overrides)))).toBe(expected);
    expect(payments.chargeCount()).toBe(0);
    expect(payments.listCharges()).toEqual([]);
  });

  it('allows exactly the approved amount', async () => {
    const { payments } = setup();
    unwrap(
      await payments.charge(
        charge({ amount: eur(9000), approval: proof({ maxAmount: eur(9000) }) }),
      ),
    );
  });

  it('one approval funds one charge', async () => {
    const { payments } = setup();
    unwrap(await payments.charge(charge()));
    const r = await payments.charge(charge({ idempotencyKey: 'other', reference: 'booking:2' }));
    expect(code(r)).toBe('approval_invalid');
    expect(payments.chargeCount()).toBe(1);
  });

  it('requires a saved payment method', async () => {
    const { payments } = setup(['mem_maya']);
    expect(unwrap(await payments.hasPaymentMethod('mem_dean'))).toBe(false);
    expect(unwrap(await payments.hasPaymentMethod('mem_maya'))).toBe(true);
    expect(code(await payments.hasPaymentMethod(''))).toBe('invalid_request');
    expect(code(await payments.charge(charge()))).toBe('not_configured');
    expect(payments.chargeCount()).toBe(0);
    const everyone = setup();
    expect(unwrap(await everyone.payments.hasPaymentMethod('mem_dean'))).toBe(true);
  });
});

describe('mock booking payments: refund', () => {
  it('partial then full, idempotent per key, never over the charge', async () => {
    const { payments } = setup();
    const intent = unwrap(await payments.charge(charge()));
    const part = unwrap(await payments.refund(intent.intentId, 'r1', eur(1800)));
    expect(part.status).toBe('partially_refunded');
    expect(part.refundedAmount).toEqual(eur(1800));
    expect(unwrap(await payments.refund(intent.intentId, 'r1', eur(1800)))).toEqual(part);
    expect(code(await payments.refund(intent.intentId, 'r1', eur(100)))).toBe('duplicate');
    expect(payments.refundCount()).toBe(1);
    expect(code(await payments.refund(intent.intentId, 'r2', eur(7201)))).toBe('invalid_request');
    expect(code(await payments.refund(intent.intentId, 'r2', money(100, 'USD')))).toBe(
      'invalid_request',
    );
    const rest = unwrap(await payments.refund(intent.intentId, 'r3'));
    expect(rest.status).toBe('refunded');
    expect(rest.refundedAmount).toEqual(eur(9000));
    expect(code(await payments.refund(intent.intentId, 'r4'))).toBe('invalid_request');
    expect(payments.refundCount()).toBe(2);
    expect(payments.chargeCount()).toBe(1);
    expect(unwrap(await payments.getCharge(intent.intentId)).status).toBe('refunded');
  });

  it('unknown charge is not_found', async () => {
    const { payments } = setup();
    expect(code(await payments.refund('pi_nope', 'r'))).toBe('not_found');
    expect(code(await payments.getCharge('pi_nope'))).toBe('not_found');
  });
});

describe('checkApprovalProof', () => {
  const nowMs = Date.parse(NOW);
  it('passes a valid proof and pins the boundaries', () => {
    expect(checkApprovalProof(proof(), eur(9000), nowMs)).toBeUndefined();
    expect(checkApprovalProof(proof(), eur(9001), nowMs)?.code).toBe('approval_exceeded');
    expect(checkApprovalProof(proof(), eur(1), Date.parse('2026-03-14T22:10:00+01:00'))?.code).toBe(
      'approval_invalid',
    );
    expect(
      checkApprovalProof(proof(), eur(1), Date.parse('2026-03-14T22:09:59.999+01:00')),
    ).toBeUndefined();
    expect(
      checkApprovalProof(
        proof({ approvedAt: '2026-03-14T22:00:00+01:00', expiresAt: '2026-03-14T21:59:00+01:00' }),
        eur(1),
        Date.parse('2026-03-14T22:05:00+01:00'),
      )?.code,
    ).toBe('approval_invalid');
    expect(checkApprovalProof('grant_t000001', eur(1), nowMs)?.code).toBe('approval_invalid');
    expect(checkApprovalProof(proof({ approvedBy: [''] }), eur(1), nowMs)?.code).toBe(
      'approval_invalid',
    );
    expect(checkApprovalProof(proof({ maxAmount: eur(-1) }), eur(1), nowMs)?.code).toBe(
      'approval_invalid',
    );
  });
});

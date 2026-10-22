import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { TravError } from '../errors.js';
import { deriveIdempotencyKey, type IdempotencyInput } from './idempotency.js';

const base: IdempotencyInput = {
  groupId: 'grp_barcelona',
  tripId: 'trip_barcelona',
  kind: 'ticket',
  provider: 'mock-tickets',
  itemRef: 'evt_razzmatazz_0314',
  eventDate: '2026-03-14',
  payerIds: ['mem_dean', 'mem_sam', 'mem_ava', 'mem_maya', 'mem_leo'],
  totalMinor: 9000,
  currency: 'EUR',
};

describe('deriveIdempotencyKey', () => {
  it('is the documented sha256 over the pipe-joined fields with sorted payers', () => {
    const expected = createHash('sha256')
      .update(
        [
          'grp_barcelona',
          'trip_barcelona',
          'ticket',
          'mock-tickets',
          'evt_razzmatazz_0314',
          '2026-03-14',
          'mem_ava,mem_dean,mem_leo,mem_maya,mem_sam',
          '9000',
          'EUR',
        ].join('|'),
      )
      .digest('hex');
    expect(deriveIdempotencyKey(base)).toBe(expected);
    expect(deriveIdempotencyKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of payer order and of who/when asked (A6)', () => {
    const reordered = { ...base, payerIds: [...base.payerIds].reverse() };
    expect(deriveIdempotencyKey(reordered)).toBe(deriveIdempotencyKey(base));
    // requestedAt / sourceMessageId / requestedBy are not inputs at all.
    const keys = Object.keys(base).sort();
    expect(keys).not.toContain('requestedAt');
    expect(keys).not.toContain('sourceMessageId');
    expect(keys).not.toContain('requestedBy');
  });

  it('differs for a different payer set, amount, date, item, kind, provider, currency, trip or group', () => {
    const k = deriveIdempotencyKey(base);
    const variants: Partial<IdempotencyInput>[] = [
      { payerIds: [...base.payerIds, 'mem_henry'] },
      { payerIds: base.payerIds.slice(0, 4) },
      { totalMinor: 9001 },
      { eventDate: '2026-03-15' },
      { eventDate: '' },
      { itemRef: 'evt_other' },
      { kind: 'other' },
      { provider: 'mock-tickets-2' },
      { currency: 'USD' },
      { tripId: 'trip_lisbon' },
      { groupId: 'grp_other' },
    ];
    const all = new Set(variants.map((v) => deriveIdempotencyKey({ ...base, ...v })));
    expect(all.size).toBe(variants.length);
    expect(all.has(k)).toBe(false);
  });

  it('a nonce ("buy it again") changes the key; an empty nonce does not', () => {
    expect(deriveIdempotencyKey({ ...base, nonce: 'again-1' })).not.toBe(
      deriveIdempotencyKey(base),
    );
    expect(deriveIdempotencyKey({ ...base, nonce: '' })).toBe(deriveIdempotencyKey(base));
    expect(deriveIdempotencyKey({ ...base, nonce: 'a' })).not.toBe(
      deriveIdempotencyKey({ ...base, nonce: 'b' }),
    );
  });

  it('duplicate payer ids collapse (the same purchase for the same people)', () => {
    expect(deriveIdempotencyKey({ ...base, payerIds: [...base.payerIds, 'mem_dean'] })).toBe(
      deriveIdempotencyKey(base),
    );
  });

  it('rejects non-integer amounts and fields containing the separator', () => {
    expect(() => deriveIdempotencyKey({ ...base, totalMinor: 90.5 })).toThrow(TravError);
    expect(() => deriveIdempotencyKey({ ...base, itemRef: 'a|b' })).toThrow(TravError);
  });
});

import { describe, expect, it } from 'vitest';
import { createDeterministicIdGenerator, createSimulatedClock } from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import { loadGroupFixture, prefsToldAt, seedGroup } from './seed.js';

function stores(at: string) {
  const clock = createSimulatedClock(at);
  return createMemoryStores({ clock, ids: createDeterministicIdGenerator('s') });
}

describe('seedGroup: spending prefs exist from when they were told (T-132)', () => {
  const told = prefsToldAt(loadGroupFixture('barcelona'), 'mem_henry');

  it("Henry's cap comes from his budget DM (mar 11), the generator's prefsFrom", () => {
    expect(told).toBe('2026-03-11T10:00:00-05:00');
  });

  it('an episode starting before then holds the prefs back; one starting after has them', () => {
    const early = stores('2026-02-03T20:00:00-05:00');
    const a = seedGroup(early, 'barcelona', { extras: true, now: '2026-02-03T20:00:00-05:00' });
    expect(early.private.getPrefs('mem_henry')).toBeUndefined();
    expect(a.deferredPrefs).toEqual([
      { at: told, prefs: expect.objectContaining({ memberId: 'mem_henry' }) },
    ]);

    const late = stores('2026-03-14T12:00:00+01:00');
    const b = seedGroup(late, 'barcelona', { extras: true, now: '2026-03-14T12:00:00+01:00' });
    expect(late.private.getPrefs('mem_henry')?.perBookingShareCapMinor).toBe(8000);
    expect(b.deferredPrefs).toEqual([]);
  });

  it('without a start time (probes) everything is seeded as before', () => {
    const s = stores('2026-02-03T20:00:00-05:00');
    seedGroup(s, 'barcelona', { extras: true });
    expect(s.private.getPrefs('mem_henry')?.perBookingShareCapMinor).toBe(8000);
  });
});

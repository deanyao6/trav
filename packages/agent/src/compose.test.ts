/** The runtime's default ticket provider covers every bundled trip (T-093). */
import { describe, expect, it } from 'vitest';
import { RAZZMATAZZ_ASK, harness } from './runtime.testkit.js';

describe('createTravRuntime default ticket provider', () => {
  // `providers: {}` drops the harness's Barcelona-only mock, so compose's default is used.
  const h = () => harness({ runtime: { providers: {} } });

  it("each trip city finds its own trip's events", async () => {
    const { tickets } = h().runtime.providers;
    const search = async (city: string, dateFrom: string, dateTo: string, query: string) => {
      const r = await tickets.searchEvents({ city, dateFrom, dateTo, query });
      if (!r.ok) throw new Error(r.error.code);
      return r.value.map((e) => e.eventId);
    };
    expect(await search('Lisbon', '2026-04-15', '2026-04-20', 'benfica vs porto')).toContain(
      'evt_lis_benfica_porto',
    );
    expect(await search('Lisbon', '2026-04-15', '2026-04-20', 'fado')).toEqual([
      'evt_lis_fado_0416',
    ]);
    expect(await search('Providenciales', '2026-06-20', '2026-06-27', 'snorkel')).toEqual([
      'evt_tci_snorkel_0622',
    ]);
    const bcn = await search('Barcelona', '2026-03-14', '2026-03-14', 'razzmatazz');
    expect(bcn).toEqual(['evt_rzm_20260314']);
    // No cross-trip leakage.
    expect(await search('Barcelona', '2026-04-15', '2026-06-27', 'snorkel benfica fado')).toEqual(
      [],
    );
  });

  it('the Razzmatazz ask is unchanged on the default provider', async () => {
    const t = h();
    await t.say('h_dean', RAZZMATAZZ_ASK);
    const [proposal] = t.pending();
    expect(proposal).toMatchObject({
      itemRef: expect.stringContaining('rzm_20260314'),
      totalMinor: 9000,
      currency: 'EUR',
    });
    expect(proposal?.attendees).toHaveLength(5);
  });
});

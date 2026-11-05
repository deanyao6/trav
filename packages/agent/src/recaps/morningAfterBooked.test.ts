/**
 * T-196 (QA-01): a booked late-night group event is a night-out signal on its
 * own, so the Morning After posts after "dinner → Razzmatazz ask → next
 * morning" even when nobody chats after midnight.
 */
import { describe, expect, it } from 'vitest';
import type { Booking, IsoDateTime, OutboundMessage, RecapCard } from '@trav/core';
import { DEFAULT_AUTO_BUY_CAP_MINOR } from '@trav/core';
import { BARCELONA } from '../compose.js';
import { RAZZMATAZZ_ASK, harness, type Harness } from '../runtime.testkit.js';
import { bookedGroupNightTimes, composeMorningAfter } from './morningAfter.js';

const DINNER = '@trav i paid €84 for dinner, split with everyone but Henry';
const MORNING: IsoDateTime = '2026-03-15T10:00:00+01:00';

type B = Pick<Booking, 'kind' | 'status' | 'activityId' | 'attendees' | 'expenseId'>;
const booking = (over: Partial<B> = {}): B => ({
  kind: 'ticket',
  status: 'confirmed',
  activityId: 'act_club',
  attendees: ['mem_a', 'mem_b'],
  expenseId: 'exp_club',
  ...over,
});
const CLUB = { activityId: 'act_club', startsAt: '2026-03-15T00:00:00+01:00' };
const times = (bs: readonly B[], acts: readonly { activityId: string; startsAt?: string }[]) => [
  ...bookedGroupNightTimes(bs, acts).entries(),
];

describe('bookedGroupNightTimes', () => {
  it("a confirmed ticket booking for 2+ is spent at its doors time, by the booking's expense", () => {
    expect(times([booking()], [CLUB])).toEqual([['exp_club', CLUB.startsAt]]);
    expect(times([booking({ status: 'partially_refunded' })], [CLUB])).toHaveLength(1);
  });

  it('a morning event (local 06:00–12:00) keeps its purchase time, so it is still listed once', () => {
    const tour = { activityId: 'act_club', startsAt: '2026-03-16T09:30:00+01:00' };
    expect([...bookedGroupNightTimes([booking()], [tour], 'Europe/Madrid').entries()]).toEqual([]);
    const late = { activityId: 'act_club', startsAt: '2026-03-15T23:30:00+01:00' };
    expect([...bookedGroupNightTimes([booking()], [late], 'Europe/Madrid').entries()]).toEqual([
      ['exp_club', late.startsAt],
    ]);
  });

  it('one person, or the same person twice, is not a group night', () => {
    expect(times([booking({ attendees: ['mem_a'] })], [CLUB])).toEqual([]);
    expect(times([booking({ attendees: ['mem_a', 'mem_a'] })], [CLUB])).toEqual([]);
  });

  it('flights, stays, rides, refunds, no ledger expense and undated or unknown plans never count', () => {
    for (const kind of ['flight', 'lodging', 'transport'] as const)
      expect(times([booking({ kind })], [CLUB])).toEqual([]);
    for (const status of ['refunded', 'cancelled'] as const)
      expect(times([booking({ status })], [CLUB])).toEqual([]);
    const { activityId: _none, ...noPlan } = booking();
    expect(times([noPlan], [CLUB])).toEqual([]);
    const { expenseId: _noExpense, ...noLedger } = booking();
    expect(times([noLedger], [CLUB])).toEqual([]);
    expect(times([booking()], [{ activityId: 'act_club' }])).toEqual([]);
    expect(times([booking()], [])).toEqual([]);
  });
});

/** The seeded runtime with T-168 auto-buy on (the product default), as the simulator serves it. */
function flagship(): Harness {
  return harness({ autoBuyCapMinor: DEFAULT_AUTO_BUY_CAP_MINOR });
}

async function nextMorning(h: Harness): Promise<OutboundMessage[]> {
  h.clock.set(MORNING);
  const turns = await h.runtime.drain({ groupId: BARCELONA.groupId });
  return turns
    .flatMap((t) => t.outbound)
    .filter((o): o is OutboundMessage => 'text' in o && o.to.kind === 'group');
}

describe('seeded click-through: dinner → Razzmatazz ask → next morning (QA-01)', () => {
  it('posts the Morning After with nobody chatting after midnight', async () => {
    const h = flagship();
    await h.say('h_dean', DINNER);
    const ask = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(
      ask.auditEventIds.some(
        (id) => h.audit().find((e) => e.id === id)?.type === 'booking.completed',
      ),
    ).toBe(true);
    // Both happened at 9:39pm: neither is a late spend, and nobody spoke after midnight.
    expect(h.runtime.clock.now() < '2026-03-14T22:00:00+01:00').toBe(true);

    const posted = await nextMorning(h);
    const recap = posted.find((m) => m.card?.type === 'recap');
    expect(recap, posted.map((m) => m.text.split('\n')[0]).join(' | ')).toBeDefined();
    const card = recap!.card as RecapCard;
    expect(card.kind).toBe('morning_after');
    const lines = recap!.text.split('\n');
    expect(lines[0]).toBe('morning after, day 4 ☀️');
    expect(lines[1]).toMatch(
      /^last night: dinner \(5 of you, not Henry\) €84 · Razzmatazz[^(]* €90$/,
    );
    expect(recap!.text).toContain('€174 total');
    // Who was out is a fact from the split, never the reason (T-028).
    expect(recap!.text).not.toMatch(/sick/i);
    // The running tab alone is not what posts.
    expect(posted.some((m) => m.card?.type === 'settle_up')).toBe(false);

    const facts = await composeMorningAfter(
      { stores: h.runtime.stores, clock: h.clock, ids: h.ids },
      BARCELONA.groupId,
      BARCELONA.tripId,
      '2026-03-15',
    );
    if (facts.kind === 'no_trip') throw new Error('no trip');
    expect(facts.facts.signals).toMatchObject({
      nightlifeBooking: true,
      expenseAfter22: true,
      chatAfterMidnight: false,
    });
  });

  it('the Razzmatazz booking alone (no dinner) is still a night out', async () => {
    const h = flagship();
    await h.say('h_dean', RAZZMATAZZ_ASK);
    const recap = (await nextMorning(h)).find((m) => m.card?.type === 'recap');
    expect(recap?.text.split('\n')[1]).toMatch(
      /^last night: Razzmatazz.* \(5 of you, not Henry\) €90$/,
    );
  });

  it('dinner alone stays the quiet running tab (one signal is not a night out)', async () => {
    const h = flagship();
    await h.say('h_dean', DINNER);
    const posted = await nextMorning(h);
    expect(posted.some((m) => m.card?.type === 'recap')).toBe(false);
    expect(posted.find((m) => m.card?.type === 'settle_up')?.text.split('\n')[0]).toBe(
      'running tab, day 4',
    );
  });

  it('a club night booked a day ahead is listed the morning after the club, once', async () => {
    const h = flagship();
    // Friday afternoon: Dean books saturday's Razzmatazz.
    h.clock.set('2026-03-13T15:00:00+01:00');
    const ask = await h.say(
      'h_dean',
      "@trav get the 5 of us Razzmatazz tickets saturday, Henry's sick",
    );
    if (h.tickets.purchaseCount() === 0) {
      const card = ask.outbound.find(
        (o): o is OutboundMessage => 'card' in o && o.card?.type === 'booking_proposal',
      );
      expect(card, ask.note).toBeDefined();
      await h.react('h_dean', card!.id, '👍');
    }
    expect(h.tickets.purchaseCount()).toBe(1);

    // Saturday morning: the purchase moved the tab, but it is not "last night".
    h.clock.set('2026-03-14T10:00:00+01:00');
    const sat = (await h.runtime.drain({ groupId: BARCELONA.groupId }))
      .flatMap((t) => t.outbound)
      .filter((o): o is OutboundMessage => 'text' in o && o.to.kind === 'group');
    expect(sat.some((m) => m.card?.type === 'recap')).toBe(false);
    expect(sat.map((m) => m.text).join('\n')).not.toMatch(/razzmatazz/i);

    // Sunday morning: the club night, with the tickets in it (never an empty "last night").
    const sun = await nextMorning(h);
    const recap = sun.find((m) => m.card?.type === 'recap');
    expect(recap, sun.map((m) => m.text.split('\n')[0]).join(' | ')).toBeDefined();
    const card = recap!.card as RecapCard;
    expect(card.kind).toBe('morning_after');
    expect(recap!.text.split('\n')[1]).toMatch(
      /^last night: Razzmatazz.* \(5 of you, not Henry\) €90$/,
    );
    expect(recap!.text).toContain('€90 total');
  });

  it('family mode: a booked late club night for the adults still gets only the quiet morning', async () => {
    const h = flagship();
    await h.say('h_dean', DINNER);
    await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(h.tickets.purchaseCount()).toBe(1);
    // Someone under 18 joins the group: family mode from now on.
    const stores = h.runtime.stores;
    const dean = stores.group.members.get('mem_dean')!;
    stores.group.members.upsert({
      ...dean,
      memberId: 'mem_kid',
      senderId: 'h_kid',
      displayName: 'Kid',
      role: 'member',
      birthDate: '2012-05-01',
    });
    const posted = await nextMorning(h);
    const recaps = posted.filter((m) => m.card?.type === 'recap');
    expect(recaps.every((m) => (m.card as RecapCard).kind !== 'morning_after')).toBe(true);
    const all = posted.map((m) => m.text).join('\n');
    expect(all).not.toMatch(/morning after|last night|razzmatazz/i);
    expect(posted.length).toBeGreaterThan(0);
  });

  it('a booked club night for one person is not a group night out', async () => {
    const h = flagship();
    await h.say('h_dean', DINNER);
    await h.say('h_dean', RAZZMATAZZ_ASK);
    // The same booking, but only Dean on it.
    const stores = h.runtime.stores;
    for (const b of stores.group.bookings.listByTrip(BARCELONA.tripId))
      stores.group.bookings.updateBooking({ ...b, attendees: ['mem_dean'] });
    const posted = await nextMorning(h);
    expect(posted.some((m) => m.card?.type === 'recap')).toBe(false);
    expect(posted.some((m) => m.card?.type === 'settle_up')).toBe(true);
  });
});

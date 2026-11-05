/**
 * T-193 (SAFETY T17, SC-5 wiring): `autoBuyVerdictOnRoster` reads the
 * auto-buy verdict against the attendance of the plan the ask names, so
 * "us" / "the N of us" mean the people still going, and a sender already out
 * never buys "for us" for the others. Anything that does not line up is the
 * ineligible verdict (the card).
 */
import { describe, expect, it } from 'vitest';
import { loadAllTicketInventories } from '@trav/adapters';
import type { AttendanceStatus } from '@trav/core';
import { createDeterministicIdGenerator, createSimulatedClock } from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import { barcelonaMembers, barcelonaTrip } from '../render/testkit.js';
import { autoBuyVerdict } from './autoBuy.js';
import { autoBuyVerdictOnRoster, notGoingToAskedPlan } from './proposals.js';
import { venueIndexFrom } from './request.js';

const NOW = '2026-03-14T21:40:00+01:00';
const INDEX = venueIndexFrom(loadAllTicketInventories());
const members = barcelonaMembers();
const ROSTER = members.map((m) => m.displayName);

function world(attendance: Readonly<Record<string, AttendanceStatus>> = {}, startsAt = NOW) {
  const stores = createMemoryStores({
    clock: createSimulatedClock(NOW),
    ids: createDeterministicIdGenerator('t'),
  });
  const trip = barcelonaTrip();
  stores.group.trips.create(trip);
  stores.group.trips.upsertActivity({
    activityId: 'act_razz',
    tripId: trip.tripId,
    groupId: trip.groupId,
    kind: 'nightlife',
    name: 'Razzmatazz',
    venue: 'Razzmatazz',
    startsAt,
    contentTags: ['nightlife', 'club'],
    ageRestriction: 18,
    createdAt: NOW,
  });
  for (const [memberId, status] of Object.entries(attendance)) {
    stores.group.trips.setAttendance({
      activityId: 'act_razz',
      memberId,
      status,
      updatedAt: NOW,
      sourceMessageId: 'msg_x',
      setBy: memberId,
    });
  }
  return { group: stores.group, trip };
}

function onRoster(
  text: string,
  attendance: Readonly<Record<string, AttendanceStatus>> = {},
  sender = 'Dean',
  startsAt = NOW,
) {
  const { group, trip } = world(attendance, startsAt);
  const verdictFor = (alreadyOut: readonly string[]) =>
    autoBuyVerdict({
      text,
      index: INDEX,
      sender,
      roster: ROSTER,
      lane: 'group',
      ...(alreadyOut.length > 0 ? { alreadyOut } : {}),
    });
  return autoBuyVerdictOnRoster(verdictFor, group, trip, members, NOW);
}

describe('autoBuyVerdictOnRoster (T-193)', () => {
  it('nobody out of the plan: the plain verdict (the flagship buys for the 5, Dean going)', () => {
    const v = onRoster("@trav get the 5 of us Razzmatazz tickets, Henry's sick");
    expect(v).toMatchObject({ eligible: true, quantity: 5 });
  });

  it('Henry already out of tonight’s Razzmatazz: the flagship still buys for the 5', () => {
    const v = onRoster("@trav get the 5 of us Razzmatazz tickets, Henry's sick", {
      mem_henry: 'out',
    });
    expect(v).toMatchObject({ eligible: true, quantity: 5, excluded: ['Henry'] });
  });

  it('"the 4 of us" with Henry and Chase out of the plan: "us" is the 4 still going', () => {
    const v = onRoster('@trav get the 4 of us razz tickets', {
      mem_henry: 'out',
      mem_chase: 'out',
    });
    expect(v).toMatchObject({ eligible: true, quantity: 4 });
    if (v.eligible) expect(v.attendees).toEqual(['Dean', 'Piotr', 'Arjun', 'Crowley']);
  });

  it('the sender already out of the plan never buys "for us" for the others (party)', () => {
    expect(onRoster('@trav get us razz tickets', { mem_dean: 'out' })).toEqual({
      eligible: false,
      reason: 'party',
    });
    expect(onRoster('@trav get razz tickets for me and chase', { mem_dean: 'out' })).toEqual({
      eligible: false,
      reason: 'party',
    });
  });

  it('"us" with Piotr already out of the plan: the 5 still going (what propose books), not 6', () => {
    const v = onRoster('@trav get us razz tickets', { mem_piotr: 'out' });
    expect(v).toMatchObject({ eligible: true, quantity: 5 });
    if (v.eligible) expect(v.attendees).not.toContain('Piotr');
    // "the 6 of us" no longer matches who is going: the card.
    expect(onRoster('@trav get the 6 of us razz tickets', { mem_piotr: 'out' }).eligible).toBe(
      false,
    );
  });

  it('a "maybe" counts as not going (the proposal leaves them off too)', () => {
    const { group, trip } = world({ mem_arjun: 'maybe', mem_dean: 'in' });
    const v = autoBuyVerdict({
      text: '@trav get us razz tickets',
      index: INDEX,
      sender: 'Dean',
      roster: ROSTER,
      lane: 'group',
    });
    expect(v.eligible).toBe(true);
    if (v.eligible) expect(notGoingToAskedPlan(group, trip, v, members, NOW)).toEqual(['Arjun']);
  });

  it('a plan on another night is not the one the ask names (tonight): the plain verdict', () => {
    const v = onRoster(
      '@trav get us razz tickets',
      { mem_piotr: 'out' },
      'Dean',
      '2026-03-16T23:00:00+01:00',
    );
    expect(v).toMatchObject({ eligible: true, quantity: 6 });
  });

  it('no trip: the plain verdict; an ineligible ask stays ineligible', () => {
    const verdictFor = () =>
      autoBuyVerdict({
        text: '@trav get razz tickets for chase and henry',
        index: INDEX,
        sender: 'Dean',
        roster: ROSTER,
        lane: 'group',
      });
    const { group } = world();
    expect(autoBuyVerdictOnRoster(verdictFor, group, null, members, NOW)).toEqual({
      eligible: false,
      reason: 'party',
    });
  });
});

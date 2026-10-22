import { describe, expect, it } from 'vitest';
import type { Activity, Roster } from '../domain/trip.js';
import { checkProposalConsistency } from './consistency.js';
import {
  FIVE,
  NOW,
  ageBandDeps,
  barcelonaMembers,
  barcelonaTrip,
  equalShares,
  member,
  razzmatazz,
  razzmatazzActivity,
  razzmatazzRoster,
} from './testkit.js';

const members = barcelonaMembers();
const run = (
  proposal = razzmatazz(),
  trip = barcelonaTrip(),
  activity: Activity | null = razzmatazzActivity(),
  roster: Roster | null = razzmatazzRoster(),
  now = NOW,
) => checkProposalConsistency(proposal, trip, activity, roster, members, now, ageBandDeps);

/** The activity without a start time (so only the proposal's eventDate is date-checked). */
const untimedActivity = (): Activity => {
  const { startsAt: _startsAt, ...rest } = razzmatazzActivity();
  return rest;
};

describe('checkProposalConsistency: the Razzmatazz case passes', () => {
  it('5 of us, Henry out, Barcelona, tonight, adults only ⇒ ok', () => {
    expect(run()).toEqual({ ok: true, problems: [] });
  });

  it('passes without an activity or roster (nothing to compare against)', () => {
    expect(
      checkProposalConsistency(
        razzmatazz(),
        barcelonaTrip(),
        null,
        null,
        members,
        NOW,
        ageBandDeps,
      ),
    ).toEqual({
      ok: true,
      problems: [],
    });
  });

  it('passes when the proposal has no city or event date', () => {
    const p = razzmatazz({ eventDate: '' });
    delete (p as { city?: string }).city;
    expect(run(p, barcelonaTrip(), untimedActivity())).toEqual({
      ok: true,
      problems: [],
    });
  });
});

describe('checkProposalConsistency: problems', () => {
  it('wrong city (the Naples case)', () => {
    expect(run(razzmatazz({ city: 'Naples' })).problems).toEqual(['city_not_in_trip']);
  });

  it('city comparison ignores case, accents and punctuation', () => {
    expect(run(razzmatazz({ city: 'barcelona' })).ok).toBe(true);
    expect(run(razzmatazz({ city: 'BARCELONA ' })).ok).toBe(true);
    expect(
      run(razzmatazz({ city: 'Sao Paulo' }), barcelonaTrip({ city: 'São Paulo' })).problems,
    ).toEqual([]);
  });

  it('event date outside the trip', () => {
    expect(run(razzmatazz({ eventDate: '2026-03-17' })).problems).toEqual(['date_outside_trip']);
    expect(run(razzmatazz({ eventDate: '2026-03-11' })).problems).toEqual(['date_outside_trip']);
  });

  it('event date on the first and last trip day is inside', () => {
    expect(
      run(razzmatazz({ eventDate: '2026-03-16' }), barcelonaTrip(), untimedActivity()).ok,
    ).toBe(true);
    expect(
      run(
        razzmatazz({ eventDate: '2026-03-12' }),
        barcelonaTrip(),
        untimedActivity(),
        razzmatazzRoster(),
        '2026-03-12T09:00:00+01:00',
      ).ok,
    ).toBe(true);
  });

  it('event date already past (relative to the injected now, in the trip time zone)', () => {
    expect(run(razzmatazz({ eventDate: '2026-03-13' })).problems).toEqual(['date_outside_trip']);
    // 00:30 local on the 15th: a ticket for the 14th is yesterday's.
    expect(
      run(
        razzmatazz(),
        barcelonaTrip(),
        razzmatazzActivity(),
        razzmatazzRoster(),
        '2026-03-15T00:30:00+01:00',
      ).problems,
    ).toEqual(['date_outside_trip']);
    // Same instant expressed in UTC: still the 15th in Madrid.
    expect(
      run(
        razzmatazz(),
        barcelonaTrip(),
        razzmatazzActivity(),
        razzmatazzRoster(),
        '2026-03-14T23:30:00Z',
      ).problems,
    ).toEqual(['date_outside_trip']);
  });

  it('activity start outside the trip, even when the proposal has no event date', () => {
    const p = razzmatazz({ eventDate: '' });
    expect(
      run(p, barcelonaTrip(), razzmatazzActivity({ startsAt: '2026-03-18T23:30:00+01:00' }))
        .problems,
    ).toEqual(['date_outside_trip']);
  });

  it('quantity ≠ roster: 4 attendees for a roster of 5, or 6 (Henry back in the list)', () => {
    const four = razzmatazz({
      attendees: FIVE.slice(0, 4),
      payers: equalShares(FIVE.slice(0, 4), 2250),
    });
    expect(run(four).problems).toEqual(['quantity_not_roster']);
    const six = razzmatazz({
      attendees: [...FIVE, 'mem_henry'],
      payers: equalShares([...FIVE, 'mem_henry'], 1500),
    });
    expect(run(six).problems).toEqual(['quantity_not_roster', 'attendee_marked_out']);
  });

  it('attendee marked out: same count but Henry swapped in for Leo', () => {
    const ids = [...FIVE.slice(0, 4), 'mem_henry'];
    expect(run(razzmatazz({ attendees: ids, payers: equalShares(ids, 1800) })).problems).toEqual([
      'attendee_marked_out',
    ]);
  });

  it('maybe and unanswered count as out', () => {
    const roster = razzmatazzRoster({ inMemberIds: FIVE.slice(0, 4), maybeMemberIds: ['mem_leo'] });
    expect(run(razzmatazz(), barcelonaTrip(), razzmatazzActivity(), roster).problems).toEqual([
      'quantity_not_roster',
      'attendee_marked_out',
    ]);
    const unanswered = razzmatazzRoster({ inMemberIds: FIVE.slice(0, 4), outMemberIds: [] });
    expect(run(razzmatazz(), barcelonaTrip(), razzmatazzActivity(), unanswered).problems).toContain(
      'attendee_marked_out',
    );
  });

  it('attendee not a member: unknown id, guest, or someone who left', () => {
    for (const bad of ['mem_nobody', 'mem_stranger', 'mem_gone']) {
      const ids = [...FIVE.slice(0, 4), bad];
      const roster = razzmatazzRoster({ inMemberIds: ids });
      expect(
        run(
          razzmatazz({ attendees: ids, payers: equalShares(ids, 1800) }),
          barcelonaTrip(),
          razzmatazzActivity(),
          roster,
        ).problems,
      ).toEqual(['attendee_not_member']);
    }
  });

  it('minor + club: blocked via ageRestriction, via content tag, and via activity kind', () => {
    const ids = [...FIVE, 'mem_kid'];
    const roster = razzmatazzRoster({ inMemberIds: ids });
    const withKid = (overrides: Partial<ReturnType<typeof razzmatazz>> = {}) =>
      razzmatazz({ attendees: ids, payers: equalShares(ids, 1500), ...overrides });

    expect(run(withKid(), barcelonaTrip(), razzmatazzActivity(), roster).problems).toEqual([
      'minor_on_restricted',
    ]);
    expect(
      run(
        withKid({ ageRestriction: null, contentTags: ['bar'] }),
        barcelonaTrip(),
        razzmatazzActivity({ kind: 'dinner', ageRestriction: null, contentTags: [] }),
        roster,
      ).problems,
    ).toEqual(['minor_on_restricted']);
    expect(
      run(
        withKid({ ageRestriction: null, contentTags: [] }),
        barcelonaTrip(),
        razzmatazzActivity({ ageRestriction: null, contentTags: [] }),
        roster,
      ).problems,
    ).toEqual(['minor_on_restricted']);
    expect(
      run(
        withKid({ ageRestriction: null, contentTags: [] }),
        barcelonaTrip(),
        razzmatazzActivity({ kind: 'dinner', ageRestriction: null, contentTags: ['alcohol'] }),
        roster,
      ).problems,
    ).toEqual(['minor_on_restricted']);
  });

  it('minor on a family item with the guardian paying is fine (family tab)', () => {
    const ids = [...FIVE, 'mem_kid'];
    const roster = razzmatazzRoster({ inMemberIds: ids });
    const family = razzmatazz({
      attendees: ids,
      payers: equalShares(FIVE, 1800),
      ageRestriction: null,
      contentTags: ['family'],
    });
    const activity = razzmatazzActivity({
      kind: 'attraction',
      ageRestriction: null,
      contentTags: ['family'],
    });
    expect(run(family, barcelonaTrip(), activity, roster)).toEqual({ ok: true, problems: [] });
  });

  it('payers who are not attendees (and not a guardian of a minor attendee)', () => {
    const p = razzmatazz({
      payers: [...equalShares(FIVE.slice(0, 4), 1800), { memberId: 'mem_henry', shareMinor: 1800 }],
    });
    expect(run(p).problems).toEqual(['payers_not_attendees']);
  });

  it('a treat (requester pays, everyone attends) is not a problem', () => {
    const p = razzmatazz({ payers: equalShares(['mem_dean'], 9000) });
    expect(run(p).ok).toBe(true);
  });

  it('empty roster / no attendees', () => {
    const none = razzmatazz({ attendees: [], payers: [] });
    expect(
      run(
        none,
        barcelonaTrip(),
        razzmatazzActivity(),
        razzmatazzRoster({ inMemberIds: [], outMemberIds: [...FIVE, 'mem_henry'] }),
      ).problems,
    ).toEqual(['empty_roster']);
    expect(run(none, barcelonaTrip(), null, null).problems).toEqual(['empty_roster']);
    expect(
      run(
        razzmatazz(),
        barcelonaTrip(),
        razzmatazzActivity(),
        razzmatazzRoster({ inMemberIds: [] }),
      ).problems,
    ).toEqual(['empty_roster', 'quantity_not_roster', 'attendee_marked_out']);
  });

  it('reports every problem once, in a stable order', () => {
    const ids = ['mem_nobody', 'mem_kid'];
    const p = razzmatazz({
      city: 'Naples',
      eventDate: '2026-04-01',
      attendees: ids,
      payers: equalShares(['mem_henry'], 9000),
    });
    expect(run(p).problems).toEqual([
      'city_not_in_trip',
      'date_outside_trip',
      'quantity_not_roster',
      'attendee_marked_out',
      'attendee_not_member',
      'minor_on_restricted',
      'payers_not_attendees',
    ]);
  });

  it('uses the injected minor predicate (default is safety.isMinor)', () => {
    const ids = [...FIVE, 'mem_kid'];
    const roster = razzmatazzRoster({ inMemberIds: ids });
    const p = razzmatazz({ attendees: ids, payers: equalShares(ids, 1500) });
    const nobodyIsMinor = { isMinor: () => false };
    expect(
      checkProposalConsistency(
        p,
        barcelonaTrip(),
        razzmatazzActivity(),
        roster,
        members,
        NOW,
        nobodyIsMinor,
      ).ok,
    ).toBe(true);
    const everyoneIsMinor = { isMinor: () => true };
    expect(
      checkProposalConsistency(
        razzmatazz(),
        barcelonaTrip(),
        razzmatazzActivity(),
        razzmatazzRoster(),
        members,
        NOW,
        everyoneIsMinor,
      ).problems,
    ).toEqual(['minor_on_restricted']);
  });

  it('is pure', () => {
    const p = razzmatazz({ city: 'Naples' });
    const copy = structuredClone(p);
    run(p);
    expect(p).toEqual(copy);
    expect(member('mem_x').groupId).toBe('grp_barcelona');
  });
});

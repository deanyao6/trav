import { describe, expect, it } from 'vitest';
import {
  ageOn,
  audienceIncludesMinor,
  detectContentTags,
  groupAgeUnconfirmed,
  groupHasMinor,
  isConfirmedAdult,
  isFamilyMode,
  isMinor,
  isRestrictedContent,
  isRestrictedText,
  restrictedContentAllowed,
} from './index.js';
import { TravError } from '../errors.js';
import { group, member } from './test-helpers.js';

const NOW = '2026-10-22T12:00:00Z';

describe('isMinor / ageOn', () => {
  it('birthDate under 18 is a minor', () => {
    expect(
      isMinor(member({ memberId: 'l', displayName: 'Lily', birthDate: '2012-06-10' }), NOW),
    ).toBe(true);
  });

  it('turns adult exactly on the 18th birthday, not the day before', () => {
    const m = member({ memberId: 'x', displayName: 'X', birthDate: '2008-10-22' });
    expect(isMinor(m, '2026-10-21T23:59:59Z')).toBe(true);
    expect(isMinor(m, '2026-10-22T00:00:00Z')).toBe(false);
    expect(ageOn(m, '2026-10-22T00:00:00Z')).toBe(18);
  });

  it('a Feb 29 birthday turns 18 on Mar 1 in a common year', () => {
    const m = member({ memberId: 'x', displayName: 'X', birthDate: '2008-02-29' });
    expect(isMinor(m, '2026-02-28T12:00:00Z')).toBe(true);
    expect(isMinor(m, '2026-03-01T12:00:00Z')).toBe(false);
  });

  it('uses the local date written in `now`', () => {
    const m = member({ memberId: 'x', displayName: 'X', birthDate: '2008-10-23' });
    // 23:30 on the 22nd in New York is the 23rd in UTC; the local date says still 17.
    expect(isMinor(m, '2026-10-22T23:30:00-04:00')).toBe(true);
  });

  it("ageBand 'under18' is a minor even without a birthDate", () => {
    expect(isMinor(member({ memberId: 'x', displayName: 'X', ageBand: 'under18' }), NOW)).toBe(
      true,
    );
  });

  it('either signal is enough: an adult birthDate does not override under18 band (fail safe)', () => {
    const m = member({
      memberId: 'x',
      displayName: 'X',
      birthDate: '1990-01-01',
      ageBand: 'under18',
    });
    expect(isMinor(m, NOW)).toBe(true);
    const n = member({
      memberId: 'y',
      displayName: 'Y',
      birthDate: '2015-01-01',
      ageBand: 'adult',
    });
    expect(isMinor(n, NOW)).toBe(true);
  });

  it('unknown age is NOT a minor but NOT a confirmed adult either', () => {
    const m = member({ memberId: 'x', displayName: 'X', ageBand: 'unknown' });
    expect(isMinor(m, NOW)).toBe(false);
    expect(isConfirmedAdult(m, NOW)).toBe(false);
  });

  it('malformed or future birthDates count as unknown', () => {
    const bad = member({ memberId: 'x', displayName: 'X', birthDate: '2008-02-30' });
    expect(ageOn(bad, NOW)).toBeUndefined();
    expect(isMinor(bad, NOW)).toBe(false);
    const future = member({ memberId: 'y', displayName: 'Y', birthDate: '2030-01-01' });
    expect(ageOn(future, NOW)).toBeUndefined();
    expect(isConfirmedAdult(future, NOW)).toBe(false);
  });

  it('confirmed adult from birthDate or adult band', () => {
    expect(
      isConfirmedAdult(member({ memberId: 'x', displayName: 'X', birthDate: '2000-01-01' }), NOW),
    ).toBe(true);
    expect(
      isConfirmedAdult(member({ memberId: 'y', displayName: 'Y', ageBand: 'adult' }), NOW),
    ).toBe(true);
  });

  it('throws on an invalid now', () => {
    expect(() =>
      isMinor(member({ memberId: 'x', displayName: 'X', birthDate: '2000-01-01' }), 'yesterday'),
    ).toThrow(TravError);
  });
});

describe('group predicates', () => {
  const dad = member({ memberId: 'dad', displayName: 'Dad', ageBand: 'adult' });
  const lily = member({ memberId: 'lily', displayName: 'Lily', birthDate: '2012-06-10' });
  const unknown = member({ memberId: 'u', displayName: 'U' });

  it('groupHasMinor: any active minor', () => {
    expect(groupHasMinor([dad, lily], NOW)).toBe(true);
    expect(groupHasMinor([dad], NOW)).toBe(false);
    expect(groupHasMinor([], NOW)).toBe(false);
  });

  it('a minor who left the chat no longer makes it a minor group', () => {
    const gone = member({
      memberId: 'lily',
      displayName: 'Lily',
      birthDate: '2012-06-10',
      active: false,
    });
    expect(groupHasMinor([dad, gone], NOW)).toBe(false);
  });

  it('groupAgeUnconfirmed: unknown age and not confirmed', () => {
    expect(groupAgeUnconfirmed(group(), [dad, unknown])).toBe(true);
    expect(groupAgeUnconfirmed(group({ allAdultsConfirmed: true }), [dad, unknown])).toBe(false);
    expect(groupAgeUnconfirmed(group(), [dad])).toBe(false);
    expect(groupAgeUnconfirmed(group(), [])).toBe(false);
  });

  it('T-170: a newcomer still in setup counts as unconfirmed, whatever the attestation says', () => {
    const newcomer = {
      ...member({
        memberId: 'n',
        displayName: 'new',
        role: 'guest',
        active: false,
        ageBand: 'unknown',
      }),
      onboarding: 'pending' as const,
    };
    expect(groupAgeUnconfirmed(group({ allAdultsConfirmed: true }), [dad, newcomer])).toBe(true);
    expect(groupAgeUnconfirmed(group(), [dad, newcomer])).toBe(true);
    // Once they left (or finished setup) they no longer count.
    const gone = { ...newcomer, leftAt: NOW };
    expect(groupAgeUnconfirmed(group({ allAdultsConfirmed: true }), [dad, gone])).toBe(false);
    const { onboarding: _done, ...finished } = newcomer;
    void _done;
    expect(
      groupAgeUnconfirmed(group({ allAdultsConfirmed: true }), [
        dad,
        { ...finished, role: 'member', active: true, ageBand: 'adult' },
      ]),
    ).toBe(false);
  });

  it('audienceIncludesMinor fails closed on unknown ids', () => {
    expect(audienceIncludesMinor(['dad'], [dad, lily], NOW)).toBe(false);
    expect(audienceIncludesMinor(['dad', 'lily'], [dad, lily], NOW)).toBe(true);
    expect(audienceIncludesMinor(['stranger'], [dad, lily], NOW)).toBe(true);
    expect(audienceIncludesMinor([], [dad, lily], NOW)).toBe(false);
  });

  it('family mode: derived from a minor, or forced', () => {
    expect(isFamilyMode(group(), [dad, lily], NOW)).toBe(true);
    expect(isFamilyMode(group(), [dad], NOW)).toBe(false);
    expect(isFamilyMode(group({ familyModeForced: true }), [dad], NOW)).toBe(true);
  });
});

describe('restricted content', () => {
  const dean = member({ memberId: 'dean', displayName: 'Dean', ageBand: 'adult' });
  const dad = member({ memberId: 'dad', displayName: 'Dad', ageBand: 'adult' });
  const lily = member({ memberId: 'lily', displayName: 'Lily', birthDate: '2012-06-10' });
  const family = [dean, dad, lily];

  it('isRestrictedContent: tag intersection', () => {
    expect(isRestrictedContent(['nightlife'])).toBe(true);
    expect(isRestrictedContent(['21+', 'family'])).toBe(true);
    expect(isRestrictedContent(['family', 'late_night'])).toBe(false);
    expect(isRestrictedContent([])).toBe(false);
  });

  it('detectContentTags: whole words only, benign phrases ignored', () => {
    expect(detectContentTags('the beach bar does rum punch')).toEqual(['bar', 'alcohol']);
    expect(detectContentTags('barça vs sevilla, sunday 9pm')).toEqual([]);
    expect(detectContentTags('kids’ club till 4 and the snack bar does smoothies')).toEqual([]);
    expect(detectContentTags('non-alcoholic cocktails')).toEqual(['alcohol']);
    expect(detectContentTags('non-alcoholic punch')).toEqual([]);
    expect(detectContentTags('there is a casino and a nightclub')).toEqual([
      'nightlife',
      'gambling',
    ]);
    expect(detectContentTags('adults only, 18+')).toEqual(['18+']);
    expect(isRestrictedText('snorkel tour at 9')).toBe(false);
  });

  it('flaw 10: more phrasings tagged, more benign club phrases ignored', () => {
    expect(detectContentTags('drinks at the pool at 6')).toEqual(['alcohol']);
    expect(detectContentTags('drinks by the marina after')).toEqual(['alcohol']);
    expect(detectContentTags('the dance floor opens at 11')).toEqual(['nightlife']);
    expect(detectContentTags('boat party saturday, $60')).toEqual(['nightlife']);
    expect(detectContentTags('a party boat leaves at 9pm')).toEqual(['nightlife']);
    expect(detectContentTags('the book club meets in the lobby at 5')).toEqual([]);
    expect(detectContentTags('Sporting fan club tour at 2')).toEqual([]);
    expect(detectContentTags('the kids drink lemonade by the pool')).toEqual([]);
  });

  it('allowed outside family mode', () => {
    expect(
      restrictedContentAllowed({ group: group(), members: [dean, dad], now: NOW, tags: ['club'] }),
    ).toBe(true);
  });

  it('blocked for a family group without an explicit adult request', () => {
    expect(
      restrictedContentAllowed({ group: group(), members: family, now: NOW, tags: ['bar'] }),
    ).toBe(false);
    expect(
      restrictedContentAllowed({
        group: group(),
        members: family,
        now: NOW,
        tags: ['bar'],
        audience: ['dad', 'dean'],
      }),
    ).toBe(false);
  });

  it('"Dad and I want a bar" with an adult-only audience is allowed', () => {
    expect(
      restrictedContentAllowed({
        group: group(),
        members: family,
        now: NOW,
        tags: ['bar', 'alcohol'],
        audience: ['dad', 'dean'],
        explicitAdultRequest: true,
      }),
    ).toBe(true);
  });

  it('explicit request still blocked if the audience includes the minor or is the whole group', () => {
    const base = {
      group: group(),
      members: family,
      now: NOW,
      tags: ['bar'] as const,
      explicitAdultRequest: true,
    };
    expect(restrictedContentAllowed({ ...base, audience: ['dad', 'lily'] })).toBe(false);
    expect(restrictedContentAllowed({ ...base })).toBe(false);
    expect(restrictedContentAllowed({ ...base, audience: [] })).toBe(false);
  });

  it('unrestricted tags are always allowed, even with a minor', () => {
    expect(
      restrictedContentAllowed({ group: group(), members: family, now: NOW, tags: ['family'] }),
    ).toBe(true);
  });
});

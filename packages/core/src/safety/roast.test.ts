import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROAST_BLOCKLIST,
  roastAllowed,
  roastTopicBlocked,
  tripAllowsRoast,
} from './index.js';
import type { RoastTopicCategory } from './index.js';
import {
  BCN_NOW,
  barcelonaMembers,
  consentWithRoast,
  group,
  loadSafetyFixture,
  member,
  trip,
} from './test-helpers.js';

interface BlocklistFixture {
  readonly blocked: readonly {
    readonly id: string;
    readonly category: RoastTopicCategory;
    readonly line: string;
  }[];
  readonly allowed: readonly { readonly id: string; readonly line: string }[];
}

const fixture = loadSafetyFixture<BlocklistFixture>('roast-blocklist-cases.json');

describe('roastAllowed (gate 1)', () => {
  const members = barcelonaMembers();
  const jordan = members.find((m) => m.memberId === 'jordan')!;
  const on = group({ roastMode: true });
  const allIn = consentWithRoast(members.map((m) => m.memberId));

  it('allowed: mode on, adults with known ages, opted in, active trip', () => {
    expect(roastAllowed(on, members, jordan, allIn, trip(), BCN_NOW)).toEqual({ allowed: true });
  });

  it('off by default', () => {
    expect(roastAllowed(group(), members, jordan, allIn, trip(), BCN_NOW)).toEqual({
      allowed: false,
      cause: 'mode_off',
    });
  });

  it('any minor in the group blocks it entirely, whoever the target is', () => {
    const lily = member({ memberId: 'lily', displayName: 'Lily', birthDate: '2012-06-10' });
    expect(roastAllowed(on, [...members, lily], jordan, allIn, trip(), BCN_NOW)).toEqual({
      allowed: false,
      cause: 'minor_in_group',
    });
  });

  it('age unknown ⇒ roast blocked until the group confirms everyone is 18+', () => {
    const unknown = member({ memberId: 'alex', displayName: 'Alex', ageBand: 'unknown' });
    const roster = [...members, unknown];
    expect(roastAllowed(on, roster, jordan, allIn, trip(), BCN_NOW)).toEqual({
      allowed: false,
      cause: 'age_unconfirmed',
    });
    const confirmed = group({ roastMode: true, allAdultsConfirmed: true });
    expect(roastAllowed(confirmed, roster, jordan, allIn, trip(), BCN_NOW)).toEqual({
      allowed: true,
    });
  });

  it('age-unknown target alone (everyone else known) still blocks', () => {
    const roster = members.map((m) =>
      m.memberId === 'jordan' ? member({ memberId: 'jordan', displayName: 'Jordan' }) : m,
    );
    expect(roastAllowed(on, roster, roster[3]!, allIn, trip(), BCN_NOW).allowed).toBe(false);
  });

  it('forced family mode blocks roasts', () => {
    expect(
      roastAllowed(
        group({ roastMode: true, familyModeForced: true }),
        members,
        jordan,
        allIn,
        trip(),
        BCN_NOW,
      ),
    ).toEqual({
      allowed: false,
      cause: 'family_mode',
    });
  });

  it('target must have opted in (consent defaults false)', () => {
    expect(roastAllowed(on, members, jordan, consentWithRoast(['dean']), trip(), BCN_NOW)).toEqual({
      allowed: false,
      cause: 'member_opted_out',
    });
    expect(roastAllowed(on, members, jordan, () => undefined, trip(), BCN_NOW)).toEqual({
      allowed: false,
      cause: 'member_opted_out',
    });
  });

  it('target who left, a guest, or someone not in the group is blocked', () => {
    const left = members.map((m) =>
      m.memberId === 'jordan' ? { ...m, active: false, leftAt: '2026-03-14T10:00:00Z' } : m,
    );
    expect(roastAllowed(on, left, jordan, allIn, trip(), BCN_NOW)).toEqual({
      allowed: false,
      cause: 'target_inactive',
    });
    const guest = member({ memberId: 'g', displayName: 'Guest', role: 'guest', ageBand: 'adult' });
    expect(roastAllowed(on, [...members, guest], guest, allIn, trip(), BCN_NOW)).toEqual({
      allowed: false,
      cause: 'target_not_member',
    });
    const outsider = member({ memberId: 'host', displayName: 'Host', ageBand: 'adult' });
    expect(roastAllowed(on, members, outsider, allIn, trip(), BCN_NOW)).toEqual({
      allowed: false,
      cause: 'target_not_member',
    });
  });

  it('a stale target object cannot bypass a leave', () => {
    const left = members.map((m) => (m.memberId === 'jordan' ? { ...m, active: false } : m));
    // `jordan` (stale, active: true) is passed, but the roster says inactive.
    expect(roastAllowed(on, left, jordan, allIn, trip(), BCN_NOW).allowed).toBe(false);
  });

  it('no roasts weeks after the trip, or with no trip', () => {
    expect(roastAllowed(on, members, jordan, allIn, null, BCN_NOW)).toEqual({
      allowed: false,
      cause: 'trip_over',
    });
    expect(
      roastAllowed(on, members, jordan, allIn, trip({ status: 'closed' }), BCN_NOW).allowed,
    ).toBe(false);
    expect(tripAllowsRoast(trip({ status: 'ended' }), '2026-03-18T10:00:00+01:00')).toBe(true);
    expect(tripAllowsRoast(trip({ status: 'ended' }), '2026-03-24T10:00:00+01:00')).toBe(true);
    expect(tripAllowsRoast(trip({ status: 'ended' }), '2026-03-25T10:00:00+01:00')).toBe(false);
    expect(tripAllowsRoast(trip({ status: 'active' }), '2026-04-30T10:00:00+01:00')).toBe(false);
  });

  it('no roasts while a trip is still being planned (SAFETY §2.8: active or just ended)', () => {
    expect(tripAllowsRoast(trip({ status: 'planning' }), '2026-03-10T10:00:00+01:00')).toBe(false);
    expect(tripAllowsRoast(trip({ status: 'planning' }), BCN_NOW)).toBe(false);
    expect(roastAllowed(on, members, jordan, allIn, trip({ status: 'planning' }), BCN_NOW)).toEqual(
      {
        allowed: false,
        cause: 'trip_over',
      },
    );
  });
});

describe('roastTopicBlocked (gate 2 blocklist)', () => {
  it.each(fixture.blocked.map((c) => [c.id, c.line, c.category] as const))(
    'blocks %s',
    (_id, line, category) => {
      expect(roastTopicBlocked(line, DEFAULT_ROAST_BLOCKLIST)).toBe(category);
    },
  );

  it.each(fixture.allowed.map((c) => [c.id, c.line] as const))('allows %s', (_id, line) => {
    expect(roastTopicBlocked(line)).toBeNull();
  });

  it('covers every required category from SAFETY F5 / the task', () => {
    const cats = new Set(fixture.blocked.map((c) => c.category));
    for (const c of [
      'body',
      'romance',
      'outsider',
      'protected_trait',
      'health',
      'intoxication',
      'hardship',
      'legal',
      'minor',
      'left_member',
      'private_data',
    ] as const) {
      expect(cats.has(c)).toBe(true);
    }
  });

  it('"Henry\'s sick" is never a roast, with curly apostrophes too', () => {
    expect(roastTopicBlocked('Henry’s sick so €0 for him')).toBe('health');
  });

  it('matches whole words only', () => {
    expect(roastTopicBlocked('the hostel was €20 a night')).toBeNull();
    expect(roastTopicBlocked('Dean brokered a €5 deal on the tab')).toBeNull();
    expect(roastTopicBlocked('i’ll allow it, €14 for a water')).toBeNull();
  });

  it('round 3 flaw 4: VOICE §7.3 / §4.8 material passes; person-targeting variants still block', () => {
    for (const fine of [
      'the €180 Sintra driver, worth it per both of you',
      'most expensive thing: the Sintra driver, €180, worth it per both of you',
      'a single €14 water',
      'every single uber was Priya',
      'asleep at the wheel of this trip',
      'the airbnb host fee was €40, split 6 ways',
    ]) {
      expect(roastTopicBlocked(fine), fine).toBeNull();
    }
    expect(roastTopicBlocked('Sam is single and spent €40 at the bar proving it')).toBe('romance');
    expect(roastTopicBlocked('Priya, still single, €40 on the tab')).toBe('romance');
    expect(roastTopicBlocked('the driver was lost for 40 minutes, €23')).toBe('outsider');
    expect(roastTopicBlocked("the driver's attitude cost us €23")).toBe('outsider');
    expect(roastTopicBlocked('our host charged €1,380 for that')).toBe('outsider');
    expect(roastTopicBlocked('the hosts were weird about the €50 deposit')).toBe('outsider');
    expect(roastTopicBlocked('the driver couldn’t find the airbnb, 40 minutes for €23')).toBe(
      'outsider',
    );
    // The idiom is blanked whole; "asleep" on its own is still a body topic.
    expect(roastTopicBlocked('Jordan fell asleep at dinner, €0 spent')).toBe('body');
    expect(roastTopicBlocked('asleep at the wheel again, and Sam was asleep by 10')).toBe('body');
  });

  it('T-138: Trav\'s "looks shared" wording is not a body topic; looks themselves still are', () => {
    for (const fine of [
      '1 charge that looks shared is waiting on a tap in dms',
      '2 charges that look shared are waiting on a tap in dms',
      'looks shared?',
    ]) {
      expect(roastTopicBlocked(fine), fine).toBeNull();
    }
    expect(roastTopicBlocked("Sam's looks cost him €40 at the door")).toBe('body');
    expect(roastTopicBlocked('looks shared, and so does his ugly shirt')).toBe('body');
    expect(roastTopicBlocked('Jordan looks rough after €90 of rounds')).toBe('body');
  });

  it('extra caller-supplied terms are honored', () => {
    expect(
      roastTopicBlocked('Sam and the karaoke machine', [{ term: 'karaoke', category: 'body' }]),
    ).toBe('body');
    expect(roastTopicBlocked('anything', [{ term: '  ', category: 'body' }])).toBeNull();
  });
});

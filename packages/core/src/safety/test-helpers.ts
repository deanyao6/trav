/**
 * Builders for safety tests (synthetic data only). Not exported from the package index.
 */
import { loadFixture } from '../testkit/fixtures.js';
import type { AgeBand, Group, GroupSettings, Member, MemberRole } from '../domain/group.js';
import { DEFAULT_GROUP_SETTINGS } from '../domain/group.js';
import { defaultSpendingPolicy } from '../domain/approval.js';
import type { ConsentFlags, ConsentLookup } from '../domain/consent.js';
import { defaultConsent } from '../domain/consent.js';
import type { Trip } from '../domain/trip.js';
import type { OutboundMessage, RecapCard, WrappedCard } from '../cards.js';

/** `<repo>/fixtures/safety/<name>` read as JSON, via the core fixture loader. */
export function loadSafetyFixture<T>(name: string): T {
  return loadFixture<T>(`safety/${name}`);
}

export interface MemberSpec {
  readonly memberId: string;
  readonly displayName: string;
  readonly role?: MemberRole;
  readonly birthDate?: string;
  readonly ageBand?: AgeBand;
  readonly guardianMemberId?: string;
  readonly active?: boolean;
  readonly leftAt?: string;
}

export function member(spec: MemberSpec, groupId = 'g1'): Member {
  return {
    memberId: spec.memberId,
    groupId,
    displayName: spec.displayName,
    role: spec.role ?? 'member',
    active: spec.active ?? true,
    senderId: `sender_${spec.memberId}`,
    ageBand: spec.ageBand ?? 'unknown',
    joinedAt: '2026-03-01T10:00:00Z',
    ...(spec.birthDate !== undefined ? { birthDate: spec.birthDate } : {}),
    ...(spec.guardianMemberId !== undefined ? { guardianMemberId: spec.guardianMemberId } : {}),
    ...(spec.leftAt !== undefined ? { leftAt: spec.leftAt } : {}),
  };
}

export function group(settings: Partial<GroupSettings> = {}, groupId = 'g1'): Group {
  return {
    groupId,
    name: 'test group',
    conversationId: `conv_${groupId}`,
    channelKind: 'simulator',
    currency: 'EUR',
    settings: { ...DEFAULT_GROUP_SETTINGS, ...settings },
    spendingPolicy: defaultSpendingPolicy(groupId, 'EUR'),
    createdAt: '2026-03-01T10:00:00Z',
  };
}

export function trip(over: Partial<Trip> = {}): Trip {
  return {
    tripId: 't1',
    groupId: 'g1',
    name: 'barcelona',
    city: 'Barcelona',
    countryCode: 'ES',
    timeZone: 'Europe/Madrid',
    startDate: '2026-03-12',
    endDate: '2026-03-17',
    currency: 'EUR',
    status: 'active',
    familyTab: false,
    createdBy: 'dean',
    createdAt: '2026-03-01T10:00:00Z',
    ...over,
  };
}

/** Consent lookup where the listed members opted into roasts. */
export function consentWithRoast(optedIn: readonly string[], groupId = 'g1'): ConsentLookup {
  const map = new Map<string, ConsentFlags>();
  return (memberId) => {
    const hit = map.get(memberId);
    if (hit !== undefined) return hit;
    const flags = {
      ...defaultConsent(memberId, groupId, '2026-03-01T10:00:00Z'),
      roast: optedIn.includes(memberId),
    };
    map.set(memberId, flags);
    return flags;
  };
}

/** Barcelona roster: six adults with birthdates (ages 20–22 on the trip). */
export function barcelonaMembers(): Member[] {
  return [
    member({
      memberId: 'dean',
      displayName: 'Dean',
      role: 'lead',
      birthDate: '2005-02-11',
      ageBand: 'adult',
    }),
    member({ memberId: 'henry', displayName: 'Henry', birthDate: '2004-07-30', ageBand: 'adult' }),
    member({ memberId: 'chase', displayName: 'Chase', birthDate: '2005-11-02', ageBand: 'adult' }),
    member({
      memberId: 'piotr',
      displayName: 'Piotr',
      birthDate: '2004-01-19',
      ageBand: 'adult',
    }),
    member({ memberId: 'arjun', displayName: 'Arjun', birthDate: '2005-05-05', ageBand: 'adult' }),
    member({
      memberId: 'crowley',
      displayName: 'Crowley',
      birthDate: '2006-01-01',
      ageBand: 'adult',
    }),
  ];
}

export const BCN_NOW = '2026-03-15T10:00:00+01:00';

export function groupMessage(text: string, over: Partial<OutboundMessage> = {}): OutboundMessage {
  return { id: 'msg_1', groupId: 'g1', to: { kind: 'group' }, text, ...over };
}

/** Barcelona Wrapped (VOICE §4.8 A) with the given awards and stats; `text` is the rendered message. */
export function wrappedCard(
  text: string,
  awards: WrappedCard['awards'],
  stats: WrappedCard['stats'] = [],
): WrappedCard {
  return {
    cardId: 'card_wrapped_1',
    type: 'wrapped',
    title: 'barcelona wrapped',
    fallbackText: text,
    trip: { name: 'Barcelona', days: 6, people: 6, currency: 'EUR' },
    totals: {
      spent: { amountMinor: 234000, currency: 'EUR' },
      perPerson: { amountMinor: 39000, currency: 'EUR' },
      byCategory: [{ category: 'transport', amount: { amountMinor: 41200, currency: 'EUR' } }],
    },
    stats,
    awards,
    photos: [],
    finalSettle: {
      cardId: 'card_settle_final',
      type: 'settle_up',
      title: 'final settle',
      fallbackText: '',
      mode: 'final',
      asOf: '2026-03-18T10:00:00+01:00',
      currency: 'EUR',
      balances: [],
      transfers: [],
      totalSpent: { amountMinor: 234000, currency: 'EUR' },
    },
    shareable: true,
  };
}

export function recapCard(text: string, roastLines: readonly string[]): RecapCard {
  return {
    cardId: 'card_recap_1',
    type: 'recap',
    title: 'morning after, day 3',
    fallbackText: text,
    kind: 'morning_after',
    date: '2026-03-15',
    dayNumber: 3,
    lastNight: {
      events: [{ label: 'razzmatazz', attendees: ['dean', 'chase', 'piotr', 'arjun', 'crowley'] }],
      total: { amountMinor: 19900, currency: 'EUR' },
    },
    roastLines,
    settle: {
      cardId: 'card_settle_1',
      type: 'settle_up',
      title: 'running tab',
      fallbackText: '',
      mode: 'running',
      asOf: '2026-03-15T10:00:00+01:00',
      currency: 'EUR',
      balances: [],
      transfers: [],
      totalSpent: { amountMinor: 19900, currency: 'EUR' },
    },
    photos: [],
  };
}

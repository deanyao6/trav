import { describe, expect, it } from 'vitest';
import type { GroupSpendingPolicy, ReasonCode } from '../domain/approval.js';
import { DEFAULT_TAB_AUTO_CAP_MINOR, tabAutoCapOf } from '../domain/approval.js';
import type { BookingProposal } from '../domain/booking.js';
import { bookingParties, decidingRule, evaluate, POLICY_RULES } from './policy.js';
import {
  FIVE,
  NOW,
  context as baseContext,
  equalShares,
  member,
  policy,
  razzmatazz,
  views,
  barcelonaMembers,
} from './testkit.js';

const ALL_REASONS: readonly ReasonCode[] = [
  'requester_not_member',
  'requester_is_guest',
  'payer_not_member',
  'payer_inactive',
  'shares_do_not_sum',
  'empty_payers',
  'negative_or_zero_amount',
  'currency_mismatch',
  'over_hard_max',
  'duplicate',
  'minor_age_restricted',
  'quote_expired',
  'default_confirm',
  'over_auto_cap',
  'over_per_person_cap',
  'over_member_share_cap',
  'non_refundable',
  'over_daily_cap',
  'over_trip_cap',
  'kind_requires_each_payer',
  'minor_is_payer',
  'payer_not_requester',
  'card_not_requester',
  'minor_requester',
  'not_general_purpose',
  'over_tab_auto_cap',
  'requester_not_attendee',
  'within_all_caps',
];

/**
 * T-168: these tests read as the member's own explicit ask (`ask: 'explicit'`),
 * the tier where the caps decide. `noAsk` is a proposal with no qualifying ask.
 */
const context = (o: Partial<Parameters<typeof baseContext>[0]> = {}) =>
  baseContext({ ask: 'explicit', ...o });
const noAsk = baseContext;

/** A policy under which the Razzmatazz proposal auto-approves (cap raised). */
const relaxed = () =>
  policy({ autoApproveCapMinor: 20000, perPersonAutoCapMinor: 5000, dailyGroupCapMinor: 50000 });

describe('evaluate: defaults', () => {
  it('default policy (auto cap 0) ⇒ needs_confirmation with default_confirm as the deciding rule', () => {
    const d = evaluate(razzmatazz(), policy(), noAsk());
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.reasons).toEqual(['default_confirm']);
    expect(d.ruleIds).toEqual(['C1']);
    expect(decidingRule(d)).toEqual({ ruleId: 'C1', reason: 'default_confirm' });
    expect(d.approvalMode).toBe('any_one');
    // T-104: Henry is not on the booking, so he is not an approver.
    expect(d.requiredApprovers).toEqual([
      'mem_dean',
      'mem_crowley',
      'mem_ava',
      'mem_chase',
      'mem_leo',
    ]);
    expect(d.expiresAt).toBe('2026-03-14T21:55:00+01:00');
    expect(d.existingBookingId).toBeNull();
    expect(d.policySnapshot).toEqual(policy());
  });

  it('raised cap and everything inside it ⇒ auto_approve with within_all_caps (A1)', () => {
    const d = evaluate(razzmatazz(), relaxed(), context());
    expect(d.outcome).toBe('auto_approve');
    expect(d.reasons).toEqual(['within_all_caps']);
    expect(d.ruleIds).toEqual(['A1']);
    expect(d.approvalMode).toBe('none');
    expect(d.requiredApprovers).toEqual([]);
    expect(d.expiresAt).toBeNull();
  });

  it('is pure: same inputs, same decision; inputs untouched', () => {
    const p = razzmatazz();
    const pol = policy();
    const ctx = context();
    const a = evaluate(p, pol, ctx);
    const b = evaluate(p, pol, ctx);
    expect(a).toEqual(b);
    expect(p).toEqual(razzmatazz());
    expect(pol).toEqual(policy());
  });
});

describe('evaluate: cap boundaries (at the cap is inside the cap)', () => {
  const cases: readonly {
    name: string;
    cap: Partial<Parameters<typeof policy>[0]>;
    ctx?: Partial<Parameters<typeof context>[0]>;
    total: number;
    share: number;
    expectReason: ReasonCode | null;
  }[] = [
    {
      name: 'autoApproveCap exactly at cap',
      cap: { autoApproveCapMinor: 9000 },
      total: 9000,
      share: 1800,
      expectReason: null,
    },
    {
      name: 'autoApproveCap +1 minor unit',
      cap: { autoApproveCapMinor: 8999 },
      total: 9000,
      share: 1800,
      expectReason: 'over_auto_cap',
    },
    {
      name: 'perPerson exactly at cap',
      cap: { autoApproveCapMinor: 20000, perPersonAutoCapMinor: 1800 },
      total: 9000,
      share: 1800,
      expectReason: null,
    },
    {
      name: 'daily exactly at cap',
      cap: { autoApproveCapMinor: 20000, dailyGroupCapMinor: 10000 },
      ctx: { spentTodayMinor: 1000 },
      total: 9000,
      share: 1800,
      expectReason: null,
    },
    {
      name: 'daily +1 minor unit',
      cap: { autoApproveCapMinor: 20000, dailyGroupCapMinor: 9999 },
      ctx: { spentTodayMinor: 1000 },
      total: 9000,
      share: 1800,
      expectReason: 'over_daily_cap',
    },
    {
      name: 'trip exactly at cap',
      cap: { autoApproveCapMinor: 20000, tripGroupCapMinor: 59000 },
      ctx: { spentTripMinor: 50000 },
      total: 9000,
      share: 1800,
      expectReason: null,
    },
    {
      name: 'trip +1 minor unit',
      cap: { autoApproveCapMinor: 20000, tripGroupCapMinor: 58999 },
      ctx: { spentTripMinor: 50000 },
      total: 9000,
      share: 1800,
      expectReason: 'over_trip_cap',
    },
    {
      name: 'hard max exactly at cap (needs confirmation, not deny)',
      cap: { autoApproveCapMinor: 20000, hardMaxPerBookingMinor: 9000 },
      total: 9000,
      share: 1800,
      expectReason: null,
    },
    {
      name: 'hard max +1 minor unit',
      cap: { autoApproveCapMinor: 20000, hardMaxPerBookingMinor: 8999 },
      total: 9000,
      share: 1800,
      expectReason: 'over_hard_max',
    },
  ];

  it.each(cases)('$name', ({ cap, ctx, total, share, expectReason }) => {
    const p = razzmatazz({ totalMinor: total, payers: equalShares(FIVE, share) });
    const d = evaluate(p, policy(cap), context(ctx));
    if (expectReason === null) {
      expect(d.outcome).toBe('auto_approve');
      expect(d.reasons).toEqual(['within_all_caps']);
    } else {
      expect(d.reasons).toContain(expectReason);
      expect(d.outcome).toBe(expectReason === 'over_hard_max' ? 'deny' : 'needs_confirmation');
    }
  });

  it('member share cap: at cap passes, +1 fires over_member_share_cap with each_payer', () => {
    const prefs = {
      mem_crowley: {
        memberId: 'mem_crowley',
        perBookingShareCapMinor: 1800,
        dailyShareCapMinor: null,
      },
    };
    expect(evaluate(razzmatazz(), relaxed(), context({ prefs })).outcome).toBe('auto_approve');
    const tighter = {
      mem_crowley: {
        memberId: 'mem_crowley',
        perBookingShareCapMinor: 1799,
        dailyShareCapMinor: null,
      },
    };
    const d = evaluate(razzmatazz(), relaxed(), context({ prefs: tighter }));
    expect(d.reasons).toEqual(['over_member_share_cap']);
    expect(d.ruleIds).toEqual(['C4']);
    expect(d.approvalMode).toBe('each_payer');
    expect(d.requiredApprovers).toEqual([...FIVE]);
    const nullCap = {
      mem_crowley: {
        memberId: 'mem_crowley',
        perBookingShareCapMinor: null,
        dailyShareCapMinor: null,
      },
    };
    expect(evaluate(razzmatazz(), relaxed(), context({ prefs: nullCap })).outcome).toBe(
      'auto_approve',
    );
  });
});

describe('evaluate: deny rules (table)', () => {
  const minorPayers = () => ({
    payers: [...equalShares(FIVE, 1500), { memberId: 'mem_kid', shareMinor: 1500 }],
    attendees: [...FIVE, 'mem_kid'],
  });

  const cases: readonly {
    name: string;
    reason: ReasonCode;
    ruleId: string;
    proposal?: Partial<ReturnType<typeof razzmatazz>>;
    ctx?: Partial<Parameters<typeof context>[0]>;
    policy?: Partial<Parameters<typeof policy>[0]>;
  }[] = [
    {
      name: 'D1 requester not a member',
      reason: 'requester_not_member',
      ruleId: 'D1',
      proposal: { requestedBy: 'mem_nobody' },
    },
    {
      name: 'D1 requester inactive (left the group)',
      reason: 'requester_not_member',
      ruleId: 'D1',
      proposal: { requestedBy: 'mem_gone' },
    },
    {
      name: 'D2 requester is a guest',
      reason: 'requester_is_guest',
      ruleId: 'D2',
      proposal: { requestedBy: 'mem_stranger' },
    },
    {
      name: 'D3 payer not a member',
      reason: 'payer_not_member',
      ruleId: 'D3',
      proposal: {
        payers: [
          ...equalShares(FIVE.slice(0, 4), 1800),
          { memberId: 'mem_nobody', shareMinor: 1800 },
        ],
      },
    },
    {
      name: 'D3 payer is a guest',
      reason: 'payer_not_member',
      ruleId: 'D3',
      proposal: {
        payers: [
          ...equalShares(FIVE.slice(0, 4), 1800),
          { memberId: 'mem_stranger', shareMinor: 1800 },
        ],
      },
    },
    {
      name: 'D3 payer inactive',
      reason: 'payer_inactive',
      ruleId: 'D3',
      proposal: {
        payers: [
          ...equalShares(FIVE.slice(0, 4), 1800),
          { memberId: 'mem_gone', shareMinor: 1800 },
        ],
      },
    },
    {
      name: 'D4 empty payers',
      reason: 'empty_payers',
      ruleId: 'D4',
      proposal: { payers: [] },
    },
    {
      name: 'D5 shares do not sum',
      reason: 'shares_do_not_sum',
      ruleId: 'D5',
      proposal: { payers: equalShares(FIVE, 1799) },
    },
    {
      name: 'D5 duplicate payer rows that still sum to the total',
      reason: 'shares_do_not_sum',
      ruleId: 'D5',
      proposal: {
        payers: [
          ...equalShares(FIVE.slice(0, 4), 1800),
          { memberId: 'mem_dean', shareMinor: 1800 },
        ],
      },
    },
    {
      name: 'D5 negative share',
      reason: 'shares_do_not_sum',
      ruleId: 'D5',
      proposal: {
        payers: [...equalShares(FIVE.slice(0, 4), 2300), { memberId: 'mem_leo', shareMinor: -200 }],
      },
    },
    {
      name: 'D5 float share',
      reason: 'shares_do_not_sum',
      ruleId: 'D5',
      proposal: {
        totalMinor: 9000,
        payers: [
          ...equalShares(FIVE.slice(0, 3), 1800),
          { memberId: 'mem_chase', shareMinor: 1800.5 },
          { memberId: 'mem_leo', shareMinor: 1799.5 },
        ],
      },
    },
    {
      name: 'D5 zero total',
      reason: 'negative_or_zero_amount',
      ruleId: 'D5',
      proposal: { totalMinor: 0, payers: equalShares(FIVE, 0) },
    },
    {
      name: 'D5 negative total',
      reason: 'negative_or_zero_amount',
      ruleId: 'D5',
      proposal: { totalMinor: -9000, payers: equalShares(FIVE, -1800) },
    },
    {
      name: 'D5 float total (never floats for money)',
      reason: 'negative_or_zero_amount',
      ruleId: 'D5',
      proposal: { totalMinor: 90.0 + 0.5, payers: equalShares(FIVE, 18.1) },
    },
    {
      name: 'D6 currency mismatch',
      reason: 'currency_mismatch',
      ruleId: 'D6',
      proposal: { currency: 'USD' },
    },
    {
      name: 'D7 over hard max',
      reason: 'over_hard_max',
      ruleId: 'D7',
      proposal: {
        totalMinor: 500001,
        payers: equalShares(['mem_dean'], 500001),
        attendees: ['mem_dean'],
      },
    },
    {
      name: 'D8 duplicate idempotency key',
      reason: 'duplicate',
      ruleId: 'D8',
      ctx: { existingBookingForKey: 'bk_existing' },
    },
    {
      name: 'D9 minor payer on an age-restricted item',
      reason: 'minor_age_restricted',
      ruleId: 'D9',
      proposal: minorPayers(),
    },
    {
      name: 'D9 minor attendee only (guardian pays) on an age-restricted item',
      reason: 'minor_age_restricted',
      ruleId: 'D9',
      proposal: { attendees: [...FIVE, 'mem_kid'] },
    },
    {
      name: 'D9 minor attendee with 18+ tag and no ageRestriction',
      reason: 'minor_age_restricted',
      ruleId: 'D9',
      proposal: { ageRestriction: null, contentTags: ['18+'], attendees: [...FIVE, 'mem_kid'] },
    },
    {
      name: 'D9 minor attendee on a nightlife-tagged item with no explicit age tag',
      reason: 'minor_age_restricted',
      ruleId: 'D9',
      proposal: {
        ageRestriction: null,
        contentTags: ['nightlife'],
        attendees: [...FIVE, 'mem_kid'],
      },
    },
    {
      name: 'D10 quote older than 15 minutes',
      reason: 'quote_expired',
      ruleId: 'D10',
      proposal: { quotedAt: '2026-03-14T21:24:59+01:00' },
    },
    {
      name: 'D10 provider hold already expired',
      reason: 'quote_expired',
      ruleId: 'D10',
      proposal: { holdExpiresAt: '2026-03-14T21:40:00+01:00' },
    },
  ];

  it.each(cases)('$name', ({ reason, ruleId, proposal: pOverrides, ctx, policy: polOverrides }) => {
    const d = evaluate(razzmatazz(pOverrides), relaxed(), context(ctx));
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toContain(reason);
    const idx = d.reasons.indexOf(reason);
    expect(d.ruleIds[idx]).toBe(ruleId);
    expect(d.approvalMode).toBe('none');
    expect(d.requiredApprovers).toEqual([]);
    expect(d.expiresAt).toBeNull();
    expect(polOverrides).toBeUndefined();
  });

  it('duplicate carries the existing booking id', () => {
    const d = evaluate(razzmatazz(), policy(), noAsk({ existingBookingForKey: 'bk_1' }));
    expect(d.reasons).toEqual(['duplicate', 'default_confirm']);
    expect(d.existingBookingId).toBe('bk_1');
    expect(decidingRule(d)).toEqual({ ruleId: 'D8', reason: 'duplicate' });
  });

  it('quote exactly 15 minutes old is still fresh; hold expiring later than now is fine', () => {
    const fresh = evaluate(
      razzmatazz({
        quotedAt: '2026-03-14T21:25:00+01:00',
        holdExpiresAt: '2026-03-14T21:40:01+01:00',
      }),
      relaxed(),
      context(),
    );
    expect(fresh.outcome).toBe('auto_approve');
  });

  it('deny rules decide before confirmation triggers, and every rule still runs', () => {
    const d = evaluate(
      razzmatazz({ requestedBy: 'mem_stranger', refundable: false, kind: 'flight' }),
      policy(),
      noAsk(),
    );
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toEqual([
      'requester_is_guest',
      'default_confirm',
      'kind_requires_each_payer',
      'non_refundable',
      'card_not_requester',
    ]);
    expect(d.ruleIds).toEqual(['D2', 'C1', 'C2', 'C5', 'C10']);
    expect(decidingRule(d)?.ruleId).toBe('D2');
  });

  it('empty payers also reports shares_do_not_sum (0 ≠ total) with empty_payers deciding', () => {
    const d = evaluate(razzmatazz({ payers: [] }), relaxed(), context());
    expect(d.reasons).toEqual(['empty_payers', 'shares_do_not_sum']);
    expect(decidingRule(d)?.reason).toBe('empty_payers');
  });
});

describe('evaluate: confirmation triggers (table)', () => {
  const cases: readonly {
    name: string;
    reason: ReasonCode;
    ruleId: string;
    mode: 'any_one' | 'each_payer';
    proposal?: Partial<ReturnType<typeof razzmatazz>>;
    ctx?: Partial<Parameters<typeof context>[0]>;
    policy?: Partial<Parameters<typeof policy>[0]>;
  }[] = [
    {
      name: 'C1 default cap 0',
      reason: 'default_confirm',
      ruleId: 'C1',
      mode: 'any_one',
      policy: { autoApproveCapMinor: 0 },
    },
    {
      name: 'C1 raised cap exceeded',
      reason: 'over_auto_cap',
      ruleId: 'C1',
      mode: 'any_one',
      policy: { autoApproveCapMinor: 100 },
    },
    {
      name: 'C4 share over member pref cap',
      reason: 'over_member_share_cap',
      ruleId: 'C4',
      mode: 'each_payer',
      ctx: {
        prefs: {
          mem_ava: { memberId: 'mem_ava', perBookingShareCapMinor: 500, dailyShareCapMinor: null },
        },
      },
    },
    {
      name: 'C5 non-refundable over €200',
      reason: 'non_refundable',
      ruleId: 'C5',
      mode: 'any_one',
      proposal: {
        refundable: false,
        totalMinor: 20001,
        payers: [{ memberId: 'mem_dean', shareMinor: 20001 }],
      },
      policy: { autoApproveCapMinor: 50000 },
    },
    {
      name: 'C6 daily cap',
      reason: 'over_daily_cap',
      ruleId: 'C6',
      mode: 'any_one',
      ctx: { spentTodayMinor: 45000 },
    },
    {
      name: 'C7 trip cap',
      reason: 'over_trip_cap',
      ruleId: 'C7',
      mode: 'any_one',
      policy: { tripGroupCapMinor: 100000 },
      ctx: { spentTripMinor: 95000 },
    },
    {
      name: 'C8 minor payer (not age restricted)',
      reason: 'minor_is_payer',
      ruleId: 'C8',
      mode: 'any_one',
      proposal: {
        ageRestriction: null,
        contentTags: ['family'],
        payers: [...equalShares(FIVE, 1500), { memberId: 'mem_kid', shareMinor: 1500 }],
        attendees: [...FIVE, 'mem_kid'],
      },
    },
    {
      name: 'C9 per-person cards charge someone other than the requester',
      reason: 'payer_not_requester',
      ruleId: 'C9',
      mode: 'each_payer',
      proposal: { paidBy: { kind: 'per_person_cards' } },
    },
  ];

  it.each(cases)(
    '$name',
    ({ reason, ruleId, mode, proposal: pOverrides, ctx, policy: polOverrides }) => {
      const d = evaluate(razzmatazz(pOverrides), relaxed(polOverrides), context(ctx));
      expect(d.outcome).toBe('needs_confirmation');
      expect(d.reasons).toEqual([reason]);
      expect(d.ruleIds).toEqual([ruleId]);
      expect(d.approvalMode).toBe(mode);
      expect(d.requiredApprovers.length).toBeGreaterThan(0);
      expect(d.expiresAt).toBe('2026-03-14T21:55:00+01:00');
      expect(decidingRule(d)).toEqual({ ruleId, reason });
    },
  );

  function relaxed(overrides: Partial<Parameters<typeof policy>[0]> = {}) {
    return policy({ autoApproveCapMinor: 20000, ...overrides });
  }

  it('non-refundable over €200 never auto-approves on an ask, even with a generous cap (A7, T-168 c)', () => {
    const d = evaluate(
      razzmatazz({
        refundable: false,
        totalMinor: 20001,
        payers: [{ memberId: 'mem_dean', shareMinor: 20001 }],
      }),
      policy({ autoApproveCapMinor: 1_000_000 }),
      context(),
    );
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.reasons).toEqual(['non_refundable']);
    // With no ask, non-refundable at any price keeps the card and says why.
    const card = evaluate(razzmatazz({ refundable: false }), policy(), noAsk());
    expect(card.reasons).toEqual(['default_confirm', 'non_refundable']);
  });

  it('per-person cards paid only by the requester do not fire C9', () => {
    const d = evaluate(
      razzmatazz({
        paidBy: { kind: 'per_person_cards' },
        payers: equalShares(['mem_dean'], 9000),
        attendees: ['mem_dean'],
      }),
      relaxed({ perPersonAutoCapMinor: 9000 }),
      context(),
    );
    expect(d.outcome).toBe('auto_approve');
  });

  it('strongest mode wins: non_refundable (any_one) + per-person cap (each_payer) ⇒ each_payer', () => {
    const d = evaluate(
      razzmatazz({ refundable: false }),
      relaxed({ perPersonAutoCapMinor: 1000 }),
      noAsk(),
    );
    expect(d.reasons).toEqual(['default_confirm', 'over_per_person_cap', 'non_refundable']);
    expect(d.approvalMode).toBe('each_payer');
    expect(d.requiredApprovers).toEqual([...FIVE]);
  });

  it('expiry is capped by a shorter provider hold', () => {
    const d = evaluate(
      razzmatazz({ holdExpiresAt: '2026-03-14T21:50:00+01:00' }),
      policy(),
      noAsk(),
    );
    expect(d.expiresAt).toBe('2026-03-14T21:50:00+01:00');
    const longer = evaluate(
      razzmatazz({ holdExpiresAt: '2026-03-14T23:00:00+01:00' }),
      policy(),
      noAsk(),
    );
    expect(longer.expiresAt).toBe('2026-03-14T21:55:00+01:00');
  });

  it('custom TTL moves expiresAt', () => {
    const d = evaluate(razzmatazz(), policy({ approvalTtlSeconds: 90 }), noAsk());
    expect(d.expiresAt).toBe('2026-03-14T21:41:30+01:00');
  });
});

describe('evaluate: required approvers', () => {
  it('any_one: adult, active, non-guest members; minors, guests and left members excluded', () => {
    const d = evaluate(razzmatazz(), policy(), noAsk());
    expect(d.requiredApprovers).not.toContain('mem_kid');
    expect(d.requiredApprovers).not.toContain('mem_stranger');
    expect(d.requiredApprovers).not.toContain('mem_gone');
  });

  it('any_one with a named approver list: the list, plus the requester (one-tap)', () => {
    const d = evaluate(
      // Leo's own card (on Dean's card, C10 would make Dean the only approver).
      razzmatazz({ requestedBy: 'mem_leo', paidBy: { kind: 'member_card', memberId: 'mem_leo' } }),
      policy({ approvers: ['mem_dean', 'mem_kid', 'mem_stranger', 'mem_nobody'] }),
      noAsk(),
    );
    expect(d.requiredApprovers).toEqual(['mem_dean', 'mem_leo']);
  });

  it('any_one with a minor requester: the minor is not added', () => {
    const d = evaluate(
      razzmatazz({
        requestedBy: 'mem_kid',
        ageRestriction: null,
        contentTags: ['family'],
        payers: equalShares(['mem_dean'], 9000),
        attendees: ['mem_dean', 'mem_kid'],
      }),
      policy({ approvers: ['mem_dean'] }),
      noAsk(),
    );
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.requiredApprovers).toEqual(['mem_dean']);
  });

  it('any_one (T-104): a member not on the booking (Henry, out tonight) is never an approver', () => {
    const d = evaluate(razzmatazz(), policy(), noAsk());
    expect(d.approvalMode).toBe('any_one');
    expect(d.requiredApprovers).not.toContain('mem_henry');
    expect(d.requiredApprovers).toEqual([...FIVE]);
    // A named approver who is not attending is dropped too; the attending requester stays.
    const named = evaluate(
      razzmatazz({
        requestedBy: 'mem_crowley',
        paidBy: { kind: 'member_card', memberId: 'mem_crowley' },
      }),
      policy({ approvers: ['mem_henry', 'mem_dean'] }),
      noAsk(),
    );
    expect(named.requiredApprovers).toEqual(['mem_dean', 'mem_crowley']);
  });

  it('any_one (T-104): the payer approves when attending; a non-attending requester does not', () => {
    const d = evaluate(
      razzmatazz({
        requestedBy: 'mem_henry',
        payers: equalShares(['mem_dean', 'mem_crowley'], 4500),
        attendees: ['mem_dean', 'mem_crowley'],
        paidBy: { kind: 'member_card', memberId: 'mem_crowley' },
      }),
      policy({ approvers: ['mem_dean', 'mem_henry'] }),
      noAsk(),
    );
    // C10: Henry asks on Crowley's card, so Crowley (the card owner) is the one approver.
    expect(d.requiredApprovers).toEqual(['mem_crowley']);
    const own = evaluate(
      razzmatazz({
        requestedBy: 'mem_henry',
        payers: equalShares(['mem_dean', 'mem_crowley'], 4500),
        attendees: ['mem_dean', 'mem_crowley'],
        paidBy: { kind: 'member_card', memberId: 'mem_henry' },
      }),
      policy({ approvers: ['mem_dean', 'mem_crowley'] }),
      noAsk(),
    );
    // On Henry's own card he is a party (card owner) and the pool's attendees stay.
    expect(own.requiredApprovers).toEqual(['mem_dean', 'mem_crowley', 'mem_henry']);
  });

  it("any_one (T-104): kid-only booking on Dean's card ⇒ Dean (card owner, Kid's guardian); a non-party requester is not added", () => {
    const d = evaluate(
      razzmatazz({
        ageRestriction: null,
        contentTags: ['family'],
        requestedBy: 'mem_crowley',
        totalMinor: 1800,
        payers: equalShares(['mem_dean'], 1800),
        attendees: ['mem_kid'],
      }),
      policy(),
      noAsk(),
    );
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.approvalMode).toBe('any_one');
    expect(d.requiredApprovers).toEqual(['mem_dean']);
  });

  describe('any_one (T-104 round 2): parties, guardians, named approvers', () => {
    // Turks and Caicos shape: Mom, Dad (Lily's guardian), Lily (14), plus Uncle.
    const tci = () =>
      views([
        member('mem_mom', { role: 'lead' }),
        member('mem_dad', { role: 'guardian' }),
        member('mem_uncle'),
        member('mem_lily', { ageBand: 'under18', guardianMemberId: 'mem_dad' }),
      ]);
    const snorkel = (overrides: Parameters<typeof razzmatazz>[0] = {}) =>
      razzmatazz({
        currency: 'EUR',
        ageRestriction: null,
        contentTags: ['family'],
        totalMinor: 4500,
        payers: equalShares(['mem_lily'], 4500),
        attendees: ['mem_lily'],
        ...overrides,
      });

    it("Lily's own request on her own card (minor requester, payer, attendee) ⇒ her guardian Dad, never empty", () => {
      const d = evaluate(
        snorkel({ requestedBy: 'mem_lily', paidBy: { kind: 'member_card', memberId: 'mem_lily' } }),
        policy(),
        noAsk({ members: tci() }),
      );
      expect(d.outcome).toBe('needs_confirmation');
      expect(d.approvalMode).toBe('any_one');
      expect(d.requiredApprovers).toEqual(['mem_dad']);
    });

    it("Mom asks for Lily on Mom's card ⇒ Mom (requester, card) and Dad (guardian); Uncle is not a party", () => {
      const d = evaluate(
        snorkel({ requestedBy: 'mem_mom', paidBy: { kind: 'member_card', memberId: 'mem_mom' } }),
        policy(),
        noAsk({ members: tci() }),
      );
      expect(d.requiredApprovers).toEqual(['mem_mom', 'mem_dad']);
    });

    it('a minor attendee with no guardian and no adult party ⇒ the pool stands in (never empty)', () => {
      const members = views([
        member('mem_mom'),
        member('mem_uncle'),
        member('mem_lily', { ageBand: 'under18' }),
      ]);
      const d = evaluate(
        snorkel({ requestedBy: 'mem_lily', paidBy: { kind: 'member_card', memberId: 'mem_lily' } }),
        policy(),
        noAsk({ members }),
      );
      expect(d.requiredApprovers).toEqual(['mem_mom', 'mem_uncle']);
    });

    it("named approvers ['mem_dean'] and a non-party requester (Chase): Chase can never approve alone", () => {
      // Dean's card: Dean is the card owner, so he is the party in the pool.
      const onDean = evaluate(
        razzmatazz({
          requestedBy: 'mem_chase',
          payers: equalShares(['mem_crowley', 'mem_leo'], 4500),
          attendees: ['mem_crowley', 'mem_leo'],
        }),
        policy({ approvers: ['mem_dean'] }),
        noAsk(),
      );
      expect(onDean.requiredApprovers).toEqual(['mem_dean']);
      // Crowley's card, Dean not on it: no party is in the pool, so the pool (Dean) stands in, not Chase.
      const onCrowley = evaluate(
        razzmatazz({
          requestedBy: 'mem_chase',
          payers: equalShares(['mem_crowley', 'mem_leo'], 4500),
          attendees: ['mem_crowley', 'mem_leo'],
          paidBy: { kind: 'member_card', memberId: 'mem_crowley' },
        }),
        policy({ approvers: ['mem_dean'] }),
        noAsk(),
      );
      // C10 (T-148): Crowley's card, Chase asking ⇒ Crowley, the card owner, is the one approver.
      expect(onCrowley.requiredApprovers).toEqual(['mem_crowley']);
      expect(onCrowley.reasons).toContain('card_not_requester');
      expect(onCrowley.requiredApprovers).not.toContain('mem_chase');
    });

    it('Henry asks for "the 5 of us, Henry\'s sick" on his own card ⇒ he can confirm his own request', () => {
      const d = evaluate(
        razzmatazz({
          requestedBy: 'mem_henry',
          paidBy: { kind: 'member_card', memberId: 'mem_henry' },
        }),
        policy(),
        noAsk(),
      );
      expect(d.requiredApprovers).toContain('mem_henry');
      expect(d.requiredApprovers).toEqual([...FIVE, 'mem_henry']);
    });

    it("bookingParties: attendees, the card owner(s) and minor attendees' guardians, nobody else", () => {
      const byId = new Map(views().map((v) => [v.memberId, v] as const));
      const p = razzmatazz({
        attendees: ['mem_crowley', 'mem_kid'],
        paidBy: { kind: 'member_card', memberId: 'mem_leo' },
      });
      expect([...bookingParties(p, byId)].sort()).toEqual(
        ['mem_dean', 'mem_kid', 'mem_leo', 'mem_crowley'].sort(),
      );
      const perCard = razzmatazz({
        attendees: ['mem_crowley'],
        payers: equalShares(['mem_crowley', 'mem_ava'], 4500),
        paidBy: { kind: 'per_person_cards' },
      });
      expect([...bookingParties(perCard, byId)].sort()).toEqual(['mem_ava', 'mem_crowley']);
    });

    it("Henry asks for the 5 of us on Dean's card ⇒ only Dean, the card owner, approves (C10)", () => {
      const d = evaluate(razzmatazz({ requestedBy: 'mem_henry' }), policy(), noAsk());
      expect(d.requiredApprovers).toEqual(['mem_dean']);
      expect(d.reasons).toEqual(['default_confirm', 'card_not_requester']);
    });

    it('needs_confirmation never has an empty approver list while the group has an adult (exhaustive)', () => {
      const groups = [views(), tci()];
      let checked = 0;
      for (const members of groups) {
        const ids = members.map((m) => m.memberId);
        const adults = members.filter((m) => m.role === 'member' && m.active && !m.isMinor);
        const approverLists: GroupSpendingPolicy['approvers'][] = [
          'any_adult_member',
          [adults[0]!.memberId],
          [adults[1]!.memberId],
          ['mem_nobody'],
        ];
        for (const requestedBy of ids) {
          for (const attendee of ids) {
            for (const cardOwner of ids) {
              for (const approvers of approverLists) {
                for (const kind of ['ticket', 'lodging'] as const) {
                  const d = evaluate(
                    razzmatazz({
                      kind,
                      ageRestriction: null,
                      contentTags: ['family'],
                      requestedBy,
                      totalMinor: 1800,
                      payers: equalShares([attendee], 1800),
                      attendees: [attendee],
                      paidBy: { kind: 'member_card', memberId: cardOwner },
                    }),
                    policy({ approvers }),
                    noAsk({ members }),
                  );
                  if (d.outcome !== 'needs_confirmation') continue;
                  checked += 1;
                  expect(d.requiredApprovers.length).toBeGreaterThan(0);
                  // and only adults who can approve are ever listed
                  for (const id of d.requiredApprovers) {
                    expect(adults.map((m) => m.memberId)).toContain(id);
                  }
                }
              }
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(100);
    });
  });

  it('each_payer (T-104 leaves it unchanged): a non-attending adult payer must still 👍', () => {
    const d = evaluate(
      razzmatazz({
        kind: 'flight',
        paidBy: { kind: 'per_person_cards' },
        payers: [
          { memberId: 'mem_dean', shareMinor: 4500 },
          { memberId: 'mem_henry', shareMinor: 4500 },
        ],
        attendees: ['mem_dean', 'mem_crowley'],
      }),
      policy(),
      noAsk(),
    );
    expect(d.approvalMode).toBe('each_payer');
    expect(d.requiredApprovers).toEqual(['mem_dean', 'mem_henry']);
  });

  it('each_payer: every adult payer, in payer order, deduplicated', () => {
    const d = evaluate(
      razzmatazz({ kind: 'flight', paidBy: { kind: 'per_person_cards' } }),
      policy(),
      noAsk(),
    );
    expect(d.approvalMode).toBe('each_payer');
    expect(d.requiredApprovers).toEqual([...FIVE]);
  });

  it('each_payer with a minor payer: the guardian stands in (and is not listed twice)', () => {
    const d = evaluate(
      razzmatazz({
        kind: 'lodging',
        ageRestriction: null,
        contentTags: ['family'],
        payers: [
          { memberId: 'mem_dean', shareMinor: 4500 },
          { memberId: 'mem_kid', shareMinor: 4500 },
        ],
        attendees: ['mem_dean', 'mem_kid'],
      }),
      policy(),
      noAsk(),
    );
    expect(d.reasons).toEqual(['default_confirm', 'kind_requires_each_payer', 'minor_is_payer']);
    expect(d.requiredApprovers).toEqual(['mem_dean']);
  });

  it('each_payer with a minor payer and no guardian: the requester stands in, else the first eligible approver', () => {
    const members = barcelonaMembers().map((m) =>
      m.memberId === 'mem_kid' ? member('mem_kid', { ageBand: 'under18' }) : m,
    );
    const p = razzmatazz({
      kind: 'lodging',
      ageRestriction: null,
      contentTags: ['family'],
      requestedBy: 'mem_crowley',
      paidBy: { kind: 'member_card', memberId: 'mem_crowley' },
      payers: [
        { memberId: 'mem_kid', shareMinor: 4500 },
        { memberId: 'mem_leo', shareMinor: 4500 },
      ],
      attendees: ['mem_kid', 'mem_leo'],
    });
    const viaRequester = evaluate(p, policy(), noAsk({ members: views(members) }));
    expect(viaRequester.requiredApprovers).toEqual(['mem_crowley', 'mem_leo']);

    const viaPool = evaluate(
      { ...p, requestedBy: 'mem_stranger' },
      policy({ approvers: ['mem_ava'] }),
      noAsk({ members: views(members) }),
    );
    expect(viaPool.outcome).toBe('deny'); // guest requester; approvers still computed deterministically
    expect(viaPool.requiredApprovers).toEqual([]);
  });

  it('each_payer with a minor payer and no eligible adult at all yields an empty list (can never complete)', () => {
    const members = [
      member('mem_kid', { ageBand: 'under18' }),
      member('mem_teen', { ageBand: 'under18' }),
    ];
    const d = evaluate(
      razzmatazz({
        kind: 'lodging',
        ageRestriction: null,
        contentTags: ['family'],
        requestedBy: 'mem_teen',
        payers: [{ memberId: 'mem_kid', shareMinor: 9000 }],
        attendees: ['mem_kid'],
      }),
      policy(),
      noAsk({ members: views(members) }),
    );
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.requiredApprovers).toEqual([]);
  });
});

describe('evaluate: C10 card owner must approve (T-148, D-030)', () => {
  /** Every cap raised as far as it goes: nothing but C10 can fire. */
  const wideOpen = (overrides: Partial<GroupSpendingPolicy> = {}) =>
    policy({
      autoApproveCapMinor: 10000,
      perPersonAutoCapMinor: 10000,
      dailyGroupCapMinor: 100000,
      tripGroupCapMinor: null,
      ...overrides,
    });
  const kidAsk = (overrides: Parameters<typeof razzmatazz>[0] = {}) =>
    razzmatazz({
      requestedBy: 'mem_kid',
      ageRestriction: null,
      contentTags: ['family'],
      totalMinor: 1500,
      payers: equalShares(['mem_dean'], 1500),
      attendees: ['mem_kid'],
      paidBy: { kind: 'member_card', memberId: 'mem_dean' },
      ...overrides,
    });

  it("the review repro: a minor's 15.00 ask on her guardian's card under a 100.00 auto cap ⇒ needs_confirmation, guardian approves", () => {
    const d = evaluate(kidAsk(), wideOpen(), context());
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.reasons).toEqual(['card_not_requester', 'minor_requester']);
    expect(d.ruleIds).toEqual(['C10', 'C10']);
    expect(d.approvalMode).toBe('any_one');
    expect(d.requiredApprovers).toEqual(['mem_dean']);
  });

  it("a minor's ask is needs_confirmation under every cap setting and every card, never approved by the minor", () => {
    const caps = [0, 1, 1499, 1500, 1501, 10000, 1_000_000];
    const cards: BookingProposal['paidBy'][] = [
      { kind: 'member_card', memberId: 'mem_dean' }, // guardian
      { kind: 'member_card', memberId: 'mem_crowley' }, // another adult
      { kind: 'member_card', memberId: 'mem_kid' }, // her own
      { kind: 'per_person_cards' },
    ];
    let checked = 0;
    for (const auto of caps) {
      for (const perPerson of caps) {
        for (const daily of caps) {
          for (const paidBy of cards) {
            for (const trip of [null, 1_000_000] as const) {
              const d = evaluate(
                kidAsk({ paidBy }),
                policy({
                  autoApproveCapMinor: auto,
                  perPersonAutoCapMinor: perPerson,
                  dailyGroupCapMinor: daily,
                  tripGroupCapMinor: trip,
                  hardMaxPerBookingMinor: 2_000_000,
                }),
                context(),
              );
              checked += 1;
              expect(d.outcome).toBe('needs_confirmation');
              expect(d.reasons).toContain('minor_requester');
              expect(d.requiredApprovers).not.toContain('mem_kid');
              expect(d.requiredApprovers.length).toBeGreaterThan(0);
              const owner =
                paidBy.kind === 'per_person_cards' || paidBy.memberId === 'mem_kid'
                  ? 'mem_dean'
                  : paidBy.memberId;
              expect(d.requiredApprovers).toContain(owner);
              if (d.approvalMode === 'any_one') expect(d.requiredApprovers).toEqual([owner]);
            }
          }
        }
      }
    }
    expect(checked).toBe(7 * 7 * 7 * 4 * 2);
  });

  it("a minor's ask on another adult's card: that adult approves, not the guardian", () => {
    const d = evaluate(
      kidAsk({ paidBy: { kind: 'member_card', memberId: 'mem_crowley' } }),
      wideOpen(),
      context(),
    );
    expect(d.requiredApprovers).toEqual(['mem_crowley']);
  });

  it("a minor's ask on her own card: her guardian stands in for the card owner", () => {
    const d = evaluate(
      kidAsk({
        payers: equalShares(['mem_kid'], 1500),
        paidBy: { kind: 'member_card', memberId: 'mem_kid' },
      }),
      wideOpen(),
      context(),
    );
    expect(d.reasons).toEqual(['minor_is_payer', 'minor_requester']);
    expect(d.requiredApprovers).toEqual(['mem_dean']);
  });

  it("a minor's ask on per-person cards is each_payer: every adult payer must 👍", () => {
    const d = evaluate(
      kidAsk({
        payers: equalShares(['mem_dean', 'mem_crowley'], 750),
        attendees: ['mem_kid', 'mem_crowley'],
        paidBy: { kind: 'per_person_cards' },
      }),
      wideOpen(),
      context(),
    );
    expect(d.approvalMode).toBe('each_payer');
    expect(d.requiredApprovers).toEqual(['mem_dean', 'mem_crowley']);
  });

  it("an adult asking on another adult's card never auto-approves; exactly at the cap is still held", () => {
    const p = razzmatazz({ requestedBy: 'mem_crowley' }); // Dean's card, €90, €18 each
    const d = evaluate(
      p,
      wideOpen({ autoApproveCapMinor: 9000, perPersonAutoCapMinor: 1800 }),
      context(),
    );
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.reasons).toEqual(['card_not_requester']);
    expect(d.requiredApprovers).toEqual(['mem_dean']);
    // the same ask on Crowley's own card, exactly at the caps, auto-approves
    const own = evaluate(
      { ...p, paidBy: { kind: 'member_card', memberId: 'mem_crowley' } },
      wideOpen({ autoApproveCapMinor: 9000, perPersonAutoCapMinor: 1800 }),
      context(),
    );
    expect(own.outcome).toBe('auto_approve');
  });

  it('under each_payer the card owner is added to the payers (not replacing them)', () => {
    const d = evaluate(
      razzmatazz({
        kind: 'flight',
        requestedBy: 'mem_crowley',
        payers: equalShares(['mem_crowley', 'mem_ava'], 4500),
        attendees: ['mem_crowley', 'mem_ava'],
      }),
      wideOpen(),
      context(),
    );
    expect(d.approvalMode).toBe('each_payer');
    expect(d.requiredApprovers).toEqual(['mem_crowley', 'mem_ava', 'mem_dean']);
  });

  it('a card owner who is not a member leaves the any_one parties (never empty, never auto)', () => {
    const d = evaluate(
      razzmatazz({
        requestedBy: 'mem_crowley',
        paidBy: { kind: 'member_card', memberId: 'mem_nobody' },
      }),
      wideOpen({ autoApproveCapMinor: 20000 }),
      context(),
    );
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.requiredApprovers.length).toBeGreaterThan(0);
  });
});

describe('POLICY_RULES', () => {
  it('covers every ReasonCode exactly once', () => {
    const covered = POLICY_RULES.flatMap((r) => r.reasons);
    expect([...covered].sort()).toEqual([...ALL_REASONS].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('every ReasonCode is reachable from evaluate (fired by at least one test scenario)', () => {
    const fired = new Set<ReasonCode>();
    const run = (
      pOverrides: Partial<ReturnType<typeof razzmatazz>> = {},
      polOverrides: Partial<Parameters<typeof policy>[0]> = {},
      ctxOverrides: Partial<Parameters<typeof context>[0]> = {},
    ) =>
      evaluate(razzmatazz(pOverrides), policy(polOverrides), context(ctxOverrides)).reasons.forEach(
        (r) => fired.add(r),
      );
    run({ requestedBy: 'mem_nobody' });
    run({ requestedBy: 'mem_stranger' });
    run({ payers: [{ memberId: 'mem_nobody', shareMinor: 9000 }] });
    run({ payers: [{ memberId: 'mem_gone', shareMinor: 9000 }] });
    run({ payers: [] });
    run({ totalMinor: 0, payers: [] });
    run({ currency: 'USD' });
    run({ totalMinor: 999999, payers: equalShares(['mem_dean'], 999999) });
    run({}, {}, { existingBookingForKey: 'bk_x' });
    run({ attendees: [...FIVE, 'mem_kid'] });
    run({ quotedAt: '2026-03-14T20:00:00+01:00' });
    run({}, { autoApproveCapMinor: 0 });
    run({}, { autoApproveCapMinor: 1 });
    run({ kind: 'flight' });
    evaluate(razzmatazz(), policy({ perPersonAutoCapMinor: 1 }), noAsk()).reasons.forEach((r) =>
      fired.add(r),
    );
    run(
      {},
      {},
      {
        prefs: {
          mem_dean: { memberId: 'mem_dean', perBookingShareCapMinor: 1, dailyShareCapMinor: null },
        },
      },
    );
    run({
      refundable: false,
      totalMinor: 20001,
      payers: [{ memberId: 'mem_dean', shareMinor: 20001 }],
    });
    run({}, {}, { spentTodayMinor: 50000 });
    run({}, { tripGroupCapMinor: 1 });
    run({
      ageRestriction: null,
      contentTags: [],
      payers: [{ memberId: 'mem_kid', shareMinor: 9000 }],
      attendees: ['mem_kid'],
    });
    run({ paidBy: { kind: 'per_person_cards' } });
    run({ requestedBy: 'mem_crowley' });
    run({
      requestedBy: 'mem_kid',
      ageRestriction: null,
      contentTags: [],
      payers: [{ memberId: 'mem_dean', shareMinor: 9000 }],
      attendees: ['mem_kid'],
    });
    run({}, { autoApproveCapMinor: 20000 });
    run({}, { perPersonTabAutoCapMinor: 1000 });
    run({ requestedBy: 'mem_henry' });
    expect([...fired].sort()).toEqual([...ALL_REASONS].sort());
  });
});

describe('evaluate: input validation', () => {
  it('throws on a malformed quotedAt (invalid input, not a decision)', () => {
    expect(() => evaluate(razzmatazz({ quotedAt: 'yesterday' }), policy(), noAsk())).toThrow(
      /ISO-8601/,
    );
  });

  it('now is taken from the context, never the wall clock', () => {
    const later = evaluate(razzmatazz(), policy(), noAsk({ now: '2026-03-14T22:30:00+01:00' }));
    expect(later.reasons).toContain('quote_expired');
    expect(NOW).toBe('2026-03-14T21:40:00+01:00');
  });
});

describe('T-168 approval tiers (D-044)', () => {
  const nonRef = (totalMinor: number) =>
    razzmatazz({
      refundable: false,
      totalMinor,
      payers: [{ memberId: 'mem_dean', shareMinor: totalMinor }],
      attendees: ['mem_dean'],
    });
  const ticket = (totalMinor: number) =>
    razzmatazz({
      totalMinor,
      payers: [{ memberId: 'mem_dean', shareMinor: totalMinor }],
      attendees: ['mem_dean'],
    });

  it('the default policy is €500 auto-buy on (DEFAULT_AUTO_BUY_CAP_MINOR)', () => {
    expect(policy().autoApproveCapMinor).toBe(50000);
  });

  describe('(a) an explicit ask, general-purpose, under the cap: auto-approve', () => {
    it('the flagship €90 Razzmatazz ask auto-approves under the default policy', () => {
      const d = evaluate(razzmatazz(), policy(), context({ ask: 'explicit' }));
      expect(d.outcome).toBe('auto_approve');
      expect(d.reasons).toEqual(['within_all_caps']);
    });

    it('the same proposal with no ask is a card, whatever the cap', () => {
      for (const cap of [0, 9000, 50000, 1_000_000]) {
        const d = evaluate(razzmatazz(), policy({ autoApproveCapMinor: cap }), noAsk());
        expect(d.outcome).toBe('needs_confirmation');
        expect(d.reasons[0]).toBe('default_confirm');
      }
    });

    it('cap boundary: exactly at the cap auto-approves, one cent over is over_auto_cap', () => {
      expect(evaluate(ticket(50000), policy(), context()).outcome).toBe('auto_approve');
      const over = evaluate(ticket(50001), policy(), context());
      expect(over.outcome).toBe('needs_confirmation');
      expect(over.reasons[0]).toBe('over_auto_cap');
      expect(over.ruleIds[0]).toBe('C1');
    });

    it('auto-buy off (cap 0) ⇒ an explicit ask is the ordinary card, with the per-person rule', () => {
      const d = evaluate(
        razzmatazz(),
        policy({ autoApproveCapMinor: 0, perPersonAutoCapMinor: 1000 }),
        context(),
      );
      expect(d.reasons).toEqual(['default_confirm', 'over_per_person_cap']);
      expect(d.approvalMode).toBe('each_payer');
    });

    it('over the cap ⇒ the pre-T-168 card rules apply (per-person cap, any non-refundable)', () => {
      const d = evaluate(
        razzmatazz({ refundable: false }),
        policy({ autoApproveCapMinor: 8000, perPersonAutoCapMinor: 1000 }),
        context(),
      );
      expect(d.reasons).toEqual(['over_auto_cap', 'over_per_person_cap', 'non_refundable']);
      expect(d.approvalMode).toBe('each_payer');
    });

    it('in the tier the per-person cap does not fire; a member’s own share cap (C4) still does', () => {
      const tight = policy({ perPersonAutoCapMinor: 1000 });
      expect(evaluate(razzmatazz(), tight, context()).outcome).toBe('auto_approve');
      const own = evaluate(
        razzmatazz(),
        tight,
        context({
          prefs: {
            mem_chase: {
              memberId: 'mem_chase',
              perBookingShareCapMinor: 1500,
              dailyShareCapMinor: null,
            },
          },
        }),
      );
      expect(own.reasons).toEqual(['over_member_share_cap']);
    });

    it('daily and trip caps, a minor, and someone else’s card still keep the card', () => {
      expect(evaluate(razzmatazz(), policy(), context({ spentTodayMinor: 41001 })).reasons).toEqual(
        ['over_daily_cap'],
      );
      expect(
        evaluate(razzmatazz(), policy({ tripGroupCapMinor: 9000 }), context({ spentTripMinor: 1 }))
          .reasons,
      ).toEqual(['over_trip_cap']);
      expect(
        evaluate(
          razzmatazz({ paidBy: { kind: 'member_card', memberId: 'mem_chase' } }),
          policy(),
          context(),
        ).reasons,
      ).toEqual(['card_not_requester']);
    });

    it('deny rules still deny on an ask (duplicate, guest, hard max)', () => {
      const dup = evaluate(razzmatazz(), policy(), context({ existingBookingForKey: 'bk_1' }));
      expect(dup.outcome).toBe('deny');
      const guest = evaluate(razzmatazz({ requestedBy: 'mem_stranger' }), policy(), context());
      expect(guest.outcome).toBe('deny');
    });
  });

  describe('(c) non-refundable over €200 keeps the card on an explicit ask', () => {
    it('non-refundable €200 exactly auto-approves; €200.01 needs the card (C5)', () => {
      expect(evaluate(nonRef(20000), policy(), context()).outcome).toBe('auto_approve');
      const over = evaluate(nonRef(20001), policy(), context());
      expect(over.outcome).toBe('needs_confirmation');
      expect(over.reasons).toEqual(['non_refundable']);
      expect(over.ruleIds).toEqual(['C5']);
    });

    it('refundable €200.01 auto-approves: the €200 line is only for non-refundable', () => {
      expect(evaluate(ticket(20001), policy(), context()).outcome).toBe('auto_approve');
    });
  });

  describe('(b) a pick on the options card', () => {
    it('a pick of a non-refundable option over €200, under the cap, auto-approves (the card stated it)', () => {
      const d = evaluate(nonRef(43200), policy(), context({ ask: 'pick' }));
      expect(d.outcome).toBe('auto_approve');
    });

    it('a pick over the cap is the card', () => {
      const d = evaluate(nonRef(50001), policy(), context({ ask: 'pick' }));
      expect(d.outcome).toBe('needs_confirmation');
      expect(d.reasons).toEqual([
        'over_auto_cap',
        'over_per_person_cap',
        'non_refundable',
        'over_daily_cap',
      ]);
    });
  });

  describe('(c) flights, lodging and transport always keep the card', () => {
    it.each(['flight', 'lodging', 'transport'] as const)('%s on an explicit ask', (kind) => {
      for (const ask of ['explicit', 'pick'] as const) {
        const d = evaluate(razzmatazz({ kind }), policy(), context({ ask }));
        expect(d.outcome).toBe('needs_confirmation');
        expect(d.reasons).toContain('not_general_purpose');
        if (kind !== 'transport') expect(d.reasons).toContain('kind_requires_each_payer');
      }
    });

    it('a ticket or "other" (a table, a tour) on an ask is general-purpose', () => {
      expect(evaluate(razzmatazz({ kind: 'other' }), policy(), context()).outcome).toBe(
        'auto_approve',
      );
    });
  });

  describe('pre-T-168 card rules with no ask (moved from the tables above)', () => {
    it('perPerson +1 minor unit ⇒ over_per_person_cap (C3, each_payer)', () => {
      const d = evaluate(
        razzmatazz(),
        policy({ autoApproveCapMinor: 20000, perPersonAutoCapMinor: 1799 }),
        noAsk(),
      );
      expect(d.reasons).toEqual(['default_confirm', 'over_per_person_cap']);
      expect(d.approvalMode).toBe('each_payer');
    });

    it.each(['flight', 'lodging'] as const)('C2 %s ⇒ each_payer', (kind) => {
      const d = evaluate(razzmatazz({ kind }), policy(), noAsk());
      expect(d.reasons).toEqual(['default_confirm', 'kind_requires_each_payer']);
      expect(d.approvalMode).toBe('each_payer');
    });

    it('any non-refundable with no ask ⇒ C5', () => {
      const d = evaluate(nonRef(1000), policy(), noAsk());
      expect(d.reasons).toEqual(['default_confirm', 'non_refundable']);
    });
  });
});

describe('T-193 auto tier: the asker is going, and nobody else is put on the tab for much (SAFETY T17, D-046)', () => {
  const ASKS = ['explicit', 'pick'] as const;
  // Dean asks; Dean and Chase go; Chase's share is `chaseMinor`, on Dean's card.
  const pair = (deanMinor: number, chaseMinor: number) =>
    razzmatazz({
      totalMinor: deanMinor + chaseMinor,
      payers: [
        { memberId: 'mem_dean', shareMinor: deanMinor },
        { memberId: 'mem_chase', shareMinor: chaseMinor },
      ],
      attendees: ['mem_dean', 'mem_chase'],
    });
  // Dean asks "for chase and henry": he is not going, the two of them owe €18 each.
  const forOthers = () =>
    razzmatazz({
      totalMinor: 3600,
      payers: equalShares(['mem_chase', 'mem_henry'], 1800),
      attendees: ['mem_chase', 'mem_henry'],
    });

  it('tabAutoCapOf: the group setting, else €100; a broken setting is the default, never unbounded', () => {
    expect(DEFAULT_TAB_AUTO_CAP_MINOR).toBe(10000);
    expect(tabAutoCapOf(policy())).toBe(10000);
    expect(tabAutoCapOf(policy({ perPersonTabAutoCapMinor: 2500 }))).toBe(2500);
    expect(tabAutoCapOf(policy({ perPersonTabAutoCapMinor: 0 }))).toBe(0);
    for (const bad of [-1, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(tabAutoCapOf(policy({ perPersonTabAutoCapMinor: bad }))).toBe(10000);
    }
  });

  describe.each(ASKS)('C3 tab cap on a %s ask', (ask) => {
    it('another member’s share exactly at the tab cap (€100) auto-approves', () => {
      const d = evaluate(pair(1000, 10000), policy(), context({ ask }));
      expect(d.outcome).toBe('auto_approve');
      expect(d.reasons).toEqual(['within_all_caps']);
    });

    it('one cent over the tab cap ⇒ over_tab_auto_cap (C3), each payer 👍s', () => {
      const d = evaluate(pair(1000, 10001), policy(), context({ ask }));
      expect(d.outcome).toBe('needs_confirmation');
      expect(d.reasons).toEqual(['over_tab_auto_cap']);
      expect(d.ruleIds).toEqual(['C3']);
      expect(d.approvalMode).toBe('each_payer');
      expect([...d.requiredApprovers].sort()).toEqual(['mem_chase', 'mem_dean']);
    });

    it('a group tab cap of €18: the flagship at it buys, €17.99 is the card', () => {
      expect(
        evaluate(razzmatazz(), policy({ perPersonTabAutoCapMinor: 1800 }), context({ ask }))
          .outcome,
      ).toBe('auto_approve');
      const d = evaluate(
        razzmatazz(),
        policy({ perPersonTabAutoCapMinor: 1799 }),
        context({ ask }),
      );
      expect(d.reasons).toEqual(['over_tab_auto_cap']);
      expect(d.approvalMode).toBe('each_payer');
    });

    it('the requester’s own share is not bounded by the tab cap (the total cap is)', () => {
      expect(evaluate(pair(30000, 5000), policy(), context({ ask })).outcome).toBe('auto_approve');
    });

    it('€500 for two (€250 on Chase, on Dean’s word) is the card, not a purchase', () => {
      const d = evaluate(pair(25000, 25000), policy(), context({ ask }));
      expect(d.outcome).toBe('needs_confirmation');
      expect(d.reasons).toEqual(['over_tab_auto_cap']);
    });

    it('the tab cap is separate from the card-flow per-person cap (€60 there, €72 each here)', () => {
      const six = ['mem_dean', 'mem_crowley', 'mem_ava', 'mem_chase', 'mem_leo', 'mem_henry'];
      const barca = razzmatazz({
        refundable: false,
        totalMinor: 43200,
        payers: equalShares(six, 7200),
        attendees: six,
        ageRestriction: null,
        contentTags: [],
      });
      const d = evaluate(barca, policy({ perPersonAutoCapMinor: 6000 }), context({ ask }));
      // A pick buys (the options card stated it); an explicit non-refundable ask over €200
      // keeps the card (C5), as before. Neither is over the tab cap.
      expect(d.reasons).toEqual(ask === 'pick' ? ['within_all_caps'] : ['non_refundable']);
    });
  });

  it('outside the tier the tab cap never fires (the card-flow C3 applies, as before)', () => {
    const d = evaluate(pair(1000, 10001), policy(), noAsk());
    expect(d.reasons).toEqual(['default_confirm', 'over_per_person_cap']);
  });

  describe.each(ASKS)('C12 the asker is going, on a %s ask', (ask) => {
    it('"for chase and henry" from Dean ⇒ requester_not_attendee, the one-tap card (any_one)', () => {
      const d = evaluate(forOthers(), policy(), context({ ask }));
      expect(d.outcome).toBe('needs_confirmation');
      expect(d.reasons).toEqual(['requester_not_attendee']);
      expect(d.ruleIds).toEqual(['C12']);
      expect(d.approvalMode).toBe('any_one');
      // Dean's card pays, so Dean is a party and can tap.
      expect(d.requiredApprovers).toContain('mem_dean');
    });

    it('"everyone but me" (the 4 others) ⇒ requester_not_attendee', () => {
      const four = FIVE.filter((id) => id !== 'mem_dean');
      const d = evaluate(
        razzmatazz({ totalMinor: 7200, payers: equalShares(four, 1800), attendees: four }),
        policy(),
        context({ ask }),
      );
      expect(d.reasons).toEqual(['requester_not_attendee']);
    });

    it('the asker going (the flagship) ⇒ no C12', () => {
      expect(evaluate(razzmatazz(), policy(), context({ ask })).outcome).toBe('auto_approve');
    });
  });

  it('with no ask, C12 does not fire (the card says default_confirm, as before)', () => {
    expect(evaluate(forOthers(), policy(), noAsk()).reasons).toEqual(['default_confirm']);
  });
});

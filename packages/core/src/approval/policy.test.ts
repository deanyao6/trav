import { describe, expect, it } from 'vitest';
import type { ReasonCode } from '../domain/approval.js';
import { decidingRule, evaluate, POLICY_RULES } from './policy.js';
import {
  FIVE,
  NOW,
  context,
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
  'within_all_caps',
];

/** A policy under which the Razzmatazz proposal auto-approves (cap raised). */
const relaxed = () =>
  policy({ autoApproveCapMinor: 20000, perPersonAutoCapMinor: 5000, dailyGroupCapMinor: 50000 });

describe('evaluate: defaults', () => {
  it('default policy (auto cap 0) ⇒ needs_confirmation with default_confirm as the deciding rule', () => {
    const d = evaluate(razzmatazz(), policy(), context());
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.reasons).toEqual(['default_confirm']);
    expect(d.ruleIds).toEqual(['C1']);
    expect(decidingRule(d)).toEqual({ ruleId: 'C1', reason: 'default_confirm' });
    expect(d.approvalMode).toBe('any_one');
    expect(d.requiredApprovers).toEqual([
      'mem_dean',
      'mem_sam',
      'mem_ava',
      'mem_maya',
      'mem_leo',
      'mem_henry',
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
      name: 'perPerson +1 minor unit',
      cap: { autoApproveCapMinor: 20000, perPersonAutoCapMinor: 1799 },
      total: 9000,
      share: 1800,
      expectReason: 'over_per_person_cap',
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
      mem_sam: { memberId: 'mem_sam', perBookingShareCapMinor: 1800, dailyShareCapMinor: null },
    };
    expect(evaluate(razzmatazz(), relaxed(), context({ prefs })).outcome).toBe('auto_approve');
    const tighter = {
      mem_sam: { memberId: 'mem_sam', perBookingShareCapMinor: 1799, dailyShareCapMinor: null },
    };
    const d = evaluate(razzmatazz(), relaxed(), context({ prefs: tighter }));
    expect(d.reasons).toEqual(['over_member_share_cap']);
    expect(d.ruleIds).toEqual(['C4']);
    expect(d.approvalMode).toBe('each_payer');
    expect(d.requiredApprovers).toEqual([...FIVE]);
    const nullCap = {
      mem_sam: { memberId: 'mem_sam', perBookingShareCapMinor: null, dailyShareCapMinor: null },
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
          { memberId: 'mem_maya', shareMinor: 1800.5 },
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
    const d = evaluate(razzmatazz(), policy(), context({ existingBookingForKey: 'bk_1' }));
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
      context(),
    );
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toEqual([
      'requester_is_guest',
      'default_confirm',
      'kind_requires_each_payer',
      'non_refundable',
    ]);
    expect(d.ruleIds).toEqual(['D2', 'C1', 'C2', 'C5']);
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
      name: 'C2 flight',
      reason: 'kind_requires_each_payer',
      ruleId: 'C2',
      mode: 'each_payer',
      proposal: { kind: 'flight' },
    },
    {
      name: 'C2 lodging',
      reason: 'kind_requires_each_payer',
      ruleId: 'C2',
      mode: 'each_payer',
      proposal: { kind: 'lodging' },
    },
    {
      name: 'C3 share over per-person cap',
      reason: 'over_per_person_cap',
      ruleId: 'C3',
      mode: 'each_payer',
      policy: { perPersonAutoCapMinor: 1000 },
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
      name: 'C5 non-refundable',
      reason: 'non_refundable',
      ruleId: 'C5',
      mode: 'any_one',
      proposal: { refundable: false },
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

  it('non-refundable never auto-approves even with a generous cap (A7)', () => {
    const d = evaluate(
      razzmatazz({ refundable: false }),
      policy({ autoApproveCapMinor: 1_000_000 }),
      context(),
    );
    expect(d.outcome).toBe('needs_confirmation');
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
      context(),
    );
    expect(d.reasons).toEqual(['over_per_person_cap', 'non_refundable']);
    expect(d.approvalMode).toBe('each_payer');
    expect(d.requiredApprovers).toEqual([...FIVE]);
  });

  it('expiry is capped by a shorter provider hold', () => {
    const d = evaluate(
      razzmatazz({ holdExpiresAt: '2026-03-14T21:50:00+01:00' }),
      policy(),
      context(),
    );
    expect(d.expiresAt).toBe('2026-03-14T21:50:00+01:00');
    const longer = evaluate(
      razzmatazz({ holdExpiresAt: '2026-03-14T23:00:00+01:00' }),
      policy(),
      context(),
    );
    expect(longer.expiresAt).toBe('2026-03-14T21:55:00+01:00');
  });

  it('custom TTL moves expiresAt', () => {
    const d = evaluate(razzmatazz(), policy({ approvalTtlSeconds: 90 }), context());
    expect(d.expiresAt).toBe('2026-03-14T21:41:30+01:00');
  });
});

describe('evaluate: required approvers', () => {
  it('any_one: adult, active, non-guest members; minors, guests and left members excluded', () => {
    const d = evaluate(razzmatazz(), policy(), context());
    expect(d.requiredApprovers).not.toContain('mem_kid');
    expect(d.requiredApprovers).not.toContain('mem_stranger');
    expect(d.requiredApprovers).not.toContain('mem_gone');
  });

  it('any_one with a named approver list: the list, plus the requester (one-tap)', () => {
    const d = evaluate(
      razzmatazz({ requestedBy: 'mem_leo' }),
      policy({ approvers: ['mem_dean', 'mem_kid', 'mem_stranger', 'mem_nobody'] }),
      context(),
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
      context(),
    );
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.requiredApprovers).toEqual(['mem_dean']);
  });

  it('each_payer: every adult payer, in payer order, deduplicated', () => {
    const d = evaluate(
      razzmatazz({ kind: 'flight', paidBy: { kind: 'per_person_cards' } }),
      policy(),
      context(),
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
      context(),
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
      requestedBy: 'mem_sam',
      payers: [
        { memberId: 'mem_kid', shareMinor: 4500 },
        { memberId: 'mem_leo', shareMinor: 4500 },
      ],
      attendees: ['mem_kid', 'mem_leo'],
    });
    const viaRequester = evaluate(p, policy(), context({ members: views(members) }));
    expect(viaRequester.requiredApprovers).toEqual(['mem_sam', 'mem_leo']);

    const viaPool = evaluate(
      { ...p, requestedBy: 'mem_stranger' },
      policy({ approvers: ['mem_ava'] }),
      context({ members: views(members) }),
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
      context({ members: views(members) }),
    );
    expect(d.outcome).toBe('needs_confirmation');
    expect(d.requiredApprovers).toEqual([]);
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
    run({}, { perPersonAutoCapMinor: 1 });
    run(
      {},
      {},
      {
        prefs: {
          mem_dean: { memberId: 'mem_dean', perBookingShareCapMinor: 1, dailyShareCapMinor: null },
        },
      },
    );
    run({ refundable: false });
    run({}, {}, { spentTodayMinor: 50000 });
    run({}, { tripGroupCapMinor: 1 });
    run({
      ageRestriction: null,
      contentTags: [],
      payers: [{ memberId: 'mem_kid', shareMinor: 9000 }],
      attendees: ['mem_kid'],
    });
    run({ paidBy: { kind: 'per_person_cards' } });
    run({}, { autoApproveCapMinor: 20000 });
    expect([...fired].sort()).toEqual([...ALL_REASONS].sort());
  });
});

describe('evaluate: input validation', () => {
  it('throws on a malformed quotedAt (invalid input, not a decision)', () => {
    expect(() => evaluate(razzmatazz({ quotedAt: 'yesterday' }), policy(), context())).toThrow(
      /ISO-8601/,
    );
  });

  it('now is taken from the context, never the wall clock', () => {
    const later = evaluate(razzmatazz(), policy(), context({ now: '2026-03-14T22:30:00+01:00' }));
    expect(later.reasons).toContain('quote_expired');
    expect(NOW).toBe('2026-03-14T21:40:00+01:00');
  });
});

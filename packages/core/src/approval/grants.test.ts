import { describe, expect, it } from 'vitest';
import { createDeterministicIdGenerator } from '../ids.js';
import { TravError } from '../errors.js';
import { sealAuditEvent, verifyAuditChain } from '../audit/index.js';
import { AUDIT_GENESIS_HASH } from '../domain/audit.js';
import type { PolicyDecision } from '../domain/approval.js';
import { evaluate } from './policy.js';
import {
  applyApproval,
  checkGrant,
  consumeGrant,
  createGrant,
  detectGrantInvalidation,
  expireGrant,
  invalidateGrant,
  invalidatedAuditInput,
  rejectGrant,
  samePolicy,
} from './grants.js';
import {
  FIVE,
  NOW,
  ageBandDeps,
  barcelonaMembers,
  context,
  equalShares,
  policy,
  razzmatazz,
  signature,
  views,
} from './testkit.js';

const ids = () => createDeterministicIdGenerator('t');
const members = barcelonaMembers();
const LATER = '2026-03-14T21:56:00+01:00';

function anyOne(): PolicyDecision {
  return evaluate(razzmatazz(), policy(), context());
}
function eachPayer(): PolicyDecision {
  return evaluate(
    razzmatazz({ kind: 'flight', paidBy: { kind: 'per_person_cards' } }),
    policy(),
    context(),
  );
}
function auto(): PolicyDecision {
  return evaluate(razzmatazz(), policy({ autoApproveCapMinor: 20000 }), context());
}

describe('createGrant', () => {
  it('needs_confirmation ⇒ pending, incomplete, expiring at the decision expiry', () => {
    const g = createGrant(anyOne(), 'aud_eval', ids(), NOW);
    expect(g).toEqual({
      grantId: 'grant_t000001',
      proposalId: 'prop_razz',
      decisionId: 'aud_eval',
      grantedBy: [],
      complete: false,
      status: 'pending',
      expiresAt: '2026-03-14T21:55:00+01:00',
    });
  });

  it('auto_approve ⇒ synthetic complete grant with the policy TTL from the injected now', () => {
    const g = createGrant(auto(), 'aud_eval', ids(), NOW);
    expect(g.status).toBe('complete');
    expect(g.complete).toBe(true);
    expect(g.grantedBy).toEqual([]);
    expect(g.expiresAt).toBe('2026-03-14T21:55:00+01:00');
  });

  it('deny ⇒ throws policy_denied (a denied decision never has a grant)', () => {
    const denied = evaluate(razzmatazz({ currency: 'USD' }), policy(), context());
    expect(() => createGrant(denied, 'aud_eval', ids(), NOW)).toThrow(TravError);
    try {
      createGrant(denied, 'aud_eval', ids(), NOW);
    } catch (e) {
      expect((e as TravError).code).toBe('policy_denied');
    }
  });
});

describe('applyApproval: identity is the channel senderId', () => {
  const decision = anyOne();
  const grant = () => createGrant(decision, 'aud_eval', ids(), NOW);

  it('accepts the requester tapping their own card (one-tap flow) and completes any_one', () => {
    const r = applyApproval(grant(), decision, signature('mem_dean'), members, NOW, ageBandDeps);
    expect(r.kind).toBe('accepted');
    expect(r.grant.complete).toBe(true);
    expect(r.grant.status).toBe('complete');
    expect(r.grant.grantedBy.map((g) => g.memberId)).toEqual(['mem_dean']);
  });

  it("a signature claiming Dean from Henry's senderId is claimed_for_other (E3)", () => {
    const forged = signature('mem_dean', { senderId: 'sim:henry' });
    const r = applyApproval(grant(), decision, forged, members, NOW, ageBandDeps);
    expect(r).toMatchObject({ kind: 'ignored', cause: 'claimed_for_other' });
    expect(r.grant.grantedBy).toEqual([]);
  });

  it("claimed_for_other wins over guest/minor: the stranger's phone claiming Dean", () => {
    const r = applyApproval(
      grant(),
      decision,
      signature('mem_dean', { senderId: 'sim:stranger' }),
      members,
      NOW,
      ageBandDeps,
    );
    expect(r).toMatchObject({ kind: 'ignored', cause: 'claimed_for_other' });
  });

  it("a left member's senderId claiming someone else is still not_member", () => {
    const r = applyApproval(
      grant(),
      decision,
      signature('mem_dean', { senderId: 'sim:gone' }),
      members,
      NOW,
      ageBandDeps,
    );
    expect(r).toMatchObject({ kind: 'ignored', cause: 'not_member' });
  });

  it('display name and text contribute nothing: unknown senderId is not_member', () => {
    const r = applyApproval(
      grant(),
      decision,
      signature('mem_dean', { senderId: 'sim:someone-named-dean', via: 'text' }),
      members,
      NOW,
      ageBandDeps,
    );
    expect(r).toMatchObject({ kind: 'ignored', cause: 'not_member' });
  });

  it('a left member is not_member', () => {
    const r = applyApproval(grant(), decision, signature('mem_gone'), members, NOW, ageBandDeps);
    expect(r).toMatchObject({ kind: 'ignored', cause: 'not_member' });
  });

  it('a guest is ignored with cause guest (E2)', () => {
    const r = applyApproval(
      grant(),
      decision,
      signature('mem_stranger'),
      members,
      NOW,
      ageBandDeps,
    );
    expect(r).toMatchObject({ kind: 'ignored', cause: 'guest' });
  });

  it("a minor's yes never counts (E5), even as requester", () => {
    const kidDecision = evaluate(
      razzmatazz({
        requestedBy: 'mem_kid',
        ageRestriction: null,
        contentTags: ['family'],
        payers: equalShares(['mem_dean'], 9000),
        attendees: ['mem_dean', 'mem_kid'],
      }),
      policy(),
      context(),
    );
    const g = createGrant(kidDecision, 'aud_eval', ids(), NOW);
    const r = applyApproval(g, kidDecision, signature('mem_kid'), members, NOW, ageBandDeps);
    expect(r).toMatchObject({ kind: 'ignored', cause: 'minor' });
  });

  it('a member outside requiredApprovers is not_required_approver', () => {
    const named = evaluate(razzmatazz(), policy({ approvers: ['mem_crowley'] }), context());
    const g = createGrant(named, 'aud_eval', ids(), NOW);
    const r = applyApproval(g, named, signature('mem_ava'), members, NOW, ageBandDeps);
    expect(r).toMatchObject({ kind: 'ignored', cause: 'not_required_approver' });
  });

  it('expired: a tap after expiresAt is ignored and the grant moves to expired', () => {
    const r = applyApproval(grant(), decision, signature('mem_dean'), members, LATER, ageBandDeps);
    expect(r).toMatchObject({ kind: 'ignored', cause: 'expired' });
    expect(r.grant.status).toBe('expired');
    expect(r.grant.complete).toBe(false);
  });

  it('a tap exactly at expiresAt still counts', () => {
    const r = applyApproval(
      grant(),
      decision,
      signature('mem_dean'),
      members,
      '2026-03-14T21:55:00+01:00',
      ageBandDeps,
    );
    expect(r.kind).toBe('accepted');
  });

  it('is idempotent per member: double tap ⇒ already_granted, no second signature (A5)', () => {
    const first = applyApproval(
      grant(),
      decision,
      signature('mem_dean'),
      members,
      NOW,
      ageBandDeps,
    );
    const second = applyApproval(
      first.grant,
      decision,
      signature('mem_dean', { messageId: 'msg_again' }),
      members,
      NOW,
      ageBandDeps,
    );
    expect(second).toMatchObject({ kind: 'ignored', cause: 'already_granted' });
    expect(second.grant).toEqual(first.grant);
  });

  it('another member after any_one completed ⇒ not_pending', () => {
    const first = applyApproval(
      grant(),
      decision,
      signature('mem_dean'),
      members,
      NOW,
      ageBandDeps,
    );
    const r = applyApproval(
      first.grant,
      decision,
      signature('mem_crowley'),
      members,
      NOW,
      ageBandDeps,
    );
    expect(r).toMatchObject({ kind: 'ignored', cause: 'not_pending' });
  });

  it('rejected / invalidated grants accept nobody', () => {
    const rejected = rejectGrant(grant(), signature('mem_dean'));
    expect(
      applyApproval(rejected, decision, signature('mem_crowley'), members, NOW, ageBandDeps),
    ).toMatchObject({
      kind: 'ignored',
      cause: 'not_pending',
    });
    const invalidated = invalidateGrant(grant(), 'price_changed');
    expect(
      applyApproval(invalidated, decision, signature('mem_crowley'), members, NOW, ageBandDeps),
    ).toMatchObject({
      kind: 'ignored',
      cause: 'not_pending',
    });
  });

  it('throws on a grant/decision proposal mismatch (programmer error)', () => {
    const other = evaluate(razzmatazz({ proposalId: 'prop_other' }), policy(), context());
    expect(() =>
      applyApproval(grant(), other, signature('mem_dean'), members, NOW, ageBandDeps),
    ).toThrow(TravError);
  });

  it('records the resolved memberId, via and messageId on the signature', () => {
    const r = applyApproval(
      grant(),
      decision,
      signature('mem_crowley', { via: 'reaction', messageId: 'msg_thumbs' }),
      members,
      NOW,
      ageBandDeps,
    );
    expect(r.grant.grantedBy).toEqual([
      {
        memberId: 'mem_crowley',
        senderId: 'sim:crowley',
        via: 'reaction',
        messageId: 'msg_thumbs',
        at: NOW,
      },
    ]);
  });
});

describe('applyApproval: each_payer completion', () => {
  it('completes only when every required approver has signed; order does not matter', () => {
    const decision = eachPayer();
    expect(decision.requiredApprovers).toEqual([...FIVE]);
    let g = createGrant(decision, 'aud_eval', ids(), NOW);
    for (const id of ['mem_leo', 'mem_dean', 'mem_ava', 'mem_chase']) {
      const r = applyApproval(g, decision, signature(id), members, NOW, ageBandDeps);
      expect(r.kind).toBe('accepted');
      g = r.grant;
      expect(g.complete).toBe(false);
      expect(g.status).toBe('pending');
    }
    expect(checkGrant(g, razzmatazz(), decision, NOW)).toEqual({
      valid: false,
      reason: 'incomplete',
    });
    const last = applyApproval(g, decision, signature('mem_crowley'), members, NOW, ageBandDeps);
    expect(last.kind).toBe('accepted');
    expect(last.grant.complete).toBe(true);
    expect(last.grant.status).toBe('complete');
    expect(last.grant.grantedBy).toHaveLength(5);
  });

  it('a non-payer adult (Henry) cannot stand in for a payer', () => {
    const decision = eachPayer();
    const g = createGrant(decision, 'aud_eval', ids(), NOW);
    expect(
      applyApproval(g, decision, signature('mem_henry'), members, NOW, ageBandDeps),
    ).toMatchObject({
      kind: 'ignored',
      cause: 'not_required_approver',
    });
  });
});

describe('rejectGrant / expireGrant / consumeGrant', () => {
  it('rejects a pending grant and records who declined', () => {
    const g = rejectGrant(
      createGrant(anyOne(), 'aud_eval', ids(), NOW),
      signature('mem_dean', { via: 'text' }),
    );
    expect(g.status).toBe('rejected');
    expect(g.complete).toBe(false);
    expect(g.rejectedBy?.memberId).toBe('mem_dean');
  });

  it('rejecting a terminal grant is a no-op', () => {
    const invalidated = invalidateGrant(
      createGrant(anyOne(), 'aud_eval', ids(), NOW),
      'payers_changed',
    );
    expect(rejectGrant(invalidated, signature('mem_dean'))).toBe(invalidated);
  });

  it('expireGrant moves a pending grant past expiresAt to expired, otherwise unchanged', () => {
    const g = createGrant(anyOne(), 'aud_eval', ids(), NOW);
    expect(expireGrant(g, NOW)).toBe(g);
    expect(expireGrant(g, '2026-03-14T21:55:00+01:00')).toBe(g);
    expect(expireGrant(g, LATER).status).toBe('expired');
    const rejected = rejectGrant(g, signature('mem_dean'));
    expect(expireGrant(rejected, LATER)).toBe(rejected);
  });

  it('consumeGrant requires a complete grant and makes it terminal', () => {
    const decision = anyOne();
    const pending = createGrant(decision, 'aud_eval', ids(), NOW);
    expect(() => consumeGrant(pending)).toThrow(TravError);
    const done = applyApproval(
      pending,
      decision,
      signature('mem_dean'),
      members,
      NOW,
      ageBandDeps,
    ).grant;
    const consumed = consumeGrant(done);
    expect(consumed.status).toBe('consumed');
    expect(checkGrant(consumed, razzmatazz(), decision, NOW)).toEqual({
      valid: false,
      reason: 'wrong_status',
    });
    expect(() => consumeGrant(consumed)).toThrow(TravError);
  });
});

describe('checkGrant (the executor re-check)', () => {
  const decision = anyOne();
  const complete = () =>
    applyApproval(
      createGrant(decision, 'aud_eval', ids(), NOW),
      decision,
      signature('mem_dean'),
      members,
      NOW,
      ageBandDeps,
    ).grant;

  it('valid for a complete, unexpired, matching grant', () => {
    expect(checkGrant(complete(), razzmatazz(), decision, NOW)).toEqual({ valid: true });
  });

  it('valid for a synthetic auto_approve grant', () => {
    const d = auto();
    expect(checkGrant(createGrant(d, 'aud_eval', ids(), NOW), razzmatazz(), d, NOW)).toEqual({
      valid: true,
    });
  });

  it('proposal_mismatch when the grant is for another proposal', () => {
    expect(checkGrant(complete(), razzmatazz({ proposalId: 'prop_other' }), decision, NOW)).toEqual(
      {
        valid: false,
        reason: 'proposal_mismatch',
      },
    );
  });

  it('decision_mismatch when the decision is for another proposal', () => {
    const other = evaluate(razzmatazz({ proposalId: 'prop_other' }), policy(), context());
    const g = { ...complete(), proposalId: 'prop_razz' };
    expect(checkGrant(g, razzmatazz(), other, NOW)).toEqual({
      valid: false,
      reason: 'decision_mismatch',
    });
  });

  it('decision_denied even if someone forged a complete grant', () => {
    const denied = evaluate(razzmatazz({ currency: 'USD' }), policy(), context());
    const forged = { ...complete(), status: 'complete' as const, complete: true };
    expect(checkGrant(forged, razzmatazz(), denied, NOW)).toEqual({
      valid: false,
      reason: 'decision_denied',
    });
  });

  it('incomplete for a pending grant and for a grant whose flag lies about its signatures', () => {
    const pending = createGrant(decision, 'aud_eval', ids(), NOW);
    expect(checkGrant(pending, razzmatazz(), decision, NOW)).toEqual({
      valid: false,
      reason: 'incomplete',
    });
    const lying = { ...pending, status: 'complete' as const, complete: true };
    expect(checkGrant(lying, razzmatazz(), decision, NOW)).toEqual({
      valid: false,
      reason: 'incomplete',
    });
  });

  it('incomplete when each_payer has only some signatures even if flagged complete', () => {
    const d = eachPayer();
    const partial = applyApproval(
      createGrant(d, 'aud_eval', ids(), NOW),
      d,
      signature('mem_dean'),
      members,
      NOW,
      ageBandDeps,
    ).grant;
    const lying = { ...partial, status: 'complete' as const, complete: true };
    expect(checkGrant(lying, razzmatazz({ kind: 'flight' }), d, NOW)).toEqual({
      valid: false,
      reason: 'incomplete',
    });
  });

  it('expired after expiresAt, and when the provider hold has lapsed', () => {
    expect(checkGrant(complete(), razzmatazz(), decision, LATER)).toEqual({
      valid: false,
      reason: 'expired',
    });
    expect(
      checkGrant(
        complete(),
        razzmatazz({ holdExpiresAt: '2026-03-14T21:40:00+01:00' }),
        decision,
        NOW,
      ),
    ).toEqual({ valid: false, reason: 'expired' });
  });

  it('wrong_status for rejected, invalidated, expired and consumed grants', () => {
    const g = complete();
    for (const bad of [
      rejectGrant(g, signature('mem_dean')),
      invalidateGrant(g, 'policy_changed'),
      { ...g, status: 'expired' as const },
      consumeGrant(g),
    ]) {
      expect(checkGrant(bad, razzmatazz(), decision, NOW)).toEqual({
        valid: false,
        reason: 'wrong_status',
      });
    }
  });
});

describe('invalidation on price / payer / policy / member change', () => {
  const decision = anyOne();
  const base = () => ({
    proposal: razzmatazz(),
    decision,
    currentPolicy: policy(),
    currentTotalMinor: 9000,
    currentCurrency: 'EUR',
    currentPayerIds: [...FIVE],
    currentAttendeeIds: [...FIVE],
    members: views(),
  });

  it('nothing changed ⇒ null', () => {
    expect(detectGrantInvalidation(base())).toBeNull();
  });

  it('detects price_changed (either direction, or currency)', () => {
    expect(detectGrantInvalidation({ ...base(), currentTotalMinor: 9001 })).toBe('price_changed');
    expect(detectGrantInvalidation({ ...base(), currentTotalMinor: 8999 })).toBe('price_changed');
    expect(detectGrantInvalidation({ ...base(), currentCurrency: 'USD' })).toBe('price_changed');
  });

  it('detects payers_changed for payer and attendee set changes (order-insensitive)', () => {
    expect(detectGrantInvalidation({ ...base(), currentPayerIds: [...FIVE].reverse() })).toBeNull();
    expect(detectGrantInvalidation({ ...base(), currentPayerIds: FIVE.slice(0, 4) })).toBe(
      'payers_changed',
    );
    expect(detectGrantInvalidation({ ...base(), currentAttendeeIds: [...FIVE, 'mem_henry'] })).toBe(
      'payers_changed',
    );
  });

  it('detects member_inactive when a payer left after approval', () => {
    const gone = barcelonaMembers().map((m) =>
      m.memberId === 'mem_leo' ? { ...m, active: false } : m,
    );
    expect(detectGrantInvalidation({ ...base(), members: views(gone) })).toBe('member_inactive');
  });

  it('detects policy_changed against the decision snapshot', () => {
    expect(
      detectGrantInvalidation({
        ...base(),
        currentPolicy: policy({ perPersonAutoCapMinor: 1000 }),
      }),
    ).toBe('policy_changed');
  });

  it('reordering set-valued policy fields is not a policy change; changing their members is', () => {
    const named = evaluate(
      razzmatazz(),
      policy({
        approvers: ['mem_crowley', 'mem_dean'],
        alwaysEachPayerKinds: ['lodging', 'flight'],
      }),
      context(),
    );
    const withPolicy = (p: Parameters<typeof policy>[0]) => ({
      ...base(),
      decision: named,
      currentPolicy: policy(p),
    });
    expect(
      detectGrantInvalidation(
        withPolicy({
          approvers: ['mem_dean', 'mem_crowley'],
          alwaysEachPayerKinds: ['flight', 'lodging'],
        }),
      ),
    ).toBeNull();
    expect(
      samePolicy(
        policy({ approvers: ['mem_crowley', 'mem_dean'] }),
        policy({ approvers: ['mem_dean', 'mem_crowley'] }),
      ),
    ).toBe(true);
    expect(
      detectGrantInvalidation(
        withPolicy({
          approvers: ['mem_dean', 'mem_crowley', 'mem_ava'],
          alwaysEachPayerKinds: ['lodging', 'flight'],
        }),
      ),
    ).toBe('policy_changed');
    expect(
      detectGrantInvalidation(
        withPolicy({ approvers: ['mem_crowley', 'mem_dean'], alwaysEachPayerKinds: ['flight'] }),
      ),
    ).toBe('policy_changed');
    expect(
      detectGrantInvalidation(
        withPolicy({ approvers: 'any_adult_member', alwaysEachPayerKinds: ['lodging', 'flight'] }),
      ),
    ).toBe('policy_changed');
  });

  it('invalidateGrant + invalidatedAuditInput produce an approval.invalidated event that seals into the chain', () => {
    const g = invalidateGrant(createGrant(decision, 'aud_eval', ids(), NOW), 'price_changed');
    expect(g.status).toBe('invalidated');
    expect(g.complete).toBe(false);
    expect(g.invalidatedCause).toBe('price_changed');
    expect(checkGrant(g, razzmatazz(), decision, NOW)).toEqual({
      valid: false,
      reason: 'wrong_status',
    });

    const input = invalidatedAuditInput(g, razzmatazz(), { kind: 'trav', id: 'trav' });
    expect(input).toEqual({
      groupId: 'grp_barcelona',
      tripId: 'trip_barcelona',
      type: 'approval.invalidated',
      actor: { kind: 'trav', id: 'trav' },
      visibility: 'group',
      proposalId: 'prop_razz',
      idempotencyKey: 'k_razz',
      payload: { cause: 'price_changed', grantId: 'grant_t000001' },
    });
    const event = sealAuditEvent(input, 'aud_1', NOW, AUDIT_GENESIS_HASH);
    expect(verifyAuditChain([event]).ok).toBe(true);
  });

  it('every cause is representable', () => {
    for (const cause of [
      'price_changed',
      'payers_changed',
      'policy_changed',
      'member_inactive',
    ] as const) {
      const g = invalidateGrant(createGrant(decision, 'aud_eval', ids(), NOW), cause);
      expect(
        invalidatedAuditInput(g, razzmatazz(), { kind: 'system', id: 'roster' }).payload['cause'],
      ).toBe(cause);
    }
  });

  it('invalidatedAuditInput refuses a grant that is not invalidated', () => {
    expect(() =>
      invalidatedAuditInput(createGrant(decision, 'aud_eval', ids(), NOW), razzmatazz(), {
        kind: 'trav',
        id: 'trav',
      }),
    ).toThrow(TravError);
  });

  it('invalidating a terminal grant is a no-op', () => {
    const consumed = consumeGrant(
      applyApproval(
        createGrant(decision, 'aud_eval', ids(), NOW),
        decision,
        signature('mem_dean'),
        members,
        NOW,
        ageBandDeps,
      ).grant,
    );
    expect(invalidateGrant(consumed, 'price_changed')).toBe(consumed);
  });
});

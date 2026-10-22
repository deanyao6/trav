/**
 * ApprovalGrant lifecycle (SAFETY §2.1 "Confirmation and grants"). Pure state
 * transitions; the agent persists the returned grant and writes the audit
 * event each transition names. Identity is always the channel `senderId`.
 */
import type { AuditEventId, IsoDateTime, MemberId } from '../primitives.js';
import type { Member } from '../domain/group.js';
import type { BookingProposal } from '../domain/booking.js';
import type { AuditActor, AuditEventInput } from '../domain/audit.js';
import type {
  ApprovalGrant,
  ApprovalSignature,
  GrantInvalidationCause,
  GroupSpendingPolicy,
  MemberView,
  PolicyDecision,
} from '../domain/approval.js';
import type { IdGenerator } from '../ids.js';
import { addMinutes, parseIso } from '../clock.js';
import { TravError } from '../errors.js';
import { canonicalJson } from '../audit/index.js';
import { DEFAULT_APPROVAL_DEPS, isActiveMember, type ApprovalDeps } from './members.js';

/**
 * needs_confirmation ⇒ a pending grant expiring at `decision.expiresAt`.
 * auto_approve ⇒ a synthetic complete grant (Flow 2 step 1) with the policy TTL.
 * deny ⇒ throws `policy_denied`: a denied decision never has a grant.
 */
export function createGrant(
  decision: PolicyDecision,
  decisionAuditEventId: AuditEventId,
  ids: IdGenerator,
  now: IsoDateTime,
): ApprovalGrant {
  if (decision.outcome === 'deny') {
    throw new TravError('policy_denied', `no grant for denied proposal ${decision.proposalId}`, {
      proposalId: decision.proposalId,
      reasons: decision.reasons,
    });
  }
  const auto = decision.outcome === 'auto_approve';
  const expiresAt =
    decision.expiresAt ?? addMinutes(now, decision.policySnapshot.approvalTtlSeconds / 60);
  return {
    grantId: ids.next('grant'),
    proposalId: decision.proposalId,
    decisionId: decisionAuditEventId,
    grantedBy: [],
    complete: auto,
    status: auto ? 'complete' : 'pending',
    expiresAt,
  };
}

export type ApplyApprovalResult =
  | { readonly kind: 'accepted'; readonly grant: ApprovalGrant }
  | {
      readonly kind: 'ignored';
      readonly grant: ApprovalGrant;
      /** Written to approval.invalid_attempt.cause (SAFETY §2.2 payload table). */
      readonly cause:
        | 'not_member'
        | 'claimed_for_other'
        | 'guest'
        | 'minor'
        | 'not_required_approver'
        | 'expired'
        | 'already_granted'
        | 'not_pending';
    };

function isExpired(grant: ApprovalGrant, now: IsoDateTime): boolean {
  return parseIso(now) > parseIso(grant.expiresAt);
}

function satisfied(decision: PolicyDecision, grantedIds: ReadonlySet<MemberId>): boolean {
  if (decision.approvalMode === 'each_payer') {
    return (
      decision.requiredApprovers.length > 0 &&
      decision.requiredApprovers.every((id) => grantedIds.has(id))
    );
  }
  if (decision.approvalMode === 'any_one') {
    return decision.requiredApprovers.some((id) => grantedIds.has(id));
  }
  return false;
}

/**
 * Apply one channel-authenticated signature. Identity is `sig.senderId`
 * matched against `members[].senderId`; the display name, message text and
 * even `sig.memberId` contribute nothing. An unknown or inactive sender is
 * `not_member`; a known sender whose signature claims someone else's
 * `memberId` ("Dean approves" from Henry's phone) is `claimed_for_other`
 * (SAFETY E3). Minors and guests are ignored. Idempotent per member.
 */
export function applyApproval(
  grant: ApprovalGrant,
  decision: PolicyDecision,
  sig: ApprovalSignature,
  members: readonly Member[],
  now: IsoDateTime,
  deps: ApprovalDeps = DEFAULT_APPROVAL_DEPS,
): ApplyApprovalResult {
  if (grant.proposalId !== decision.proposalId) {
    throw new TravError('invariant_violation', 'applyApproval: grant/decision proposal mismatch', {
      grantProposalId: grant.proposalId,
      decisionProposalId: decision.proposalId,
    });
  }
  const ignored = (cause: Extract<ApplyApprovalResult, { kind: 'ignored' }>['cause']) =>
    ({ kind: 'ignored', grant, cause }) as const;

  const member = members.find((m) => m.senderId === sig.senderId && isActiveMember(m));
  if (member === undefined) return ignored('not_member');
  if (member.memberId !== sig.memberId) return ignored('claimed_for_other');
  if (member.role === 'guest') return ignored('guest');
  if (deps.isMinor(member, now)) return ignored('minor');

  if (grant.status === 'pending' && isExpired(grant, now)) {
    return { kind: 'ignored', grant: { ...grant, status: 'expired' }, cause: 'expired' };
  }
  if (grant.grantedBy.some((g) => g.memberId === member.memberId))
    return ignored('already_granted');
  if (grant.status !== 'pending' || decision.outcome !== 'needs_confirmation') {
    return ignored('not_pending');
  }
  if (!decision.requiredApprovers.includes(member.memberId)) {
    return ignored('not_required_approver');
  }

  const grantedBy = [...grant.grantedBy, { ...sig, memberId: member.memberId }];
  const complete = satisfied(decision, new Set(grantedBy.map((g) => g.memberId)));
  return {
    kind: 'accepted',
    grant: { ...grant, grantedBy, complete, status: complete ? 'complete' : 'pending' },
  };
}

/**
 * Decline. Authorization (required approver, or the requester's own "no") is the
 * handler's job since it has the members; this is the state transition.
 * Pending or complete-but-unconsumed grants become `rejected`; terminal grants
 * are returned unchanged.
 */
export function rejectGrant(grant: ApprovalGrant, sig: ApprovalSignature): ApprovalGrant {
  if (grant.status !== 'pending' && grant.status !== 'complete') return grant;
  return { ...grant, status: 'rejected', complete: false, rejectedBy: sig };
}

/** Price / payer / policy / member change before execution. Terminal grants are returned unchanged. */
export function invalidateGrant(
  grant: ApprovalGrant,
  cause: GrantInvalidationCause,
): ApprovalGrant {
  if (grant.status !== 'pending' && grant.status !== 'complete') return grant;
  return { ...grant, status: 'invalidated', complete: false, invalidatedCause: cause };
}

/** `now > expiresAt` on a pending grant ⇒ `expired` (the proposal_expiry job). Otherwise unchanged. */
export function expireGrant(grant: ApprovalGrant, now: IsoDateTime): ApprovalGrant {
  if (grant.status !== 'pending' || !isExpired(grant, now)) return grant;
  return { ...grant, status: 'expired' };
}

/** The executor marks a complete grant consumed right after the purchase so it can never buy twice. */
export function consumeGrant(grant: ApprovalGrant): ApprovalGrant {
  if (grant.status !== 'complete' || !grant.complete) {
    throw new TravError(
      'grant_invalid',
      `cannot consume grant ${grant.grantId} (${grant.status})`,
      {
        grantId: grant.grantId,
        status: grant.status,
      },
    );
  }
  return { ...grant, status: 'consumed' };
}

export type GrantCheck =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason:
        | 'proposal_mismatch'
        | 'incomplete'
        | 'expired'
        | 'wrong_status'
        | 'decision_denied'
        | 'decision_mismatch';
    };

/**
 * The executor's re-check (SAFETY §2.1 "single call site"). Does not trust
 * `grant.complete`: completeness is recomputed from the decision's
 * `requiredApprovers` and the recorded signatures.
 */
export function checkGrant(
  grant: ApprovalGrant,
  proposal: BookingProposal,
  decision: PolicyDecision,
  now: IsoDateTime,
): GrantCheck {
  if (grant.proposalId !== proposal.proposalId)
    return { valid: false, reason: 'proposal_mismatch' };
  if (decision.proposalId !== proposal.proposalId) {
    return { valid: false, reason: 'decision_mismatch' };
  }
  if (decision.outcome === 'deny') return { valid: false, reason: 'decision_denied' };
  if (grant.status !== 'pending' && grant.status !== 'complete') {
    return { valid: false, reason: 'wrong_status' };
  }
  if (isExpired(grant, now)) return { valid: false, reason: 'expired' };
  if (proposal.holdExpiresAt !== undefined && parseIso(now) >= parseIso(proposal.holdExpiresAt)) {
    return { valid: false, reason: 'expired' };
  }
  const grantedIds = new Set(grant.grantedBy.map((g) => g.memberId));
  const complete =
    decision.outcome === 'auto_approve'
      ? grant.grantedBy.length === 0
      : satisfied(decision, grantedIds);
  if (grant.status !== 'complete' || !grant.complete || !complete) {
    return { valid: false, reason: 'incomplete' };
  }
  return { valid: true };
}

// ---------- invalidation detection ----------

export interface GrantInvalidationInput {
  /** The proposal as it was approved. */
  readonly proposal: BookingProposal;
  /** Carries the policy snapshot the decision was made against. */
  readonly decision: PolicyDecision;
  readonly currentPolicy: GroupSpendingPolicy;
  /** From the executor's re-price. */
  readonly currentTotalMinor: number;
  readonly currentCurrency: string;
  /** From the roster right before execution. */
  readonly currentPayerIds: readonly MemberId[];
  readonly currentAttendeeIds: readonly MemberId[];
  readonly members: readonly MemberView[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

/** Policy with its set-valued fields (`approvers`, `alwaysEachPayerKinds`) sorted and deduped, so order alone is not a change. */
function normalizePolicy(policy: GroupSpendingPolicy): GroupSpendingPolicy {
  return {
    ...policy,
    approvers:
      policy.approvers === 'any_adult_member'
        ? policy.approvers
        : [...new Set(policy.approvers)].sort(),
    alwaysEachPayerKinds: [...new Set(policy.alwaysEachPayerKinds)].sort(),
  };
}

export function samePolicy(a: GroupSpendingPolicy, b: GroupSpendingPolicy): boolean {
  return canonicalJson(normalizePolicy(a)) === canonicalJson(normalizePolicy(b));
}

/** First applicable cause, or null if the grant still stands (SAFETY §2.1 invalidation rule). */
export function detectGrantInvalidation(
  input: GrantInvalidationInput,
): GrantInvalidationCause | null {
  const { proposal } = input;
  if (
    input.currentTotalMinor !== proposal.totalMinor ||
    input.currentCurrency !== proposal.currency
  ) {
    return 'price_changed';
  }
  const payerIds = proposal.payers.map((s) => s.memberId);
  if (
    !sameSet(payerIds, input.currentPayerIds) ||
    !sameSet(proposal.attendees, input.currentAttendeeIds)
  ) {
    return 'payers_changed';
  }
  const byId = new Map(input.members.map((m) => [m.memberId, m]));
  if (payerIds.some((id) => byId.get(id)?.active !== true)) return 'member_inactive';
  if (!samePolicy(input.decision.policySnapshot, input.currentPolicy)) return 'policy_changed';
  return null;
}

/** The `approval.invalidated` event for an invalidated grant (SAFETY §2.2 payload table). */
export function invalidatedAuditInput(
  grant: ApprovalGrant,
  proposal: BookingProposal,
  actor: AuditActor,
): AuditEventInput {
  if (grant.status !== 'invalidated' || grant.invalidatedCause === undefined) {
    throw new TravError('invariant_violation', `grant ${grant.grantId} is not invalidated`, {
      grantId: grant.grantId,
      status: grant.status,
    });
  }
  if (grant.proposalId !== proposal.proposalId) {
    throw new TravError('invariant_violation', 'invalidatedAuditInput: proposal mismatch');
  }
  return {
    groupId: proposal.groupId,
    tripId: proposal.tripId,
    type: 'approval.invalidated',
    actor,
    visibility: 'group',
    proposalId: proposal.proposalId,
    idempotencyKey: proposal.idempotencyKey,
    payload: { cause: grant.invalidatedCause, grantId: grant.grantId },
  };
}

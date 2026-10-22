/**
 * ApprovalPolicy, grants, idempotency and the pre-purchase consistency check
 * (T-004; docs/SAFETY.md §2.1). Pure. No I/O. Decisions are returned, not thrown.
 */
import type {
  CurrencyCode,
  GroupId,
  IdempotencyKey,
  IsoDateTime,
  MemberId,
  TripId,
} from '../primitives.js';
import type { Member } from '../domain/group.js';
import type { Activity, Roster, Trip } from '../domain/trip.js';
import type { BookingKind, BookingProposal } from '../domain/booking.js';
import type {
  ApprovalGrant,
  ApprovalSignature,
  GrantInvalidationCause,
  GroupSpendingPolicy,
  MemberView,
  PolicyContext,
  PolicyDecision,
} from '../domain/approval.js';
import type { IdGenerator } from '../ids.js';
import { notImplemented } from '../errors.js';

// ---------- policy ----------

/** Collapse lead/guardian/member to 'member'; `isMinor` from `safety/`. */
export function toMemberView(member: Member, now: IsoDateTime): MemberView {
  return notImplemented(`toMemberView(${member.memberId}, ${now})`);
}

/**
 * SAFETY §2.1 rules D1..D10 then C1..C8, in order; all rules run so `reasons`
 * is complete. "At the cap" is inside the cap (`>` not `>=`).
 */
export function evaluate(
  p: BookingProposal,
  policy: GroupSpendingPolicy,
  ctx: PolicyContext,
): PolicyDecision {
  return notImplemented(`evaluate(${p.proposalId}, ${policy.groupId}, ${ctx.now})`);
}

// ---------- idempotency ----------

export interface IdempotencyInput {
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly kind: BookingKind;
  readonly provider: string;
  readonly itemRef: string;
  readonly eventDate: string;
  readonly payerIds: readonly MemberId[];
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  /** Only for an explicit "buy it again" (SAFETY §2.1); audited as booking.duplicate_override. */
  readonly nonce?: string;
}

/**
 * sha256(groupId|tripId|kind|provider|itemRef|eventDate|sortedPayerIds.join(',')|totalMinor|currency[|nonce]).hex
 * Deliberately excludes requestedAt, sourceMessageId and requestedBy.
 */
export function deriveIdempotencyKey(input: IdempotencyInput): IdempotencyKey {
  return notImplemented(`deriveIdempotencyKey(${input.itemRef})`);
}

// ---------- grants ----------

export function createGrant(
  decision: PolicyDecision,
  decisionAuditEventId: string,
  ids: IdGenerator,
  now: IsoDateTime,
): ApprovalGrant {
  return notImplemented(`createGrant(${decision.proposalId}, ${decisionAuditEventId}, ${now})`);
}

export type ApplyApprovalResult =
  | { readonly kind: 'accepted'; readonly grant: ApprovalGrant }
  | {
      readonly kind: 'ignored';
      readonly grant: ApprovalGrant;
      /** Written to approval.invalid_attempt.cause. */
      readonly cause:
        | 'not_member'
        | 'guest'
        | 'minor'
        | 'not_required_approver'
        | 'expired'
        | 'already_granted'
        | 'not_pending';
    };

/**
 * Apply one channel-authenticated signature. Identity is `sig.senderId`
 * matched against `members[].senderId`; the display name and message text
 * contribute nothing. Minors and guests are ignored. Idempotent per member.
 */
export function applyApproval(
  grant: ApprovalGrant,
  decision: PolicyDecision,
  sig: ApprovalSignature,
  members: readonly Member[],
  now: IsoDateTime,
): ApplyApprovalResult {
  return notImplemented(
    `applyApproval(${grant.grantId}, ${decision.proposalId}, ${sig.senderId}, ${members.length}, ${now})`,
  );
}

export function rejectGrant(grant: ApprovalGrant, sig: ApprovalSignature): ApprovalGrant {
  return notImplemented(`rejectGrant(${grant.grantId}, ${sig.senderId})`);
}

export function invalidateGrant(
  grant: ApprovalGrant,
  cause: GrantInvalidationCause,
): ApprovalGrant {
  return notImplemented(`invalidateGrant(${grant.grantId}, ${cause})`);
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

/** The executor's re-check (SAFETY §2.1 "single call site"). */
export function checkGrant(
  grant: ApprovalGrant,
  proposal: BookingProposal,
  decision: PolicyDecision,
  now: IsoDateTime,
): GrantCheck {
  return notImplemented(
    `checkGrant(${grant.grantId}, ${proposal.proposalId}, ${decision.proposalId}, ${now})`,
  );
}

// ---------- consistency (G-02) ----------

export type ConsistencyProblem =
  | 'city_not_in_trip'
  | 'date_outside_trip'
  | 'quantity_not_roster'
  | 'attendee_not_member'
  | 'attendee_marked_out'
  | 'minor_on_restricted'
  | 'payers_not_attendees'
  | 'empty_roster';

export interface ConsistencyResult {
  readonly ok: boolean;
  readonly problems: readonly ConsistencyProblem[];
}

/** Runs before `evaluate()`; any problem blocks the proposal from being posted. */
export function checkProposalConsistency(
  proposal: BookingProposal,
  trip: Trip,
  activity: Activity | null,
  roster: Roster | null,
  members: readonly Member[],
  now: IsoDateTime,
): ConsistencyResult {
  return notImplemented(
    `checkProposalConsistency(${proposal.proposalId}, ${trip.tripId}, ${activity?.activityId ?? ''}, ${roster?.activityId ?? ''}, ${members.length}, ${now})`,
  );
}

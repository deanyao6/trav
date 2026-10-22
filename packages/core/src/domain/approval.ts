/**
 * ApprovalPolicy types, verbatim from docs/SAFETY.md §2.1. Pure data; the
 * functions live in `../approval/`.
 */
import type {
  AuditEventId,
  CurrencyCode,
  GrantId,
  GroupId,
  IsoDateTime,
  MemberId,
  MessageId,
  ProposalId,
  SenderId,
} from '../primitives.js';
import type { BookingKind } from './booking.js';

/** Per-group spending policy. Editable only by adult members via explicit command; every change audited. */
export interface GroupSpendingPolicy {
  readonly groupId: GroupId;
  readonly currency: CurrencyCode;
  /** DEFAULT 0 (everything confirmed). */
  readonly autoApproveCapMinor: number;
  /** DEFAULT 5000. */
  readonly perPersonAutoCapMinor: number;
  /** DEFAULT 50000. */
  readonly dailyGroupCapMinor: number;
  /** DEFAULT null. */
  readonly tripGroupCapMinor: number | null;
  /** DEFAULT 500000. */
  readonly hardMaxPerBookingMinor: number;
  readonly approvers: 'any_adult_member' | readonly MemberId[];
  /** DEFAULT 900. */
  readonly approvalTtlSeconds: number;
  /** DEFAULT ['flight', 'lodging']. */
  readonly alwaysEachPayerKinds: readonly BookingKind[];
}

export function defaultSpendingPolicy(
  groupId: GroupId,
  currency: CurrencyCode,
): GroupSpendingPolicy {
  return {
    groupId,
    currency,
    autoApproveCapMinor: 0,
    perPersonAutoCapMinor: 5000,
    dailyGroupCapMinor: 50000,
    tripGroupCapMinor: null,
    hardMaxPerBookingMinor: 500000,
    approvers: 'any_adult_member',
    approvalTtlSeconds: 900,
    alwaysEachPayerKinds: ['flight', 'lodging'],
  };
}

/** Per-member preferences, owned by the member (lives in PrivateStore.memberPrefs). */
export interface MemberSpendingPrefs {
  readonly memberId: MemberId;
  readonly perBookingShareCapMinor: number | null;
  readonly dailyShareCapMinor: number | null;
}

/** The subset of Member the policy needs. Built by `toMemberView(member, now)`. */
export interface MemberView {
  readonly memberId: MemberId;
  /** lead/guardian/member collapse to 'member'; guests cannot request, approve, or pay. */
  readonly role: 'member' | 'guest';
  readonly isMinor: boolean;
  readonly active: boolean;
}

export interface PolicyContext {
  readonly now: IsoDateTime;
  readonly members: readonly MemberView[];
  readonly prefs: Readonly<Record<MemberId, MemberSpendingPrefs>>;
  /** Trav-executed bookings in the last 24h for this group. */
  readonly spentTodayMinor: number;
  readonly spentTripMinor: number;
  /** bookingId if idempotencyKey already executed. */
  readonly existingBookingForKey: string | null;
}

export type Outcome = 'auto_approve' | 'needs_confirmation' | 'deny';

export type ReasonCode =
  // deny
  | 'requester_not_member'
  | 'requester_is_guest'
  | 'payer_not_member'
  | 'payer_inactive'
  | 'shares_do_not_sum'
  | 'empty_payers'
  | 'negative_or_zero_amount'
  | 'currency_mismatch'
  | 'over_hard_max'
  | 'duplicate'
  | 'minor_age_restricted'
  | 'quote_expired'
  // needs_confirmation
  | 'default_confirm'
  | 'over_auto_cap'
  | 'over_per_person_cap'
  | 'over_member_share_cap'
  | 'non_refundable'
  | 'over_daily_cap'
  | 'over_trip_cap'
  | 'kind_requires_each_payer'
  | 'minor_is_payer'
  | 'payer_not_requester'
  // auto
  | 'within_all_caps';

export type ApprovalMode = 'none' | 'any_one' | 'each_payer';

export interface PolicyDecision {
  readonly proposalId: ProposalId;
  readonly outcome: Outcome;
  /** Every rule that fired, in evaluation order (D1..D10 then C1..C8). */
  readonly reasons: readonly ReasonCode[];
  /** Rule ids that fired, e.g. ['C1','C5']; the receipt card names the deciding one. */
  readonly ruleIds: readonly string[];
  readonly approvalMode: ApprovalMode;
  /** any_one: any one of these; each_payer: all of these. */
  readonly requiredApprovers: readonly MemberId[];
  readonly expiresAt: IsoDateTime | null;
  readonly existingBookingId: string | null;
  readonly policySnapshot: GroupSpendingPolicy;
}

/** One member's confirmation, bound to the channel sender id. */
export interface ApprovalSignature {
  readonly memberId: MemberId;
  readonly senderId: SenderId;
  readonly via: 'button' | 'reaction' | 'text';
  readonly messageId: MessageId;
  readonly at: IsoDateTime;
}

export type GrantStatus =
  'pending' | 'complete' | 'rejected' | 'expired' | 'invalidated' | 'consumed';

export type GrantInvalidationCause =
  'price_changed' | 'payers_changed' | 'policy_changed' | 'member_inactive';

export interface ApprovalGrant {
  readonly grantId: GrantId;
  readonly proposalId: ProposalId;
  /** The `policy.evaluated` audit event id. */
  readonly decisionId: AuditEventId;
  readonly grantedBy: readonly ApprovalSignature[];
  /** All requiredApprovers satisfied. */
  readonly complete: boolean;
  readonly status: GrantStatus;
  readonly expiresAt: IsoDateTime;
  readonly invalidatedCause?: GrantInvalidationCause;
}

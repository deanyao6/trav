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
  /**
   * The auto-buy cap (T-168, D-044): an asked-for, general-purpose purchase
   * (`PolicyContext.ask`) whose total is at or under this is bought without a
   * card. DEFAULT 50000 (€500 total). 0 turns auto-buy off: everything confirmed.
   */
  readonly autoApproveCapMinor: number;
  /** DEFAULT 5000. */
  readonly perPersonAutoCapMinor: number;
  /**
   * T-193 (SAFETY T17, D-046): inside the auto tier, the most an ask or a pick
   * may put on anyone else's tab without their own 👍. Any non-requester share
   * over it fires C3 (`over_tab_auto_cap`, each_payer). Absent ⇒
   * `DEFAULT_TAB_AUTO_CAP_MINOR` (€100); read it with `tabAutoCapOf`. Separate
   * from `perPersonAutoCapMinor`, which gates the card flow (who must 👍 a card).
   */
  readonly perPersonTabAutoCapMinor?: number;
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

/** T-168: the default auto-buy cap, €500 total (minor units of the group currency). */
export const DEFAULT_AUTO_BUY_CAP_MINOR = 50000;

/**
 * T-168 (c): a non-refundable purchase over this total needs the card even on
 * an explicit ask (€200, minor units of the group currency).
 */
export const NON_REFUNDABLE_AUTO_MAX_MINOR = 20000;

/**
 * T-193 (D-046): the default most an auto-tier purchase may put on the tab of
 * a member who didn't ask (€100, minor units of the group currency).
 */
export const DEFAULT_TAB_AUTO_CAP_MINOR = 10000;

/** The group's tab cap inside the auto tier (T-193): its own setting, else the €100 default. */
export function tabAutoCapOf(
  policy: Pick<GroupSpendingPolicy, 'perPersonTabAutoCapMinor'>,
): number {
  const v = policy.perPersonTabAutoCapMinor;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : DEFAULT_TAB_AUTO_CAP_MINOR;
}

/** T-168 (a): the general-purpose kinds an ask can auto-buy. Flights, lodging and transport never are. */
export const AUTO_BUY_KINDS: readonly BookingKind[] = ['ticket', 'other'];

/**
 * Why a proposal may be bought without a confirm card (T-168, D-044). Set only
 * by the proposal service, from code, never from model output:
 * - `explicit`: the triggering message passed `autoBuyVerdict` (an unambiguous
 *   ask addressed to Trav) and the proposal is exactly what it asked for
 *   (venue, night, party).
 * - `pick`: a member on the booking picked this option on Trav's options card
 *   (a tap, or an exact "1" / "option 1" bound to the card), at the price the
 *   card showed.
 * Absent: anything else (a model-originated proposal whose message is no
 * clear ask, a soft or repaired ask, a re-quote) ⇒ the card, whatever the caps.
 */
export type AskSignal = 'explicit' | 'pick';

export function defaultSpendingPolicy(
  groupId: GroupId,
  currency: CurrencyCode,
): GroupSpendingPolicy {
  return {
    groupId,
    currency,
    autoApproveCapMinor: DEFAULT_AUTO_BUY_CAP_MINOR,
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
  /** For minors: the adult who confirms on their behalf under `each_payer` (T-004). */
  readonly guardianMemberId?: MemberId;
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
  /** T-168: the ask behind the proposal; absent ⇒ never auto-approved. */
  readonly ask?: AskSignal;
}

export type Outcome = 'auto_approve' | 'needs_confirmation' | 'deny';

export const OUTCOMES: readonly Outcome[] = ['auto_approve', 'needs_confirmation', 'deny'];

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

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
  | 'not_general_purpose'
  | 'over_per_person_cap'
  | 'over_tab_auto_cap'
  | 'over_member_share_cap'
  | 'non_refundable'
  | 'over_daily_cap'
  | 'over_trip_cap'
  | 'kind_requires_each_payer'
  | 'minor_is_payer'
  | 'payer_not_requester'
  | 'card_not_requester'
  | 'minor_requester'
  | 'requester_not_attendee'
  // auto
  | 'within_all_caps';

export type ApprovalMode = 'none' | 'any_one' | 'each_payer';

export interface PolicyDecision {
  readonly proposalId: ProposalId;
  readonly outcome: Outcome;
  /** Every rule that fired, in evaluation order (D1..D10 then C1..C10). */
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
  /** The decline that moved the grant to `rejected` (feeds `approval.rejected`). */
  readonly rejectedBy?: ApprovalSignature;
}

/**
 * ApprovalPolicy.evaluate (SAFETY §2.1). Pure. No I/O. Decisions are returned,
 * never thrown. Every rule runs so `reasons` is complete; `ruleIds[0]` is the
 * deciding rule (deny rules are evaluated before confirmation triggers).
 */
import type { IsoDateTime, MemberId } from '../primitives.js';
import type { BookingProposal } from '../domain/booking.js';
import type {
  ApprovalMode,
  GroupSpendingPolicy,
  MemberView,
  PolicyContext,
  PolicyDecision,
  ReasonCode,
} from '../domain/approval.js';
import { addMinutes, parseIso } from '../clock.js';
import { RESTRICTED_TAGS } from '../safety/index.js';

/** D10: a quote older than this is stale (SAFETY §2.1). */
export const QUOTE_MAX_AGE_MS = 15 * 60 * 1000;

/** Rule ids in evaluation order, for docs and the receipt card. */
export const POLICY_RULES: readonly {
  readonly id: string;
  readonly stage: 'deny' | 'confirm' | 'auto';
  readonly reasons: readonly ReasonCode[];
}[] = [
  { id: 'D1', stage: 'deny', reasons: ['requester_not_member'] },
  { id: 'D2', stage: 'deny', reasons: ['requester_is_guest'] },
  { id: 'D3', stage: 'deny', reasons: ['payer_not_member', 'payer_inactive'] },
  { id: 'D4', stage: 'deny', reasons: ['empty_payers'] },
  { id: 'D5', stage: 'deny', reasons: ['negative_or_zero_amount', 'shares_do_not_sum'] },
  { id: 'D6', stage: 'deny', reasons: ['currency_mismatch'] },
  { id: 'D7', stage: 'deny', reasons: ['over_hard_max'] },
  { id: 'D8', stage: 'deny', reasons: ['duplicate'] },
  { id: 'D9', stage: 'deny', reasons: ['minor_age_restricted'] },
  { id: 'D10', stage: 'deny', reasons: ['quote_expired'] },
  { id: 'C1', stage: 'confirm', reasons: ['default_confirm', 'over_auto_cap'] },
  { id: 'C2', stage: 'confirm', reasons: ['kind_requires_each_payer'] },
  { id: 'C3', stage: 'confirm', reasons: ['over_per_person_cap'] },
  { id: 'C4', stage: 'confirm', reasons: ['over_member_share_cap'] },
  { id: 'C5', stage: 'confirm', reasons: ['non_refundable'] },
  { id: 'C6', stage: 'confirm', reasons: ['over_daily_cap'] },
  { id: 'C7', stage: 'confirm', reasons: ['over_trip_cap'] },
  { id: 'C8', stage: 'confirm', reasons: ['minor_is_payer'] },
  { id: 'C9', stage: 'confirm', reasons: ['payer_not_requester'] },
  { id: 'A1', stage: 'auto', reasons: ['within_all_caps'] },
];

const MODE_RANK: Readonly<Record<ApprovalMode, number>> = { none: 0, any_one: 1, each_payer: 2 };

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Adult, active, non-guest: the only people who can confirm (SAFETY §2.1, §2.5, §2.7). */
export function canApprove(view: MemberView | undefined): view is MemberView {
  return view !== undefined && view.active && view.role === 'member' && !view.isMinor;
}

function earliest(a: IsoDateTime, b: IsoDateTime | undefined): IsoDateTime {
  if (b === undefined) return a;
  return parseIso(b) < parseIso(a) ? b : a;
}

/**
 * SAFETY §2.1 rules D1..D10 then C1..C9, in order; all rules run so `reasons`
 * is complete. "At the cap" is inside the cap (`>` not `>=`).
 *
 * Beyond the SAFETY table:
 * - C1 reports `default_confirm` when `autoApproveCapMinor` is 0 (the default:
 *   everything confirmed) and `over_auto_cap` when a raised cap is exceeded.
 * - C9 (`payer_not_requester`): with `paidBy: per_person_cards`, charging a
 *   card other than the requester's needs that card holder's confirmation
 *   (`each_payer`). Under `member_card` the requester's card pays and the others
 *   only owe on the tab, so the requester's one tap suffices.
 * - D9 also treats the `18+` / `21+` content tags as an age restriction.
 * - D10 also fires once the provider hold (`holdExpiresAt`) has passed.
 * - Guests and non-integer amounts are denied (`payer_not_member`,
 *   `negative_or_zero_amount` / `shares_do_not_sum`).
 * - D5 also fires `shares_do_not_sum` when the same member appears twice in
 *   `payers`: duplicate rows are not a split, whatever they add up to.
 */
export function evaluate(
  p: BookingProposal,
  policy: GroupSpendingPolicy,
  ctx: PolicyContext,
): PolicyDecision {
  const reasons: ReasonCode[] = [];
  const ruleIds: string[] = [];
  let mode: ApprovalMode = 'none';
  const fire = (ruleId: string, reason: ReasonCode, triggerMode: ApprovalMode = 'none'): void => {
    reasons.push(reason);
    ruleIds.push(ruleId);
    if (MODE_RANK[triggerMode] > MODE_RANK[mode]) mode = triggerMode;
  };

  const byId = new Map<MemberId, MemberView>(ctx.members.map((m) => [m.memberId, m]));
  const requester = byId.get(p.requestedBy);
  const payerIds = p.payers.map((s) => s.memberId);
  const participantIds = unique([...payerIds, ...p.attendees]);
  const isMinorId = (id: MemberId): boolean => byId.get(id)?.isMinor === true;

  // ---- deny rules ----
  if (requester === undefined || !requester.active) fire('D1', 'requester_not_member');
  if (requester?.role === 'guest') fire('D2', 'requester_is_guest');

  let payerNotMember = false;
  let payerInactive = false;
  for (const id of payerIds) {
    const m = byId.get(id);
    if (m === undefined || m.role === 'guest') payerNotMember = true;
    else if (!m.active) payerInactive = true;
  }
  if (payerNotMember) fire('D3', 'payer_not_member');
  if (payerInactive) fire('D3', 'payer_inactive');

  if (p.payers.length === 0) fire('D4', 'empty_payers');

  if (!Number.isInteger(p.totalMinor) || p.totalMinor <= 0) fire('D5', 'negative_or_zero_amount');
  const sharesValid = p.payers.every((s) => Number.isInteger(s.shareMinor) && s.shareMinor >= 0);
  const shareSum = p.payers.reduce((acc, s) => acc + s.shareMinor, 0);
  // A payer listed twice is not a valid split either, even when the rows sum to the total.
  const payersUnique = new Set(payerIds).size === payerIds.length;
  if (!sharesValid || !payersUnique || shareSum !== p.totalMinor) fire('D5', 'shares_do_not_sum');

  if (p.currency !== policy.currency) fire('D6', 'currency_mismatch');
  if (p.totalMinor > policy.hardMaxPerBookingMinor) fire('D7', 'over_hard_max');
  if (ctx.existingBookingForKey !== null) fire('D8', 'duplicate');

  // D9 mirrors the consistency check's RESTRICTED_TAGS so the policy is safe on its own
  // (defence in depth: nightlife/club/bar/alcohol count even without an explicit age tag).
  const ageRestricted =
    p.ageRestriction !== null || p.contentTags.some((t) => RESTRICTED_TAGS.includes(t));
  if (ageRestricted && participantIds.some(isMinorId)) fire('D9', 'minor_age_restricted');

  const nowMs = parseIso(ctx.now);
  const quoteStale =
    nowMs - parseIso(p.quotedAt) > QUOTE_MAX_AGE_MS ||
    (p.holdExpiresAt !== undefined && nowMs >= parseIso(p.holdExpiresAt));
  if (quoteStale) fire('D10', 'quote_expired');

  const denied = reasons.length > 0;

  // ---- confirmation triggers (all run so reasons is complete) ----
  if (policy.autoApproveCapMinor <= 0) fire('C1', 'default_confirm', 'any_one');
  else if (p.totalMinor > policy.autoApproveCapMinor) fire('C1', 'over_auto_cap', 'any_one');

  if (policy.alwaysEachPayerKinds.includes(p.kind)) {
    fire('C2', 'kind_requires_each_payer', 'each_payer');
  }
  if (p.payers.some((s) => s.shareMinor > policy.perPersonAutoCapMinor)) {
    fire('C3', 'over_per_person_cap', 'each_payer');
  }
  const overMemberShareCap = p.payers.some((s) => {
    const cap = ctx.prefs[s.memberId]?.perBookingShareCapMinor;
    return cap !== null && cap !== undefined && s.shareMinor > cap;
  });
  if (overMemberShareCap) fire('C4', 'over_member_share_cap', 'each_payer');

  if (!p.refundable) fire('C5', 'non_refundable', 'any_one');
  if (ctx.spentTodayMinor + p.totalMinor > policy.dailyGroupCapMinor) {
    fire('C6', 'over_daily_cap', 'any_one');
  }
  if (
    policy.tripGroupCapMinor !== null &&
    ctx.spentTripMinor + p.totalMinor > policy.tripGroupCapMinor
  ) {
    fire('C7', 'over_trip_cap', 'any_one');
  }
  // C8: approvers are restricted to adults in every mode (see canApprove); mode is not escalated.
  if (payerIds.some(isMinorId)) fire('C8', 'minor_is_payer', 'any_one');
  if (p.paidBy.kind === 'per_person_cards' && payerIds.some((id) => id !== p.requestedBy)) {
    fire('C9', 'payer_not_requester', 'each_payer');
  }

  const base = {
    proposalId: p.proposalId,
    reasons,
    ruleIds,
    existingBookingId: ctx.existingBookingForKey,
    policySnapshot: policy,
  };

  if (denied) {
    return {
      ...base,
      outcome: 'deny',
      approvalMode: 'none',
      requiredApprovers: [],
      expiresAt: null,
    };
  }

  if (mode === 'none') {
    fire('A1', 'within_all_caps');
    return {
      ...base,
      outcome: 'auto_approve',
      approvalMode: 'none',
      requiredApprovers: [],
      expiresAt: null,
    };
  }

  const ttlExpiry = addMinutes(ctx.now, policy.approvalTtlSeconds / 60);
  return {
    ...base,
    outcome: 'needs_confirmation',
    approvalMode: mode,
    requiredApprovers: requiredApproversFor(mode, p, policy, byId, ctx.members),
    expiresAt: earliest(ttlExpiry, p.holdExpiresAt),
  };
}

/**
 * The members a booking is about (T-104, SAFETY §2.1): its attendees, whoever's
 * card is charged (`paidBy.memberId`, or every payer under `per_person_cards`),
 * and the guardian of each minor attendee. Anyone else (excluded, out tonight,
 * "Henry's sick" on Dean's card) is not a party to it.
 */
export function bookingParties(
  p: Pick<BookingProposal, 'attendees' | 'payers' | 'paidBy'>,
  byId: ReadonlyMap<MemberId, MemberView>,
): ReadonlySet<MemberId> {
  const cardOwners =
    p.paidBy.kind === 'member_card' ? [p.paidBy.memberId] : p.payers.map((s) => s.memberId);
  return new Set([...p.attendees, ...cardOwners, ...minorAttendeeGuardians(p, byId)]);
}

/** Adult guardians (who can approve) of the booking's minor attendees, in attendee order. */
function minorAttendeeGuardians(
  p: Pick<BookingProposal, 'attendees'>,
  byId: ReadonlyMap<MemberId, MemberView>,
): MemberId[] {
  const out: MemberId[] = [];
  for (const id of p.attendees) {
    const m = byId.get(id);
    if (m?.isMinor !== true || m.guardianMemberId === undefined) continue;
    const g = byId.get(m.guardianMemberId);
    if (canApprove(g)) out.push(g.memberId);
  }
  return unique(out);
}

/**
 * The `any_one` approver set (T-104, SAFETY §2.1): the eligible pool
 * (`policy.approvers`, adults only), the requester (one-tap) and the guardians
 * of minor attendees, kept only if they are a party to the booking
 * (`bookingParties`). So Henry, left off "the 5 of us", never approves a charge
 * on Dean's card, but does approve his own request on his own card.
 *
 * When no party can approve (a kid-only booking with no guardian in the group,
 * or a named approver list that names no party), the pool stands in: it
 * respects `policy.approvers`, and a non-party requester is not added. Only
 * when the pool is empty too does the requester, then any adult member, stand
 * in. The result is empty only when the group has no adult who can approve.
 */
export function anyOneApprovers(
  p: Pick<BookingProposal, 'attendees' | 'payers' | 'paidBy'>,
  pool: readonly MemberId[],
  requesterId: MemberId | undefined,
  byId: ReadonlyMap<MemberId, MemberView>,
): readonly MemberId[] {
  const parties = bookingParties(p, byId);
  const guardians = minorAttendeeGuardians(p, byId);
  const candidates = unique([
    ...pool,
    ...(requesterId === undefined ? [] : [requesterId]),
    ...guardians,
  ]);
  const party = candidates.filter((id) => parties.has(id));
  if (party.length > 0) return party;
  if (pool.length > 0) return unique(pool);
  if (requesterId !== undefined) return [requesterId];
  return [...byId.values()].filter(canApprove).map((m) => m.memberId);
}

/**
 * any_one: `anyOneApprovers` (pool, requester and guardians, booking parties
 * only). each_payer: every adult payer, plus one adult (guardian, else
 * requester, else first eligible approver) per minor payer.
 */
function requiredApproversFor(
  mode: ApprovalMode,
  p: BookingProposal,
  policy: GroupSpendingPolicy,
  byId: ReadonlyMap<MemberId, MemberView>,
  members: readonly MemberView[],
): readonly MemberId[] {
  const listed =
    policy.approvers === 'any_adult_member'
      ? members
      : policy.approvers.map((id) => byId.get(id)).filter((m): m is MemberView => m !== undefined);
  const pool = listed.filter(canApprove).map((m) => m.memberId);
  const requester = byId.get(p.requestedBy);
  const requesterId = canApprove(requester) ? requester.memberId : undefined;

  if (mode === 'any_one') {
    return anyOneApprovers(p, pool, requesterId, byId);
  }

  const required: MemberId[] = [];
  for (const payer of p.payers) {
    const m: MemberView | undefined = byId.get(payer.memberId);
    if (m === undefined) continue;
    if (canApprove(m)) {
      required.push(m.memberId);
      continue;
    }
    const minor: MemberView = m;
    if (minor.isMinor) {
      const guardian =
        minor.guardianMemberId === undefined ? undefined : byId.get(minor.guardianMemberId);
      const standIn = canApprove(guardian)
        ? guardian.memberId
        : (requesterId ?? pool[0] ?? members.find(canApprove)?.memberId);
      if (standIn !== undefined) required.push(standIn);
    }
  }
  return unique(required);
}

/** The rule that decided the outcome: the first fired rule (deny rules come first). */
export function decidingRule(
  decision: PolicyDecision,
): { readonly ruleId: string; readonly reason: ReasonCode } | null {
  const ruleId = decision.ruleIds[0];
  const reason = decision.reasons[0];
  return ruleId === undefined || reason === undefined ? null : { ruleId, reason };
}

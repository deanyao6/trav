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
import { AUTO_BUY_KINDS, NON_REFUNDABLE_AUTO_MAX_MINOR, tabAutoCapOf } from '../domain/approval.js';
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
  { id: 'C3', stage: 'confirm', reasons: ['over_per_person_cap', 'over_tab_auto_cap'] },
  { id: 'C4', stage: 'confirm', reasons: ['over_member_share_cap'] },
  { id: 'C5', stage: 'confirm', reasons: ['non_refundable'] },
  { id: 'C6', stage: 'confirm', reasons: ['over_daily_cap'] },
  { id: 'C7', stage: 'confirm', reasons: ['over_trip_cap'] },
  { id: 'C8', stage: 'confirm', reasons: ['minor_is_payer'] },
  { id: 'C9', stage: 'confirm', reasons: ['payer_not_requester'] },
  { id: 'C10', stage: 'confirm', reasons: ['card_not_requester', 'minor_requester'] },
  { id: 'C11', stage: 'confirm', reasons: ['not_general_purpose'] },
  { id: 'C12', stage: 'confirm', reasons: ['requester_not_attendee'] },
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
 * SAFETY §2.1 rules D1..D10 then C1..C12, in order; all rules run so `reasons`
 * is complete. "At the cap" is inside the cap (`>` not `>=`).
 *
 * Approval tiers (T-168, D-044): only a proposal with `ctx.ask` can
 * auto-approve.
 * - (a) `explicit` (an unambiguous ask, `autoBuyVerdict`), a general-purpose
 *   kind (`AUTO_BUY_KINDS`), total at or under `autoApproveCapMinor` (default
 *   €500), and non-refundable only up to €200 (`NON_REFUNDABLE_AUTO_MAX_MINOR`).
 * - (b) `pick` (a member's pick on Trav's options card): the same, except the
 *   non-refundable line, which the options card states for each option.
 * - (c) everything else keeps the card: no ask, flights/lodging/transport
 *   (C2, C11), over the cap (C1), non-refundable over €200 (C5), and every
 *   other confirmation trigger below (member share caps, daily/trip caps,
 *   someone else's card, a minor).
 *
 * Beyond the SAFETY table:
 * - C1 reports `default_confirm` when there is no ask or `autoApproveCapMinor`
 *   is 0 (auto-buy off), and `over_auto_cap` when an ask's total is over the cap.
 * - Outside the auto tier (no ask, auto-buy off, or over the cap) the card
 *   rules are exactly the pre-T-168 ones: C3 per-person cap, C5 any
 *   non-refundable.
 * - Inside it, C3 checks the tab cap instead (T-193, D-046): any share of a
 *   payer other than the requester over `tabAutoCapOf(policy)` (default €100)
 *   fires `over_tab_auto_cap` (each_payer). The requester's own share is
 *   bounded by the total cap and their own share cap (C4).
 * - C11 (`not_general_purpose`): an in-tier ask for anything but tickets/other.
 * - C12 (`requester_not_attendee`, T-193): an in-tier ask or pick whose
 *   requester is not one of the attendees ("for chase and henry", "everyone
 *   but me") gets the one-tap card (any_one).
 * - C9 (`payer_not_requester`): with `paidBy: per_person_cards`, charging a
 *   card other than the requester's needs that card holder's confirmation
 *   (`each_payer`). Under `member_card` the requester's card pays and the others
 *   only owe on the tab, so the requester's one tap suffices.
 * - C10 (T-148, D-030): a `member_card` that isn't the requester's
 *   (`card_not_requester`), or any request from a minor (`minor_requester`),
 *   never auto-approves, whatever the caps. The card owner is a required
 *   approver (their guardian stands in for a minor owner): under `any_one` the
 *   card owner is the only approver; under `each_payer` they are added to the
 *   list. A minor's request on `per_person_cards` is `each_payer`.
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
  // T-168 (D-044): only an explicit ask or an option pick can skip the card.
  const ask = ctx.ask;
  const autoOn = ask !== undefined && policy.autoApproveCapMinor > 0;
  // The auto tier the proposal is in: an ask, auto-buy on, total inside the
  // cap. Outside it (no ask, auto-buy off, over the cap) every card rule of
  // the confirm flow applies as before T-168.
  const tier = autoOn && p.totalMinor <= policy.autoApproveCapMinor ? ask : undefined;
  if (!autoOn) {
    fire('C1', 'default_confirm', 'any_one');
  } else if (tier === undefined) {
    fire('C1', 'over_auto_cap', 'any_one');
  }

  if (policy.alwaysEachPayerKinds.includes(p.kind)) {
    fire('C2', 'kind_requires_each_payer', 'each_payer');
  }
  // The per-person cap gates the card flow. An asked-for purchase is gated by
  // its total (the auto-buy cap), each member's own share cap (C4), and, for
  // anyone who didn't ask, the tab cap (T-193, D-046): nobody is put on the
  // tab for more than it on someone else's word.
  if (tier === undefined && p.payers.some((s) => s.shareMinor > policy.perPersonAutoCapMinor)) {
    fire('C3', 'over_per_person_cap', 'each_payer');
  }
  if (tier !== undefined) {
    const tabCap = tabAutoCapOf(policy);
    if (p.payers.some((s) => s.memberId !== p.requestedBy && s.shareMinor > tabCap)) {
      fire('C3', 'over_tab_auto_cap', 'each_payer');
    }
  }
  const overMemberShareCap = p.payers.some((s) => {
    const cap = ctx.prefs[s.memberId]?.perBookingShareCapMinor;
    return cap !== null && cap !== undefined && s.shareMinor > cap;
  });
  if (overMemberShareCap) fire('C4', 'over_member_share_cap', 'each_payer');

  // T-168 (c): non-refundable over €200 keeps the card on an explicit ask. A
  // pick is made on an options card that states each total and "non-refundable",
  // so the pick itself is that approval (D-044).
  if (
    !p.refundable &&
    (tier === undefined || (tier === 'explicit' && p.totalMinor > NON_REFUNDABLE_AUTO_MAX_MINOR))
  ) {
    fire('C5', 'non_refundable', 'any_one');
  }
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
  // C10: someone else's card, or a minor asking, always needs the card owner's 👍.
  const cardNotRequester = p.paidBy.kind === 'member_card' && p.paidBy.memberId !== p.requestedBy;
  const minorRequester = requester?.isMinor === true;
  if (cardNotRequester) fire('C10', 'card_not_requester', 'any_one');
  if (minorRequester) {
    fire('C10', 'minor_requester', p.paidBy.kind === 'per_person_cards' ? 'each_payer' : 'any_one');
  }
  // C11 (T-168 c): flights, lodging and transport are never bought on an ask alone.
  if (tier !== undefined && !AUTO_BUY_KINDS.includes(p.kind)) {
    fire('C11', 'not_general_purpose', 'any_one');
  }
  // C12 (T-193, SAFETY T17): an ask or a pick buys on its own only when the
  // asker is one of the people going. "for chase and henry", "everyone but
  // me" get the one-tap card instead.
  if (tier !== undefined && !p.attendees.includes(p.requestedBy)) {
    fire('C12', 'requester_not_attendee', 'any_one');
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
    requiredApprovers: requiredApproversFor(
      mode,
      p,
      policy,
      byId,
      ctx.members,
      cardNotRequester || minorRequester,
    ),
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
 * With C10 (`ownerRequired`) the card owner must approve: under `any_one`
 * they are the only approver (the list above stands in only when nobody can
 * approve for the owner); under `each_payer` they are added to it.
 */
function requiredApproversFor(
  mode: ApprovalMode,
  p: BookingProposal,
  policy: GroupSpendingPolicy,
  byId: ReadonlyMap<MemberId, MemberView>,
  members: readonly MemberView[],
  ownerRequired: boolean,
): readonly MemberId[] {
  const base = baseApprovers(mode, p, policy, byId, members);
  if (!ownerRequired) return base;
  const ownerIds =
    p.paidBy.kind === 'member_card' ? [p.paidBy.memberId] : p.payers.map((s) => s.memberId);
  const owners = unique(
    ownerIds
      .map((id) => cardOwnerApprover(id, byId))
      .filter((id): id is MemberId => id !== undefined),
  );
  if (owners.length === 0) return base;
  return mode === 'any_one' ? owners : unique([...base, ...owners]);
}

/** Who approves for a card owner (C10): the owner, else a minor owner's adult guardian. */
function cardOwnerApprover(
  id: MemberId,
  byId: ReadonlyMap<MemberId, MemberView>,
): MemberId | undefined {
  const m: MemberView | undefined = byId.get(id);
  if (m === undefined) return undefined;
  if (!m.isMinor) return canApprove(m) ? id : undefined;
  const g = m.guardianMemberId === undefined ? undefined : byId.get(m.guardianMemberId);
  return canApprove(g) ? g.memberId : undefined;
}

function baseApprovers(
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

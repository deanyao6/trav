/**
 * Who is charged for a booking (VOICE §8 "Money", SAFETY §2.5, §2.7). A leaf:
 * the proposal service, the roster's booking party and the purchase re-check
 * all derive payers from the attendees through this one rule, so they agree.
 *
 *  - No minors, no family tab: the attendees, unchanged.
 *  - A minor is never charged: their share is carried by their guardian
 *    (`guardianMemberId`, an active adult). A minor with no valid guardian
 *    stays listed, and `ApprovalPolicy` C8 (`minor_is_payer`) then needs an
 *    adult's 👍 while the ledger refuses to fold them (never guessed).
 *  - Family tab (`Trip.familyTab`): one pot, adults-only bookings included
 *    (VOICE §8, D-030), so one adult carries it all: the
 *    requester if they are an adult attendee or the guardian of a minor
 *    attendee, else the requester's guardian under the same condition, else
 *    the first adult attendee (or minor attendee's guardian) in attendee
 *    order; only with no adult at all does the per-guardian rule above apply.
 */
import type { IsoDateTime, Member, MemberId } from '@trav/core';
import { safety } from '@trav/core';

export interface PayerRule {
  readonly members: readonly Member[];
  readonly now: IsoDateTime;
  readonly familyTab: boolean;
  readonly requestedBy: MemberId;
}

function adult(m: Member | undefined, now: IsoDateTime): m is Member {
  return (
    m !== undefined &&
    m.active &&
    m.leftAt === undefined &&
    m.role !== 'guest' &&
    !safety.isMinor(m, now)
  );
}

/** The guardian who carries a minor attendee's share, or undefined (not a minor, or no valid guardian). */
function guardianFor(
  id: MemberId,
  rule: PayerRule,
  byId: ReadonlyMap<MemberId, Member>,
): MemberId | undefined {
  const m = byId.get(id);
  if (m === undefined || !safety.isMinor(m, rule.now)) return undefined;
  const g = m.guardianMemberId === undefined ? undefined : byId.get(m.guardianMemberId);
  return adult(g, rule.now) && g.memberId !== id ? g.memberId : undefined;
}

/** Payers in attendee order (carriers deduped at first appearance). No rule ⇒ the attendees. */
export function payersFor(attendees: readonly MemberId[], rule?: PayerRule): MemberId[] {
  if (rule === undefined) return [...attendees];
  const byId = new Map(rule.members.map((m) => [m.memberId, m] as const));
  const guardians = new Set(
    attendees
      .map((id) => guardianFor(id, rule, byId))
      .filter((g): g is MemberId => g !== undefined),
  );
  // The family tab is one pot (VOICE §8, D-030), adults-only bookings
  // included ("casino night for me and dad" is all on Dean): no splitting.
  if (rule.familyTab && attendees.length > 0) {
    // Consistency (core `checkProposalConsistency`): a payer attends or guards a minor attendee.
    const eligible = (id: MemberId | undefined): id is MemberId =>
      id !== undefined &&
      adult(byId.get(id), rule.now) &&
      (attendees.includes(id) || guardians.has(id));
    const requester = byId.get(rule.requestedBy);
    if (eligible(rule.requestedBy)) return [rule.requestedBy];
    const theirGuardian = requester?.guardianMemberId;
    if (eligible(theirGuardian)) return [theirGuardian];
    // Still one pot: the first adult on it (or a minor attendee's guardian), in attendee order.
    for (const id of attendees) {
      const carrier = guardianFor(id, rule, byId) ?? id;
      if (eligible(carrier)) return [carrier];
    }
  }
  const out: MemberId[] = [];
  for (const id of attendees) {
    const to = guardianFor(id, rule, byId) ?? id;
    if (!out.includes(to)) out.push(to);
  }
  return out;
}

/** The rule for an existing proposal (the purchase re-check and roster changes use the same one it was built with). */
export function payerRuleFor(
  proposal: { readonly requestedBy: MemberId },
  trip: { readonly familyTab?: boolean },
  members: readonly Member[],
  now: IsoDateTime,
): PayerRule {
  return { members, now, familyTab: trip.familyTab === true, requestedBy: proposal.requestedBy };
}

/**
 * Whose card is charged (T-081 r1 #4). An adult requester pays with their own
 * card. A minor never does: their guardian when the guardian is a payer, else
 * the first adult payer. No adult payer at all ⇒ the requester, and
 * `ApprovalPolicy` C8 (`minor_is_payer`) then holds it for an adult.
 */
export function cardHolderFor(
  requestedBy: MemberId,
  payers: readonly MemberId[],
  rule: PayerRule,
): MemberId {
  const byId = new Map(rule.members.map((m) => [m.memberId, m] as const));
  const requester = byId.get(requestedBy);
  if (requester === undefined || !safety.isMinor(requester, rule.now)) return requestedBy;
  const g = guardianFor(requestedBy, rule, byId);
  if (g !== undefined && payers.includes(g)) return g;
  return payers.find((id) => adult(byId.get(id), rule.now)) ?? requestedBy;
}

/** Whose share an attendee's ticket lands on, given the payer list from `payersFor`. */
export function carrierOf(id: MemberId, payers: readonly MemberId[], rule: PayerRule): MemberId {
  if (payers.includes(id)) return id;
  if (payers.length === 1) return payers[0]!;
  const byId = new Map(rule.members.map((m) => [m.memberId, m] as const));
  const g = guardianFor(id, rule, byId);
  return g !== undefined && payers.includes(g) ? g : id;
}

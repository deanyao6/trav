/**
 * Identity gate (SAFETY §2.5). Identity is the channel's: a member is found by
 * `senderId` only; display names are labels. Guests may chat and be answered,
 * but may not request bookings, approve, pay, log expenses or change settings.
 * Text that names another member ("Dean said it's fine", "everyone's in")
 * contributes nothing to any approval, and a minor's "yes" is ignored.
 *
 * These are pure functions over `Member`s; the loop and the tools call them.
 */
import type {
  BookingProposal,
  GroupId,
  IsoDateTime,
  Member,
  MemberId,
  MemberRepository,
  PolicyDecision,
  SenderId,
} from '@trav/core';
import { safety } from '@trav/core';
import type { ApprovalIntent } from './approval/events.js';
import { stripInvisible } from './untrusted.js';

// The alias and tapback classifiers live with the normalizer (approval/events.ts)
// so there is one definition of "what counts as approval" (VOICE §6.2).
export { classifyApprovalText, reactionIntent, type ApprovalIntent } from './approval/events.js';

export type Identity =
  | { readonly kind: 'member'; readonly member: Member }
  | { readonly kind: 'guest'; readonly senderId: SenderId; readonly displayName?: string };

/** `members.getBySenderId` only. An inactive member is a guest for authorization purposes. */
export function resolveIdentity(
  members: Pick<MemberRepository, 'getBySenderId'>,
  groupId: GroupId,
  senderId: SenderId,
  displayName?: string,
): Identity {
  const member = members.getBySenderId(groupId, senderId);
  if (member !== undefined && member.active && member.leftAt === undefined) {
    return { kind: 'member', member };
  }
  return displayName === undefined
    ? { kind: 'guest', senderId }
    : { kind: 'guest', senderId, displayName };
}

export function memberOf(identity: Identity): Member | null {
  return identity.kind === 'member' ? identity.member : null;
}

/** Active, non-guest member (minors included: they may ask, the policy decides what they may pay for). */
export function canRequest(identity: Identity): identity is Extract<Identity, { kind: 'member' }> {
  return identity.kind === 'member' && identity.member.role !== 'guest';
}

/** Adult, active, non-guest: the only people whose 👍 means anything (SAFETY §2.5, §2.7). */
export function canApprove(identity: Identity, now: IsoDateTime): boolean {
  return canRequest(identity) && !safety.isMinor(identity.member, now);
}

/** Leads (and guardians, who are leads in family mode) set caps and roast mode. */
export function isLead(identity: Identity): boolean {
  return (
    identity.kind === 'member' &&
    (identity.member.role === 'lead' || identity.member.role === 'guardian')
  );
}

// ---------- claims on someone else's behalf ----------

export type ClaimedApproval =
  /** "Dean said it's fine": the text speaks for one named member. */
  | { readonly kind: 'named'; readonly claimedFor: MemberId }
  /** "everyone's in": a claim about the group that names nobody in particular. */
  | { readonly kind: 'everyone' };

/**
 * "Dean said it's fine", "Dean's ok", "Dean is good". Attendance words ("in",
 * "down") are deliberately absent: "Henry's in now too" is a roster line for
 * the roster handler, not Henry's consent (T-066). The consent word must end
 * the claim: the end of the text, punctuation, "with it/that", "to go", or
 * an approval word ("dean said yes, book it", "dean says yes book it").
 * "dean is ok right? he was sick" and "dean said it's good to meet at 9"
 * are about Dean, not his consent.
 */
const CONSENT_END = String.raw`(?=\s*(?:$|[^\w\s']|with (?:it|that|this)\b|to go\b|(?:so\s+|and\s+|just\s+|pls\s+|please\s+)?(?:yes|yep|go ahead|go for it|book it|do it|approve|confirm|lock it in|send it)\b))`;
/**
 * Strong consent words ("yes", "go ahead", "go for it", "approved", "book it",
 * "do it") are a claim whatever follows ("dean said yes to the razzmatazz
 * tickets", "dean said go for it, he is paying"); weak ones ("ok", "fine",
 * "cool", "good", "go") only when they end the claim (`CONSENT_END`), so
 * "dean is ok right?" and "dean said it's good to meet at 9" are not claims.
 */
const SAID_YES = String.raw`(?:'s|\s+(?:said|says|is|told me|texted|confirmed))\s+(?:it'?s\s+)?(?:(?:yes|go ahead|go for it|approved|book it|do it|all good|a go)\b|(?:ok(?:ay)?|fine|cool|good|go)\b${CONSENT_END})`;
/**
 * "everyone's in" as a whole claim: followed by the end of the text,
 * punctuation, or an approval word ("everyone's in, book it", "we're all
 * good 👍"). "everyone's in the lobby" is a sentence about a lobby (T-066).
 */
const EVERYONE_IN =
  /\b(?:everyone|everybody|we all|all of us)(?:'s| is| are| said)?\s+(?:in|down|fine with it|ok(?:ay)? with it|said yes|good|approved?)(?=\s*(?:$|[^\w\s']|(?:so\s+|and\s+|just\s+|pls\s+|please\s+)?(?:yes|yep|go ahead|go for it|book it|do it|approve|confirm|lock it in|send it)\b))/i;

/**
 * Text that claims someone else's consent: "Dean said it's fine", "Henry's
 * in" (`named`, with the member), or "everyone's in" (`everyone`, which picks
 * no target: nobody in particular was named, so nobody in particular is
 * tagged). Claims about oneself are just a sentence. Matching is on display
 * names, which is why a `named` claim is only ever used to REJECT.
 */
export function detectClaimedApproval(
  text: string,
  members: readonly Member[],
  sender: MemberId | null,
): ClaimedApproval | undefined {
  const t = stripInvisible(text).replace(/\s+/g, ' ');
  for (const m of members) {
    if (m.memberId === sender) continue;
    const name = m.displayName.trim();
    if (name.length === 0) continue;
    const re = new RegExp(`\\b${escapeRegExp(name)}${SAID_YES}`, 'i');
    if (re.test(t)) return { kind: 'named', claimedFor: m.memberId };
  }
  if (EVERYONE_IN.test(t)) return { kind: 'everyone' };
  return undefined;
}

/**
 * Approval-shaped words that turn a claim about someone else ("Dean said it's
 * fine, go ahead") into an attempted approval even when Trav is not addressed.
 * Without one of these, "Maya is in the shower" is just chat and gets nothing.
 */
const APPROVAL_INTENT_WORD =
  /(?:\b(?:yes|yep|go ahead|go for it|book it|do it|approve[ds]?|confirm(?:ed|s)?|green light|lock it in|send it)\b|👍)/i;

export function hasApprovalIntentWord(text: string): boolean {
  return APPROVAL_INTENT_WORD.test(stripInvisible(text));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- the gate ----------

export type ApprovalGateCause =
  | 'guest'
  | 'minor'
  | 'not_member'
  | 'claimed_for_other'
  | 'ambiguous'
  | 'no_pending'
  /** A bare alias from someone who is not the requester and referenced no card (SAFETY §2.1): chat, not an approval. */
  | 'not_requester';

export type ApprovalGateResult =
  | { readonly kind: 'ignored'; readonly cause: ApprovalGateCause }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly BookingProposal[] }
  | { readonly kind: 'candidate'; readonly proposal: BookingProposal };

export interface ApprovalGateInput {
  readonly identity: Identity;
  readonly intent: ApprovalIntent;
  /** Text of the message (for "Dean said yes" detection); empty for taps. */
  readonly text: string;
  readonly members: readonly Member[];
  /** Pending proposals in this group, newest first. */
  readonly pending: readonly BookingProposal[];
  readonly decisionFor: (proposalId: string) => PolicyDecision | undefined;
  /** Proposal the event is bound to (button, tapback or quote-reply), if any. */
  readonly boundProposalId?: string;
  readonly now: IsoDateTime;
}

/**
 * SAFETY §2.5 pre-check before an approval event reaches the handler:
 * guests and minors are ignored. A claim on someone else's behalf ("Dean said
 * yes") is ignored. "everyone's in, book it" names nobody, so it is the
 * sender's own attempt, and it counts only where the sender is a required
 * approver (D-019). Binding (SAFETY §2.1): a bound card (button, tapback,
 * quote-reply, reply-window card) wins; otherwise a bare "yes" / "no" (and a
 * card-less "everyone's in, book it", T-066) binds only to the sender's OWN
 * pending proposal (requester), a bare "not me" to the proposal the sender
 * is charged on (an opt-out never spends and only ever produces a fresh
 * card), two or more ⇒ `ambiguous` (Trav asks which), none ⇒
 * `not_requester` (anyone else must reference the card, so their bare "yes"
 * is chat).
 */
export function gateApproval(input: ApprovalGateInput): ApprovalGateResult {
  const { identity, now } = input;
  if (identity.kind !== 'member') return { kind: 'ignored', cause: 'guest' };
  if (identity.member.role === 'guest') return { kind: 'ignored', cause: 'guest' };
  if (safety.isMinor(identity.member, now)) return { kind: 'ignored', cause: 'minor' };
  const me = identity.member.memberId;

  let ownAsApprover = false;
  const claim =
    input.text.length > 0 ? detectClaimedApproval(input.text, input.members, me) : undefined;
  if (claim !== undefined) {
    if (claim.kind === 'named' || !hasApprovalIntentWord(input.text)) {
      return { kind: 'ignored', cause: 'claimed_for_other' };
    }
    ownAsApprover = true;
  }
  const isApprover = (p: BookingProposal): boolean =>
    input.decisionFor(p.proposalId)?.requiredApprovers.includes(me) === true;

  if (input.boundProposalId !== undefined) {
    const bound = input.pending.find((p) => p.proposalId === input.boundProposalId);
    if (bound === undefined) return { kind: 'ignored', cause: 'no_pending' };
    if (ownAsApprover && !isApprover(bound)) return { kind: 'ignored', cause: 'claimed_for_other' };
    return { kind: 'candidate', proposal: bound };
  }

  if (input.pending.length === 0) return { kind: 'ignored', cause: 'no_pending' };

  const mine = (p: BookingProposal): boolean => p.requestedBy === me;
  const chargedOrMine = (p: BookingProposal): boolean =>
    mine(p) || p.attendees.includes(me) || p.payers.some((s) => s.memberId === me);
  if (ownAsApprover) {
    // Card-less "everyone's in, book it": the same requester-only binding as
    // a bare "yes" (SAFETY §2.1), and then only where the requester is also
    // an approver. Anyone else must reply to the card or tap it.
    const own = input.pending.filter(mine);
    if (own.length === 0) return { kind: 'ignored', cause: 'not_requester' };
    const approvable = own.filter(isApprover);
    if (approvable.length === 0) return { kind: 'ignored', cause: 'claimed_for_other' };
    if (approvable.length === 1) return { kind: 'candidate', proposal: approvable[0]! };
    return { kind: 'ambiguous', candidates: approvable };
  }
  const candidates = input.pending.filter(input.intent === 'not_me' ? chargedOrMine : mine);
  if (candidates.length === 0) return { kind: 'ignored', cause: 'not_requester' };
  if (candidates.length === 1) return { kind: 'candidate', proposal: candidates[0]! };
  return { kind: 'ambiguous', candidates };
}

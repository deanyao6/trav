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
import { TEXT_ALIASES } from './approval/events.js';
import { stripInvisible } from './untrusted.js';

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

// ---------- approval-shaped text ----------

export type ApprovalIntent = 'approve' | 'decline' | 'not_me';

const TRAILING_NOISE = /[\s!.,;:)]+$/u;
const LEADING_NOISE = /^[\s(]+/u;

function normalizeAlias(text: string): string {
  return stripInvisible(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(LEADING_NOISE, '')
    .replace(TRAILING_NOISE, '')
    .replace(/^@trav\s*[,:]?\s*/, '')
    .replace(/^(?:hey |ok |okay |yeah )?trav\s*[,:]?\s*/, '')
    .trim();
}

/**
 * The whole message is one of the VOICE §6.2 text aliases ("yes", "book it",
 * "nah", "not me"), optionally prefixed by "@trav"/"trav," and followed by
 * punctuation. Anything longer is a sentence, not an approval.
 */
export function classifyApprovalText(text: string): ApprovalIntent | undefined {
  const t = normalizeAlias(text);
  if (t.length === 0) return undefined;
  for (const intent of ['approve', 'decline', 'not_me'] as const) {
    if (TEXT_ALIASES[intent].some((alias) => alias === t)) return intent;
  }
  return undefined;
}

/** Tapbacks and reaction names that mean 👍 / 👎 (iMessage names, emoji). */
export function reactionIntent(reaction: string): ApprovalIntent | undefined {
  const r = reaction.trim().toLowerCase();
  if (r === '👍' || r === 'like' || r === 'thumbs_up' || r === 'thumbsup' || r === '+1') {
    return 'approve';
  }
  if (r === '👎' || r === 'dislike' || r === 'thumbs_down' || r === 'thumbsdown' || r === '-1') {
    return 'decline';
  }
  return undefined;
}

export interface ClaimedApproval {
  /** The member the text speaks for. */
  readonly claimedFor: MemberId;
}

const SAID_YES = String.raw`(?:'s|\s+(?:said|says|is|told me|texted|confirmed))\s+(?:it'?s\s+)?(?:yes|ok(?:ay)?|fine|cool|good|go|in|down|approved|book it|do it|all good|a go)\b`;
const EVERYONE_IN =
  /\b(?:everyone|everybody|we all|all of us)(?:'s| is| are| said)?\s+(?:in|down|fine with it|ok(?:ay)? with it|said yes|good|approved?)\b/i;

/**
 * Text that claims another member's consent: "Dean said it's fine", "Henry's
 * in", "everyone's in". Returns the named member when it is someone other
 * than the sender (claims about oneself are just a sentence). Matching is on
 * display names, which is why the result is only ever used to REJECT.
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
    if (re.test(t)) return { claimedFor: m.memberId };
  }
  if (EVERYONE_IN.test(t)) {
    const other = members.find((m) => m.memberId !== sender);
    if (other !== undefined) return { claimedFor: other.memberId };
  }
  return undefined;
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
  | 'no_pending';

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
 * guests and minors are ignored; a claim on someone else's behalf is ignored;
 * a bare alias binds to the bound card, else to the sender's single relevant
 * pending proposal; two or more ⇒ `ambiguous` (Trav asks which).
 */
export function gateApproval(input: ApprovalGateInput): ApprovalGateResult {
  const { identity, now } = input;
  if (identity.kind !== 'member') return { kind: 'ignored', cause: 'guest' };
  if (identity.member.role === 'guest') return { kind: 'ignored', cause: 'guest' };
  if (safety.isMinor(identity.member, now)) return { kind: 'ignored', cause: 'minor' };
  const me = identity.member.memberId;

  if (input.text.length > 0 && detectClaimedApproval(input.text, input.members, me)) {
    return { kind: 'ignored', cause: 'claimed_for_other' };
  }

  if (input.boundProposalId !== undefined) {
    const bound = input.pending.find((p) => p.proposalId === input.boundProposalId);
    return bound === undefined
      ? { kind: 'ignored', cause: 'no_pending' }
      : { kind: 'candidate', proposal: bound };
  }

  if (input.pending.length === 0) return { kind: 'ignored', cause: 'no_pending' };

  // Relevant = I requested it, I am charged on it, or I am a required approver.
  const relevant = input.pending.filter((p) => {
    if (p.requestedBy === me || p.payers.some((s) => s.memberId === me)) return true;
    const d = input.decisionFor(p.proposalId);
    return d !== undefined && d.requiredApprovers.includes(me);
  });
  const candidates = relevant.length > 0 ? relevant : input.pending;
  if (candidates.length === 1) return { kind: 'candidate', proposal: candidates[0]! };
  return { kind: 'ambiguous', candidates };
}

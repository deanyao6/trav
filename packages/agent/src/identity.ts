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
  | { readonly kind: 'everyone' }
  /**
   * "i'll approve for him" / "approve for dean and maya": relayed consent for
   * others only (named in `others` when the text names them), never the
   * sender's own 👍 (T-132).
   */
  | { readonly kind: 'proxy'; readonly others: readonly MemberId[] }
  /**
   * "i approve for all of us", "i approve for me and henry", a guardian's
   * "i'll approve for lily": the sender's OWN approval (it counts where they
   * are a required approver), plus a claim for `others` (or, `group`, for
   * everyone else) that never counts (T-132 r1 #2). A guardian approving for
   * their own minor is only their own approval (D-028).
   */
  | { readonly kind: 'with_self'; readonly others: readonly MemberId[]; readonly group: boolean };

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
  const relay = relayedApproval(t, members, sender);
  if (relay !== undefined) {
    if (relay.self) return { kind: 'with_self', others: relay.others, group: relay.group };
    if (relay.others.length === 1 && !relay.group && !relay.unresolved) {
      return { kind: 'named', claimedFor: relay.others[0]! };
    }
    return { kind: 'proxy', others: relay.others };
  }
  if (EVERYONE_IN.test(t)) return { kind: 'everyone' };
  return undefined;
}

/**
 * An approval word, then who it is "for" ("i'll approve for him", "approve on
 * behalf of henry", "approved for henry", "👍 for henry", "yes for henry too",
 * "i approve for me and henry", "i approve for both of us"), or "… on henry's
 * behalf". The subject, if any, is the sender ("can you confirm for everyone
 * what time" is a question to Trav, not an approval).
 */
const RELAY_VERB = String.raw`(?:^|[\s,.!:;(])(?<subj>(?:i|i'll|ill|i will|i'm|im|i am|let me|i can|i'd|we'll|we will|we can)\s+(?:just\s+|gonna\s+|going to\s+|also\s+)?)?(?:approve[sd]?|approving|confirm(?:s|ed|ing)?|yes|yep|👍|sign(?:ed|ing)? off|say(?:ing)? yes|vote yes)`;
const RELAY_FOR = new RegExp(
  String.raw`${RELAY_VERB}\s*(?:it\s+|this\s+|that\s+|(?:this|that|the) one\s+)?(?<too>too\s+|also\s+)?(?:for|on behalf of|in place of|instead of)\s+(?<who>[^.!?;]*)`,
  'iu',
);
const RELAY_BEHALF = new RegExp(
  String.raw`${RELAY_VERB}\s*(?:it\s+|this\s+|that\s+)?on\s+(?<who>his|her|their|[\p{L}][\p{L}-]*'s)\s+behalf\b`,
  'iu',
);
/** A bare verb asked of someone else ("can you confirm for everyone …") is no approval. */
const ASKED_OF_OTHERS =
  /\b(?:you|u|they|he|she|to|should|would|could|can|will|did|does|do|pls|please)\s*$/i;
/** A "no" anywhere before the approval verb: "i don't approve", "no way i approve", "never". */
const RELAY_NEGATION =
  /\b(?:don'?t|dont|do not|does not|doesn'?t|not|never|no way|won'?t|wont|can'?t|cant|cannot|didn'?t|wouldn'?t|shouldn'?t|refuse|no)\b/;
/** A question: "should i approve for all of us", "do i approve …", or a trailing "?". */
const RELAY_QUESTION =
  /^\s*(?:@trav\s+)?(?:should|do|does|did|can|could|would|will|shall|may|am)\s+(?:i|we)\b|\?\s*$/i;
/** Someone other than the sender as the subject of the approval verb. */
const RELAY_THIRD_PERSON = /\b(?:he|she|they|he's|she's|they're|hes|shes|theyre)\s*$/;
/** What may come before a subject-less verb that still speaks for the sender. */
const RELAY_OPENER =
  /^\s*(?:@trav[\s,:]*)?(?:(?:yes|yep|yeah|ok|okay|sure|alright|so|and|then|cool|great)[\s,!.]*)*$/;
/** Who "for …" can mean without a name. */
const SELF_WORDS = new Set(['me', 'myself', 'mine']);
const GROUP_PHRASES =
  /\b(?:both of us|all of us|us all|us both|all of them|both of them|the (?:whole )?group|everyone|everybody|all six|all 6)\b/g;
const PRONOUNS = new Set(['him', 'her', 'them', 'his', 'their']);
const CONNECTORS = new Set(['and', '&', 'plus', 'too', 'also', ',']);

interface Relay {
  readonly others: MemberId[];
  readonly self: boolean;
  readonly group: boolean;
  /** A pronoun nobody in the text resolves. */
  readonly unresolved: boolean;
}

/**
 * Who an approval "for …" is for (T-132): the sender themself ("me", their
 * own name, "all of us"/"the group", and a guardian's own minor, D-028), the
 * other members it names (a pronoun resolves to the other members the text
 * names), and whether it speaks for the whole group. Undefined when the
 * words after "for" name nobody ("i approve for sure").
 */
function relayedApproval(
  t: string,
  members: readonly Member[],
  sender: MemberId | null,
): Relay | undefined {
  const forMatch = RELAY_FOR.exec(t);
  const match = forMatch ?? RELAY_BEHALF.exec(t);
  if (match === null) return undefined;
  if (match.groups?.['subj'] === undefined && ASKED_OF_OTHERS.test(t.slice(0, match.index + 1))) {
    return undefined;
  }
  const tail = (match.groups?.['who'] ?? '').toLowerCase();
  if (tail.length === 0) return undefined;
  const people = members.filter((m) => m.displayName.trim().length > 0);
  // T-132 r2 review #1 (blocker): a negated or questioning sentence ("i don't
  // approve for the group", "should i approve for all of us", "… ?") is no
  // approval at all, for anyone.
  // The match opens with a boundary character unless it starts the text.
  const before = t.slice(0, match.index + (/^[\s,.!:;(]/u.test(match[0]) ? 1 : 0)).toLowerCase();
  const subj = (match.groups?.['subj'] ?? '').toLowerCase();
  if (RELAY_NEGATION.test(`${before} ${subj}`) || RELAY_QUESTION.test(t)) return undefined;
  // r2 review #2: someone else as the subject ("henry approves for me too",
  // "maya confirmed for the group") reports their approval; it never counts as
  // the sender's own. Only an explicit first-person subject, or the verb opening
  // the message ("yes for henry too", "👍 for me and henry"), speaks for the sender.
  const othersName = people.some(
    (m) =>
      m.memberId !== sender &&
      new RegExp(`\\b${escapeRegExp(m.displayName.trim().toLowerCase())}\\b`).test(before),
  );
  const reported =
    subj === '' && (othersName || RELAY_THIRD_PERSON.test(before) || !RELAY_OPENER.test(before));
  const nameOf = (w: string): Member | undefined =>
    people.find((m) => m.displayName.trim().toLowerCase() === w.replace(/'s$/, ''));
  let group = false;
  const words = tail
    .replace(GROUP_PHRASES, () => {
      group = true;
      return ' ';
    })
    .replace(/,/g, ' , ')
    .split(/\s+/)
    .filter(Boolean);
  const targets = new Set<MemberId>();
  // "yes for henry too": the sender says yes as well.
  let self = group || match.groups?.['too'] !== undefined;
  let pronoun = false;
  for (const w of words) {
    if (w === 'too' || w === 'also') self = true;
    if (CONNECTORS.has(w)) continue;
    if (SELF_WORDS.has(w)) {
      self = true;
      continue;
    }
    if (PRONOUNS.has(w)) {
      pronoun = true;
      continue;
    }
    const m = nameOf(w);
    if (m === undefined) break;
    targets.add(m.memberId);
  }
  if (!self && !pronoun && targets.size === 0) return undefined;
  let unresolved = false;
  if (pronoun && targets.size === 0) {
    // "henry's at practice, i'll approve for him": the other members the text names.
    const lower = t.toLowerCase();
    const inText = people.filter(
      (m) =>
        m.memberId !== sender &&
        new RegExp(`\\b${escapeRegExp(m.displayName.trim().toLowerCase())}\\b`).test(lower),
    );
    for (const m of inText) targets.add(m.memberId);
    unresolved = inText.length === 0;
  }
  const others: MemberId[] = [];
  for (const id of targets) {
    if (id === sender) {
      self = true;
      continue;
    }
    // A guardian approving for their own minor approves as themself (D-028).
    if (sender !== null && people.find((m) => m.memberId === id)?.guardianMemberId === sender) {
      self = true;
      continue;
    }
    others.push(id);
  }
  // A reported approval is a claim for whoever it names, never the sender's own.
  if (reported) self = false;
  if (!self && others.length === 0 && !group && !pronoun) return undefined;
  return { others, self, group, unresolved };
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
  | {
      readonly kind: 'candidate';
      readonly proposal: BookingProposal;
      /**
       * "i approve for me and henry": the sender's own approval is the
       * candidate; the part said for others (`others`, or `group` for
       * everyone else) never counts and is audited `claimed_for_other` (T-132).
       */
      readonly relayedFor?: { readonly others: readonly MemberId[]; readonly group: boolean };
    };

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
  let relayedFor: { readonly others: readonly MemberId[]; readonly group: boolean } | undefined;
  const claim =
    input.text.length > 0 ? detectClaimedApproval(input.text, input.members, me) : undefined;
  if (claim !== undefined) {
    if (claim.kind === 'with_self') {
      // The sender's own part counts where they are a required approver; the rest is a claim.
      if (claim.others.length > 0 || claim.group) {
        relayedFor = { others: claim.others, group: claim.group };
      }
    } else if (claim.kind !== 'everyone' || !hasApprovalIntentWord(input.text)) {
      return { kind: 'ignored', cause: 'claimed_for_other' };
    }
    ownAsApprover = true;
  }
  const candidate = (proposal: BookingProposal): ApprovalGateResult =>
    relayedFor === undefined
      ? { kind: 'candidate', proposal }
      : { kind: 'candidate', proposal, relayedFor };
  const isApprover = (p: BookingProposal): boolean =>
    input.decisionFor(p.proposalId)?.requiredApprovers.includes(me) === true;

  if (input.boundProposalId !== undefined) {
    const bound = input.pending.find((p) => p.proposalId === input.boundProposalId);
    if (bound === undefined) return { kind: 'ignored', cause: 'no_pending' };
    if (ownAsApprover && !isApprover(bound)) return { kind: 'ignored', cause: 'claimed_for_other' };
    return candidate(bound);
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
    if (approvable.length === 1) return candidate(approvable[0]!);
    return { kind: 'ambiguous', candidates: approvable };
  }
  const candidates = input.pending.filter(input.intent === 'not_me' ? chargedOrMine : mine);
  if (candidates.length === 0) return { kind: 'ignored', cause: 'not_requester' };
  if (candidates.length === 1) return { kind: 'candidate', proposal: candidates[0]! };
  return { kind: 'ambiguous', candidates };
}

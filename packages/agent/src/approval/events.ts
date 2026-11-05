/**
 * One approval code path (VOICE §6, §9.3; D-009). Tapbacks, text aliases and
 * simulator buttons all normalize into `ApprovalEvent`; `ApprovalHandler`
 * (`handler.ts`) is the only consumer and the only caller of
 * `BookingExecutor.execute`.
 */
import type {
  ActionId,
  BookingProposal,
  CardId,
  IsoDateTime,
  MemberId,
  MessageId,
  Outbound,
  ProposalId,
  RichCard,
  SenderId,
  TripId,
} from '@trav/core';
import type { InboundEvent } from '@trav/adapters';
import { stripInvisible } from '../untrusted.js';
import {
  APPROVE_REPLIES,
  DECLINE_REPLIES,
  NOT_ME_REPLIES,
  approvalReplyIntent,
} from './whitelist.js';

export interface ApprovalEvent {
  readonly kind: ActionId;
  /** Channel identity. Never the display name. */
  readonly senderId: SenderId;
  readonly via: 'button' | 'reaction' | 'text';
  readonly messageId: MessageId;
  readonly at: IsoDateTime;
  /** The card the event binds to, when known (buttons and tapbacks always; text only via reply-to). */
  readonly cardId?: CardId;
  readonly proposalId?: ProposalId;
  readonly targetMessageId?: MessageId;
  /** For 'pick': option id or index as typed. */
  readonly value?: string;
}

/**
 * VOICE §6.2 only: a bare "ok" in unrelated chat must never bind to a pending
 * proposal. The T-182 whitelist (`whitelist.ts`) is the source of truth.
 */
export const TEXT_ALIASES: Readonly<Record<'approve' | 'decline' | 'not_me', readonly string[]>> = {
  approve: APPROVE_REPLIES,
  decline: DECLINE_REPLIES,
  not_me: NOT_ME_REPLIES,
};

export interface PendingCardRef {
  readonly cardId: CardId;
  readonly messageId: MessageId;
  readonly card: RichCard;
  readonly proposalId?: ProposalId;
  readonly expiresAt?: IsoDateTime;
  readonly sentAt: IsoDateTime;
}

/** What the normalizer needs to bind a bare "yes" or a tapback to a card. */
export interface PendingCardIndex {
  byMessageId(messageId: MessageId): PendingCardRef | undefined;
  /** Pending proposals the requester (resolved from senderId) created, newest first. */
  pendingProposalsRequestedBy(memberId: MemberId): readonly BookingProposal[];
  /** Trav's last question in this lane, if within the 2-minute reply window (VOICE §2). */
  lastTravQuestion(lane: 'group' | 'dm', memberId?: MemberId): PendingCardRef | undefined;
}

export type NormalizeResult =
  | { readonly kind: 'event'; readonly event: ApprovalEvent }
  | {
      readonly kind: 'ambiguous';
      readonly senderId: SenderId;
      readonly candidates: readonly ProposalId[];
    }
  | { readonly kind: 'none' };

// ---------- approval-shaped text and tapbacks ----------

export type ApprovalIntent = 'approve' | 'decline' | 'not_me';

/**
 * The whole message is one of the VOICE §6.2 text aliases ("yes", "book it",
 * "nah", "not me"), optionally prefixed by "@trav"/"trav," and followed by
 * punctuation or a warm emoji. Anything longer is a sentence, not an
 * approval (T-182 whitelist, `approvalReplyIntent`).
 */
export function classifyApprovalText(text: string): ApprovalIntent | undefined {
  return approvalReplyIntent(text);
}

/** "cancel that", "drop mine", "scrap my ticket": a cancel that names no proposal but the sender's own. */
const OWN_CANCEL_CLAUSE =
  /^(?:(?:pls|please|ok|okay|so|just|yeah|actually)\s+)*(?:cancel|drop|scrap|kill)(?:\s+(?:that|it|this|mine|my one|my ticket|my tix|that one|that ticket|the ticket|the extra one))?(?:\s+(?:pls|plz|please|then|too|for me))?$/;
/**
 * Other clauses a requester's own cancel may carry ("actually nah, staying
 * in. cancel that"): filler or the sender saying they're not going. Anything
 * else (a question, a name, another request) makes it not a bare own-cancel.
 */
const OWN_CANCEL_FILLER =
  /^(?:(?:actually|nah|nvm|never ?mind|wait|hmm+|ugh|ok|okay|sorry|lol|no|nope|yeah|jk|scratch that|changed my mind|on second thought|i changed my mind|i'?m good|im good|i'?m out|im out|i'?ll pass|ill pass|gonna pass|not going|not coming|staying in|staying home|i'?m staying in|im staying in|i'?m staying home|im staying home|maybe next time|next time|all good)\s*)+$/;

/**
 * A message whose request is "cancel my own pending one" (T-137): one cancel
 * clause that names nothing but "that"/"it"/"mine", plus optional filler
 * clauses. The loop binds it only to a proposal the sender asked for, never
 * to someone else's card or to anything already booked.
 */
export function isOwnCancelText(text: string): boolean {
  const t = stripInvisible(text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(^|[^\w@])@trav(?![\w-])\s*[,:]?/g, ' ')
    .replace(/^\s*(?:(?:hey|hi|yo|ok|okay|yeah)\s+)?trav\s*[,:]\s*/, '')
    .trim();
  if (t.length === 0 || t.length > 100) return false;
  const clauses = t
    .split(/[,.;!?\n]+|\s+-+\s+/)
    .map((c) => c.replace(/\s+/g, ' ').trim())
    .filter((c) => c.length > 0);
  const cancels = clauses.filter((c) => OWN_CANCEL_CLAUSE.test(c));
  if (cancels.length !== 1) return false;
  return clauses.every((c) => OWN_CANCEL_CLAUSE.test(c) || OWN_CANCEL_FILLER.test(c));
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

/** Button ids that are approval events on a proposal card (VOICE §6.2 simulator column). */
const PROPOSAL_BUTTONS: readonly ActionId[] = ['approve', 'decline', 'not_me', 'pick'];

function isProposalButton(actionId: string): actionId is ActionId {
  return (PROPOSAL_BUTTONS as readonly string[]).includes(actionId);
}

/**
 * Rules: a button tap or a 👍/👎 on a card binds to that card; a text alias
 * binds to the replied-to card, else to the card of Trav's last question in
 * the reply window, else (requester only) to their single pending proposal
 * (two or more ⇒ `ambiguous`, Trav asks which). A text alias that binds to
 * nothing is still returned as an event without `proposalId`: the loop's
 * identity gate binds it to the one proposal the sender is charged on or
 * must approve, or asks which (SAFETY §2.1 "a confirmation binds to exactly
 * one proposalId"). Anything else is `none`. The display name and any names
 * in the text are ignored; identity is the channel sender only.
 */
export function normalizeApprovalEvent(
  inbound: InboundEvent,
  index: PendingCardIndex,
  senderMemberId: MemberId | null,
  now: IsoDateTime,
): NormalizeResult {
  const none: NormalizeResult = { kind: 'none' };
  switch (inbound.type) {
    case 'member_joined':
    case 'member_left':
      return none;
    case 'button_tap': {
      if (!isProposalButton(inbound.actionId)) return none;
      const ref = index.byMessageId(inbound.cardMessageId);
      if (ref === undefined || ref.proposalId === undefined) return none;
      return {
        kind: 'event',
        event: {
          kind: inbound.actionId,
          senderId: inbound.sender,
          via: 'button',
          messageId: inbound.messageId,
          at: now,
          cardId: ref.cardId,
          proposalId: ref.proposalId,
          targetMessageId: inbound.cardMessageId,
          ...(inbound.value !== undefined ? { value: inbound.value } : {}),
        },
      };
    }
    case 'reaction': {
      if (inbound.removed) return none;
      const intent = reactionIntent(inbound.reaction);
      if (intent === undefined) return none;
      const ref = index.byMessageId(inbound.targetMessageId);
      if (ref === undefined || ref.proposalId === undefined) return none;
      return {
        kind: 'event',
        event: {
          kind: intent,
          senderId: inbound.sender,
          via: 'reaction',
          messageId: inbound.messageId,
          at: now,
          cardId: ref.cardId,
          proposalId: ref.proposalId,
          targetMessageId: inbound.targetMessageId,
        },
      };
    }
    case 'message': {
      const intent = classifyApprovalText(inbound.text);
      if (intent === undefined) return none;
      // A forwarded "yes" is old words from somewhere else (T-182).
      if (inbound.forwarded === true) return none;
      const base = {
        kind: intent,
        senderId: inbound.sender,
        via: 'text' as const,
        messageId: inbound.messageId,
        at: now,
      };
      const bound =
        inbound.replyToMessageId === undefined
          ? undefined
          : index.byMessageId(inbound.replyToMessageId);
      // A quote-reply to one of Trav's other cards (a logged expense, a
      // question) is a reply to that card, never an approval of some
      // unrelated proposal: it must not fall through to the reply window or
      // the requester's own proposal.
      if (bound !== undefined && bound.proposalId === undefined) return none;
      if (bound?.proposalId !== undefined) {
        return {
          kind: 'event',
          event: {
            ...base,
            cardId: bound.cardId,
            proposalId: bound.proposalId,
            targetMessageId: bound.messageId,
          },
        };
      }
      const asked = index.lastTravQuestion(inbound.lane, senderMemberId ?? undefined);
      if (asked?.proposalId !== undefined) {
        return {
          kind: 'event',
          event: {
            ...base,
            cardId: asked.cardId,
            proposalId: asked.proposalId,
            targetMessageId: asked.messageId,
          },
        };
      }
      if (senderMemberId !== null) {
        const mine = index.pendingProposalsRequestedBy(senderMemberId);
        if (mine.length === 1) {
          return { kind: 'event', event: { ...base, proposalId: mine[0]!.proposalId } };
        }
        if (mine.length > 1) {
          return {
            kind: 'ambiguous',
            senderId: inbound.sender,
            candidates: mine.map((p) => p.proposalId),
          };
        }
      }
      return { kind: 'event', event: base };
    }
  }
}

/** Longest `supersededBy` chain followed; a longer one is a store bug, not a card to act on. */
export const MAX_SUPERSEDE_HOPS = 16;

/**
 * The live replacement of a superseded proposal: follows `supersededBy` to
 * the end of the chain (at most `MAX_SUPERSEDE_HOPS`), so a "not me" on an
 * old card still drops the member from the card that replaced it (VOICE
 * §6.2: an opt-out never spends and only ever yields a fresh card). Returns
 * `proposalId` itself when it is not superseded. Only for `not_me`: a 👍 or
 * 👎 on a superseded card stays dead, since the price and count changed.
 */
export function followSupersededBy(
  getProposal: (id: ProposalId) => Pick<BookingProposal, 'status' | 'supersededBy'> | undefined,
  proposalId: ProposalId,
): ProposalId {
  let current = proposalId;
  const seen = new Set<ProposalId>([current]);
  for (let hop = 0; hop < MAX_SUPERSEDE_HOPS; hop++) {
    const p = getProposal(current);
    if (p === undefined || p.status !== 'superseded' || p.supersededBy === undefined) break;
    if (seen.has(p.supersededBy)) break;
    seen.add(p.supersededBy);
    current = p.supersededBy;
  }
  return current;
}

/** A roster change the handler must reconcile pending proposals against. */
export interface RosterChangeNotice {
  readonly groupId: string;
  readonly activityId: string;
  /** Ids and statuses only; the reason is never carried (SAFETY §2.8). */
  readonly changes: readonly {
    readonly memberId: MemberId;
    readonly status: 'in' | 'out' | 'maybe';
  }[];
  /** Who made the change (channel-resolved member). */
  readonly by: MemberId;
  readonly messageId: MessageId;
}

export interface ApprovalHandler {
  /** Applies the event to the grant, audits, and on completion calls the executor. Returns the outbound messages for this turn. */
  handle(event: ApprovalEvent): Promise<readonly Outbound[]>;
  /**
   * A proposal the policy auto-approved (`outcome: 'auto_approve'`, synthetic
   * complete grant): the loop hands it here instead of calling the executor
   * itself, so this module stays the only caller. Executes once, then renders
   * the receipt and ticket DMs (or the failure line) exactly like a 👍 would.
   * Returns nothing when the proposal is not pending, was not auto-approved,
   * or is already executing.
   */
  autoApproved(proposalId: ProposalId, sourceMessageId: MessageId): Promise<readonly Outbound[]>;
  /**
   * A roster change for an activity: a pending proposal whose attendees no
   * longer match the roster is invalidated (`approval.invalidated{payers_changed}`),
   * superseded and re-priced; a member who joins after the booking is offered
   * a separate ticket. Returns the outbound messages for this turn.
   */
  rosterChanged(notice: RosterChangeNotice): Promise<readonly Outbound[]>;
  /**
   * A purchase whose money moved but whose ledger expense or tickets never
   * landed (the executor threw after `booking.completed`): the next @ on the
   * trip finishes it through the executor's duplicate path (never a second
   * purchase) and returns the receipt and ticket DMs, or the "booking stands"
   * line again if it still cannot. `[]` when nothing on the trip is stuck.
   */
  resumeIncomplete(tripId: TripId): Promise<readonly Outbound[]>;
}

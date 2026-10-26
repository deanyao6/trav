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
} from '@trav/core';
import type { InboundEvent } from '@trav/adapters';
import { stripInvisible } from '../untrusted.js';

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

/** VOICE §6.2 only: a bare "ok" in unrelated chat must never bind to a pending proposal. */
export const TEXT_ALIASES: Readonly<Record<'approve' | 'decline' | 'not_me', readonly string[]>> = {
  approve: ['yes', 'yep', 'go', 'book it', 'do it', '👍'],
  decline: ['no', 'nah', 'cancel', 'drop it', '👎'],
  not_me: ['not me', "i'm out", 'im out', 'without me'],
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
}

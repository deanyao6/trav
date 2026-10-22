/**
 * One approval code path (VOICE §6, §9.3; D-009). Tapbacks, text aliases and
 * simulator buttons all normalize into `ApprovalEvent`; `ApprovalHandler` is
 * the only consumer and the only caller of `BookingExecutor.execute`.
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
import { notImplemented } from '@trav/core';
import type { InboundEvent } from '@trav/adapters';

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

export const TEXT_ALIASES: Readonly<Record<'approve' | 'decline' | 'not_me', readonly string[]>> = {
  approve: ['yes', 'yep', 'go', 'book it', 'do it', 'ok', '👍'],
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

/**
 * Rules: a button tap or a 👍/👎 on a card binds to that card; a text alias
 * binds to the replied-to card, else (requester only) to their single pending
 * proposal, else `ambiguous` (Trav asks which); anything else is `none`.
 * The display name and any names in the text are ignored.
 */
export function normalizeApprovalEvent(
  inbound: InboundEvent,
  index: PendingCardIndex,
  senderMemberId: MemberId | null,
  now: IsoDateTime,
): NormalizeResult {
  return notImplemented(
    `normalizeApprovalEvent(${inbound.type}, ${typeof index}, ${senderMemberId ?? ''}, ${now})`,
  );
}

export interface ApprovalHandler {
  /** Applies the event to the grant, audits, and on completion calls the executor. Returns the outbound messages for this turn. */
  handle(event: ApprovalEvent): Promise<readonly Outbound[]>;
}

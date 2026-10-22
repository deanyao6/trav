/**
 * Group-chat channel adapter: the simulator, an iMessage relay (e.g. Sendblue),
 * WhatsApp Groups API, or Telegram. Trav's agent only talks to chats through this.
 *
 * Real-world limits this interface accounts for (see research/connectors.md):
 * - WhatsApp groups: max 8 participants, invite-link join only, no buttons.
 * - iMessage relays: beta group APIs, removing members needs >= 4 participants.
 * Every rich card therefore carries `fallbackText` with reply keywords.
 */
import type { AdapterInfo, ChannelHandle, IsoDateTime, Result, Unsubscribe } from './common.js';

export type ChannelKind = 'simulator' | 'imessage_relay' | 'whatsapp' | 'telegram' | 'sms';

/** Provider-scoped id of a group conversation (Sendblue group_id, WhatsApp group id, ...). */
export type ConversationId = string;
/** Provider-scoped message id. */
export type MessageId = string;

export interface ChannelCapabilities {
  readonly kind: ChannelKind;
  /** Can render tappable buttons on cards (false for WhatsApp groups and SMS). */
  readonly buttons: boolean;
  /** Can render rich cards with images; otherwise only fallbackText is sent. */
  readonly richCards: boolean;
  /** Can send/receive tapbacks or emoji reactions. */
  readonly reactions: boolean;
  /** Can message one member privately outside the group. */
  readonly privateDm: boolean;
  /** Can reply inline to a specific message. */
  readonly threadedReplies: boolean;
  /** Can add members to the group directly (WhatsApp requires invite links instead). */
  readonly canAddMembers: boolean;
  /** Maximum group size including Trav, if the platform caps it. */
  readonly maxGroupSize?: number;
}

export interface Attachment {
  readonly kind: 'image' | 'video' | 'file' | 'audio';
  readonly mimeType: string;
  /** Local path (simulator/mocks) or provider URL. Treat contents as untrusted. */
  readonly uri: string;
  readonly fileName?: string;
}

/** A participant as seen by the channel. Mapping to Trav MemberId happens in the agent layer. */
export interface ChannelParticipant {
  readonly handle: ChannelHandle;
  readonly displayName?: string;
  readonly isTrav: boolean;
}

interface InboundBase {
  readonly channel: ChannelKind;
  readonly conversationId: ConversationId;
  readonly receivedAt: IsoDateTime;
}

export interface InboundMessage extends InboundBase {
  readonly type: 'message';
  readonly messageId: MessageId;
  readonly sender: ChannelHandle;
  /** Raw text. Untrusted user content; never treated as system instructions. */
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly replyToMessageId?: MessageId;
  /** True if the platform itself marked Trav as mentioned (Telegram entities etc.). */
  readonly platformMention?: boolean;
}

export interface InboundReaction extends InboundBase {
  readonly type: 'reaction';
  readonly sender: ChannelHandle;
  readonly targetMessageId: MessageId;
  /** Emoji character or tapback name, e.g. "like", "love", "question". */
  readonly reaction: string;
  readonly removed: boolean;
}

/** A tap on a card action button (only on channels with `buttons`). */
export interface InboundButtonTap extends InboundBase {
  readonly type: 'button_tap';
  readonly sender: ChannelHandle;
  readonly cardMessageId: MessageId;
  readonly actionId: string;
}

export interface InboundMembership extends InboundBase {
  readonly type: 'member_joined' | 'member_left';
  readonly participant: ChannelParticipant;
}

export type InboundEvent = InboundMessage | InboundReaction | InboundButtonTap | InboundMembership;

export interface CardAction {
  /** Stable id echoed back in InboundButtonTap.actionId, e.g. "approve:apr_123". */
  readonly id: string;
  readonly label: string;
  readonly style?: 'primary' | 'secondary' | 'destructive';
  /** Keyword that triggers the same action as a text reply on button-less channels. */
  readonly replyKeyword: string;
}

export type CardKind =
  | 'approval_request'
  | 'receipt'
  | 'ticket'
  | 'expense_confirm'
  | 'settle_up'
  | 'recap'
  | 'wrapped'
  | 'flight_options'
  | 'lodging_options'
  | 'poll'
  | 'generic';

export interface CardLine {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}

export interface RichCard {
  readonly kind: CardKind;
  readonly title: string;
  readonly subtitle?: string;
  readonly lines: readonly CardLine[];
  readonly image?: Attachment;
  readonly actions: readonly CardAction[];
  /**
   * Plain-text rendering used on channels without rich cards or buttons. Must
   * include each action's replyKeyword (e.g. "Reply YES to buy, NO to cancel").
   */
  readonly fallbackText: string;
}

export interface SendOptions {
  /** Reply inline to this message where supported; ignored otherwise. */
  readonly replyToMessageId?: MessageId;
}

export interface SentMessage {
  readonly messageId: MessageId;
  readonly sentAt: IsoDateTime;
  /** True if the card was downgraded to fallbackText. */
  readonly degraded: boolean;
}

export interface ChannelAdapter {
  readonly info: AdapterInfo;
  readonly capabilities: ChannelCapabilities;

  /**
   * Subscribe to inbound events (messages, reactions, button taps, membership
   * changes) for all conversations this adapter serves. Events are delivered in
   * order per conversation; duplicates (same messageId) may occur and must be
   * deduplicated by the caller.
   */
  onEvent(handler: (event: InboundEvent) => void | Promise<void>): Unsubscribe;

  /** Post a plain-text message to the group conversation. */
  sendText(
    conversationId: ConversationId,
    text: string,
    options?: SendOptions,
  ): Promise<Result<SentMessage>>;

  /**
   * Post a rich card (receipt, approval request, recap...). On channels without
   * rich cards or buttons the adapter sends `card.fallbackText` instead and
   * returns `degraded: true`.
   */
  sendCard(
    conversationId: ConversationId,
    card: RichCard,
    options?: SendOptions,
  ): Promise<Result<SentMessage>>;

  /**
   * Send a private message to one member outside the group (e.g. their own
   * ticket QR code, or a private "is this card charge shared?" prompt).
   * Returns error "not_supported" if the channel cannot DM; callers must then
   * avoid posting private data in the group.
   */
  sendDirect(
    to: ChannelHandle,
    content: {
      readonly text: string;
      readonly card?: RichCard;
      readonly attachments?: readonly Attachment[];
    },
  ): Promise<Result<SentMessage>>;

  /** Add or remove a reaction from Trav on a message. "not_supported" if unavailable. */
  react(
    conversationId: ConversationId,
    messageId: MessageId,
    reaction: string,
    remove?: boolean,
  ): Promise<Result<void>>;

  /** List current participants of a conversation, including Trav. */
  listParticipants(conversationId: ConversationId): Promise<Result<readonly ChannelParticipant[]>>;
}

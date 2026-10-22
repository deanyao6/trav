/**
 * Group-chat channel adapter: the simulator, an iMessage relay (e.g. Sendblue),
 * WhatsApp Groups API, or Telegram. Trav's agent only talks to chats through this.
 *
 * Two lanes (D-009): the GROUP lane (`sendGroup`) and the private DM lane
 * (`sendDirect`). The agent's single send path picks the lane from
 * `OutboundMessage.to`; a DM-only card can never be handed to `sendGroup`
 * because `screenOutbound` suppresses it first, and adapters must also refuse
 * it (`invalid_request`) as a second line of defense.
 *
 * Real-world limits this interface accounts for (see research/connectors.md):
 * - WhatsApp groups: max 8 participants, invite-link join only, no buttons.
 * - iMessage relays: beta group APIs, removing members needs >= 4 participants.
 * Every rich card therefore carries `fallbackText` (== `OutboundMessage.text`).
 *
 * The message-budget guard (G-03) is a decorator over this interface:
 * `withMessageBudget(channel, { clock, audit, maxProactivePerDay })` in
 * `packages/adapters/src/channel/budget.ts`; it drops proactive group messages
 * past the cap (audit `message.budget_dropped`), lets `urgent` through, and
 * never limits DMs or replies.
 */
import type { OutboundMessage, OutboundReaction } from '@trav/core';
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
  /** Can render rich cards with images; otherwise only `text` is sent. */
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

/** A participant as seen by the channel. Mapping handle → MemberId happens in the agent layer via `MemberRepository.getBySenderId`. */
export interface ChannelParticipant {
  readonly handle: ChannelHandle;
  /** Label only; never an identity. */
  readonly displayName?: string;
  readonly isTrav: boolean;
}

interface InboundBase {
  readonly channel: ChannelKind;
  readonly conversationId: ConversationId;
  /** 'group' for the shared thread, 'dm' for a member's private thread with Trav. */
  readonly lane: 'group' | 'dm';
  readonly receivedAt: IsoDateTime;
}

export interface InboundMessage extends InboundBase {
  readonly type: 'message';
  readonly messageId: MessageId;
  /** Channel-authenticated identity. */
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
  readonly messageId: MessageId;
  readonly targetMessageId: MessageId;
  /** Emoji character or tapback name, e.g. "👍", "like", "love", "question". */
  readonly reaction: string;
  readonly removed: boolean;
}

/** A tap on a card action button (only on channels with `buttons`). */
export interface InboundButtonTap extends InboundBase {
  readonly type: 'button_tap';
  readonly sender: ChannelHandle;
  readonly messageId: MessageId;
  readonly cardMessageId: MessageId;
  readonly cardId: string;
  /** A core `ActionId`, plus `value` for 'pick'. */
  readonly actionId: string;
  readonly value?: string;
}

export interface InboundMembership extends InboundBase {
  readonly type: 'member_joined' | 'member_left';
  readonly participant: ChannelParticipant;
}

export type InboundEvent = InboundMessage | InboundReaction | InboundButtonTap | InboundMembership;

export interface SendOptions {
  /** Reply inline to this message where supported; ignored otherwise. */
  readonly replyToMessageId?: MessageId;
}

export interface SentMessage {
  readonly messageId: MessageId;
  readonly sentAt: IsoDateTime;
  /** True if the card was downgraded to `text`. */
  readonly degraded: boolean;
}

export interface ChannelAdapter {
  readonly info: AdapterInfo;
  readonly capabilities: ChannelCapabilities;

  /**
   * Subscribe to inbound events for all conversations and lanes this adapter
   * serves. Events are delivered in order per conversation; duplicates (same
   * messageId) may occur and must be deduplicated by the caller.
   */
  onEvent(handler: (event: InboundEvent) => void | Promise<void>): Unsubscribe;

  /**
   * GROUP lane. Posts `message.text` (and `card`/`actions`/`images` where the
   * channel can render them, else degraded). Returns `invalid_request` if
   * `message.to.kind !== 'group'` or the card is DM-only.
   */
  sendGroup(
    conversationId: ConversationId,
    message: OutboundMessage,
    options?: SendOptions,
  ): Promise<Result<SentMessage>>;

  /**
   * DM lane. Sends to one member's private thread (their QR ticket, a "looks
   * shared?" prompt). Returns `not_supported` if the channel cannot DM; the
   * caller must then post at most a count in the group.
   */
  sendDirect(
    to: ChannelHandle,
    message: OutboundMessage,
    options?: SendOptions,
  ): Promise<Result<SentMessage>>;

  /** Add (or remove) one of Trav's two reactions. "not_supported" if unavailable. */
  react(
    conversationId: ConversationId,
    reaction: OutboundReaction,
    remove?: boolean,
  ): Promise<Result<void>>;

  /** List current participants of a conversation, including Trav. */
  listParticipants(conversationId: ConversationId): Promise<Result<readonly ChannelParticipant[]>>;
}

/**
 * Keyword fallback for button-less channels (C-03): maps a text reply to a
 * card action using `Action.textAliases`; returns `ambiguous` when several
 * pending cards could match. Implemented in `packages/adapters/src/channel/keywords.ts`.
 */
export interface KeywordMatch {
  readonly actionId: string;
  readonly confidence: number;
}

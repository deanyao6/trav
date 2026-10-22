/**
 * In-memory simulator channel (T-006). Implements `ChannelAdapter` for the
 * simulator web UI, the CLI and tests: outbound sends are recorded in a
 * transcript, and tests (or the UI server) inject inbound messages, reactions,
 * button taps and membership changes, which are delivered to `onEvent`
 * subscribers in order.
 *
 * Lanes (D-009): every group conversation has its own group lane; each
 * participant has one private DM thread with Trav whose conversation id is
 * `dm:<handle>`. DMs are recorded with `lane: 'dm'` and never appear in a
 * group transcript.
 *
 * It models real channel limits rather than being permissive: unknown senders,
 * taps on buttons that were never rendered, and taps on someone else's DM card
 * throw (programmer error in the test or UI), while expected send failures
 * (`invalid_request`, `not_found`, `not_supported`, `duplicate`) are returned
 * as `Result`s (D-010). No network, no wall clock: every timestamp comes from
 * the injected `Clock`.
 */
import type { Action, Clock, IsoDateTime, MemberId, OutboundMessage, RichCard } from '@trav/core';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelParticipant,
  ConversationId,
  InboundButtonTap,
  InboundEvent,
  InboundMembership,
  InboundMessage,
  InboundReaction,
  MessageId,
  SentMessage,
  Attachment,
} from '../../interfaces/channel.js';
import type {
  AdapterError,
  AdapterErrorCode,
  AdapterInfo,
  ChannelHandle,
  Result,
  Unsubscribe,
} from '../../interfaces/common.js';
import type { ChannelSendOptions } from '../types.js';
import { isDmOnlyCard } from '../types.js';

export interface SimulatorParticipant {
  readonly handle: ChannelHandle;
  /** Label only (never an identity). Printed in transcripts. */
  readonly displayName: string;
  /**
   * The member this handle belongs to, if known. When set, `sendDirect`
   * refuses a message addressed to a different member (a ticket can never be
   * delivered to the wrong handle).
   */
  readonly memberId?: MemberId;
}

export interface SimulatorConversation {
  readonly conversationId: ConversationId;
  readonly participants: readonly SimulatorParticipant[];
}

export interface SimulatorChannelOptions {
  readonly clock: Clock;
  readonly conversations: readonly SimulatorConversation[];
  /** Trav's own handle. Default `trav`. */
  readonly travHandle?: ChannelHandle;
  /** Override capabilities, e.g. `{ buttons: false }` to simulate a WhatsApp group. */
  readonly capabilities?: Partial<Omit<ChannelCapabilities, 'kind'>>;
}

interface EntryBase {
  /** Monotonic position in the transcript. */
  readonly seq: number;
  readonly at: IsoDateTime;
  readonly lane: 'group' | 'dm';
  /** Group conversation id, or `dm:<handle>` for the DM lane. */
  readonly conversationId: ConversationId;
  readonly direction: 'inbound' | 'outbound';
  /** Sender handle (Trav's handle for outbound). */
  readonly from: ChannelHandle;
  readonly fromName: string;
}

/** An attachment as recorded in the transcript; outbound images carry their alt text. */
export interface TranscriptAttachment extends Attachment {
  readonly alt?: string;
}

/** `data:image/png;base64,...` → `image/png`; otherwise guessed from the extension. */
function imageMimeType(url: string): string {
  const data = /^data:(image\/[a-z0-9.+-]+)[;,]/i.exec(url);
  if (data) return data[1]!.toLowerCase();
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url)?.[1]?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png' || ext === 'gif' || ext === 'webp') return `image/${ext}`;
  return 'image/*';
}

export interface TranscriptMessage extends EntryBase {
  readonly type: 'message';
  readonly messageId: MessageId;
  /** DM lane: the member's handle (recipient for outbound, sender for inbound). */
  readonly dmHandle?: ChannelHandle;
  readonly dmName?: string;
  readonly text: string;
  /** Present only if the channel rendered it (not degraded). */
  readonly card?: RichCard;
  /** Buttons rendered with the message (empty if the channel has no buttons). */
  readonly actions: readonly Action[];
  /** Inbound attachments, or outbound `OutboundMessage.images` (kind 'image', with `alt`). */
  readonly attachments: readonly TranscriptAttachment[];
  readonly replyToMessageId?: MessageId;
  /** Long card-less text rendered inside a plain card panel (budget decorator hint). */
  readonly renderedAsCard: boolean;
  /** True if a card or buttons were dropped because the channel can't render them. */
  readonly degraded: boolean;
  /** Outbound only: the original envelope as handed to the channel. */
  readonly outbound?: OutboundMessage;
}

export interface TranscriptReaction extends EntryBase {
  readonly type: 'reaction';
  readonly messageId: MessageId;
  readonly targetMessageId: MessageId;
  readonly reaction: string;
  readonly removed: boolean;
}

export interface TranscriptButtonTap extends EntryBase {
  readonly type: 'button_tap';
  readonly messageId: MessageId;
  readonly cardMessageId: MessageId;
  readonly cardId: string;
  readonly actionId: string;
  readonly value?: string;
}

export interface TranscriptMembership extends EntryBase {
  readonly type: 'member_joined' | 'member_left';
  readonly handle: ChannelHandle;
  readonly name: string;
}

export type TranscriptEntry =
  TranscriptMessage | TranscriptReaction | TranscriptButtonTap | TranscriptMembership;

export interface InjectMessageInput {
  readonly from: ChannelHandle;
  readonly text: string;
  /** Default: the first conversation. Ignored for the DM lane. */
  readonly conversationId?: ConversationId;
  /** Default `group`. `dm` = the sender's private thread with Trav. */
  readonly lane?: 'group' | 'dm';
  readonly attachments?: readonly Attachment[];
  readonly replyToMessageId?: MessageId;
  readonly platformMention?: boolean;
  /** Fix the inbound id (e.g. to test duplicate delivery). Default `sim_in_<n>`. */
  readonly messageId?: MessageId;
}

export interface InjectReactionInput {
  readonly from: ChannelHandle;
  readonly targetMessageId: MessageId;
  /** Emoji or tapback name. */
  readonly reaction: string;
  readonly removed?: boolean;
}

export interface InjectButtonTapInput {
  readonly from: ChannelHandle;
  /** The outbound message that carried the card. */
  readonly cardMessageId: MessageId;
  readonly actionId: string;
  readonly value?: string;
}

export interface InjectMembershipInput {
  readonly conversationId?: ConversationId;
  readonly participant: SimulatorParticipant;
}

export interface SimulatorChannel extends ChannelAdapter {
  readonly travHandle: ChannelHandle;
  /** Every entry, both lanes, in order. */
  transcript(): readonly TranscriptEntry[];
  /** Group-lane entries of one conversation (default: the first). Never contains DMs. */
  groupTranscript(conversationId?: ConversationId): readonly TranscriptEntry[];
  /** One participant's private thread with Trav. */
  dmTranscript(handle: ChannelHandle): readonly TranscriptEntry[];
  /** An outbound message by id (either lane). */
  sentMessage(messageId: MessageId): TranscriptMessage | undefined;
  /** Participants of a conversation (excluding Trav); synchronous for printers. */
  participants(conversationId?: ConversationId): readonly SimulatorParticipant[];
  injectMessage(input: InjectMessageInput): Promise<InboundMessage>;
  injectReaction(input: InjectReactionInput): Promise<InboundReaction>;
  injectButtonTap(input: InjectButtonTapInput): Promise<InboundButtonTap>;
  injectMemberJoined(input: InjectMembershipInput): Promise<InboundMembership>;
  injectMemberLeft(input: InjectMembershipInput): Promise<InboundMembership>;
}

const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  kind: 'simulator',
  buttons: true,
  richCards: true,
  reactions: true,
  privateDm: true,
  threadedReplies: true,
  canAddMembers: true,
};

/** The DM-lane conversation id for a participant's private thread with Trav. */
export function dmConversationId(handle: ChannelHandle): ConversationId {
  return `dm:${handle}`;
}

function fail<T>(code: AdapterErrorCode, message: string): Result<T> {
  const error: AdapterError = { code, message, retryable: false };
  return { ok: false, error };
}

export function createSimulatorChannel(options: SimulatorChannelOptions): SimulatorChannel {
  const { clock } = options;
  if (options.conversations.length === 0) {
    throw new Error('createSimulatorChannel: at least one conversation is required');
  }
  const travHandle = options.travHandle ?? 'trav';
  const capabilities: ChannelCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  const info: AdapterInfo = { provider: 'simulator', mode: 'mock' };

  const conversations = new Map<ConversationId, SimulatorParticipant[]>();
  for (const c of options.conversations) {
    if (conversations.has(c.conversationId)) {
      throw new Error(`createSimulatorChannel: duplicate conversation ${c.conversationId}`);
    }
    if (c.participants.some((p) => p.handle === travHandle)) {
      throw new Error(`createSimulatorChannel: ${travHandle} is Trav's handle, not a participant`);
    }
    conversations.set(c.conversationId, [...c.participants]);
  }
  const firstConversation = options.conversations[0]!.conversationId;

  const entries: TranscriptEntry[] = [];
  const sentById = new Map<MessageId, { entry: TranscriptMessage; sent: SentMessage }>();
  const handlers = new Set<(event: InboundEvent) => void | Promise<void>>();
  let seq = 0;
  let inboundCounter = 0;

  const nextInboundId = (): MessageId => `sim_in_${++inboundCounter}`;

  function findParticipant(handle: ChannelHandle): SimulatorParticipant | undefined {
    for (const list of conversations.values()) {
      const p = list.find((x) => x.handle === handle);
      if (p) return p;
    }
    return undefined;
  }

  function nameOf(handle: ChannelHandle): string {
    if (handle === travHandle) return 'trav';
    return findParticipant(handle)?.displayName ?? handle;
  }

  function requireConversation(conversationId: ConversationId): SimulatorParticipant[] {
    const list = conversations.get(conversationId);
    if (!list) throw new Error(`simulator: unknown conversation ${conversationId}`);
    return list;
  }

  function findMessage(messageId: MessageId): TranscriptMessage | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.type === 'message' && e.messageId === messageId) return e;
    }
    return undefined;
  }

  async function dispatch(event: InboundEvent): Promise<void> {
    for (const handler of [...handlers]) {
      await handler(event);
    }
  }

  function record<E extends TranscriptEntry>(entry: Omit<E, 'seq'>): E {
    const full = { ...entry, seq: ++seq } as E;
    entries.push(full);
    return full;
  }

  /** Shared outbound path for both lanes once validation passed. */
  function recordOutbound(
    lane: 'group' | 'dm',
    conversationId: ConversationId,
    message: OutboundMessage,
    opts: ChannelSendOptions | undefined,
    dm?: SimulatorParticipant,
  ): Result<SentMessage> {
    const previous = sentById.get(message.id);
    if (previous) {
      // Retried send with the same OutboundMessage id: idempotent on the same
      // target, refused if the id is reused for a different target.
      if (previous.entry.conversationId === conversationId) {
        return { ok: true, value: previous.sent };
      }
      return fail('duplicate', `message id ${message.id} was already sent to another thread`);
    }
    const at = clock.now();
    const cardDropped = message.card !== undefined && !capabilities.richCards;
    const actions = capabilities.buttons ? (message.actions ?? []) : [];
    const hasButtons = (message.actions ?? []).length > 0 || message.card?.type === 'options';
    const actionsDropped = !capabilities.buttons && hasButtons;
    const replyTo = capabilities.threadedReplies
      ? (opts?.replyToMessageId ?? message.replyTo)
      : undefined;
    const renderedAsCard =
      opts?.renderAsCard === true && message.card === undefined && capabilities.richCards;
    const degraded = cardDropped || actionsDropped;

    const entry = record<TranscriptMessage>({
      type: 'message',
      at,
      lane,
      conversationId,
      direction: 'outbound',
      from: travHandle,
      fromName: 'trav',
      messageId: message.id,
      ...(dm ? { dmHandle: dm.handle, dmName: dm.displayName } : {}),
      text: message.text,
      ...(message.card && !cardDropped ? { card: message.card } : {}),
      actions,
      attachments: (message.images ?? []).map((img): TranscriptAttachment => ({
        kind: 'image',
        mimeType: imageMimeType(img.url),
        uri: img.url,
        alt: img.alt,
      })),
      ...(replyTo !== undefined ? { replyToMessageId: replyTo } : {}),
      renderedAsCard,
      degraded,
      outbound: message,
    });
    const sent: SentMessage = { messageId: message.id, sentAt: at, degraded };
    sentById.set(message.id, { entry, sent });
    return { ok: true, value: sent };
  }

  const channel: SimulatorChannel = {
    info,
    capabilities,
    travHandle,

    onEvent(handler): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    async sendGroup(conversationId, message, opts?: ChannelSendOptions) {
      if (!conversations.has(conversationId)) {
        return fail('not_found', `unknown conversation ${conversationId}`);
      }
      if (message.to.kind !== 'group') {
        return fail('invalid_request', 'sendGroup requires a message addressed to the group');
      }
      if (message.card && isDmOnlyCard(message.card)) {
        return fail(
          'invalid_request',
          `card ${message.card.type} is DM-only and cannot be posted to the group`,
        );
      }
      return recordOutbound('group', conversationId, message, opts);
    },

    async sendDirect(to, message, opts?: ChannelSendOptions) {
      if (message.to.kind !== 'member') {
        return fail('invalid_request', 'sendDirect requires a message addressed to one member');
      }
      if (!capabilities.privateDm) {
        return fail('not_supported', 'this channel cannot send private messages');
      }
      const participant = findParticipant(to);
      if (!participant) return fail('not_found', `unknown handle ${to}`);
      const memberId = message.to.memberId;
      if (participant.memberId !== undefined && participant.memberId !== memberId) {
        return fail('invalid_request', `handle ${to} does not belong to member ${memberId}`);
      }
      const card = message.card;
      if (card?.type === 'ticket' && card.deliveredTo !== memberId) {
        return fail('invalid_request', `ticket ${card.cardId} is not addressed to ${memberId}`);
      }
      if (card?.type === 'expense_confirm') {
        // A private item may only be shown to its owner (CLAUDE.md §2 privacy).
        const items = [card, ...(card.digestItems ?? [])];
        const foreign = items.find((i) => i.visibility === 'private' && i.paidBy !== memberId);
        if (foreign) {
          return fail(
            'invalid_request',
            `private expense ${foreign.cardId} belongs to another member, not ${memberId}`,
          );
        }
      }
      return recordOutbound('dm', dmConversationId(to), message, opts, participant);
    },

    async react(conversationId, reaction, remove = false) {
      if (!capabilities.reactions) {
        return fail('not_supported', 'this channel cannot send reactions');
      }
      const target = findMessage(reaction.targetMessageId);
      if (!target || target.conversationId !== conversationId) {
        return fail('not_found', `message ${reaction.targetMessageId} not in ${conversationId}`);
      }
      record<TranscriptReaction>({
        type: 'reaction',
        at: clock.now(),
        lane: target.lane,
        conversationId,
        direction: 'outbound',
        from: travHandle,
        fromName: 'trav',
        messageId: reaction.id,
        targetMessageId: reaction.targetMessageId,
        reaction: reaction.emoji,
        removed: remove,
      });
      return { ok: true, value: undefined };
    },

    async listParticipants(conversationId) {
      const list = conversations.get(conversationId);
      if (!list) return fail('not_found', `unknown conversation ${conversationId}`);
      const result: ChannelParticipant[] = [
        ...list.map((p) => ({ handle: p.handle, displayName: p.displayName, isTrav: false })),
        { handle: travHandle, displayName: 'Trav', isTrav: true },
      ];
      return { ok: true, value: result };
    },

    transcript() {
      return [...entries];
    },

    groupTranscript(conversationId = firstConversation) {
      return entries.filter((e) => e.lane === 'group' && e.conversationId === conversationId);
    },

    dmTranscript(handle) {
      const id = dmConversationId(handle);
      return entries.filter((e) => e.lane === 'dm' && e.conversationId === id);
    },

    sentMessage(messageId) {
      return sentById.get(messageId)?.entry;
    },

    participants(conversationId = firstConversation) {
      return [...requireConversation(conversationId)];
    },

    async injectMessage(input) {
      const lane = input.lane ?? 'group';
      const sender = findParticipant(input.from);
      let conversationId: ConversationId;
      if (lane === 'dm') {
        if (!sender) throw new Error(`simulator: unknown sender ${input.from}`);
        conversationId = dmConversationId(input.from);
      } else {
        conversationId = input.conversationId ?? firstConversation;
        const list = requireConversation(conversationId);
        if (!list.some((p) => p.handle === input.from)) {
          throw new Error(`simulator: ${input.from} is not in ${conversationId}`);
        }
      }
      const at = clock.now();
      const messageId = input.messageId ?? nextInboundId();
      const attachments = input.attachments ?? [];
      record<TranscriptMessage>({
        type: 'message',
        at,
        lane,
        conversationId,
        direction: 'inbound',
        from: input.from,
        fromName: nameOf(input.from),
        messageId,
        ...(lane === 'dm' ? { dmHandle: input.from, dmName: nameOf(input.from) } : {}),
        text: input.text,
        actions: [],
        attachments,
        ...(input.replyToMessageId !== undefined
          ? { replyToMessageId: input.replyToMessageId }
          : {}),
        renderedAsCard: false,
        degraded: false,
      });
      const event: InboundMessage = {
        type: 'message',
        channel: 'simulator',
        conversationId,
        lane,
        receivedAt: at,
        messageId,
        sender: input.from,
        text: input.text,
        attachments,
        ...(input.replyToMessageId !== undefined
          ? { replyToMessageId: input.replyToMessageId }
          : {}),
        ...(input.platformMention !== undefined ? { platformMention: input.platformMention } : {}),
      };
      await dispatch(event);
      return event;
    },

    async injectReaction(input) {
      const target = findMessage(input.targetMessageId);
      if (!target) throw new Error(`simulator: unknown message ${input.targetMessageId}`);
      assertCanSee(target, input.from);
      const at = clock.now();
      const messageId = nextInboundId();
      const removed = input.removed ?? false;
      record<TranscriptReaction>({
        type: 'reaction',
        at,
        lane: target.lane,
        conversationId: target.conversationId,
        direction: 'inbound',
        from: input.from,
        fromName: nameOf(input.from),
        messageId,
        targetMessageId: input.targetMessageId,
        reaction: input.reaction,
        removed,
      });
      const event: InboundReaction = {
        type: 'reaction',
        channel: 'simulator',
        conversationId: target.conversationId,
        lane: target.lane,
        receivedAt: at,
        sender: input.from,
        messageId,
        targetMessageId: input.targetMessageId,
        reaction: input.reaction,
        removed,
      };
      await dispatch(event);
      return event;
    },

    async injectButtonTap(input) {
      if (!capabilities.buttons) throw new Error('simulator: this channel has no buttons');
      const target = sentById.get(input.cardMessageId)?.entry;
      if (!target) throw new Error(`simulator: unknown outbound message ${input.cardMessageId}`);
      if (!target.card) throw new Error(`simulator: message ${input.cardMessageId} has no card`);
      assertCanSee(target, input.from);
      const rendered = [
        ...target.actions,
        ...(target.card.type === 'options' ? [target.card.pickAction] : []),
      ];
      if (!rendered.some((a) => a.id === input.actionId)) {
        throw new Error(`simulator: card ${target.card.cardId} has no ${input.actionId} button`);
      }
      const at = clock.now();
      const messageId = nextInboundId();
      const cardId = target.card.cardId;
      record<TranscriptButtonTap>({
        type: 'button_tap',
        at,
        lane: target.lane,
        conversationId: target.conversationId,
        direction: 'inbound',
        from: input.from,
        fromName: nameOf(input.from),
        messageId,
        cardMessageId: input.cardMessageId,
        cardId,
        actionId: input.actionId,
        ...(input.value !== undefined ? { value: input.value } : {}),
      });
      const event: InboundButtonTap = {
        type: 'button_tap',
        channel: 'simulator',
        conversationId: target.conversationId,
        lane: target.lane,
        receivedAt: at,
        sender: input.from,
        messageId,
        cardMessageId: input.cardMessageId,
        cardId,
        actionId: input.actionId,
        ...(input.value !== undefined ? { value: input.value } : {}),
      };
      await dispatch(event);
      return event;
    },

    async injectMemberJoined(input) {
      const conversationId = input.conversationId ?? firstConversation;
      const list = requireConversation(conversationId);
      if (input.participant.handle === travHandle) {
        throw new Error('simulator: Trav cannot join as a participant');
      }
      if (!list.some((p) => p.handle === input.participant.handle)) {
        list.push(input.participant);
      }
      return membership('member_joined', conversationId, input.participant);
    },

    async injectMemberLeft(input) {
      const conversationId = input.conversationId ?? firstConversation;
      const list = requireConversation(conversationId);
      const idx = list.findIndex((p) => p.handle === input.participant.handle);
      if (idx < 0) throw new Error(`simulator: ${input.participant.handle} is not in the chat`);
      list.splice(idx, 1);
      return membership('member_left', conversationId, input.participant);
    },
  };

  /** A member can only react to / tap what they can see: the group, or their own DM thread. */
  function assertCanSee(target: TranscriptMessage, handle: ChannelHandle): void {
    if (target.lane === 'dm') {
      if (target.dmHandle !== handle) {
        throw new Error(`simulator: ${handle} cannot act on another member's DM`);
      }
      return;
    }
    const list = requireConversation(target.conversationId);
    if (!list.some((p) => p.handle === handle)) {
      throw new Error(`simulator: ${handle} is not in ${target.conversationId}`);
    }
  }

  async function membership(
    type: 'member_joined' | 'member_left',
    conversationId: ConversationId,
    p: SimulatorParticipant,
  ): Promise<InboundMembership> {
    const at = clock.now();
    record<TranscriptMembership>({
      type,
      at,
      lane: 'group',
      conversationId,
      direction: 'inbound',
      from: p.handle,
      fromName: p.displayName,
      handle: p.handle,
      name: p.displayName,
    });
    const event: InboundMembership = {
      type,
      channel: 'simulator',
      conversationId,
      lane: 'group',
      receivedAt: at,
      participant: { handle: p.handle, displayName: p.displayName, isTrav: false },
    };
    await dispatch(event);
    return event;
  }

  return channel;
}

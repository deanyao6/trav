/**
 * The relay loopback (T-169): the simulator, played over the relay channel.
 *
 * `pnpm relay:dev`, the Barcelona-over-relay test and the contract suite use
 * this to run Trav exactly as it would run on a real line, with the members'
 * phones simulated:
 *
 *   member in the simulator UI ─▶ "world" (a simulator channel under the
 *     imessage_relay_group profile: what the members' phones show)
 *     ─▶ mock relay builds the vendor's signed webhook
 *     ─▶ RelayChannel.handleWebhook (signature, parse, dedupe, id mapping)
 *     ─▶ agent
 *   agent ─▶ withOutboundPacing ─▶ RelayChannel (text fallback, PNG QR, retries)
 *     ─▶ vendor-shaped HTTP request ─▶ mock relay transport (validates, records)
 *     ─▶ the world transcript under the vendor's message id
 *
 * The returned `channel` is a `SimulatorChannel`: its sends and `onEvent`
 * are the (paced) relay channel's, its transcript and `inject*` are the
 * world's. So everything that drives the simulator (the UI server, the demo)
 * drives the relay without knowing it. Transcript ids are vendor ids (what a
 * phone would see), so a tapback in the UI targets the vendor id and the
 * relay maps it back to the Trav message the agent sent.
 *
 * Button taps throw, as on a real iMessage line (there are no buttons):
 * members approve with a 👍 tapback or by replying "yes".
 *
 * Inbound burst debounce (`withInboundDebounce`) is deliberately NOT wired:
 * a merged "do" + "it" reads as an exact approval, and the agent-side
 * refusal of merged approvals (T-217) is not built yet (D-048 §4).
 */
import type {
  Attachment,
  ChannelAdapter,
  InboundButtonTap,
  InboundEvent,
} from '../../interfaces/channel.js';
import type { Clock } from '../../interfaces/common.js';
import type { OutboundMessage } from '@trav/core';
import type { RelayChannel, RelayDiagnostic } from '../../channel/relay/core.js';
import { createRelayChannel } from '../../channel/relay/core.js';
import { MOCK_RELAY_KEY, MOCK_RELAY_SECRET } from '../../channel/relay/config.js';
import { createMemoryMediaHost } from '../../channel/relay/media.js';
import type {
  RelayChatRef,
  RelayContact,
  RelayVendorId,
  TapbackName,
} from '../../channel/relay/types.js';
import { relayVendor } from '../../channel/relay/vendors/index.js';
import { emojiToTapback, tapbackToEmoji } from '../../channel/relay/tapbacks.js';
import type { OutboundPacingOptions, PacedChannel } from '../../channel/pacing.js';
import { withOutboundPacing } from '../../channel/pacing.js';
import type {
  InjectButtonTapInput,
  SimulatorChannel,
  SimulatorConversation,
  TranscriptEntry,
  TranscriptMessage,
} from '../../channel/simulator/index.js';
import { createSimulatorChannel } from '../../channel/simulator/index.js';
import type { MockRelay, MockRelaySend } from './index.js';
import { createMockRelay } from './index.js';

export interface RelayLoopbackOptions {
  readonly vendor: RelayVendorId;
  readonly clock: Clock;
  readonly conversations: readonly SimulatorConversation[];
  readonly travHandle?: string;
  /** Default: a fictional 555-01xx number per handle, in conversation order. */
  readonly addressOf?: (handle: string, index: number) => string;
  /** Default on (T-071 defaults). `false` sends straight through the relay channel. */
  readonly pacing?: false | Omit<OutboundPacingOptions, 'clock'>;
  /**
   * What the simulator shows (the wire is the same either way):
   * - `phone` (default): exactly what an iPhone in the group shows: text,
   *   images and tapbacks; no cards, no buttons.
   * - `overlay`: a developer view that also draws the card Trav meant (from
   *   its own send log) with its buttons. A tap is never sent as a tap:
   *   it is translated into what the member would do on iMessage (a 👍/👎
   *   tapback on that message where the action has one, else the action's
   *   first text alias as a reply, e.g. "sent"; a pick sends the option
   *   number), and that travels as a signed vendor webhook like any other
   *   member action. This is how the full Barcelona demo script, written
   *   with taps, runs over the relay.
   */
  readonly view?: 'phone' | 'overlay';
  readonly onDiagnostic?: (d: RelayDiagnostic) => void;
}

export interface RelayLoopback {
  /** Hand this to the runtime and the simulator backend. */
  readonly channel: SimulatorChannel;
  readonly relay: RelayChannel;
  readonly paced?: PacedChannel;
  readonly mock: MockRelay;
  /** The members' phones: the transcript as it appears on the wire. */
  readonly world: SimulatorChannel;
  readonly contacts: readonly RelayContact[];
  addressOf(handle: string): string;
}

/** Fictional NANP numbers (555-0101…0199) across a few area codes. */
export function fictionalAddress(index: number): string {
  const areas = ['617', '646', '312', '415', '213', '305'];
  const area = areas[Math.floor(index / 99) % areas.length]!;
  return `+1${area}55501${String((index % 99) + 1).padStart(2, '0')}`;
}

export function createRelayLoopback(options: RelayLoopbackOptions): RelayLoopback {
  const { clock, vendor: vendorId } = options;
  const travHandle = options.travHandle ?? 'trav';
  const vendor = relayVendor(vendorId);
  const media = createMemoryMediaHost();

  // Directory: every handle gets one address, the same in every chat.
  const contacts: RelayContact[] = [];
  const addressByHandle = new Map<string, string>();
  const assign = (handle: string): string =>
    options.addressOf
      ? options.addressOf(handle, addressByHandle.size)
      : fictionalAddress(addressByHandle.size);
  for (const c of options.conversations) {
    for (const p of c.participants) {
      if (addressByHandle.has(p.handle)) continue;
      const address = assign(p.handle);
      addressByHandle.set(p.handle, address);
      contacts.push({
        handle: p.handle,
        address,
        displayName: p.displayName,
        ...(p.memberId !== undefined ? { memberId: p.memberId } : {}),
      });
    }
  }
  const addressOf = (handle: string): string => {
    const a = addressByHandle.get(handle);
    if (a === undefined) throw new Error(`relay loopback: no address for ${handle}`);
    return a;
  };
  const chats = options.conversations.map((c) => ({
    chatId: c.conversationId,
    participants: c.participants.map((p) => addressOf(p.handle)),
  }));

  const mock = createMockRelay({ vendor: vendorId, clock, chats, media });
  const relay = createRelayChannel({
    vendor,
    transport: mock.transport,
    auth: { apiKey: MOCK_RELAY_KEY, apiSecret: MOCK_RELAY_KEY },
    webhookSecret: MOCK_RELAY_SECRET,
    line: mock.line,
    clock,
    mode: 'mock',
    travHandle,
    contacts,
    chats,
    media,
    // Simulated time: a backoff never waits on the wall clock.
    sleep: async () => undefined,
    resolveInboundMedia: async (a) => mock.uploadedOriginal(a.uri) ?? a,
    ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
  });

  const world = createSimulatorChannel({
    clock,
    conversations: options.conversations,
    profile: 'imessage_relay_group',
    travHandle,
    capabilities: {
      reactions: relay.capabilities.reactions,
      threadedReplies: relay.capabilities.threadedReplies,
    },
  });

  // ---- Trav → wire → world. Recorded after the relay's send returns, so
  // the Trav envelope and every vendor id are known; pacing wraps this, so a
  // queued message lands in the world when it actually goes out.
  const sendsById = new Map<string, MockRelaySend>();
  mock.onSend((s) => {
    sendsById.set(s.vendorMessageId, s);
  });
  const worldId = (travOrVendorId: string): string =>
    relay.vendorIdsOf(travOrVendorId)[0] ?? travOrVendorId;

  async function recordInWorld(
    message: OutboundMessage,
    to: { lane: 'group'; conversationId: string } | { lane: 'dm'; handle: string },
  ): Promise<void> {
    const ids = relay.vendorIdsOf(message.id);
    const first = ids[0] !== undefined ? sendsById.get(ids[0]) : undefined;
    if (!first) return;
    const wireMedia = ids.flatMap((id) => sendsById.get(id)?.media ?? []);
    const alts = (message.images ?? []).map((i) => i.alt);
    const envelope: OutboundMessage = {
      ...message,
      id: first.vendorMessageId,
      text: first.text,
      images: wireMedia.map((m, i) => ({
        url: media.dataUrl(m.url) ?? m.url,
        alt: alts[i] ?? 'image',
      })),
    };
    const opts =
      first.replyToVendorId !== undefined ? { replyToMessageId: first.replyToVendorId } : undefined;
    const r =
      to.lane === 'group'
        ? await world.sendGroup(to.conversationId, envelope, opts)
        : await world.sendDirect(to.handle, envelope, opts);
    if (!r.ok)
      throw new Error(`relay loopback: the world refused ${message.id}: ${r.error.message}`);
  }

  const recording: ChannelAdapter = {
    info: relay.info,
    capabilities: relay.capabilities,
    onEvent: (h) => relay.onEvent(h),
    async sendGroup(conversationId, message, opts) {
      const r = await relay.sendGroup(conversationId, message, opts);
      if (
        r.ok &&
        relay.vendorIdsOf(message.id).length > 0 &&
        world.sentMessage(worldId(message.id)) === undefined
      ) {
        await recordInWorld(message, { lane: 'group', conversationId });
      }
      return r;
    },
    async sendDirect(to, message, opts) {
      const r = await relay.sendDirect(to, message, opts);
      if (
        r.ok &&
        relay.vendorIdsOf(message.id).length > 0 &&
        world.sentMessage(worldId(message.id)) === undefined
      ) {
        await recordInWorld(message, { lane: 'dm', handle: to });
      }
      return r;
    },
    async react(conversationId, reaction, remove) {
      const r = await relay.react(conversationId, reaction, remove);
      if (r.ok) {
        await world.react(
          conversationId,
          { ...reaction, targetMessageId: worldId(reaction.targetMessageId) },
          remove,
        );
      }
      return r;
    },
    listParticipants: (c) => relay.listParticipants(c),
  };
  const paced =
    options.pacing === false
      ? undefined
      : withOutboundPacing(recording, { clock, ...options.pacing });
  const front: ChannelAdapter = paced ?? recording;

  // ---- world → webhook → relay. Every member action becomes the vendor's signed delivery.
  const chatOf = (event: InboundEvent): RelayChatRef =>
    event.lane === 'group'
      ? { kind: 'group', chatId: event.conversationId }
      : { kind: 'dm', address: addressOf(event.conversationId.replace(/^dm:/, '')) };

  async function deliver(
    webhook: { rawBody: string; headers: Readonly<Record<string, string>> } | undefined,
  ): Promise<void> {
    if (!webhook) return;
    const outcome = await relay.handleWebhook(webhook);
    if (outcome.status !== 200)
      throw new Error(`relay loopback: webhook refused (${String(outcome.status)})`);
    await outcome.delivered;
  }

  world.onEvent(async (event) => {
    switch (event.type) {
      case 'message':
        await deliver(
          await mock.memberMessage({
            chat: chatOf(event),
            from: addressOf(event.sender),
            text: event.text,
            vendorMessageId: event.messageId,
            ...(event.attachments.length > 0
              ? { attachments: event.attachments as Attachment[] }
              : {}),
            ...(event.replyToMessageId !== undefined
              ? { replyToVendorId: event.replyToMessageId }
              : {}),
          }),
        );
        return;
      case 'reaction': {
        const tapback = emojiToTapback(event.reaction) ?? 'like';
        await deliver(
          mock.memberTapback({
            chat: chatOf(event),
            from: addressOf(event.sender),
            targetVendorId: event.targetMessageId,
            tapback,
            removed: event.removed,
          }),
        );
        return;
      }
      case 'member_joined': {
        if (!addressByHandle.has(event.participant.handle)) {
          const address = assign(event.participant.handle);
          addressByHandle.set(event.participant.handle, address);
        }
        await deliver(
          mock.memberJoined({
            chatId: event.conversationId,
            address: addressOf(event.participant.handle),
            ...(event.participant.displayName !== undefined
              ? { displayName: event.participant.displayName }
              : {}),
          }),
        );
        return;
      }
      case 'member_left':
        await deliver(
          mock.memberLeft({
            chatId: event.conversationId,
            address: addressOf(event.participant.handle),
          }),
        );
        return;
      case 'button_tap':
        // The world runs the relay profile (no buttons), so it never emits a
        // tap; the overlay view turns a tap into a tapback or a reply first.
        return;
    }
  });

  /** The iMessage equivalent of tapping `actionId` on the message `cardMessageId`. */
  function tapAsMemberAction(
    cardMessageId: string,
    actionId: string,
    value: string | undefined,
  ): { kind: 'tapback'; tapback: TapbackName } | { kind: 'text'; text: string } {
    const sent = world.sentMessage(cardMessageId)?.outbound;
    const card = sent?.card;
    if (card?.type === 'options' && actionId === card.pickAction.id) {
      const option = card.options.find((o) => o.id === value);
      return { kind: 'text', text: String(option?.index ?? value ?? '') };
    }
    const action = (sent?.actions ?? []).find((a) => a.id === actionId);
    const emoji = action?.tapback;
    const tapback = emoji !== undefined ? emojiToTapback(emoji) : undefined;
    if (tapback !== undefined && relay.capabilities.reactions) return { kind: 'tapback', tapback };
    // A "sent" / "got it" reply binds to the final settle card only as a
    // quote-reply. On a line without inline replies (Sendblue) the member
    // uses the 👍 the card offers instead; Trav reads it by role (T-166).
    if (
      card?.type === 'settle_up' &&
      (actionId === 'sent' || actionId === 'got_it') &&
      !relay.capabilities.threadedReplies &&
      relay.capabilities.reactions
    ) {
      return { kind: 'tapback', tapback: 'like' };
    }
    const alias = action?.textAliases[0];
    if (alias !== undefined) return { kind: 'text', text: alias };
    if (relay.capabilities.reactions && (actionId === 'approve' || actionId === 'confirm')) {
      return { kind: 'tapback', tapback: 'like' };
    }
    return { kind: 'text', text: (action?.label ?? actionId).toLowerCase() };
  }

  // ---- the overlay view: Trav's own card and buttons drawn over the wire text.
  const overlay = options.view === 'overlay';
  function decorate<T extends TranscriptEntry>(entry: T): T {
    if (!overlay || entry.type !== 'message' || entry.direction !== 'outbound') return entry;
    const sent = entry.outbound;
    if (sent === undefined) return entry;
    return {
      ...entry,
      ...(sent.card !== undefined ? { card: sent.card } : {}),
      actions: sent.actions ?? [],
      // iMessage has no grey notice line: on the wire (and in the phone view)
      // a T-165 notice is a plain text from Trav. The overlay marks it.
      systemNotice: sent.kind === 'system_notice',
    };
  }
  const decorateAll = (list: readonly TranscriptEntry[]): readonly TranscriptEntry[] =>
    overlay ? list.map((e) => decorate(e)) : list;
  /** Trav's message by its Trav id or its vendor id (the world keys by vendor id). */
  const sentMessage = (id: string): TranscriptMessage | undefined => {
    const m = world.sentMessage(worldId(id));
    return m === undefined ? undefined : decorate(m);
  };

  /**
   * A tap on an overlay button, played as the member's iMessage action (a
   * tapback, or a reply) through the world, so it travels as a signed vendor
   * webhook. The same refusals as the simulator apply: no tap on a message
   * Trav didn't send, on one without a card, or on a button it didn't draw.
   * Resolves with a record of the tap (its `messageId` is the wire event's).
   */
  async function overlayTap(input: InjectButtonTapInput): Promise<InboundButtonTap> {
    const target = sentMessage(input.cardMessageId);
    if (!target) throw new Error(`relay loopback: unknown outbound message ${input.cardMessageId}`);
    const card = target.card;
    if (!card) throw new Error(`relay loopback: message ${input.cardMessageId} has no card`);
    const drawn = [...target.actions, ...(card.type === 'options' ? [card.pickAction] : [])];
    if (!drawn.some((a) => a.id === input.actionId)) {
      throw new Error(`relay loopback: card ${card.cardId} has no ${input.actionId} button`);
    }
    if (target.lane === 'dm' && target.dmHandle !== input.from) {
      throw new Error(`relay loopback: ${input.from} cannot see ${input.cardMessageId}`);
    }
    const intent = tapAsMemberAction(target.messageId, input.actionId, input.value);
    const wire =
      intent.kind === 'tapback'
        ? await world.injectReaction({
            from: input.from,
            targetMessageId: target.messageId,
            reaction: tapbackToEmoji(intent.tapback),
          })
        : await world.injectMessage({
            from: input.from,
            text: intent.text,
            messageId: mock.nextMessageId(),
            ...(target.lane === 'dm'
              ? { lane: 'dm' as const }
              : { lane: 'group' as const, conversationId: target.conversationId }),
            ...(relay.capabilities.threadedReplies ? { replyToMessageId: target.messageId } : {}),
          });
    return {
      type: 'button_tap',
      channel: 'imessage_relay',
      conversationId: target.conversationId,
      lane: target.lane,
      receivedAt: wire.receivedAt,
      sender: input.from,
      messageId: wire.messageId,
      cardMessageId: target.messageId,
      cardId: card.cardId,
      actionId: input.actionId,
      ...(input.value !== undefined ? { value: input.value } : {}),
    };
  }

  const channel: SimulatorChannel = {
    info: front.info,
    capabilities: front.capabilities,
    travHandle,
    onEvent: (h) => front.onEvent(h),
    sendGroup: (c, m, o) => front.sendGroup(c, m, o),
    sendDirect: (t, m, o) => front.sendDirect(t, m, o),
    react: (c, r, rm) => front.react(c, r, rm),
    listParticipants: (c) => front.listParticipants(c),
    transcript: () => decorateAll(world.transcript()),
    groupTranscript: (c) => decorateAll(world.groupTranscript(c)),
    dmTranscript: (h) => decorateAll(world.dmTranscript(h)),
    sentMessage,
    participants: (c) => world.participants(c),
    injectMessage: (input) =>
      world.injectMessage({
        ...input,
        messageId: input.messageId ?? mock.nextMessageId(),
        ...(input.replyToMessageId !== undefined
          ? { replyToMessageId: worldId(input.replyToMessageId) }
          : {}),
      }),
    injectReaction: (input) =>
      world.injectReaction({ ...input, targetMessageId: worldId(input.targetMessageId) }),
    injectButtonTap: (input) => (overlay ? overlayTap(input) : world.injectButtonTap(input)),
    injectMemberJoined: (input) => world.injectMemberJoined(input),
    injectMemberLeft: (input) => world.injectMemberLeft(input),
  };

  return {
    channel,
    relay,
    ...(paced !== undefined ? { paced } : {}),
    mock,
    world,
    contacts,
    addressOf,
  };
}

/**
 * The iMessage relay channel (T-169): one `ChannelAdapter` (`kind:
 * 'imessage_relay'`) over any relay vendor module (`vendors/`).
 *
 * Inbound: `handleWebhook({ rawBody, headers })` is what the HTTP receiver
 * (`http.ts`) calls for every delivery. In this order it checks the body
 * size, verifies the vendor's signature on the raw bytes, parses the JSON,
 * lets the vendor module normalize it, drops our own echoes and anything
 * already seen (provider ids in a `RelaySeenStore`: memory by default, the
 * runtime's SQLite once T-185 lands), maps
 * addresses to Trav handles, vendor ids back to Trav's own message ids (so a
 * 👍 tapback on a proposal points at the card the agent sent), and diffs
 * group rosters where the vendor has no membership events. It answers as soon
 * as the delivery is accepted; the events then reach `onEvent` handlers one
 * at a time, in order (`delivered` resolves when they have).
 *
 * Outbound: the group and DM lanes keep the simulator's refusals (D-009: a
 * DM-only card never goes to the group, a ticket only to its holder). There
 * are no buttons or cards on iMessage, so the wire text is `textForChannel`
 * of the message (its `fallbackText` with answer instructions reworded per
 * capability, D-048); images are published through the media host (an SVG
 * QR becomes a PNG). Each Trav message id is sent at most once (a resend
 * returns the first result; an in-flight resend waits for it). Retryable
 * failures are retried with exponential backoff (honoring `Retry-After`);
 * for a vendor without idempotency keys only responses that guarantee
 * nothing was sent (429, 503) are retried, so a lost reply can never turn
 * into a double send. Pacing (T-071) is a decorator on top:
 * `withOutboundPacing(createRelayChannel(…))`.
 *
 * Every timestamp comes from the injected `Clock`. The core never calls
 * `fetch`; the transport is injected (mock or, only when live is enabled,
 * `createLiveRelayTransport`).
 */
import type { MemberId, OutboundMessage, OutboundReaction } from '@trav/core';
import type {
  Attachment,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelParticipant,
  ConversationId,
  InboundEvent,
  InboundMembership,
  InboundMessage,
  InboundReaction,
  MessageId,
  SentMessage,
} from '../../interfaces/channel.js';
import type {
  AdapterError,
  AdapterErrorCode,
  AdapterInfo,
  AdapterMode,
  ChannelHandle,
  Clock,
  Result,
  Unsubscribe,
} from '../../interfaces/common.js';
import { textForChannel } from '../fallbackText.js';
import type { ChannelProfileId } from '../profiles.js';
import { channelProfile } from '../profiles.js';
import { createSerialQueue } from '../timers.js';
import type { ChannelSendOptions } from '../types.js';
import { isDmOnlyCard } from '../types.js';
import type { RelayMediaHost } from './media.js';
import {
  attachmentKindOf,
  createMemoryMediaHost,
  isAcceptableInboundMediaUrl,
  prepareOutboundImages,
} from './media.js';
import { mentionsContactName } from './mention.js';
import {
  emojiToTapback,
  isSmsService,
  parseLegacyTapbackText,
  quoteMatches,
  tapbackToEmoji,
} from './tapbacks.js';
import type {
  RelayAuth,
  RelayChatRef,
  RelayChatSeed,
  RelayContact,
  RelayHeaders,
  RelayHttpRequest,
  RelayInbound,
  RelayMedia,
  RelaySend,
  RelayTransport,
  RelayVendor,
} from './types.js';
import { RelayPayloadError } from './types.js';

/** Largest webhook body accepted (a message with a few attachment URLs is a few KB). */
export const MAX_WEBHOOK_BYTES = 1_000_000;
/** Vendor ids remembered for dedupe and id mapping. */
export const RELAY_MEMORY_CAP = 10_000;
/**
 * Tries for a message whose image part keeps failing after its text went out
 * (the first send included). Matches the T-071 pacing queue's 3 attempts, so
 * the queue's last try ends in a degraded success, never a "never sent".
 */
export const RELAY_PART_TRIES = 3;
/** Trav messages per conversation remembered for matching an iOS `Liked “…”` text. */
const RECENT_WIRE_PER_CONVERSATION = 50;

/**
 * Provider message ids already delivered to Trav. Vendors retry a webhook
 * until they get a 2xx (and BlueBubbles re-sends on reconnect), so a restart
 * must not forget them: pass a store backed by the runtime's SQLite (T-185);
 * the default is in memory. Keys are `<vendor>:<kind>:<provider id>`, and
 * nothing else (no text, no addresses). Synchronous, like `node:sqlite`.
 */
export interface RelaySeenStore {
  has(key: string): boolean;
  add(key: string): void;
}

/** The default `RelaySeenStore`: in memory, bounded (oldest dropped past `cap`). */
export function createMemorySeenStore(cap = RELAY_MEMORY_CAP): RelaySeenStore {
  const keys = new Map<string, true>();
  return {
    has: (key) => keys.has(key),
    add: (key) => remember(keys, key, true, cap),
  };
}

export interface RelayRetryOptions {
  /** Tries per send, the first included. Default 3. */
  readonly maxAttempts?: number;
  /** Wait before try n+1 is `baseDelayMs × 2^(n-1)`. Default 500 ms. */
  readonly baseDelayMs?: number;
  /** Cap on any one wait (also on `Retry-After`). Default 8 s. */
  readonly maxDelayMs?: number;
}

/** Content-free notes for logs and tests (never message text, names or keys). */
export interface RelayDiagnostic {
  readonly type:
    | 'webhook_rejected'
    | 'duplicate'
    | 'echo'
    | 'ignored'
    | 'attachment_dropped'
    | 'image_skipped'
    | 'send_retry'
    | 'send_failed'
    | 'handler_error';
  readonly detail: string;
}

export interface RelayChannelOptions {
  readonly vendor: RelayVendor;
  readonly transport: RelayTransport;
  readonly auth: RelayAuth;
  /** Shared secret / signing key for inbound webhooks. Empty ⇒ every delivery is refused. */
  readonly webhookSecret: string;
  /** Trav's own address on the line (E.164 or Apple ID email). */
  readonly line: string;
  readonly clock: Clock;
  /** `mock` unless built by `createRelayFromEnv` with live enabled. */
  readonly mode?: AdapterMode;
  /** Trav's own handle (default `trav`). */
  readonly travHandle?: ChannelHandle;
  /**
   * Names the members saved the line's contact under (`TRAV_RELAY_CONTACT_NAME`).
   * "Trav" itself needs no entry: the agent's mention rules read "trav" and
   * "@trav". See `mention.ts`.
   */
  readonly travNames?: readonly string[];
  /** Known people: address ↔ Trav handle. Unknown addresses are passed through as handles. */
  readonly contacts?: readonly RelayContact[];
  /** Group chats the line is known to be in. Others are learned from webhooks. */
  readonly chats?: readonly RelayChatSeed[];
  /** Default `imessage_relay_group`. */
  readonly profile?: ChannelProfileId;
  readonly capabilities?: Partial<Omit<ChannelCapabilities, 'kind'>>;
  /** Where outbound images are published. Default: in-memory (mock) host. */
  readonly media?: RelayMediaHost;
  /**
   * Turns an accepted inbound `https:` attachment into what the agent reads
   * (Trav's receipt reader only opens files under `.trav/attachments/`, never
   * a URL). A live deployment downloads the vendor URL there (T-188); the
   * mock relay maps its upload URL back to the member's original file.
   * Default: the URL as is. Returning undefined drops the attachment.
   */
  readonly resolveInboundMedia?: (attachment: Attachment) => Promise<Attachment | undefined>;
  /** Dedupe by provider message id across restarts (T-185). Default: in memory. */
  readonly seen?: RelaySeenStore;
  readonly retry?: RelayRetryOptions;
  /** Backoff wait. Default: a real (unref'd) timer. Tests pass an instant one. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onDiagnostic?: (d: RelayDiagnostic) => void;
}

export interface RelayWebhookInput {
  /** The exact bytes received (signatures are over these, never over re-serialized JSON). */
  readonly rawBody: string;
  readonly headers: RelayHeaders;
  /** The request URL's query string, `?…` (BlueBubbles carries its shared secret there). */
  readonly query?: string;
}

export interface RelayWebhookOutcome {
  /** 200 accepted (including duplicates and ignored types), 400 malformed, 401 bad signature, 413 too big. */
  readonly status: 200 | 400 | 401 | 413;
  readonly accepted: number;
  readonly duplicates: number;
  readonly ignored: number;
  /** Resolves once every accepted event reached the `onEvent` handlers. Never rejects. */
  readonly delivered: Promise<void>;
}

export interface RelayChannelStats {
  readonly webhooksAccepted: number;
  readonly webhooksRejected: number;
  readonly duplicatesDropped: number;
  readonly sends: number;
  readonly retries: number;
  readonly sendFailures: number;
}

export interface RelayChannel extends ChannelAdapter {
  readonly vendor: RelayVendor;
  handleWebhook(input: RelayWebhookInput): Promise<RelayWebhookOutcome>;
  /** The vendor id(s) a Trav message went out as (first = the text). */
  vendorIdsOf(travMessageId: MessageId): readonly string[];
  /** The Trav message a vendor id belongs to, if Trav sent it. */
  travIdOf(vendorMessageId: string): MessageId | undefined;
  /** Known group chat ids. */
  chats(): readonly string[];
  stats(): RelayChannelStats;
}

interface SentRecord {
  readonly conversationId: ConversationId;
  readonly vendorIds: readonly string[];
  readonly sent: SentMessage;
}

function fail<T>(code: AdapterErrorCode, message: string, retryable = false): Result<T> {
  const error: AdapterError = { code, message, retryable };
  return { ok: false, error };
}

/** A bounded insertion-ordered map: the oldest entry goes once `cap` is passed. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

function normalizeAddress(address: string): string {
  const a = address.trim();
  return a.includes('@') ? a.toLowerCase() : a;
}

function looksLikeAddress(handle: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(handle) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(handle);
}

/** T-165 parity with the simulator: a notice is one line of bare text. */
function hasNoticeExtras(message: OutboundMessage): boolean {
  return (
    message.card !== undefined ||
    (message.actions ?? []).length > 0 ||
    (message.images ?? []).length > 0 ||
    (message.mentions ?? []).length > 0 ||
    /[\r\n]/.test(message.text)
  );
}

function errorCodeFor(status: number): AdapterErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 0 || status >= 500) return 'provider_unavailable';
  if (status === 401 || status === 403) return 'not_configured';
  if (status === 404) return 'not_found';
  return 'invalid_request';
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });

export function createRelayChannel(options: RelayChannelOptions): RelayChannel {
  const { vendor, transport, auth, clock } = options;
  const line = normalizeAddress(options.line);
  const travHandle = options.travHandle ?? 'trav';
  const travNames = options.travNames ?? [];
  const mode = options.mode ?? 'mock';
  const info: AdapterInfo = { provider: `relay-${vendor.id}`, mode };
  const profile = channelProfile(options.profile ?? 'imessage_relay_group');
  const capabilities: ChannelCapabilities = {
    ...profile,
    // A vendor that cannot send tapbacks or inline replies can't be told it can.
    reactions: profile.reactions && vendor.support.reactionsOut,
    threadedReplies: profile.threadedReplies && vendor.support.inlineReplies,
    ...options.capabilities,
    kind: 'imessage_relay',
  };
  const media = options.media ?? createMemoryMediaHost();
  const sleep = options.sleep ?? realSleep;
  const maxAttempts = Math.max(1, Math.floor(options.retry?.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, options.retry?.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, options.retry?.maxDelayMs ?? 8_000);
  const diag = (type: RelayDiagnostic['type'], detail: string): void => {
    options.onDiagnostic?.({ type, detail });
  };

  // ---- directory: addresses ↔ handles, rosters
  const handleByAddress = new Map<string, RelayContact>();
  const contactByHandle = new Map<ChannelHandle, RelayContact>();
  for (const c of options.contacts ?? []) {
    const address = normalizeAddress(c.address);
    if (address === line)
      throw new Error('createRelayChannel: a contact cannot use the line address');
    if (c.handle === travHandle)
      throw new Error(`createRelayChannel: ${travHandle} is Trav's handle`);
    const contact = { ...c, address };
    handleByAddress.set(address, contact);
    contactByHandle.set(c.handle, contact);
  }
  const rosters = new Map<string, Set<string>>();
  for (const chat of options.chats ?? []) {
    rosters.set(
      chat.chatId,
      new Set(chat.participants.map(normalizeAddress).filter((a) => a !== line)),
    );
  }

  const handleOf = (address: string): ChannelHandle =>
    handleByAddress.get(normalizeAddress(address))?.handle ?? normalizeAddress(address);
  const addressOf = (handle: ChannelHandle): string | undefined => {
    const known = contactByHandle.get(handle)?.address;
    if (known !== undefined) return known;
    return looksLikeAddress(handle) ? normalizeAddress(handle) : undefined;
  };
  const nameOf = (address: string): string | undefined =>
    handleByAddress.get(normalizeAddress(address))?.displayName;
  const dmConversation = (handle: ChannelHandle): ConversationId => `dm:${handle}`;
  const conversationOf = (chat: RelayChatRef): ConversationId =>
    chat.kind === 'group' ? chat.chatId : dmConversation(handleOf(chat.address));
  const chatRefOf = (conversationId: ConversationId): RelayChatRef | undefined => {
    if (conversationId.startsWith('dm:')) {
      const address = addressOf(conversationId.slice(3));
      return address === undefined ? undefined : { kind: 'dm', address };
    }
    return rosters.has(conversationId) ? { kind: 'group', chatId: conversationId } : undefined;
  };

  // ---- memory (bounded)
  const seen = options.seen ?? createMemorySeenStore();
  const travIdByVendorId = new Map<string, MessageId>();
  /** Inbound vendor message ids → their conversation (tapback targets Trav may react to). */
  const inboundConversation = new Map<string, ConversationId>();
  const sentByTravId = new Map<MessageId, SentRecord>();
  /** Messages whose first parts went out and a later image part did not (resumed on resend). */
  const partialSends = new Map<
    MessageId,
    { conversationId: ConversationId; vendorIds: readonly string[]; tries: number }
  >();
  const inFlight = new Map<MessageId, Promise<Result<SentMessage>>>();
  /** Trav's own tapbacks already on the wire (reaction id, `:remove` for an undo) → vendor id. */
  const sentReactions = new Map<string, string>();
  const recentWire = new Map<ConversationId, { travId: MessageId; text: string }[]>();

  const stats = {
    webhooksAccepted: 0,
    webhooksRejected: 0,
    duplicatesDropped: 0,
    sends: 0,
    retries: 0,
    sendFailures: 0,
  };

  const handlers = new Set<(event: InboundEvent) => void | Promise<void>>();
  const serial = createSerialQueue();

  async function withResolvedMedia(event: InboundEvent): Promise<InboundEvent> {
    const resolve = options.resolveInboundMedia;
    if (event.type !== 'message' || event.attachments.length === 0 || resolve === undefined) {
      return event;
    }
    const attachments: Attachment[] = [];
    for (const a of event.attachments) {
      try {
        const r = await resolve(a);
        if (r) attachments.push(r);
        else diag('attachment_dropped', 'resolver declined');
      } catch {
        diag('attachment_dropped', 'resolver failed');
      }
    }
    return { ...event, attachments };
  }

  async function dispatch(raw: readonly InboundEvent[]): Promise<void> {
    for (const rawEvent of raw) {
      const event = await withResolvedMedia(rawEvent);
      for (const handler of [...handlers]) {
        try {
          await handler(event);
        } catch (e) {
          diag('handler_error', e instanceof Error ? e.name : 'error');
        }
      }
    }
  }

  function firstSighting(key: string): boolean {
    const k = `${vendor.id}:${key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }

  function travTarget(vendorId: string): MessageId {
    return travIdByVendorId.get(vendorId) ?? vendorId;
  }

  function participantOf(address: string, displayName?: string): ChannelParticipant {
    const isTrav = normalizeAddress(address) === line;
    const name = isTrav ? 'Trav' : (nameOf(address) ?? displayName);
    return {
      handle: isTrav ? travHandle : handleOf(address),
      ...(name !== undefined ? { displayName: name } : {}),
      isTrav,
    };
  }

  function membership(
    type: 'member_joined' | 'member_left',
    chatId: string,
    address: string,
    displayName?: string,
  ): InboundMembership {
    return {
      type,
      channel: 'imessage_relay',
      conversationId: chatId,
      lane: 'group',
      receivedAt: clock.now(),
      participant: participantOf(address, displayName),
    };
  }

  /** Joins/leaves from a vendor-reported roster (vendors without membership webhooks). */
  function rosterDiff(chatId: string, reported: readonly string[]): InboundMembership[] {
    const next = new Set(reported.map(normalizeAddress).filter((a) => a !== line));
    const known = rosters.get(chatId);
    rosters.set(chatId, next);
    if (known === undefined) return [];
    const out: InboundMembership[] = [];
    for (const a of next) if (!known.has(a)) out.push(membership('member_joined', chatId, a));
    for (const a of known) if (!next.has(a)) out.push(membership('member_left', chatId, a));
    return out;
  }

  // A self-hosted server on the same Mac (BlueBubbles on http://127.0.0.1) serves
  // attachments from its own origin; the module builds those URLs from the
  // configured origin, never from the payload.
  const vendorOrigin = ((): string | undefined => {
    try {
      return new URL(vendor.baseUrl).origin;
    } catch {
      return undefined;
    }
  })();
  const fromVendorOrigin = (url: string): boolean => {
    try {
      const u = new URL(url);
      return vendorOrigin !== undefined && u.origin === vendorOrigin && u.username === '';
    } catch {
      return false;
    }
  };

  function inboundAttachments(list: readonly RelayMedia[]): Attachment[] {
    const out: Attachment[] = [];
    for (const m of list) {
      if (!isAcceptableInboundMediaUrl(m.url) && !fromVendorOrigin(m.url)) {
        diag('attachment_dropped', 'not an https url');
        continue;
      }
      out.push({
        kind: attachmentKindOf(m.mimeType),
        mimeType: m.mimeType,
        uri: m.url,
        ...(m.fileName !== undefined ? { fileName: m.fileName } : {}),
      });
    }
    return out;
  }

  /** `Liked “…”` from an SMS/MMS thread → a tapback on the one Trav message it quotes. */
  function legacyTapback(
    conversationId: ConversationId,
    lane: 'group' | 'dm',
    sender: ChannelHandle,
    vendorMessageId: string,
    text: string,
  ): InboundReaction | undefined {
    const legacy = parseLegacyTapbackText(text);
    if (!legacy) return undefined;
    const recent = recentWire.get(conversationId) ?? [];
    const matches = recent.filter((r) => quoteMatches(legacy, r.text));
    // A truncated quote that fits several of Trav's messages is ambiguous:
    // leave it as plain text rather than guess which card it approves.
    const distinct = new Set(matches.map((m) => m.travId));
    if (distinct.size !== 1) return undefined;
    return {
      type: 'reaction',
      channel: 'imessage_relay',
      conversationId,
      lane,
      receivedAt: clock.now(),
      sender,
      messageId: vendorMessageId,
      targetMessageId: [...distinct][0]!,
      reaction: tapbackToEmoji(legacy.tapback),
      removed: legacy.removed,
    };
  }

  function mapInbound(item: RelayInbound): { events: InboundEvent[]; duplicate: boolean } {
    const none = { events: [], duplicate: false };
    switch (item.kind) {
      case 'ignored':
        diag('ignored', item.reason);
        return none;
      case 'message': {
        if (item.fromLine || normalizeAddress(item.from) === line) {
          diag('echo', 'own message');
          return none;
        }
        if (!firstSighting(`m:${item.vendorMessageId}`)) return { events: [], duplicate: true };
        const conversationId = conversationOf(item.chat);
        const lane = item.chat.kind === 'group' ? 'group' : 'dm';
        const sender = handleOf(item.from);
        const events: InboundEvent[] = [];
        if (item.chat.kind === 'group') {
          const chatId = item.chat.chatId;
          if (item.participants !== undefined)
            events.push(...rosterDiff(chatId, item.participants));
          // A sender we didn't know about joins the roster silently (T-170 greets them).
          const roster = rosters.get(chatId) ?? new Set<string>();
          roster.add(normalizeAddress(item.from));
          rosters.set(chatId, roster);
        }
        remember(inboundConversation, item.vendorMessageId, conversationId, RELAY_MEMORY_CAP);
        // `Liked “…”` text is a tapback only where tapbacks arrive as text: an
        // SMS/MMS thread, or a vendor with no structured reaction events.
        const legacyAllowed = !vendor.support.structuredTapbacksIn || isSmsService(item.service);
        const tapback =
          item.media.length === 0 && legacyAllowed
            ? legacyTapback(conversationId, lane, sender, item.vendorMessageId, item.text)
            : undefined;
        if (tapback) {
          events.push(tapback);
          return { events, duplicate: false };
        }
        // iMessage has no bot mentions: a structured mention of the line, or
        // the line's saved contact name, is the platform's "@trav" (mention.ts).
        const mentioned =
          (item.mentionedAddresses ?? []).some((a) => normalizeAddress(a) === line) ||
          mentionsContactName(item.text, travNames);
        const message: InboundMessage = {
          type: 'message',
          channel: 'imessage_relay',
          conversationId,
          lane,
          receivedAt: clock.now(),
          messageId: item.vendorMessageId,
          sender,
          text: item.text,
          attachments: inboundAttachments(item.media),
          ...(item.replyToVendorId !== undefined
            ? { replyToMessageId: travTarget(item.replyToVendorId) }
            : {}),
          ...(mentioned ? { platformMention: true } : {}),
        };
        events.push(message);
        return { events, duplicate: false };
      }
      case 'reaction': {
        if (item.fromLine || normalizeAddress(item.from) === line) {
          diag('echo', 'own tapback');
          return none;
        }
        if (!firstSighting(`r:${item.eventId}`)) return { events: [], duplicate: true };
        const reaction: InboundReaction = {
          type: 'reaction',
          channel: 'imessage_relay',
          conversationId: conversationOf(item.chat),
          lane: item.chat.kind === 'group' ? 'group' : 'dm',
          receivedAt: clock.now(),
          sender: handleOf(item.from),
          messageId: item.eventId,
          targetMessageId: travTarget(item.targetVendorId),
          reaction: tapbackToEmoji(item.reaction),
          removed: item.removed,
        };
        return { events: [reaction], duplicate: false };
      }
      case 'member_joined':
      case 'member_left': {
        if (!firstSighting(`p:${item.eventId}`)) return { events: [], duplicate: true };
        const address = normalizeAddress(item.address);
        const roster = rosters.get(item.chatId) ?? new Set<string>();
        if (address !== line) {
          if (item.kind === 'member_joined') roster.add(address);
          else roster.delete(address);
        }
        rosters.set(item.chatId, roster);
        return {
          events: [membership(item.kind, item.chatId, address, item.displayName)],
          duplicate: false,
        };
      }
    }
  }

  // ---------------------------------------------------------------- outbound

  const anyTransient = (status: number): boolean =>
    status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  /**
   * Retry-safe statuses. A send whose duplicate would be harmless (a follow-up
   * image part: a second copy of a QR beats a ticket with none) retries every
   * transient failure, like a vendor with idempotency keys.
   */
  const retrySafeFor =
    (duplicateHarmless: boolean) =>
    (status: number): boolean =>
      vendor.support.idempotencyKeys || duplicateHarmless
        ? anyTransient(status)
        : status === 429 || status === 503;

  async function deliver(
    request: RelayHttpRequest,
    opts: { duplicateHarmless?: boolean } = {},
  ): Promise<Result<string>> {
    const retrySafe = retrySafeFor(opts.duplicateHarmless === true);
    for (let attempt = 1; ; attempt += 1) {
      stats.sends += 1;
      let outcome;
      try {
        outcome = vendor.parseSendResponse(await transport(request));
      } catch {
        outcome = {
          ok: false as const,
          status: 0,
          retryable: true,
          message: `${vendor.id}: network error`,
        };
      }
      if (outcome.ok) return { ok: true, value: outcome.value.vendorMessageId };
      const canRetry = outcome.retryable && retrySafe(outcome.status) && attempt < maxAttempts;
      if (!canRetry) {
        stats.sendFailures += 1;
        diag('send_failed', outcome.message);
        // Retryable above the core (the pacing queue requeues these) only when a later
        // try can't double-send: the same retry-safe statuses as here. A Sendblue 500
        // or lost reply may already be on the wire, so it is final.
        return fail(
          errorCodeFor(outcome.status),
          outcome.message,
          outcome.retryable && retrySafe(outcome.status),
        );
      }
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const wait = Math.min(
        maxDelayMs,
        outcome.retryAfterSeconds !== undefined ? outcome.retryAfterSeconds * 1000 : backoff,
      );
      stats.retries += 1;
      diag('send_retry', `${outcome.message}; retry ${String(attempt)} in ${String(wait)}ms`);
      await sleep(wait);
    }
  }

  function rememberWire(conversationId: ConversationId, travId: MessageId, text: string): void {
    const list = recentWire.get(conversationId) ?? [];
    list.push({ travId, text });
    if (list.length > RECENT_WIRE_PER_CONVERSATION) list.shift();
    recentWire.set(conversationId, list);
  }

  async function sendMessage(
    conversationId: ConversationId,
    chat: RelayChatRef,
    message: OutboundMessage,
    opts: ChannelSendOptions | undefined,
  ): Promise<Result<SentMessage>> {
    const previous = sentByTravId.get(message.id);
    if (previous) {
      if (previous.conversationId === conversationId) return { ok: true, value: previous.sent };
      return fail('duplicate', `message id ${message.id} was already sent to another thread`);
    }
    const pending = inFlight.get(message.id);
    if (pending) return pending;
    const run = (async (): Promise<Result<SentMessage>> => {
      const text = textForChannel(message, capabilities);
      const prepared = await prepareOutboundImages(message.images ?? [], media, {
        upload: vendor.support.mediaUpload,
      });
      for (const s of prepared.skipped) diag('image_skipped', s.reason);
      const replyTravId = capabilities.threadedReplies
        ? (opts?.replyToMessageId ?? message.replyTo)
        : undefined;
      const replyToVendorId =
        replyTravId === undefined
          ? undefined
          : (sentByTravId.get(replyTravId)?.vendorIds[0] ??
            (inboundConversation.has(replyTravId) ? replyTravId : undefined));
      // Split images into as many sends as the vendor needs; the text rides on
      // the first, or goes alone first where text and files can't share a send.
      const per = Math.max(1, vendor.support.mediaPerMessage);
      const groups: RelayMedia[][] = [];
      if (!vendor.support.textWithMedia && text.length > 0 && prepared.media.length > 0) {
        groups.push([]);
      }
      for (let i = 0; i < prepared.media.length; i += per)
        groups.push(prepared.media.slice(i, i + per));
      if (groups.length === 0) groups.push([]);
      // A resend of a message whose text went out but an image part did not
      // resumes at that part: the text is never sent twice.
      const resume = partialSends.get(message.id);
      const resumeHere = resume !== undefined && resume.conversationId === conversationId;
      const vendorIds: string[] = resumeHere ? [...resume.vendorIds] : [];
      const tries = resumeHere ? resume.tries + 1 : 1;
      let missingImages = 0;
      for (const [i, chunk] of groups.entries()) {
        if (i < vendorIds.length) continue;
        const send: RelaySend = {
          kind: 'message',
          chat,
          text: i === 0 ? text : '',
          media: chunk,
          ...(i === 0 && replyToVendorId !== undefined ? { replyToVendorId } : {}),
          idempotencyKey: i === 0 ? message.id : `${message.id}:${String(i + 1)}`,
        };
        const result = await deliver(vendor.buildSend(send, auth, line), {
          duplicateHarmless: i > 0,
        });
        if (!result.ok) {
          if (i === 0) return result;
          // The text (and any earlier part) went out; this image did not. A
          // ticket without its QR is not delivered: while the failure is
          // transient, keep what went out and fail retryably, so a resend
          // (the pacing queue's retry) sends only the missing parts. Past
          // RELAY_PART_TRIES, or on a permanent refusal, report the message
          // sent but degraded, with the count of images that never arrived.
          for (const v of vendorIds) remember(travIdByVendorId, v, message.id, RELAY_MEMORY_CAP);
          if (!resumeHere) rememberWire(conversationId, message.id, text);
          if (result.error.retryable && tries < RELAY_PART_TRIES) {
            remember(
              partialSends,
              message.id,
              { conversationId, vendorIds, tries },
              RELAY_MEMORY_CAP,
            );
            diag(
              'send_failed',
              `image part ${String(i + 1)} of ${String(groups.length)}; resumable`,
            );
            return fail(
              result.error.code,
              `the text went out but image part ${String(i + 1)} did not; resend to finish`,
              true,
            );
          }
          diag('image_skipped', 'send_failed');
          missingImages = groups.slice(i).reduce((n, g) => n + g.length, 0);
          break;
        }
        vendorIds.push(result.value);
      }
      partialSends.delete(message.id);
      const degraded =
        message.card !== undefined ||
        (message.actions ?? []).length > 0 ||
        message.kind === 'system_notice' ||
        text !== message.text ||
        prepared.skipped.length > 0 ||
        missingImages > 0;
      const sent: SentMessage = {
        messageId: message.id,
        sentAt: clock.now(),
        degraded,
        ...(missingImages > 0 ? { missingImages } : {}),
      };
      remember(sentByTravId, message.id, { conversationId, vendorIds, sent }, RELAY_MEMORY_CAP);
      for (const v of vendorIds) remember(travIdByVendorId, v, message.id, RELAY_MEMORY_CAP);
      if (!resumeHere) rememberWire(conversationId, message.id, text);
      return { ok: true, value: sent };
    })();
    inFlight.set(message.id, run);
    try {
      return await run;
    } finally {
      inFlight.delete(message.id);
    }
  }

  const channel: RelayChannel = {
    info,
    capabilities,
    vendor,

    onEvent(handler): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    async handleWebhook(input) {
      const reject = (status: 400 | 401 | 413, why: string): RelayWebhookOutcome => {
        stats.webhooksRejected += 1;
        diag('webhook_rejected', why);
        return { status, accepted: 0, duplicates: 0, ignored: 0, delivered: Promise.resolve() };
      };
      if (Buffer.byteLength(input.rawBody, 'utf8') > MAX_WEBHOOK_BYTES)
        return reject(413, 'too large');
      const verified = vendor.verifyWebhook({
        rawBody: input.rawBody,
        headers: input.headers,
        secret: options.webhookSecret,
        nowMs: clock.nowMs(),
        ...(input.query !== undefined ? { query: input.query } : {}),
      });
      if (!verified) return reject(401, 'bad signature');
      let body: unknown;
      try {
        body = JSON.parse(input.rawBody);
      } catch {
        return reject(400, 'not json');
      }
      let items: readonly RelayInbound[];
      try {
        items = vendor.parseWebhook(body);
      } catch (e) {
        if (e instanceof RelayPayloadError) return reject(400, e.message);
        throw e;
      }
      const events: InboundEvent[] = [];
      let duplicates = 0;
      let ignored = 0;
      for (const item of items) {
        const mapped = mapInbound(item);
        if (mapped.duplicate) {
          duplicates += 1;
          stats.duplicatesDropped += 1;
          diag('duplicate', item.kind);
        } else if (mapped.events.length === 0) {
          ignored += 1;
        }
        events.push(...mapped.events);
      }
      stats.webhooksAccepted += 1;
      const delivered = events.length === 0 ? Promise.resolve() : serial(() => dispatch(events));
      return { status: 200, accepted: events.length, duplicates, ignored, delivered };
    },

    async sendGroup(conversationId, message, opts?: ChannelSendOptions) {
      if (conversationId.startsWith('dm:') || !rosters.has(conversationId)) {
        return fail('not_found', `unknown group chat ${conversationId}`);
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
      if (message.kind === 'system_notice' && hasNoticeExtras(message)) {
        return fail('invalid_request', 'a system notice is one line of text, nothing attached');
      }
      return sendMessage(conversationId, { kind: 'group', chatId: conversationId }, message, opts);
    },

    async sendDirect(to, message, opts?: ChannelSendOptions) {
      if (message.to.kind !== 'member') {
        return fail('invalid_request', 'sendDirect requires a message addressed to one member');
      }
      if (message.kind === 'system_notice') {
        return fail('invalid_request', 'system notices are group-lane only');
      }
      if (!capabilities.privateDm)
        return fail('not_supported', 'this line cannot send private messages');
      // Only a known contact bound to this member gets a DM, as on the simulator
      // ("unknown handle"): a raw number or email, or a contact with no member,
      // would skip the ownership check that keeps tickets and private cards with
      // their owner.
      const memberId: MemberId = message.to.memberId;
      const contact = contactByHandle.get(to);
      if (contact === undefined) return fail('not_found', `unknown handle ${to}`);
      if (contact.memberId !== memberId) {
        return fail('invalid_request', `handle ${to} does not belong to member ${memberId}`);
      }
      const address = contact.address;
      const card = message.card;
      if (card?.type === 'ticket' && card.deliveredTo !== memberId) {
        return fail('invalid_request', `ticket ${card.cardId} is not addressed to ${memberId}`);
      }
      if (card?.type === 'expense_confirm') {
        const items = [card, ...(card.digestItems ?? [])];
        const foreign = items.find((i) => i.visibility === 'private' && i.paidBy !== memberId);
        if (foreign) {
          return fail(
            'invalid_request',
            `private expense ${foreign.cardId} belongs to another member, not ${memberId}`,
          );
        }
      }
      return sendMessage(dmConversation(to), { kind: 'dm', address }, message, opts);
    },

    async react(conversationId, reaction: OutboundReaction, remove = false) {
      if (!capabilities.reactions) return fail('not_supported', 'this line cannot send tapbacks');
      const tapback = emojiToTapback(reaction.emoji);
      if (tapback === undefined) return fail('invalid_request', 'not a tapback emoji');
      const chat = chatRefOf(conversationId);
      if (!chat) return fail('not_found', `unknown conversation ${conversationId}`);
      const own = sentByTravId.get(reaction.targetMessageId);
      let targetVendorId: string | undefined;
      if (own) {
        if (own.conversationId === conversationId) targetVendorId = own.vendorIds[0];
      } else if (inboundConversation.get(reaction.targetMessageId) === conversationId) {
        targetVendorId = reaction.targetMessageId;
      }
      if (targetVendorId === undefined) {
        return fail('not_found', `message ${reaction.targetMessageId} not in ${conversationId}`);
      }
      const key = `${reaction.id}${remove ? ':remove' : ''}`;
      if (sentReactions.has(key)) return { ok: true, value: undefined };
      const result = await deliver(
        vendor.buildSend(
          { kind: 'reaction', chat, targetVendorId, tapback, remove, idempotencyKey: key },
          auth,
          line,
        ),
      );
      if (!result.ok) return result;
      remember(sentReactions, key, result.value, RELAY_MEMORY_CAP);
      return { ok: true, value: undefined };
    },

    async listParticipants(conversationId) {
      const roster = rosters.get(conversationId);
      if (!roster) return fail('not_found', `unknown group chat ${conversationId}`);
      const list: ChannelParticipant[] = [...roster].map((a) => participantOf(a));
      list.push({ handle: travHandle, displayName: 'Trav', isTrav: true });
      return { ok: true, value: list };
    },

    vendorIdsOf: (travMessageId) => sentByTravId.get(travMessageId)?.vendorIds ?? [],
    travIdOf: (vendorMessageId) => travIdByVendorId.get(vendorMessageId),
    chats: () => [...rosters.keys()],
    stats: () => ({ ...stats }),
  };
  return channel;
}

/**
 * Mock iMessage relay (T-169): an in-memory stand-in for the vendor's side
 * of the wire, for tests, the contract suite and `pnpm relay:dev`.
 *
 * It mirrors each vendor independently of the client modules in
 * `channel/relay/vendors/` (its own request validation and its own webhook
 * builder and signer), so a client that drifts from the documented shape
 * fails here the way it would fail against the real API:
 *
 * - `transport` answers the vendor's send endpoints: it checks the path,
 *   method, auth headers and body fields, honors Photon's idempotency key,
 *   records every accepted send, and replies in the vendor's shape. `failNext`
 *   injects 429 / 5xx / network failures (including "accepted, then the
 *   connection dropped") for the retry tests.
 * - `memberMessage`, `memberTapback`, `memberJoined`, `memberLeft` build the
 *   signed webhook a vendor would POST when a person in the chat does that.
 *
 * Nothing here opens a socket or calls `fetch`. Media "uploads" stay in a
 * `MemoryMediaHost` on the reserved `.invalid` TLD.
 */
import { createHmac } from 'node:crypto';
import type { Attachment } from '../../interfaces/channel.js';
import type { Clock, Unsubscribe } from '../../interfaces/common.js';
import type { MemoryMediaHost } from '../../channel/relay/media.js';
import { createMemoryMediaHost, decodeDataUrl } from '../../channel/relay/media.js';
import type {
  RelayChatRef,
  RelayChatSeed,
  RelayHttpRequest,
  RelayHttpResponse,
  RelayMedia,
  RelayTransport,
  RelayVendorId,
  TapbackName,
} from '../../channel/relay/types.js';
import { MOCK_RELAY_KEY, MOCK_RELAY_LINE, MOCK_RELAY_SECRET } from '../../channel/relay/config.js';

export interface MockRelayOptions {
  readonly vendor: RelayVendorId;
  readonly clock: Clock;
  /** Trav's line. Default the fictional `MOCK_RELAY_LINE`. */
  readonly line?: string;
  readonly webhookSecret?: string;
  readonly apiKey?: string;
  readonly apiSecret?: string;
  /** Group chats and their member addresses (Trav's line excluded). */
  readonly chats?: readonly RelayChatSeed[];
  /** Where Trav's published media lives (to "download" it), and member uploads go. */
  readonly media?: MemoryMediaHost;
}

/** One send the mock accepted. */
export interface MockRelaySend {
  readonly vendorMessageId: string;
  readonly kind: 'message' | 'reaction';
  readonly chat: RelayChatRef;
  readonly text: string;
  readonly media: readonly RelayMedia[];
  readonly replyToVendorId?: string;
  readonly targetVendorId?: string;
  readonly tapback?: TapbackName;
  readonly remove?: boolean;
  readonly at: string;
}

export interface SignedWebhook {
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type MockRelayFault =
  | { readonly kind: 'status'; readonly status: number; readonly retryAfterSeconds?: number }
  /** Thrown before the request is processed. */
  | { readonly kind: 'network' }
  /** Processed and recorded, then the reply is lost (the client sees a network error). */
  | { readonly kind: 'lost_reply' };

export interface MockMemberMessage {
  readonly chat: RelayChatRef;
  readonly from: string;
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly replyToVendorId?: string;
  /** Default: a fresh vendor id. */
  readonly vendorMessageId?: string;
  /** The service the vendor reports (default `iMessage`; `SMS` for an MMS-fallback thread). */
  readonly service?: string;
}

export interface MockRelay {
  readonly vendor: RelayVendorId;
  readonly line: string;
  readonly media: MemoryMediaHost;
  readonly transport: RelayTransport;
  /** Every request the transport saw, accepted or not (contract tests). */
  requests(): readonly RelayHttpRequest[];
  sends(): readonly MockRelaySend[];
  /** Called for each accepted send before the reply goes back. */
  onSend(listener: (send: MockRelaySend) => void | Promise<void>): Unsubscribe;
  /** The next N requests fail this way (in order). */
  failNext(...faults: readonly MockRelayFault[]): void;
  nextMessageId(): string;
  memberMessage(input: MockMemberMessage): Promise<SignedWebhook>;
  memberTapback(input: {
    readonly chat: RelayChatRef;
    readonly from: string;
    readonly targetVendorId: string;
    readonly tapback: TapbackName;
    readonly removed?: boolean;
    readonly eventId?: string;
  }): SignedWebhook;
  /** Photon posts a webhook; Sendblue has none (the roster rides on the next group message). */
  memberJoined(input: {
    readonly chatId: string;
    readonly address: string;
    readonly displayName?: string;
  }): SignedWebhook | undefined;
  memberLeft(input: {
    readonly chatId: string;
    readonly address: string;
  }): SignedWebhook | undefined;
  /** What a member upload became (the vendor CDN URL) → the original attachment. */
  uploadedOriginal(url: string): Attachment | undefined;
  /** Current roster of a chat (addresses, Trav excluded). */
  roster(chatId: string): readonly string[];
}

const TAPBACKS: readonly TapbackName[] = [
  'love',
  'like',
  'dislike',
  'laugh',
  'emphasize',
  'question',
];

const ADDED_VERB: Readonly<Record<TapbackName, string>> = {
  like: 'Liked',
  love: 'Loved',
  dislike: 'Disliked',
  laugh: 'Laughed at',
  emphasize: 'Emphasized',
  question: 'Questioned',
};
const REMOVED_NOUN: Readonly<Record<TapbackName, string>> = {
  like: 'a like',
  love: 'a heart',
  dislike: 'a dislike',
  laugh: 'a laugh',
  emphasize: 'an exclamation',
  question: 'a question mark',
};
/** iOS quotes up to about this many characters of the message, then "…". */
const IOS_QUOTE_LIMIT = 120;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bad(status: number, message: string, vendor: RelayVendorId): RelayHttpResponse {
  return vendor === 'photon'
    ? {
        status,
        body: { error: { code: status === 401 ? 'unauthorized' : 'invalid_request', message } },
      }
    : { status, body: { status: 'ERROR', error_message: message } };
}

export function createMockRelay(options: MockRelayOptions): MockRelay {
  const { vendor, clock } = options;
  const line = options.line ?? MOCK_RELAY_LINE;
  const secret = options.webhookSecret ?? MOCK_RELAY_SECRET;
  const apiKey = options.apiKey ?? MOCK_RELAY_KEY;
  const apiSecret = options.apiSecret ?? MOCK_RELAY_KEY;
  const media = options.media ?? createMemoryMediaHost();
  const chats = new Map<string, Set<string>>();
  for (const c of options.chats ?? [])
    chats.set(c.chatId, new Set(c.participants.filter((a) => a !== line)));

  const requests: RelayHttpRequest[] = [];
  const sends: MockRelaySend[] = [];
  const listeners = new Set<(send: MockRelaySend) => void | Promise<void>>();
  const faults: MockRelayFault[] = [];
  /** Photon idempotency key → the reply it got. */
  const byKey = new Map<string, RelayHttpResponse>();
  /** Every message the line saw (both directions): vendor id → chat + text. */
  const messages = new Map<string, { chat: RelayChatRef; text: string }>();
  const uploads = new Map<string, Attachment>();
  let counter = 0;
  let events = 0;

  const nextMessageId = (): string => {
    counter += 1;
    const n = String(counter).padStart(6, '0');
    return vendor === 'photon' ? `PHM-${n}` : `sb-${n}-mock`;
  };

  const chatKey = (chat: RelayChatRef): string =>
    chat.kind === 'group' ? chat.chatId : `dm:${chat.address}`;
  const sameChat = (a: RelayChatRef, b: RelayChatRef): boolean => chatKey(a) === chatKey(b);

  // ------------------------------------------------------------ send side

  function checkMedia(list: unknown): RelayMedia[] | string {
    if (list === undefined) return [];
    if (!Array.isArray(list)) return 'attachments must be an array';
    const out: RelayMedia[] = [];
    for (const a of list) {
      if (!isObj(a) || typeof a['url'] !== 'string' || !a['url'].startsWith('https://')) {
        return 'attachment url must be https';
      }
      out.push({
        url: a['url'],
        mimeType: typeof a['mime_type'] === 'string' ? a['mime_type'] : 'application/octet-stream',
      });
    }
    return out;
  }

  function photonChat(guid: string): RelayChatRef | undefined {
    const dm = /^(?:iMessage|SMS|RCS|any);-;(.+)$/.exec(guid);
    if (dm) return { kind: 'dm', address: dm[1]! };
    return chats.has(guid) ? { kind: 'group', chatId: guid } : undefined;
  }

  function handlePhoton(req: RelayHttpRequest): RelayHttpResponse | MockRelaySend {
    if (req.headers['authorization'] !== `Bearer ${apiKey}`) return bad(401, 'bad key', vendor);
    const key = req.headers['idempotency-key'];
    if (key === undefined || key.length === 0) return bad(400, 'idempotency-key required', vendor);
    const prior = byKey.get(key);
    if (prior) return prior;
    const url = new URL(req.url);
    if (url.origin !== 'https://api.photon.codes') return bad(404, 'unknown host', vendor);
    const body = req.body;
    if (req.method !== 'POST' || !isObj(body)) return bad(400, 'POST a JSON object', vendor);
    const chat = typeof body['chat_guid'] === 'string' ? photonChat(body['chat_guid']) : undefined;
    if (!chat) return bad(404, 'unknown chat', vendor);
    const at = clock.now();
    if (url.pathname === '/v1/messages') {
      const text = body['text'];
      if (typeof text !== 'string') return bad(400, 'text must be a string', vendor);
      const m = checkMedia(body['attachments']);
      if (typeof m === 'string') return bad(400, m, vendor);
      if (text.length === 0 && m.length === 0) return bad(400, 'empty message', vendor);
      const replyTo = body['reply_to_guid'];
      if (replyTo !== undefined) {
        const target = typeof replyTo === 'string' ? messages.get(replyTo) : undefined;
        if (!target || !sameChat(target.chat, chat))
          return bad(404, 'unknown reply target', vendor);
      }
      return {
        vendorMessageId: nextMessageId(),
        kind: 'message',
        chat,
        text,
        media: m,
        ...(typeof replyTo === 'string' ? { replyToVendorId: replyTo } : {}),
        at,
      };
    }
    const reaction = /^\/v1\/messages\/([^/]+)\/reactions$/.exec(url.pathname);
    if (reaction) {
      const target = decodeURIComponent(reaction[1]!);
      const known = messages.get(target);
      if (!known || !sameChat(known.chat, chat)) return bad(404, 'unknown message', vendor);
      const type = body['type'];
      if (typeof type !== 'string' || !(TAPBACKS as readonly string[]).includes(type)) {
        return bad(400, 'type must be a tapback', vendor);
      }
      if (typeof body['remove'] !== 'boolean') return bad(400, 'remove must be a boolean', vendor);
      return {
        vendorMessageId: nextMessageId(),
        kind: 'reaction',
        chat,
        text: '',
        media: [],
        targetVendorId: target,
        tapback: type as TapbackName,
        remove: body['remove'],
        at,
      };
    }
    return bad(404, 'unknown endpoint', vendor);
  }

  function handleSendblue(req: RelayHttpRequest): RelayHttpResponse | MockRelaySend {
    if (req.headers['sb-api-key-id'] !== apiKey || req.headers['sb-api-secret-key'] !== apiSecret) {
      return bad(401, 'bad key', vendor);
    }
    const url = new URL(req.url);
    if (url.origin !== 'https://api.sendblue.co') return bad(404, 'unknown host', vendor);
    const body = req.body;
    if (req.method !== 'POST' || !isObj(body)) return bad(400, 'POST a JSON object', vendor);
    if (body['from_number'] !== line) return bad(400, 'from_number must be your line', vendor);
    const at = clock.now();
    const mediaUrl = body['media_url'];
    if (
      mediaUrl !== undefined &&
      (typeof mediaUrl !== 'string' || !mediaUrl.startsWith('https://'))
    ) {
      return bad(400, 'media_url must be https', vendor);
    }
    // Sendblue takes a bare URL; like the vendor, the mock learns the type by fetching it.
    const m: RelayMedia[] =
      typeof mediaUrl === 'string'
        ? [{ url: mediaUrl, mimeType: media.resolve(mediaUrl)?.mimeType ?? 'image/*' }]
        : [];
    const content = body['content'];
    if (url.pathname === '/api/send-message' || url.pathname === '/api/send-group-message') {
      if (typeof content !== 'string') return bad(400, 'content must be a string', vendor);
      if (content.length === 0 && m.length === 0) return bad(400, 'empty message', vendor);
      let chat: RelayChatRef;
      if (url.pathname === '/api/send-group-message') {
        const gid = body['group_id'];
        if (typeof gid !== 'string' || !chats.has(gid)) return bad(404, 'unknown group_id', vendor);
        chat = { kind: 'group', chatId: gid };
      } else {
        const number = body['number'];
        if (typeof number !== 'string' || !/^\+[1-9]\d{6,14}$|^[^\s@]+@[^\s@]+$/.test(number)) {
          return bad(400, 'number must be E.164 or an email', vendor);
        }
        chat = { kind: 'dm', address: number };
      }
      return {
        vendorMessageId: nextMessageId(),
        kind: 'message',
        chat,
        text: content,
        media: m,
        at,
      };
    }
    if (url.pathname === '/api/send-reaction') {
      const handle = body['message_handle'];
      const raw = body['reaction'];
      const known = typeof handle === 'string' ? messages.get(handle) : undefined;
      if (!known || typeof handle !== 'string') return bad(404, 'unknown message_handle', vendor);
      const remove = typeof raw === 'string' && raw.startsWith('-');
      const name = typeof raw === 'string' ? raw.replace(/^-/, '') : '';
      if (!(TAPBACKS as readonly string[]).includes(name))
        return bad(400, 'reaction must be a tapback', vendor);
      return {
        vendorMessageId: nextMessageId(),
        kind: 'reaction',
        chat: known.chat,
        text: '',
        media: [],
        targetVendorId: handle,
        tapback: name as TapbackName,
        remove,
        at,
      };
    }
    return bad(404, 'unknown endpoint', vendor);
  }

  function okReply(send: MockRelaySend): RelayHttpResponse {
    if (vendor === 'photon') {
      const inner = { guid: send.vendorMessageId, status: 'queued', created_at: send.at };
      return {
        status: 200,
        body:
          send.kind === 'reaction'
            ? { reaction: inner }
            : { message: { ...inner, chat_guid: chatKey(send.chat) } },
      };
    }
    return {
      status: 200,
      body: {
        accountEmail: 'mock-relay@example.test',
        status: 'QUEUED',
        message_handle: send.vendorMessageId,
        is_outbound: true,
        date_created: send.at,
      },
    };
  }

  const transport: RelayTransport = async (req) => {
    requests.push(req);
    const fault = faults.shift();
    if (fault?.kind === 'network') throw new Error('mock relay: connection reset');
    if (fault?.kind === 'status') {
      return {
        status: fault.status,
        headers:
          fault.retryAfterSeconds !== undefined
            ? { 'retry-after': String(fault.retryAfterSeconds) }
            : {},
        body: vendor === 'photon' ? { error: { code: 'unavailable' } } : { status: 'ERROR' },
      };
    }
    const handled = vendor === 'photon' ? handlePhoton(req) : handleSendblue(req);
    if ('status' in handled) return handled;
    sends.push(handled);
    messages.set(handled.vendorMessageId, { chat: handled.chat, text: handled.text });
    const reply = okReply(handled);
    const key = req.headers['idempotency-key'];
    if (vendor === 'photon' && key !== undefined) byKey.set(key, reply);
    for (const l of [...listeners]) await l(handled);
    if (fault?.kind === 'lost_reply') throw new Error('mock relay: reply lost');
    return reply;
  };

  // --------------------------------------------------------- webhook side

  function sign(body: unknown): SignedWebhook {
    const rawBody = JSON.stringify(body);
    if (vendor === 'photon') {
      const t = Math.floor(clock.nowMs() / 1000);
      const v1 = createHmac('sha256', secret)
        .update(`${String(t)}.${rawBody}`)
        .digest('hex');
      return {
        rawBody,
        headers: {
          'content-type': 'application/json',
          'x-photon-signature': `t=${String(t)},v1=${v1}`,
        },
      };
    }
    return {
      rawBody,
      headers: { 'content-type': 'application/json', 'sb-signing-secret': secret },
    };
  }

  const eventId = (): string => {
    events += 1;
    return `evt_mock_${String(events).padStart(6, '0')}`;
  };

  const photonChatGuid = (chat: RelayChatRef): string =>
    chat.kind === 'group' ? chat.chatId : `iMessage;-;${chat.address}`;

  async function upload(att: Attachment): Promise<RelayMedia | undefined> {
    if (/^https:\/\//.test(att.uri)) return { url: att.uri, mimeType: att.mimeType };
    // The member's phone uploads the file; the vendor hands Trav a CDN URL.
    const decoded = att.uri.startsWith('data:') ? decodeDataUrl(att.uri) : undefined;
    const bytes = decoded?.bytes ?? Buffer.from(att.uri, 'utf8');
    const published = await media.publish({ bytes, mimeType: decoded?.mimeType ?? att.mimeType });
    uploads.set(published.url, att);
    return {
      ...published,
      mimeType: att.mimeType,
      ...(att.fileName !== undefined ? { fileName: att.fileName } : {}),
    };
  }

  function rosterList(chatId: string): string[] {
    return [...(chats.get(chatId) ?? [])];
  }

  const relay: MockRelay = {
    vendor,
    line,
    media,
    transport,
    requests: () => [...requests],
    sends: () => [...sends],
    onSend(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    failNext(...f) {
      faults.push(...f);
    },
    nextMessageId,

    async memberMessage(input) {
      const id = input.vendorMessageId ?? nextMessageId();
      messages.set(id, { chat: input.chat, text: input.text });
      if (input.chat.kind === 'group') {
        const set = chats.get(input.chat.chatId) ?? new Set<string>();
        set.add(input.from);
        chats.set(input.chat.chatId, set);
      }
      const uploaded: RelayMedia[] = [];
      for (const a of input.attachments ?? []) {
        const m = await upload(a);
        if (m) uploaded.push(m);
      }
      const at = clock.now();
      if (vendor === 'photon') {
        return sign({
          id: eventId(),
          type: 'message.received',
          created_at: at,
          data: {
            message: {
              guid: id,
              chat_guid: photonChatGuid(input.chat),
              is_group: input.chat.kind === 'group',
              is_from_me: false,
              from: { address: input.from, service: input.service ?? 'iMessage' },
              text: input.text,
              attachments: uploaded.map((m, i) => ({
                guid: `${id}-att-${String(i + 1)}`,
                url: m.url,
                mime_type: m.mimeType,
                ...(m.fileName !== undefined ? { file_name: m.fileName } : {}),
              })),
              ...(input.replyToVendorId !== undefined
                ? { reply_to_guid: input.replyToVendorId }
                : {}),
              date: at,
            },
          },
        });
      }
      const group = input.chat.kind === 'group';
      // Sendblue: one media_url per message; extra photos would arrive as their own deliveries.
      return sign({
        accountEmail: 'mock-relay@example.test',
        content: input.text,
        is_outbound: false,
        status: 'RECEIVED',
        error_code: null,
        error_message: null,
        message_handle: id,
        date_sent: at,
        date_updated: at,
        from_number: input.from,
        number: input.from,
        to_number: line,
        sendblue_number: line,
        was_downgraded: false,
        plan: 'dedicated',
        media_url: uploaded[0]?.url ?? '',
        message_type: group ? 'group' : 'message',
        group_id: group && input.chat.kind === 'group' ? input.chat.chatId : '',
        participants:
          group && input.chat.kind === 'group' ? [...rosterList(input.chat.chatId), line] : [],
        send_style: '',
        opted_out: false,
        service: input.service ?? 'iMessage',
      });
    },

    memberTapback(input) {
      const at = clock.now();
      if (vendor === 'photon') {
        return sign({
          id: input.eventId ?? eventId(),
          type: input.removed === true ? 'reaction.removed' : 'reaction.added',
          created_at: at,
          data: {
            reaction: {
              guid: input.eventId ?? `${nextMessageId()}-r`,
              chat_guid: photonChatGuid(input.chat),
              is_group: input.chat.kind === 'group',
              from: { address: input.from },
              target_guid: input.targetVendorId,
              type: input.tapback,
            },
          },
        });
      }
      // Sendblue: the tapback arrives the way iOS spells it in text.
      const target = messages.get(input.targetVendorId)?.text ?? '';
      const flat = target.replace(/\s+/g, ' ').trim();
      const quoted = flat.length > IOS_QUOTE_LIMIT ? `${flat.slice(0, IOS_QUOTE_LIMIT)}…` : flat;
      const text =
        input.removed === true
          ? `Removed ${REMOVED_NOUN[input.tapback]} from “${quoted}”`
          : `${ADDED_VERB[input.tapback]} “${quoted}”`;
      return sendblueTextWebhook(input.chat, input.from, text, input.eventId);
    },

    memberJoined(input) {
      const set = chats.get(input.chatId) ?? new Set<string>();
      set.add(input.address);
      chats.set(input.chatId, set);
      if (vendor !== 'photon') return undefined;
      return sign({
        id: eventId(),
        type: 'chat.participant_added',
        created_at: clock.now(),
        data: {
          chat_guid: input.chatId,
          participant: {
            address: input.address,
            ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
          },
        },
      });
    },

    memberLeft(input) {
      chats.get(input.chatId)?.delete(input.address);
      if (vendor !== 'photon') return undefined;
      return sign({
        id: eventId(),
        type: 'chat.participant_removed',
        created_at: clock.now(),
        data: { chat_guid: input.chatId, participant: { address: input.address } },
      });
    },

    uploadedOriginal: (url) => uploads.get(url),
    roster: (chatId) => rosterList(chatId),
  };

  function sendblueTextWebhook(
    chat: RelayChatRef,
    from: string,
    text: string,
    id?: string,
  ): SignedWebhook {
    const handle = id ?? nextMessageId();
    messages.set(handle, { chat, text });
    const at = clock.now();
    const group = chat.kind === 'group';
    return sign({
      accountEmail: 'mock-relay@example.test',
      content: text,
      is_outbound: false,
      status: 'RECEIVED',
      message_handle: handle,
      date_sent: at,
      from_number: from,
      number: from,
      to_number: line,
      sendblue_number: line,
      media_url: '',
      message_type: group ? 'group' : 'message',
      group_id: chat.kind === 'group' ? chat.chatId : '',
      participants: chat.kind === 'group' ? [...rosterList(chat.chatId), line] : [],
      service: 'iMessage',
    });
  }

  return relay;
}

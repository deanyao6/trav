/**
 * BlueBubbles vendor module (T-187): a self-hosted iMessage line, for Dean's
 * own dogfooding only (docs/DEPLOY_IMESSAGE.md). BlueBubbles is an
 * open-source server that runs on a Mac signed in to an Apple ID and exposes
 * that Mac's Messages app over a REST API and webhooks. Use a dedicated Mac
 * and a dedicated Apple ID, never a personal one: research found a
 * self-hosted line banned within a day at launch volume, so this is not for
 * friends' groups.
 *
 * Written in our own words from the BlueBubbles server's public REST and
 * webhook documentation as we know it (no traffic was recorded, no text
 * copied). The JSON shapes below and in `fixtures/relay/bluebubbles/` are a
 * reconstruction: before the first live run, capture one real webhook of each
 * kind from the server and one reply per send, and fix any field the contract
 * tests flag (docs/RELAY.md, "Going live").
 *
 * Wire contract this module implements:
 *
 * - Server: `TRAV_BLUEBUBBLES_URL`, the server's own origin (an `https:`
 *   tunnel, or `http://127.0.0.1:<port>` when Trav runs on the same Mac).
 *   Every REST call authenticates with the server password as the
 *   `?password=` query parameter (the server's documented scheme); the
 *   transport never logs URLs.
 * - Webhook: `POST` JSON `{ type, data }`. BlueBubbles can neither sign a
 *   webhook nor add a header, so the shared secret travels in the URL you
 *   register: `https://<tunnel>/relay/webhook?token=<TRAV_RELAY_WEBHOOK_SECRET>`,
 *   compared in constant time. Types: `new-message` (a message, a tapback, or
 *   our own echo with `isFromMe`), `participant-added`, `participant-removed`,
 *   `participant-left`; anything else (`updated-message` for delivered/read,
 *   `typing-indicator`, `chat-read-status-changed`, `group-name-change`, …)
 *   is acked and ignored.
 * - A message: `{ guid, text, handle: { address, service }, isFromMe,
 *   dateCreated (ms), attachments: [{ guid, mimeType, transferName }],
 *   associatedMessageGuid, associatedMessageType, threadOriginatorGuid,
 *   attributedBody, itemType, chats: [{ guid, style, participants? }] }`.
 *   Groups are addressed by chat GUID (`iMessage;+;chat…`, style 43); a DM
 *   is `iMessage;-;<address>` (style 45).
 * - Tapbacks arrive structured: `associatedMessageType` is a name (`like`,
 *   `-like` for a removal) or the raw Messages code (2000-2005 add, 3000-3005
 *   remove; 2006/3006 an iOS 18 emoji tapback with `associatedMessageEmoji`),
 *   and `associatedMessageGuid` is the target (`p:0/<guid>` or `bp:<guid>`).
 * - Mentions: an iMessage mention is a run in `attributedBody` whose
 *   attributes carry `__kIMMentionConfirmedMention: <address>`.
 * - Inbound attachments are downloaded from the server
 *   (`GET /api/v1/attachment/<guid>/download`, password required); the URL is
 *   passed on without the password, and fetching it is T-188's downloader.
 * - Send text: `POST /api/v1/message/text` `{ chatGuid, tempGuid, message,
 *   method, selectedMessageGuid?, partIndex? }` → `{ status, message, data:
 *   { guid, … } }`.
 * - Send an image: `POST /api/v1/message/attachment`, multipart form with
 *   `chatGuid`, `tempGuid`, `name`, `method` and the file as `attachment`.
 *   One file per send, no caption: the core sends the text first.
 * - Tapback: `POST /api/v1/message/react` `{ chatGuid, selectedMessageGuid,
 *   reaction, partIndex }`, `reaction` a name or `-name` to remove.
 * - Tapbacks and inline replies need the server's Private API helper
 *   (`TRAV_BLUEBUBBLES_PRIVATE_API=1`). Without it the module sends with
 *   `method: "apple-script"` and claims neither, so the core degrades (no
 *   tapbacks out, no threads). Inbound tapbacks work either way.
 * - No idempotency keys: `tempGuid` only labels a send for the server's
 *   clients, it does not dedupe. So the core retries only 429 and 503, and a
 *   lost reply is never retried (no double texts).
 */
import type {
  RelayChatRef,
  RelayHttpRequest,
  RelayInbound,
  RelayMedia,
  RelaySendOutcome,
  RelayVendor,
} from '../types.js';
import { RelayPayloadError } from '../types.js';
import type { Json } from './shared.js';
import {
  isLoopbackHostname,
  isObject,
  isRetryableStatus,
  obj,
  optBool,
  optStr,
  retryAfterOf,
  safeEqual,
  str,
} from './shared.js';

/** The fake server's origin (reserved `.invalid` TLD): mock relay, tests, demo. */
export const BLUEBUBBLES_MOCK_SERVER_URL = 'https://bluebubbles.mock-relay.invalid';
/** Query parameter of the registered webhook URL that carries the shared secret. */
export const BLUEBUBBLES_TOKEN_PARAM = 'token';
/** Messages' chat style for a group (45 is a one-to-one chat). */
export const BLUEBUBBLES_GROUP_STYLE = 43;
/**
 * T-071 pacing for a self-hosted Apple ID: a much lower daily cap than a paid
 * line's 500, since a personal-grade account is what Apple flags for volume.
 * Wrap the channel with `withOutboundPacing(channel, { clock, ...these })`.
 */
export const BLUEBUBBLES_MAX_SENDS_PER_DAY = 150;

const TAPBACK_CODES: readonly string[] = [
  'love',
  'like',
  'dislike',
  'laugh',
  'emphasize',
  'question',
];
const MENTION_ATTRIBUTE = '__kIMMentionConfirmedMention';
/** Messages puts U+FFFC where an attachment sits in the text. */
const OBJECT_REPLACEMENT = /\uFFFC/gu;

/**
 * The server origin from `TRAV_BLUEBUBBLES_URL`: `https:` anywhere, or
 * `http:` on loopback only (Trav on the same Mac). No credentials, no path.
 * Throws with a message that never echoes the value.
 */
export function blueBubblesServerOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('TRAV_BLUEBUBBLES_URL is not a URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('TRAV_BLUEBUBBLES_URL must not carry credentials');
  }
  const loopbackHttp = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('TRAV_BLUEBUBBLES_URL must be https, or http on 127.0.0.1');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('TRAV_BLUEBUBBLES_URL must be the server origin, without a path');
  }
  return url.origin;
}

/** `iMessage;-;+15550100001` → the address; a group GUID (`;+;`) → undefined. */
export function blueBubblesDmAddress(chatGuid: string): string | undefined {
  return /^(?:iMessage|SMS|RCS|any);-;(.+)$/.exec(chatGuid)?.[1];
}

/** `iMessage;+;chat…`: Messages' own marker for a group thread. */
function isGroupGuid(chatGuid: string): boolean {
  return /^(?:iMessage|SMS|RCS|any);\+;.+$/.test(chatGuid);
}

/** Attachment guids as the server issues them; anything else (`..`, `/`, `%`) is not a file of ours. */
export const BLUEBUBBLES_ATTACHMENT_GUID = /^[A-Za-z0-9:_-]{1,200}$/;

const sameAddress = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function blueBubblesChatGuid(chat: RelayChatRef): string {
  return chat.kind === 'group' ? chat.chatId : `iMessage;-;${chat.address}`;
}

/** The download URL of an inbound attachment (no password; the downloader adds auth). */
export function blueBubblesAttachmentUrl(serverOrigin: string, attachmentGuid: string): string {
  return `${serverOrigin}/api/v1/attachment/${encodeURIComponent(attachmentGuid)}/download`;
}

/** `p:0/<guid>` / `bp:<guid>` / `<guid>` → `<guid>`. */
function targetGuid(associated: string): string {
  return associated.replace(/^(?:p:\d+\/|bp:)/, '');
}

/** `associatedMessageType` → a tapback name (or custom emoji) and whether it is a removal. */
function tapbackOf(
  m: Json,
): { reaction: string; removed: boolean } | 'not_a_tapback' | 'unsupported' {
  const raw = m['associatedMessageType'];
  if (raw === null || raw === undefined || raw === 0 || raw === '') return 'not_a_tapback';
  if (typeof raw === 'string') {
    const removed = raw.startsWith('-');
    const name = raw.replace(/^-/, '').toLowerCase();
    if (TAPBACK_CODES.includes(name)) return { reaction: name, removed };
    if (name === 'emoji') {
      const emoji = optStr(m, 'associatedMessageEmoji');
      return emoji !== undefined ? { reaction: emoji, removed } : 'unsupported';
    }
    return 'unsupported';
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    // 2000-2005 add a classic tapback, 3000-3005 remove it, x006 is an emoji tapback.
    const removed = raw >= 3000;
    const offset = raw - (removed ? 3000 : 2000);
    if (raw < 2000 || raw > 3006 || offset < 0 || offset > 6) return 'unsupported';
    if (offset < TAPBACK_CODES.length) return { reaction: TAPBACK_CODES[offset]!, removed };
    const emoji = optStr(m, 'associatedMessageEmoji');
    return emoji !== undefined ? { reaction: emoji, removed } : 'unsupported';
  }
  return 'unsupported';
}

function firstChat(m: Json, what: string): Json {
  const chats = m['chats'];
  if (!Array.isArray(chats) || chats.length === 0) {
    throw new RelayPayloadError(`${what}.chats is missing`);
  }
  return obj(chats[0], `${what}.chats[0]`);
}

/**
 * The chat a row belongs to. The GUID's own marker decides (`;-;` one-to-one,
 * `;+;` group), never `style`: a group reply must not land in a 1:1 thread
 * because a field disagreed. Only a GUID with neither marker falls back to
 * `style` 43, and anything else is refused.
 */
function chatRefOf(chat: Json): RelayChatRef {
  const guid = str(chat, 'guid', 'chat');
  const dm = blueBubblesDmAddress(guid);
  if (dm !== undefined) return { kind: 'dm', address: dm };
  if (isGroupGuid(guid) || chat['style'] === BLUEBUBBLES_GROUP_STYLE) {
    return { kind: 'group', chatId: guid };
  }
  throw new RelayPayloadError('chat.guid is neither a group nor a one-to-one chat');
}

function addressOf(v: unknown): string | undefined {
  return isObject(v) ? optStr(v, 'address') : undefined;
}

function participantsOf(chat: Json): readonly string[] | undefined {
  const list = chat['participants'];
  if (!Array.isArray(list)) return undefined;
  return list.map(addressOf).filter((a): a is string => a !== undefined);
}

/** Addresses in `attributedBody` runs marked as confirmed mentions. */
function mentionsOf(m: Json): readonly string[] {
  const body = m['attributedBody'];
  const parts = Array.isArray(body) ? body : isObject(body) ? [body] : [];
  const out: string[] = [];
  for (const part of parts) {
    if (!isObject(part) || !Array.isArray(part['runs'])) continue;
    for (const run of part['runs']) {
      if (!isObject(run) || !isObject(run['attributes'])) continue;
      const v = run['attributes'][MENTION_ATTRIBUTE];
      if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

function mediaOf(serverOrigin: string, list: unknown): RelayMedia[] {
  if (!Array.isArray(list)) return [];
  const out: RelayMedia[] = [];
  for (const a of list) {
    if (!isObject(a) || optBool(a, 'hideAttachment') === true) continue;
    const guid = optStr(a, 'guid');
    // The guid becomes a path segment of the download URL: never `..` or a slash.
    if (guid === undefined || !BLUEBUBBLES_ATTACHMENT_GUID.test(guid)) continue;
    const fileName = optStr(a, 'transferName');
    out.push({
      url: blueBubblesAttachmentUrl(serverOrigin, guid),
      mimeType: optStr(a, 'mimeType') ?? 'application/octet-stream',
      ...(fileName !== undefined ? { fileName } : {}),
    });
  }
  return out;
}

function isoOf(v: unknown): string | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function parseNewMessage(serverOrigin: string, m: Json): RelayInbound {
  const guid = str(m, 'guid', 'message');
  const fromMe = optBool(m, 'isFromMe') === true;
  const from = addressOf(m['handle']);
  if (!fromMe && from === undefined) throw new RelayPayloadError('message.handle is missing');
  const chat = chatRefOf(firstChat(m, 'message'));
  if (chat.kind === 'dm' && !fromMe && !sameAddress(chat.address, from ?? '')) {
    // A one-to-one row from someone other than that chat's member: Trav would
    // answer one person's private thread on another's word. Drop it.
    return { kind: 'ignored', reason: 'bluebubbles dm sender does not match the chat' };
  }
  const itemType = m['itemType'];
  if (typeof itemType === 'number' && itemType !== 0) {
    // Renames, member changes and other group events also arrive as rows; the
    // participant-* webhooks (or the next roster) carry what Trav needs.
    return { kind: 'ignored', reason: `bluebubbles group event ${String(itemType)}` };
  }
  const tapback = tapbackOf(m);
  const associated = optStr(m, 'associatedMessageGuid');
  if (tapback !== 'not_a_tapback') {
    if (tapback === 'unsupported' || associated === undefined) {
      return { kind: 'ignored', reason: 'bluebubbles associated message' };
    }
    return {
      kind: 'reaction',
      eventId: guid,
      chat,
      from: from ?? '',
      targetVendorId: targetGuid(associated),
      reaction: tapback.reaction,
      removed: tapback.removed,
      fromLine: fromMe,
    };
  }
  const handle = isObject(m['handle']) ? m['handle'] : undefined;
  const service = handle ? optStr(handle, 'service') : undefined;
  const text = typeof m['text'] === 'string' ? m['text'].replace(OBJECT_REPLACEMENT, '') : '';
  const replyTo = optStr(m, 'threadOriginatorGuid');
  const sentAt = isoOf(m['dateCreated']);
  const participants = chat.kind === 'group' ? participantsOf(firstChat(m, 'message')) : undefined;
  const mentions = mentionsOf(m);
  return {
    kind: 'message',
    vendorMessageId: guid,
    chat,
    from: from ?? '',
    text: text.trim().length === 0 ? '' : text,
    media: mediaOf(serverOrigin, m['attachments']),
    fromLine: fromMe,
    ...(replyTo !== undefined ? { replyToVendorId: targetGuid(replyTo) } : {}),
    ...(sentAt !== undefined ? { sentAt } : {}),
    ...(service !== undefined ? { service } : {}),
    ...(participants !== undefined ? { participants } : {}),
    ...(mentions.length > 0 ? { mentionedAddresses: mentions } : {}),
  };
}

function parseParticipantEvent(type: string, m: Json): RelayInbound {
  const guid = str(m, 'guid', 'message');
  const chatGuid = str(firstChat(m, 'message'), 'guid', 'chat');
  // `participant-left`: the handle is the person who left. Added / removed:
  // the handle is whoever made the change, and the affected person is
  // `otherHandle`, which the server may report only as a row id. Without an
  // address, the roster diff on the next group message picks the change up.
  const address =
    type === 'participant-left' ? addressOf(m['handle']) : addressOf(m['otherHandle']);
  if (address === undefined) {
    return { kind: 'ignored', reason: `bluebubbles ${type} without an address` };
  }
  return {
    kind: type === 'participant-added' ? 'member_joined' : 'member_left',
    eventId: guid,
    chatId: chatGuid,
    address,
  };
}

/**
 * Every value of `name` in a query string, percent-decoded but with `+` kept
 * as `+` (form decoding would turn it into a space, so a secret with a `+`
 * could never match). Undefined on a malformed escape.
 */
function queryValues(query: string, name: string): string[] | undefined {
  const out: string[] = [];
  for (const part of query.replace(/^\?/, '').split('&')) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    try {
      if (decodeURIComponent(rawKey) === name) out.push(decodeURIComponent(rawValue));
    } catch {
      return undefined;
    }
  }
  return out;
}

/** Path → absolute URL with the password as the server expects it. */
function apiUrl(serverOrigin: string, path: string, password: string): string {
  return `${serverOrigin}${path}?password=${encodeURIComponent(password)}`;
}

/** BlueBubbles labels each send with a `tempGuid`; derived from Trav's own key. */
function tempGuidOf(key: string): string {
  return `temp-${key.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120)}`;
}

export interface BlueBubblesVendorOptions {
  /** The server origin (see `blueBubblesServerOrigin`). */
  readonly serverUrl: string;
  /** The server's Private API helper is on: tapbacks and inline replies out. Default false. */
  readonly privateApi?: boolean;
}

export function createBlueBubblesVendor(options: BlueBubblesVendorOptions): RelayVendor {
  const origin = blueBubblesServerOrigin(options.serverUrl);
  const privateApi = options.privateApi === true;
  const method = privateApi ? 'private-api' : 'apple-script';
  return {
    id: 'bluebubbles',
    displayName: 'BlueBubbles (self-hosted, dogfooding only)',
    baseUrl: origin,
    support: {
      reactionsOut: privateApi,
      inlineReplies: privateApi,
      mediaPerMessage: 1,
      idempotencyKeys: false,
      membershipEvents: true,
      structuredTapbacksIn: true,
      mediaUpload: true,
      textWithMedia: false,
    },

    verifyWebhook({ secret, query }) {
      if (secret.length === 0 || query === undefined) return false;
      const got = queryValues(query, BLUEBUBBLES_TOKEN_PARAM);
      // Exactly one token: a second copy could be a smuggled value.
      return got !== undefined && got.length === 1 && safeEqual(got[0]!, secret);
    },

    parseWebhook(body) {
      const env = obj(body, 'webhook');
      const type = str(env, 'type', 'webhook');
      switch (type) {
        case 'new-message':
          return [parseNewMessage(origin, obj(env['data'], 'webhook.data'))];
        case 'participant-added':
        case 'participant-removed':
        case 'participant-left':
          return [parseParticipantEvent(type, obj(env['data'], 'webhook.data'))];
        default:
          if (!/^[a-z][a-z-]{0,63}$/.test(type)) {
            throw new RelayPayloadError('webhook.type is malformed');
          }
          return [{ kind: 'ignored', reason: `bluebubbles ${type}` }];
      }
    },

    buildSend(send, auth): RelayHttpRequest {
      const chatGuid = blueBubblesChatGuid(send.chat);
      const tempGuid = tempGuidOf(send.idempotencyKey);
      if (send.kind === 'reaction') {
        return {
          method: 'POST',
          url: apiUrl(origin, '/api/v1/message/react', auth.apiKey),
          headers: { 'content-type': 'application/json' },
          body: {
            chatGuid,
            selectedMessageGuid: send.targetVendorId,
            reaction: send.remove ? `-${send.tapback}` : send.tapback,
            partIndex: 0,
          },
        };
      }
      const file = send.media[0];
      if (file !== undefined) {
        if (send.media.length > 1 || send.text.length > 0 || file.base64 === undefined) {
          // The core sends one uploaded image per send, text first (support flags).
          throw new Error('bluebubbles: an attachment send carries one uploaded file and no text');
        }
        return {
          method: 'POST',
          url: apiUrl(origin, '/api/v1/message/attachment', auth.apiKey),
          headers: {},
          form: {
            fields: {
              chatGuid,
              tempGuid,
              name: file.fileName ?? file.url.replace(/^upload:/, ''),
              method,
            },
            files: [
              {
                field: 'attachment',
                fileName: file.fileName ?? file.url.replace(/^upload:/, ''),
                mimeType: file.mimeType,
                base64: file.base64,
              },
            ],
          },
        };
      }
      return {
        method: 'POST',
        url: apiUrl(origin, '/api/v1/message/text', auth.apiKey),
        headers: { 'content-type': 'application/json' },
        body: {
          chatGuid,
          tempGuid,
          message: send.text,
          method,
          ...(privateApi && send.replyToVendorId !== undefined
            ? { selectedMessageGuid: send.replyToVendorId, partIndex: 0 }
            : {}),
        },
      };
    },

    parseSendResponse(res): RelaySendOutcome {
      const body = isObject(res.body) ? res.body : undefined;
      const inner = body && isObject(body['data']) ? body['data'] : undefined;
      const declared = body?.['status'];
      const declaredOk = declared === undefined || declared === 200;
      if (res.status >= 200 && res.status < 300 && declaredOk) {
        const guid = inner ? optStr(inner, 'guid') : undefined;
        if (guid !== undefined && !guid.startsWith('temp-')) {
          return { ok: true, value: { vendorMessageId: guid } };
        }
        // Accepted but not matched to a sent row (or only the temp label came
        // back): it may be on the wire, so it is final, never retried.
        return {
          ok: false,
          status: res.status,
          retryable: false,
          message: 'bluebubbles: no message guid in reply',
        };
      }
      const retryAfter = retryAfterOf(res.headers);
      const httpOk = res.status >= 200 && res.status < 300;
      return {
        ok: false,
        status: res.status,
        retryable: !httpOk && isRetryableStatus(res.status),
        message: `bluebubbles: ${httpOk ? 'error in reply' : `HTTP ${String(res.status)}`}`,
        ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
      };
    },
  };
}

/** The module against the fake server (mock relay, tests, demo), Private API on. */
export const bluebubblesVendor: RelayVendor = createBlueBubblesVendor({
  serverUrl: BLUEBUBBLES_MOCK_SERVER_URL,
  privateApi: true,
});

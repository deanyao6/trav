/**
 * Photon vendor module (T-169), written in our own words from Photon's
 * public pages as summarized in research/connectors.md "iMessage group access
 * (2026-11-04)": a managed iMessage line with group messaging (Business
 * plan), inbound group events, tapbacks, threaded replies, membership
 * changes and media.
 *
 * Field names are a reconstruction, not a copy: Photon's docs describe the
 * capabilities, and the exact JSON below is how this module expects them.
 * Before the first live call, record one real webhook of each type from the
 * account's webhook log into `fixtures/relay/photon/` and adjust the readers
 * here if a name differs (docs/RELAY.md, "Going live").
 *
 * Wire contract this module implements:
 *
 * - Webhook: `POST` JSON `{ id, type, created_at, data }` with header
 *   `x-photon-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`
 *   under the webhook secret; deliveries older than 5 minutes are refused.
 *   Types: `message.received`, `message.sent` (our own echo), `reaction.added`,
 *   `reaction.removed`, `chat.participant_added`, `chat.participant_removed`;
 *   anything else (`message.delivered`, `message.read`, `typing.*`) is acked
 *   and ignored.
 * - Chats are Apple chat GUIDs: `iMessage;+;chat…` for a group, `iMessage;-;<address>`
 *   (or `SMS;-;…`) for one person.
 * - Send: `POST /v1/messages` `{ chat_guid, text, attachments?, reply_to_guid? }`,
 *   bearer key, `idempotency-key` header → `{ message: { guid, … } }`.
 * - Tapback: `POST /v1/messages/<guid>/reactions` `{ chat_guid, type, remove }`
 *   → `{ reaction: { guid } }`.
 */
import type {
  RelayChatRef,
  RelayHttpRequest,
  RelayInbound,
  RelayMedia,
  RelaySendOutcome,
  RelayVendor,
} from '../types.js';
import { RelayPayloadError, headerValue } from '../types.js';
import type { Json } from './shared.js';
import {
  hmacSha256Hex,
  isObject,
  isRetryableStatus,
  obj,
  optBool,
  optStr,
  retryAfterOf,
  safeEqual,
  safeLabel,
  str,
} from './shared.js';

export const PHOTON_BASE_URL = 'https://api.photon.codes';
export const PHOTON_SIGNATURE_HEADER = 'x-photon-signature';
/** Replay window for a signed delivery. */
export const PHOTON_SIGNATURE_TOLERANCE_S = 300;

/** `iMessage;-;+15550100001` → the address; a group GUID (`;+;`) → undefined. */
export function photonDmAddress(chatGuid: string): string | undefined {
  const m = /^(?:iMessage|SMS|RCS|any);-;(.+)$/.exec(chatGuid);
  return m?.[1];
}

export function photonChatGuid(chat: RelayChatRef): string {
  return chat.kind === 'group' ? chat.chatId : `iMessage;-;${chat.address}`;
}

function chatRefOf(chatGuid: string, isGroupFlag: boolean | undefined): RelayChatRef {
  const dm = photonDmAddress(chatGuid);
  if (dm !== undefined && isGroupFlag !== true) return { kind: 'dm', address: dm };
  return { kind: 'group', chatId: chatGuid };
}

/** The signature header value for `rawBody` at `t` (unix seconds). The mock relay signs with this. */
export function photonSignature(secret: string, t: number, rawBody: string): string {
  return `t=${String(t)},v1=${hmacSha256Hex(secret, `${String(t)}.${rawBody}`)}`;
}

function parseSignature(header: string): { t: number; v1: readonly string[] } | undefined {
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && v !== undefined && /^\d{1,12}$/.test(v)) t = Number(v);
    if (k === 'v1' && v !== undefined && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  return t === undefined || v1.length === 0 ? undefined : { t, v1 };
}

function mediaOf(list: unknown): RelayMedia[] {
  if (!Array.isArray(list)) return [];
  const out: RelayMedia[] = [];
  for (const a of list) {
    if (!isObject(a)) continue;
    const url = optStr(a, 'url');
    if (url === undefined) continue;
    const fileName = optStr(a, 'file_name');
    out.push({
      url,
      mimeType: optStr(a, 'mime_type') ?? 'application/octet-stream',
      ...(fileName !== undefined ? { fileName } : {}),
    });
  }
  return out;
}

function senderOf(o: Json, what: string): { address: string; name?: string } {
  const from = obj(o['from'], `${what}.from`);
  const name = optStr(from, 'display_name');
  return { address: str(from, 'address', `${what}.from`), ...(name !== undefined ? { name } : {}) };
}

function parseMessage(data: Json, fromLine: boolean): RelayInbound {
  const m = obj(data['message'], 'data.message');
  const chatGuid = str(m, 'chat_guid', 'message');
  const sender = senderOf(m, 'message');
  const text = typeof m['text'] === 'string' ? m['text'] : '';
  const replyTo = optStr(m, 'reply_to_guid');
  const sentAt = optStr(m, 'date');
  const service = optStr(obj(m['from'], 'message.from'), 'service');
  return {
    kind: 'message',
    vendorMessageId: str(m, 'guid', 'message'),
    chat: chatRefOf(chatGuid, optBool(m, 'is_group')),
    from: sender.address,
    text,
    media: mediaOf(m['attachments']),
    fromLine: fromLine || optBool(m, 'is_from_me') === true,
    ...(replyTo !== undefined ? { replyToVendorId: replyTo } : {}),
    ...(sentAt !== undefined ? { sentAt } : {}),
    ...(sender.name !== undefined ? { senderName: sender.name } : {}),
    ...(service !== undefined ? { service } : {}),
  };
}

export const photonVendor: RelayVendor = {
  id: 'photon',
  displayName: 'Photon',
  baseUrl: PHOTON_BASE_URL,
  support: {
    reactionsOut: true,
    inlineReplies: true,
    mediaPerMessage: 10,
    idempotencyKeys: true,
    membershipEvents: true,
    structuredTapbacksIn: true,
  },

  verifyWebhook({ rawBody, headers, secret, nowMs }) {
    if (secret.length === 0) return false;
    const header = headerValue(headers, PHOTON_SIGNATURE_HEADER);
    if (header === undefined) return false;
    const sig = parseSignature(header);
    if (!sig) return false;
    if (Math.abs(nowMs / 1000 - sig.t) > PHOTON_SIGNATURE_TOLERANCE_S) return false;
    const expected = hmacSha256Hex(secret, `${String(sig.t)}.${rawBody}`);
    return sig.v1.some((v) => safeEqual(v, expected));
  },

  parseWebhook(body) {
    const env = obj(body, 'webhook');
    const type = str(env, 'type', 'webhook');
    const eventId = str(env, 'id', 'webhook');
    const data = obj(env['data'], 'webhook.data');
    switch (type) {
      case 'message.received':
        return [parseMessage(data, false)];
      case 'message.sent':
        return [parseMessage(data, true)];
      case 'reaction.added':
      case 'reaction.removed': {
        const r = obj(data['reaction'], 'data.reaction');
        const chatGuid = str(r, 'chat_guid', 'reaction');
        return [
          {
            kind: 'reaction',
            eventId: optStr(r, 'guid') ?? eventId,
            chat: chatRefOf(chatGuid, optBool(r, 'is_group')),
            from: senderOf(r, 'reaction').address,
            targetVendorId: str(r, 'target_guid', 'reaction'),
            reaction: str(r, 'type', 'reaction'),
            removed: type === 'reaction.removed',
            fromLine: optBool(r, 'is_from_me') === true,
          },
        ];
      }
      case 'chat.participant_added':
      case 'chat.participant_removed': {
        const chatGuid = str(data, 'chat_guid', 'data');
        const p = obj(data['participant'], 'data.participant');
        const name = optStr(p, 'display_name');
        return [
          {
            kind: type === 'chat.participant_added' ? 'member_joined' : 'member_left',
            eventId,
            chatId: chatGuid,
            address: str(p, 'address', 'participant'),
            ...(name !== undefined ? { displayName: name } : {}),
          },
        ];
      }
      default:
        if (!/^[a-z_.]{1,64}$/.test(type)) throw new RelayPayloadError('webhook.type is malformed');
        return [{ kind: 'ignored', reason: `photon ${type}` }];
    }
  },

  buildSend(send, auth): RelayHttpRequest {
    const headers = {
      authorization: `Bearer ${auth.apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': send.idempotencyKey,
    };
    const chatGuid = photonChatGuid(send.chat);
    if (send.kind === 'reaction') {
      return {
        method: 'POST',
        url: `${PHOTON_BASE_URL}/v1/messages/${encodeURIComponent(send.targetVendorId)}/reactions`,
        headers,
        body: { chat_guid: chatGuid, type: send.tapback, remove: send.remove },
      };
    }
    return {
      method: 'POST',
      url: `${PHOTON_BASE_URL}/v1/messages`,
      headers,
      body: {
        chat_guid: chatGuid,
        text: send.text,
        ...(send.media.length > 0
          ? {
              attachments: send.media.map((m) => ({
                url: m.url,
                mime_type: m.mimeType,
                ...(m.fileName !== undefined ? { file_name: m.fileName } : {}),
              })),
            }
          : {}),
        ...(send.replyToVendorId !== undefined ? { reply_to_guid: send.replyToVendorId } : {}),
      },
    };
  },

  parseSendResponse(res): RelaySendOutcome {
    if (res.status >= 200 && res.status < 300 && isObject(res.body)) {
      const inner = isObject(res.body['message'])
        ? res.body['message']
        : isObject(res.body['reaction'])
          ? res.body['reaction']
          : undefined;
      const guid = inner ? optStr(inner, 'guid') : undefined;
      if (guid !== undefined) return { ok: true, value: { vendorMessageId: guid } };
      return {
        ok: false,
        status: res.status,
        retryable: false,
        message: 'photon: no guid in reply',
      };
    }
    const retryAfter = retryAfterOf(res.headers);
    const code = safeLabel(
      isObject(res.body) && isObject(res.body['error'])
        ? optStr(res.body['error'], 'code')
        : undefined,
    );
    return {
      ok: false,
      status: res.status,
      retryable: isRetryableStatus(res.status),
      message: `photon: HTTP ${String(res.status)}${code !== undefined ? ` (${code})` : ''}`,
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    };
  },
};

/**
 * Sendblue vendor module (T-169), written in our own words from Sendblue's
 * public pages as summarized in research/connectors.md "iMessage group access
 * (2026-11-04)": the AI Agent plan "can only respond to group chats that the
 * number has been added to" (exactly Trav's case), the group API is beta on
 * select plans, media works in groups, iMessage groups only (no SMS/MMS
 * groups).
 *
 * As with Photon, the JSON below is our reconstruction of the documented
 * fields, not a copy; re-record one real delivery of each kind into
 * `fixtures/relay/sendblue/` before going live (docs/RELAY.md).
 *
 * Wire contract this module implements:
 *
 * - Webhook ("receive"): one flat JSON object per message: `message_handle`,
 *   `content`, `from_number`, `to_number`/`sendblue_number` (the line),
 *   `is_outbound`, `status`, `media_url`, `message_type` (`message` | `group`),
 *   `group_id`, `participants`, `service`, `date_sent`. An outbound status
 *   callback (`is_outbound: true`) is our own echo and is ignored.
 * - Auth on the webhook: a shared secret sent back in `sb-signing-secret`
 *   (compared in constant time).
 * - No membership webhooks: the core diffs `participants` on each group
 *   message to produce joins and leaves.
 * - No structured inbound tapback was found in the docs read; a tapback
 *   that arrives in its iOS text form (`Liked “…”`) is parsed by the core.
 * - Send: `POST /api/send-message` `{ number, from_number, content, media_url? }`
 *   for one person, `POST /api/send-group-message` `{ group_id, from_number,
 *   content, media_url? }` for a group, with `sb-api-key-id` and
 *   `sb-api-secret-key` headers → `{ status: "QUEUED", message_handle }`.
 *   One `media_url` per message (the core splits extra images into their
 *   own sends). No inline replies.
 * - Tapback: `POST /api/send-reaction` `{ from_number, message_handle, reaction }`.
 */
import type {
  RelayChatRef,
  RelayHttpRequest,
  RelayInbound,
  RelaySendOutcome,
  RelayVendor,
} from '../types.js';
import { headerValue } from '../types.js';
import {
  isObject,
  isRetryableStatus,
  obj,
  optBool,
  optStr,
  retryAfterOf,
  safeEqual,
  safeLabel,
  str,
  strArray,
} from './shared.js';

export const SENDBLUE_BASE_URL = 'https://api.sendblue.co';
export const SENDBLUE_SECRET_HEADER = 'sb-signing-secret';

function mimeOfMediaUrl(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url)?.[1]?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png' || ext === 'gif' || ext === 'webp') return `image/${ext}`;
  if (ext === 'heic') return 'image/heic';
  if (ext === 'mov' || ext === 'mp4') return `video/${ext === 'mov' ? 'quicktime' : 'mp4'}`;
  if (ext === 'caf' || ext === 'm4a') return 'audio/mp4';
  return 'application/octet-stream';
}

export const sendblueVendor: RelayVendor = {
  id: 'sendblue',
  displayName: 'Sendblue',
  baseUrl: SENDBLUE_BASE_URL,
  support: {
    reactionsOut: true,
    inlineReplies: false,
    mediaPerMessage: 1,
    idempotencyKeys: false,
    membershipEvents: false,
    structuredTapbacksIn: false,
    mediaUpload: false,
    textWithMedia: true,
  },

  verifyWebhook({ headers, secret }) {
    if (secret.length === 0) return false;
    const got = headerValue(headers, SENDBLUE_SECRET_HEADER);
    return got !== undefined && safeEqual(got, secret);
  },

  parseWebhook(body) {
    const m = obj(body, 'webhook');
    const handle = str(m, 'message_handle', 'webhook');
    if (optBool(m, 'is_outbound') === true) {
      return [
        { kind: 'ignored', reason: `sendblue outbound status ${optStr(m, 'status') ?? '?'}` },
      ];
    }
    const from = str(m, 'from_number', 'webhook');
    const isGroup = optStr(m, 'message_type') === 'group' || optStr(m, 'group_id') !== undefined;
    const chat: RelayChatRef = isGroup
      ? { kind: 'group', chatId: str(m, 'group_id', 'webhook') }
      : { kind: 'dm', address: from };
    const mediaUrl = optStr(m, 'media_url');
    const participants = isGroup ? strArray(m, 'participants') : undefined;
    const sentAt = optStr(m, 'date_sent');
    const service = optStr(m, 'service');
    const inbound: RelayInbound = {
      kind: 'message',
      vendorMessageId: handle,
      chat,
      from,
      text: typeof m['content'] === 'string' ? m['content'] : '',
      media: mediaUrl !== undefined ? [{ url: mediaUrl, mimeType: mimeOfMediaUrl(mediaUrl) }] : [],
      fromLine: false,
      ...(participants !== undefined ? { participants } : {}),
      ...(sentAt !== undefined ? { sentAt } : {}),
      ...(service !== undefined ? { service } : {}),
    };
    return [inbound];
  },

  buildSend(send, auth, line): RelayHttpRequest {
    const headers = {
      'sb-api-key-id': auth.apiKey,
      'sb-api-secret-key': auth.apiSecret ?? '',
      'content-type': 'application/json',
    };
    if (send.kind === 'reaction') {
      return {
        method: 'POST',
        url: `${SENDBLUE_BASE_URL}/api/send-reaction`,
        headers,
        body: {
          from_number: line,
          message_handle: send.targetVendorId,
          reaction: send.remove ? `-${send.tapback}` : send.tapback,
        },
      };
    }
    const media = send.media[0];
    const common = {
      from_number: line,
      content: send.text,
      ...(media !== undefined ? { media_url: media.url } : {}),
    };
    if (send.chat.kind === 'group') {
      return {
        method: 'POST',
        url: `${SENDBLUE_BASE_URL}/api/send-group-message`,
        headers,
        body: { group_id: send.chat.chatId, ...common },
      };
    }
    return {
      method: 'POST',
      url: `${SENDBLUE_BASE_URL}/api/send-message`,
      headers,
      body: { number: send.chat.address, ...common },
    };
  },

  parseSendResponse(res): RelaySendOutcome {
    const body = isObject(res.body) ? res.body : undefined;
    const status = safeLabel(body ? optStr(body, 'status')?.toUpperCase() : undefined);
    if (res.status >= 200 && res.status < 300 && status !== 'ERROR' && status !== 'FAILED') {
      const handle = body ? optStr(body, 'message_handle') : undefined;
      if (handle !== undefined) return { ok: true, value: { vendorMessageId: handle } };
      return {
        ok: false,
        status: res.status,
        retryable: false,
        message: 'sendblue: no message_handle in reply',
      };
    }
    const retryAfter = retryAfterOf(res.headers);
    const httpOk = res.status >= 200 && res.status < 300;
    return {
      ok: false,
      status: res.status,
      retryable: !httpOk && isRetryableStatus(res.status),
      message: `sendblue: ${httpOk ? `status ${status ?? '?'}` : `HTTP ${String(res.status)}`}`,
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    };
  },
};

/**
 * Vendor-neutral types for the iMessage relay channel (T-169).
 *
 * The relay channel is split in two:
 *
 * - the **core** (`core.ts`): one `ChannelAdapter` for `imessage_relay` that
 *   owns everything vendors have in common (webhook verification order,
 *   dedupe on vendor ids, Trav id ↔ vendor id mapping for tapbacks and
 *   replies, rosters, retries with backoff, media publishing, the text
 *   fallback for cards);
 * - a thin **vendor module** (`vendors/photon.ts`, `vendors/sendblue.ts`):
 *   how that vendor signs webhooks, what its payloads look like, and how its
 *   send endpoints want a request. A vendor module is pure: it builds and
 *   parses plain objects and never does I/O.
 *
 * Every HTTP call goes through an injected `RelayTransport`. The core never
 * touches `fetch`; only `createLiveRelayTransport` (config.ts) does, and only
 * when `TRAV_RELAY_LIVE=1` and a key are both set.
 *
 * Webhook content (text, names, media URLs) is untrusted data: it is mapped
 * into `InboundEvent`s as data and never interpreted here.
 */
import type { IsoDateTime } from '../../interfaces/common.js';

export type RelayVendorId = 'photon' | 'sendblue' | 'bluebubbles';

export const RELAY_VENDOR_IDS: readonly RelayVendorId[] = ['photon', 'sendblue', 'bluebubbles'];

export function isRelayVendorId(value: string): value is RelayVendorId {
  return (RELAY_VENDOR_IDS as readonly string[]).includes(value);
}

/** Lower-cased header name → value, as Node's `IncomingMessage.headers` has them. */
export type RelayHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface RelayHttpRequest {
  readonly method: 'POST' | 'GET' | 'DELETE';
  /** Absolute URL on the vendor's API host. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON body, serialized by the transport. */
  readonly body?: unknown;
  /**
   * A `multipart/form-data` body instead of JSON (BlueBubbles takes an
   * attachment as an upload, not a URL). The transport builds the form; never
   * set together with `body`.
   */
  readonly form?: RelayForm;
}

/** A multipart form, kept as plain data so vendor modules stay pure and fixtures stay JSON. */
export interface RelayForm {
  readonly fields: Readonly<Record<string, string>>;
  readonly files: readonly RelayFormFile[];
}

export interface RelayFormFile {
  readonly field: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly base64: string;
}

export interface RelayHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Parsed JSON body (or `undefined` for an empty one). */
  readonly body?: unknown;
}

/**
 * The one door to the vendor's API. The mock relay implements it in memory;
 * `createLiveRelayTransport` implements it with `fetch` (live only). A thrown
 * error means the request may not have arrived (network), and is retried.
 */
export type RelayTransport = (request: RelayHttpRequest) => Promise<RelayHttpResponse>;

/** API credentials. Never logged, never put in an error message. */
export interface RelayAuth {
  readonly apiKey: string;
  /** Sendblue uses a key id plus a secret; Photon a single bearer key. */
  readonly apiSecret?: string;
}

/** Where a send goes: a group chat by the vendor's chat id, or one person by address. */
export type RelayChatRef =
  | { readonly kind: 'group'; readonly chatId: string }
  | { readonly kind: 'dm'; readonly address: string };

/** The six classic iMessage tapbacks. */
export type TapbackName = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';

export interface RelayMedia {
  /**
   * An `https:` URL the vendor can fetch. For a vendor that takes uploads
   * (`support.mediaUpload`), an outbound image is never published: its URL
   * is a local `upload:<sha>.<ext>` label and the bytes ride in `base64`.
   */
  readonly url: string;
  readonly mimeType: string;
  readonly fileName?: string;
  /** The bytes, base64, only on an outbound image for an upload vendor (BlueBubbles). */
  readonly base64?: string;
}

export type RelaySend =
  | {
      readonly kind: 'message';
      readonly chat: RelayChatRef;
      readonly text: string;
      readonly media: readonly RelayMedia[];
      readonly replyToVendorId?: string;
      /** Same key ⇒ the vendor sends at most once (where it supports keys). */
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: 'reaction';
      readonly chat: RelayChatRef;
      readonly targetVendorId: string;
      readonly tapback: TapbackName;
      readonly remove: boolean;
      readonly idempotencyKey: string;
    };

/** One normalized webhook event, before the core maps it to an `InboundEvent`. */
export type RelayInbound =
  | {
      readonly kind: 'message';
      /** The vendor's message id (dedupe key, tapback target). */
      readonly vendorMessageId: string;
      readonly chat: RelayChatRef;
      readonly from: string;
      readonly text: string;
      readonly media: readonly RelayMedia[];
      readonly replyToVendorId?: string;
      readonly sentAt?: IsoDateTime;
      /** Sent by Trav's own line (an echo); dropped by the core. */
      readonly fromLine: boolean;
      /** Group roster as the vendor reports it on this message, if it does (Sendblue). */
      readonly participants?: readonly string[];
      /** Label only; untrusted. */
      readonly senderName?: string;
      /** iMessage, SMS or RCS, if the vendor says. */
      readonly service?: string;
      /**
       * Addresses the vendor reports as structured mentions in this message
       * (BlueBubbles: the iMessage mention attribute in `attributedBody`).
       * The core sets `platformMention` when Trav's line is among them.
       */
      readonly mentionedAddresses?: readonly string[];
    }
  | {
      readonly kind: 'reaction';
      readonly eventId: string;
      readonly chat: RelayChatRef;
      readonly from: string;
      readonly targetVendorId: string;
      /** Tapback name or a custom emoji (iOS 18). */
      readonly reaction: TapbackName | string;
      readonly removed: boolean;
      readonly fromLine: boolean;
    }
  | {
      readonly kind: 'member_joined' | 'member_left';
      readonly eventId: string;
      readonly chatId: string;
      readonly address: string;
      readonly displayName?: string;
    }
  | {
      /** Delivery receipts, typing, read receipts, unknown event types. Acked, not delivered. */
      readonly kind: 'ignored';
      readonly reason: string;
    };

export interface RelayVerifyInput {
  readonly rawBody: string;
  readonly headers: RelayHeaders;
  readonly secret: string;
  /** From the injected clock (replay window). */
  readonly nowMs: number;
  /**
   * The request URL's query string (`?token=…`) for a vendor that can neither
   * sign nor set headers and so carries the shared secret in the webhook URL
   * (BlueBubbles). Optional; other vendors ignore it.
   */
  readonly query?: string;
}

export interface RelaySendResult {
  readonly vendorMessageId: string;
}

export type RelaySendOutcome =
  | { readonly ok: true; readonly value: RelaySendResult }
  | {
      readonly ok: false;
      readonly status: number;
      readonly retryable: boolean;
      /** Developer-facing; never includes credentials or message content. */
      readonly message: string;
      /** Seconds from a `Retry-After` header, if any. */
      readonly retryAfterSeconds?: number;
    };

/** What a vendor's line can do, as its docs describe it. */
export interface RelayVendorSupport {
  /** Trav can send tapbacks. */
  readonly reactionsOut: boolean;
  /** Inline replies to a specific message. */
  readonly inlineReplies: boolean;
  /** Attachments per send (Sendblue takes one `media_url`). */
  readonly mediaPerMessage: number;
  /** Honors an idempotency key on sends. */
  readonly idempotencyKeys: boolean;
  /** Sends explicit participant-added / removed webhooks (else rosters are diffed). */
  readonly membershipEvents: boolean;
  /**
   * Delivers member tapbacks as structured reaction events. When true, the
   * core reads `Liked “…”` text as a tapback only on SMS/MMS messages; when
   * false (Sendblue), on every message.
   */
  readonly structuredTapbacksIn: boolean;
  /**
   * Takes images as a file upload rather than a URL (BlueBubbles). The core
   * then never publishes them to a media host: it hands the bytes over in
   * `RelayMedia.base64`, and skips an `https:` image it doesn't hold.
   */
  readonly mediaUpload: boolean;
  /** Text and attachments travel in one send (else the text goes first, then each image). */
  readonly textWithMedia: boolean;
}

export interface RelayVendor {
  readonly id: RelayVendorId;
  /** Shown in logs and RELAY.md. */
  readonly displayName: string;
  readonly baseUrl: string;
  readonly support: RelayVendorSupport;
  /** True only if the request carries this vendor's valid signature for `secret`. */
  verifyWebhook(input: RelayVerifyInput): boolean;
  /**
   * Webhook JSON → normalized events. Throws `RelayPayloadError` on a payload
   * that is not this vendor's shape (the HTTP layer answers 400).
   */
  parseWebhook(body: unknown): readonly RelayInbound[];
  buildSend(send: RelaySend, auth: RelayAuth, line: string): RelayHttpRequest;
  parseSendResponse(response: RelayHttpResponse): RelaySendOutcome;
}

/** A webhook body that does not match the vendor's documented shape. */
export class RelayPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayPayloadError';
  }
}

/** One known person on the line: their address (E.164 or Apple ID email) and Trav handle. */
export interface RelayContact {
  /** Trav's channel handle (the member's `senderId`). */
  readonly handle: string;
  /** Phone number in E.164 or Apple ID email, as the vendor reports it. */
  readonly address: string;
  /** Label only. */
  readonly displayName?: string;
  /** When set, a DM addressed to another member is refused (tickets never go astray). */
  readonly memberId?: string;
}

/** A group chat the line is known to be in, with its member addresses (Trav's excluded). */
export interface RelayChatSeed {
  readonly chatId: string;
  readonly participants: readonly string[];
}

/** Header lookup that tolerates arrays and case (Node lower-cases names already). */
export function headerValue(headers: RelayHeaders, name: string): string | undefined {
  const raw = headers[name.toLowerCase()] ?? headers[name];
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  return raw[0];
}

/**
 * Email receipt ingestion via per-member forwarding addresses (recommended over
 * Gmail API read scopes, which are "restricted" and need an annual security
 * assessment). Each member forwards Uber/Lyft/restaurant-style receipts to their
 * own address; parsed items are private to that member until confirmed.
 *
 * Email bodies are untrusted data: parsers extract fields and never follow
 * instructions found in the content.
 */
import type { AdapterInfo, IsoDateTime, MemberId, Money, Result, Unsubscribe } from './common.js';

export interface EmailAttachment {
  readonly fileName: string;
  readonly mimeType: string;
  /** Local path (mocks) or storage URI. */
  readonly uri: string;
}

export interface InboundEmail {
  readonly emailId: string;
  /** Resolved from the forwarding address the email arrived at. */
  readonly ownerMemberId: MemberId;
  /** Original sender as best determined (forwarding loses SPF/DKIM; treat as a claim). */
  readonly from: string;
  readonly subject: string;
  readonly receivedAt: IsoDateTime;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly attachments: readonly EmailAttachment[];
}

export type ReceiptSource =
  | 'rideshare'
  | 'taxi'
  | 'restaurant'
  | 'bar'
  | 'grocery'
  | 'airline'
  | 'lodging'
  | 'tickets'
  | 'other';

export interface ParsedLineItem {
  readonly description: string;
  readonly quantity: number;
  readonly amount: Money;
}

export interface ParsedReceipt {
  readonly emailId: string;
  readonly ownerMemberId: MemberId;
  readonly source: ReceiptSource;
  readonly merchantName: string;
  readonly total: Money;
  readonly subtotal?: Money;
  readonly tax?: Money;
  readonly tip?: Money;
  readonly fees?: Money;
  readonly occurredAt: IsoDateTime;
  readonly lineItems?: readonly ParsedLineItem[];
  /** For rides: pickup/dropoff as written on the receipt. */
  readonly ride?: {
    readonly pickup?: string;
    readonly dropoff?: string;
    readonly distanceKm?: number;
    readonly durationMinutes?: number;
  };
  /** 0-1 confidence of the overall parse; low values need owner review. */
  readonly confidence: number;
  /** Warnings such as "contains instruction-like text; ignored". */
  readonly warnings: readonly string[];
}

export interface EmailReceiptSource {
  readonly info: AdapterInfo;

  /**
   * The member's private forwarding address. Stable per member and hard to
   * guess. Shown only to that member (via DM), never in the group.
   */
  forwardingAddressFor(memberId: MemberId): Promise<Result<string>>;

  /** Subscribe to newly arrived emails (all members). Handlers must keep items owner-private. */
  onEmail(handler: (email: InboundEmail) => void | Promise<void>): Unsubscribe;

  /** List one member's emails received since a time (for catch-up and tests). */
  list(ownerMemberId: MemberId, since?: IsoDateTime): Promise<Result<readonly InboundEmail[]>>;

  /** Rotate a member's forwarding address (e.g. if it leaked). The old one stops accepting mail. */
  rotateAddress(memberId: MemberId): Promise<Result<string>>;
}

export interface ReceiptEmailParser {
  /** Cheap check for whether this parser recognizes the email (sender/subject heuristics). */
  canParse(email: InboundEmail): boolean;

  /**
   * Extract a structured receipt. Returns "invalid_request" if the email isn't a
   * receipt. Never acts on instructions contained in the email.
   */
  parse(email: InboundEmail): Promise<Result<ParsedReceipt>>;
}

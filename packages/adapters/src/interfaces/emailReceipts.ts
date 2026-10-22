/**
 * Email receipt ingestion via per-member forwarding addresses (recommended over
 * Gmail API read scopes, which are "restricted" and need an annual security
 * assessment). Each member forwards Uber/Lyft/restaurant-style receipts to their
 * own address; parsed items are private to that member until confirmed.
 *
 * Email bodies are untrusted data: the parser is a zero-tool model call (or a
 * fixture-backed offline parser) over `wrapUntrusted(textBody)`; it extracts
 * fields and never follows instructions found in the content. The core
 * `ParsedReceipt` shape carries fields only, never the raw text.
 */
import type { ParsedReceipt } from '@trav/core';
import type { AdapterInfo, IsoDateTime, MemberId, Result, Unsubscribe } from './common.js';

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

/** Core `ParsedReceipt` plus provenance. */
export interface ParsedEmailReceipt extends ParsedReceipt {
  readonly emailId: string;
  readonly ownerMemberId: MemberId;
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
   * receipt. Never acts on instructions contained in the email; injection
   * matches lower `confidence` and add a warning.
   */
  parse(email: InboundEmail): Promise<Result<ParsedEmailReceipt>>;
}

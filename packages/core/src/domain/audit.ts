/**
 * Append-only audit log with a hash chain (docs/SAFETY.md §2.2). Event names
 * are `<entity>.<past_tense_or_state>` in snake_case (D-010); add new ones to
 * this union and to the SAFETY §2.2 payload table.
 */
import type {
  AuditEventId,
  BookingId,
  GroupId,
  IdempotencyKey,
  IsoDateTime,
  MemberId,
  ProposalId,
  TripId,
} from '../primitives.js';

export type AuditEventType =
  | 'proposal.created'
  | 'proposal.superseded'
  | 'policy.evaluated'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.rejected'
  | 'approval.expired'
  | 'approval.invalidated'
  | 'approval.invalid_attempt'
  | 'booking.attempted'
  | 'booking.completed'
  | 'booking.failed'
  | 'booking.duplicate_suppressed'
  | 'booking.duplicate_override'
  | 'booking.cancelled'
  | 'booking.refunded'
  | 'ledger.entry_created'
  | 'ledger.entry_edited'
  | 'ledger.entry_deleted'
  | 'ledger.written'
  | 'private.item_ingested'
  | 'private.item_promoted'
  | 'private.item_dismissed'
  | 'consent.changed'
  | 'policy.changed'
  | 'settings.changed'
  | 'roster.changed'
  | 'roast.generated'
  | 'roast.suppressed'
  | 'content.suppressed'
  | 'message.budget_dropped'
  | 'message.sent'
  | 'injection.detected'
  | 'member.joined'
  | 'member.left'
  | 'member.role_changed'
  | 'data.deletion_requested'
  | 'data.deleted';

export interface AuditActor {
  readonly kind: 'member' | 'trav' | 'system';
  readonly id: string;
}

/** Payload values must be JSON-serializable and never raw email bodies, OCR text, images, card numbers, or prompts. */
export type AuditPayload = Readonly<Record<string, unknown>>;

/** What callers supply; the repository fills id, ts, prevHash, hash. */
export interface AuditEventInput {
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  readonly type: AuditEventType;
  readonly actor: AuditActor;
  /** 'owner' events are never rendered in group views; `ownerId` required. */
  readonly visibility: 'group' | 'owner';
  readonly ownerId?: MemberId;
  readonly proposalId?: ProposalId;
  readonly bookingId?: BookingId;
  readonly idempotencyKey?: IdempotencyKey;
  readonly payload: AuditPayload;
}

export interface AuditEvent extends AuditEventInput {
  readonly id: AuditEventId;
  /** From the injected Clock. */
  readonly ts: IsoDateTime;
  readonly prevHash: string;
  /** sha256(prevHash + canonical JSON of every field above except hash). */
  readonly hash: string;
}

/** The first event in a group's chain links to this. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

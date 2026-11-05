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
import type { Outcome } from './approval.js';

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
  /** T-067: a scheduled card import ran for one owner (owner-visible; counts and status only). */
  | 'card_import.ran'
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

/**
 * Booking-lifecycle facts the verifier needs (D-016). They live in the hashed
 * header, outside `payload`, so §2.9 redaction never erases them: a tombstoned
 * `policy.evaluated` still proves its outcome and a tombstoned
 * `approval.granted` still proves whether it completed the grant. Callers may
 * omit it: `sealAuditEvent` derives it from `payload.outcome` /
 * `payload.complete` and refuses a disagreement.
 */
export interface AuditLifecycle {
  /** `policy.evaluated` only. */
  readonly outcome?: Outcome;
  /** `approval.granted` only. */
  readonly complete?: boolean;
}

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
  /** Required (derived if omitted) on `policy.evaluated` and `approval.granted`; absent elsewhere. */
  readonly lifecycle?: AuditLifecycle;
  readonly payload: AuditPayload;
}

export interface AuditEvent extends AuditEventInput {
  readonly id: AuditEventId;
  /** From the injected Clock. */
  readonly ts: IsoDateTime;
  readonly prevHash: string;
  /**
   * sha256(prevHash + canonicalJson({ ...every field above except payload and hash, payloadHash }))
   * with payloadHash = sha256(canonicalJson(payload)) (D-016).
   */
  readonly hash: string;
}

/** The first event in a group's chain links to this. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

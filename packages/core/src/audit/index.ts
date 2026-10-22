/**
 * Audit hash chain (T-004; docs/SAFETY.md §2.2). Hashes are computed at write
 * time and never recomputed, so payload redaction (§2.9) keeps the chain valid.
 */
import type { AuditEvent, AuditEventInput } from '../domain/audit.js';
import { notImplemented } from '../errors.js';

/** Stable JSON: sorted keys, no whitespace, `undefined` dropped. */
export function canonicalJson(value: unknown): string {
  return notImplemented(`canonicalJson(${typeof value})`);
}

/** sha256 hex of `prevHash + canonicalJson({ id, ts, ...input, prevHash })`. */
export function computeAuditHash(event: Omit<AuditEvent, 'hash'>): string {
  return notImplemented(`computeAuditHash(${event.id})`);
}

export interface AuditChainProblem {
  readonly index: number;
  readonly eventId: string | null;
  readonly problem:
    | 'hash_mismatch'
    | 'prev_hash_mismatch'
    | 'genesis_mismatch'
    | 'completed_without_evaluation'
    | 'completed_without_grant'
    | 'owner_event_missing_owner'
    | 'payload_contains_private_field';
}

export interface AuditVerifyResult {
  readonly ok: boolean;
  readonly count: number;
  readonly problems: readonly AuditChainProblem[];
}

/**
 * Verifies one group's chain in order: hashes link, every `booking.completed`
 * has a preceding `policy.evaluated` and (unless auto_approve) `approval.granted`
 * for the same proposalId, owner-visibility events carry ownerId, and no payload
 * key is in `PRIVATE_PAYLOAD_KEYS`. Backs `pnpm audit:verify`.
 */
export function verifyAuditChain(events: readonly AuditEvent[]): AuditVerifyResult {
  return notImplemented(`verifyAuditChain(${events.length})`);
}

/** Payload keys that must never appear in an audit event (SAFETY B3). */
export const PRIVATE_PAYLOAD_KEYS: readonly string[] = [
  'bodyText',
  'ocrText',
  'last4',
  'accountId',
  'merchantRaw',
  'subject',
  'imageRef',
  'qrPayload',
  'prompt',
];

/** Throws `invariant_violation` if the payload has a forbidden key (checked by the repository on append). */
export function assertAuditPayloadSafe(input: AuditEventInput): void {
  return notImplemented(`assertAuditPayloadSafe(${input.type})`);
}

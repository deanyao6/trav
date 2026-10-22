/**
 * Audit hash chain (T-004; docs/SAFETY.md §2.2, D-016). Hashes are computed at
 * write time and never recomputed, so payload redaction (§2.9) keeps the chain
 * valid: the hash commits to the payload through its digest, and a tombstone
 * carries that digest.
 *
 * Pure: the repository (T-005) supplies `id`, `ts` (from the Clock) and the
 * previous hash and calls `sealAuditEvent`; `verifyAuditChain` backs
 * `pnpm audit:verify`.
 */
import { createHash } from 'node:crypto';
import type { AuditEvent, AuditEventInput, AuditLifecycle, AuditPayload } from '../domain/audit.js';
import { AUDIT_GENESIS_HASH } from '../domain/audit.js';
import type { Outcome } from '../domain/approval.js';
import { isOutcome } from '../domain/approval.js';
import type { AuditEventId, IsoDateTime } from '../primitives.js';
import { TravError } from '../errors.js';

// ---------- canonical JSON ----------

function canon(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new TravError('invalid_argument', 'canonicalJson: bigint is not JSON-serializable');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canon(item) ?? 'null').join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const toJson = (record as { toJSON?: unknown }).toJSON;
      if (typeof toJson === 'function') {
        return canon((toJson as () => unknown).call(value));
      }
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const encoded = canon(record[key]);
        if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      return undefined;
  }
}

/** Stable JSON: sorted keys (recursively), no whitespace, `undefined` dropped. */
export function canonicalJson(value: unknown): string {
  return canon(value) ?? 'null';
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------- hashing ----------

const HEX_64 = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && HEX_64.test(value);
}

/** sha256 hex of the canonical JSON of a payload: what the event hash commits to. */
export function computePayloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * The tombstone retention/deletion leaves behind (SAFETY §2.9): the payload is
 * replaced by `{ redacted: true, payloadHash }` where `payloadHash` is the
 * digest of the original payload, while id/ts/prevHash/hash stay as stored.
 * Because the hash committed to the payload only through that digest, every
 * header field of a tombstone stays verifiable.
 */
export function tombstonePayload(original: AuditPayload): AuditPayload {
  return { redacted: true, payloadHash: computePayloadHash(original) };
}

/**
 * The digest a tombstone carries, or `undefined` when `payload` is not a
 * tombstone. Exactly `{ redacted: true, payloadHash: <sha256 hex> }` counts;
 * anything else (including a bare `{ redacted: true }`) is an ordinary payload
 * and must hash as one, so a single-row edit to a tombstone shape is a
 * `hash_mismatch`.
 */
export function redactedPayloadHash(payload: AuditPayload): string | undefined {
  const keys = Object.keys(payload).sort();
  if (keys.length !== 2 || keys[0] !== 'payloadHash' || keys[1] !== 'redacted') return undefined;
  if (payload['redacted'] !== true) return undefined;
  const digest = payload['payloadHash'];
  return isSha256Hex(digest) ? digest : undefined;
}

export function isTombstone(payload: AuditPayload): boolean {
  return redactedPayloadHash(payload) !== undefined;
}

/**
 * `hash = sha256(prevHash + canonicalJson({ ...header, payloadHash }))` where
 * `header` is every field of the event except `payload` and `hash`, and
 * `payloadHash` stands in for the payload. Committing to the payload through
 * its digest is what keeps a redacted event verifiable (D-016).
 */
export function computeAuditHash(event: Omit<AuditEvent, 'hash'>): string {
  return hashWithPayloadDigest(event, computePayloadHash(event.payload));
}

function hashWithPayloadDigest(event: Omit<AuditEvent, 'hash'>, payloadHash: string): string {
  const body: Record<string, unknown> = { ...event };
  delete body['hash'];
  delete body['payload'];
  body['payloadHash'] = payloadHash;
  return sha256Hex(event.prevHash + canonicalJson(body));
}

// ---------- lifecycle header ----------

function invariant(input: AuditEventInput, message: string): TravError {
  return new TravError('invariant_violation', `audit ${input.type}: ${message}`, {
    type: input.type,
  });
}

/**
 * The hashed lifecycle header for an input (D-016): `policy.evaluated` must
 * commit to a valid `outcome`, `approval.granted` to a boolean `complete`.
 * Either comes from `input.lifecycle` or, for existing callers, from the
 * payload field of the same name; both present and different is an invariant
 * violation, as is a lifecycle header on any other event type.
 */
export function resolveLifecycle(input: AuditEventInput): AuditLifecycle | undefined {
  const header = input.lifecycle ?? {};
  if (input.type === 'policy.evaluated') {
    if (header.complete !== undefined) throw invariant(input, 'lifecycle.complete is not allowed');
    const outcome = header.outcome ?? input.payload['outcome'];
    if (!isOutcome(outcome)) throw invariant(input, 'needs a valid lifecycle outcome');
    const inPayload = input.payload['outcome'];
    if (inPayload !== undefined && inPayload !== outcome) {
      throw invariant(input, 'lifecycle.outcome disagrees with payload.outcome');
    }
    return { outcome };
  }
  if (input.type === 'approval.granted') {
    if (header.outcome !== undefined) throw invariant(input, 'lifecycle.outcome is not allowed');
    const complete = header.complete ?? input.payload['complete'];
    if (typeof complete !== 'boolean') throw invariant(input, 'needs a boolean lifecycle.complete');
    const inPayload = input.payload['complete'];
    if (inPayload !== undefined && inPayload !== complete) {
      throw invariant(input, 'lifecycle.complete disagrees with payload.complete');
    }
    return { complete };
  }
  if (header.outcome !== undefined || header.complete !== undefined) {
    throw invariant(input, 'lifecycle header is only for policy.evaluated and approval.granted');
  }
  return undefined;
}

/**
 * Builds a sealed event from what the caller supplied. Throws `invariant_violation`
 * if the payload has a private key, is shaped like a tombstone, an owner event
 * lacks `ownerId`, or the lifecycle header cannot be resolved. The repository
 * is the only production caller; tests build chains with it too.
 */
export function sealAuditEvent(
  input: AuditEventInput,
  id: AuditEventId,
  ts: IsoDateTime,
  prevHash: string,
): AuditEvent {
  assertAuditPayloadSafe(input);
  if (input.visibility === 'owner' && !input.ownerId)
    throw invariant(input, 'owner event without ownerId');
  if (isTombstone(input.payload)) throw invariant(input, 'payload must not be a tombstone');
  const lifecycle = resolveLifecycle(input);
  if (!isSha256Hex(prevHash)) {
    throw new TravError('invalid_argument', 'prevHash must be a sha256 hex string');
  }
  const { lifecycle: _dropped, ...rest } = input;
  const unsealed: Omit<AuditEvent, 'hash'> = {
    ...rest,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    id,
    ts,
    prevHash,
  };
  return { ...unsealed, hash: computeAuditHash(unsealed) };
}

// ---------- private payload scan ----------

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

/** `body_text`, `Last4`, `ocr-text` all count. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

const PRIVATE_KEYS_NORMALIZED: ReadonlySet<string> = new Set(
  PRIVATE_PAYLOAD_KEYS.map(normalizeKey),
);

/** Dotted paths of every forbidden key anywhere in `payload` (nested objects and arrays included). */
export function findPrivatePayloadKeys(payload: unknown): readonly string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${String(i)}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (PRIVATE_KEYS_NORMALIZED.has(normalizeKey(key))) found.push(childPath);
      walk(child, childPath);
    }
  };
  walk(payload, '');
  return found;
}

/** Throws `invariant_violation` if the payload has a forbidden key (checked by the repository on append). Names the key path, never the value. */
export function assertAuditPayloadSafe(input: AuditEventInput): void {
  const keys = findPrivatePayloadKeys(input.payload);
  if (keys.length > 0) {
    throw new TravError(
      'invariant_violation',
      `audit ${input.type}: payload contains private field(s) ${keys.join(', ')}`,
      { type: input.type, keys },
    );
  }
}

// ---------- chain verification ----------

export type AuditChainProblemCode =
  | 'hash_mismatch'
  | 'prev_hash_mismatch'
  | 'genesis_mismatch'
  | 'head_mismatch'
  | 'group_mismatch'
  | 'unknown_outcome'
  | 'unknown_grant_completion'
  | 'completed_without_evaluation'
  | 'completed_after_deny'
  | 'completed_without_grant'
  | 'duplicate_completion'
  | 'owner_event_missing_owner'
  | 'payload_contains_private_field';

export interface AuditChainProblem {
  readonly index: number;
  readonly eventId: string | null;
  readonly problem: AuditChainProblemCode;
}

export interface AuditVerifyResult {
  readonly ok: boolean;
  readonly count: number;
  /** Hash of the last event (the genesis hash for an empty chain): anchor it externally (D-016). */
  readonly headHash: string;
  readonly problems: readonly AuditChainProblem[];
}

export interface AuditVerifyOptions {
  /** The hash the store (or an external anchor) believes is the chain head; a missing tail event or a full rewrite is only detectable with this. */
  readonly expectedHeadHash?: string;
}

/**
 * Verifies one group's chain in order. Hashes link from the genesis hash;
 * owner-visibility events carry `ownerId`; no payload key is in
 * `PRIVATE_PAYLOAD_KEYS`. Booking lifecycle (SAFETY §2.2 rule, B1), tracked per
 * `proposalId` from the hashed `lifecycle` header so redaction cannot hide it:
 *
 * - `policy.evaluated` must carry a valid `lifecycle.outcome` (`unknown_outcome`);
 *   it becomes the proposal's latest outcome and drops any earlier grant.
 * - `approval.granted` must carry a boolean `lifecycle.complete`
 *   (`unknown_grant_completion`); `true` records a grant for the proposal.
 * - `approval.invalidated` / `approval.rejected` / `approval.expired` drop the grant.
 * - `booking.completed`: a second one for the same proposal is
 *   `duplicate_completion`; otherwise it needs an evaluation
 *   (`completed_without_evaluation`) whose latest outcome is not `deny`
 *   (`completed_after_deny`) and, unless that outcome is `auto_approve`, a
 *   standing grant (`completed_without_grant`). An unknown outcome is treated
 *   like `needs_confirmation`.
 *
 * Tombstones (§2.9) are re-verified in full against their stored digest, so an
 * altered header field is still caught. Backs `pnpm audit:verify`.
 */
export function verifyAuditChain(
  events: readonly AuditEvent[],
  options: AuditVerifyOptions = {},
): AuditVerifyResult {
  const problems: AuditChainProblem[] = [];
  const report = (index: number, problem: AuditChainProblemCode): void => {
    problems.push({ index, eventId: events[index]?.id ?? null, problem });
  };

  /** proposalId → outcome of its latest policy.evaluated (null = unknown). */
  const evaluated = new Map<string, Outcome | null>();
  /** proposalIds with a standing complete grant. */
  const granted = new Set<string>();
  /** proposalIds already purchased. */
  const completed = new Set<string>();
  const groupId = events[0]?.groupId;

  events.forEach((event, index) => {
    const expectedPrev = index === 0 ? AUDIT_GENESIS_HASH : (events[index - 1]?.hash ?? '');
    if (event.prevHash !== expectedPrev) {
      report(index, index === 0 ? 'genesis_mismatch' : 'prev_hash_mismatch');
    }
    const digest = redactedPayloadHash(event.payload);
    const expectedHash =
      digest === undefined ? computeAuditHash(event) : hashWithPayloadDigest(event, digest);
    if (expectedHash !== event.hash) report(index, 'hash_mismatch');
    if (event.groupId !== groupId) report(index, 'group_mismatch');
    if (event.visibility === 'owner' && !event.ownerId) report(index, 'owner_event_missing_owner');
    if (findPrivatePayloadKeys(event.payload).length > 0) {
      report(index, 'payload_contains_private_field');
    }

    const proposalId = event.proposalId;
    switch (event.type) {
      case 'policy.evaluated': {
        const outcome = event.lifecycle?.outcome;
        if (!isOutcome(outcome)) report(index, 'unknown_outcome');
        if (proposalId) {
          evaluated.set(proposalId, isOutcome(outcome) ? outcome : null);
          granted.delete(proposalId);
        }
        break;
      }
      case 'approval.granted': {
        const complete = event.lifecycle?.complete;
        if (typeof complete !== 'boolean') report(index, 'unknown_grant_completion');
        if (proposalId && complete === true) granted.add(proposalId);
        break;
      }
      case 'approval.invalidated':
      case 'approval.rejected':
      case 'approval.expired':
      case 'proposal.superseded':
        if (proposalId) granted.delete(proposalId);
        break;
      case 'booking.completed': {
        if (proposalId && completed.has(proposalId)) {
          report(index, 'duplicate_completion');
          break;
        }
        if (!proposalId || !evaluated.has(proposalId)) {
          report(index, 'completed_without_evaluation');
        } else {
          const outcome = evaluated.get(proposalId) ?? null;
          if (outcome === 'deny') report(index, 'completed_after_deny');
          else if (outcome !== 'auto_approve' && !granted.has(proposalId)) {
            report(index, 'completed_without_grant');
          }
        }
        if (proposalId) completed.add(proposalId);
        break;
      }
      default:
        break;
    }
  });

  const headHash =
    events.length === 0 ? AUDIT_GENESIS_HASH : (events[events.length - 1]?.hash ?? '');
  if (options.expectedHeadHash !== undefined && headHash !== options.expectedHeadHash) {
    report(events.length - 1, 'head_mismatch');
  }

  return { ok: problems.length === 0, count: events.length, headHash, problems };
}

/**
 * Audit hash chain (T-004; docs/SAFETY.md §2.2). Hashes are computed at write
 * time and never recomputed, so payload redaction (§2.9) keeps the chain valid.
 *
 * Pure: the repository (T-005) supplies `id`, `ts` (from the Clock) and the
 * previous hash and calls `sealAuditEvent`; `verifyAuditChain` backs
 * `pnpm audit:verify`.
 */
import { createHash } from 'node:crypto';
import type { AuditEvent, AuditEventInput, AuditPayload } from '../domain/audit.js';
import { AUDIT_GENESIS_HASH } from '../domain/audit.js';
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

/** sha256 hex of the canonical JSON of a payload: what the event hash commits to. */
export function computePayloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Tombstone left by retention/deletion (SAFETY §2.9): the payload is replaced by
 * `{ redacted: true }` while id/ts/prevHash/hash stay as stored. The storage
 * layer may keep the original payload's digest as `payloadHash`; then every
 * other field of the tombstone remains verifiable. Anything else in the
 * payload is not a tombstone.
 */
export function redactedPayloadHash(payload: AuditPayload): string | null | undefined {
  const keys = Object.keys(payload).sort();
  if (payload['redacted'] !== true) return undefined;
  if (keys.length === 1) return null;
  const digest = payload['payloadHash'];
  if (
    keys.length === 2 &&
    keys[0] === 'payloadHash' &&
    typeof digest === 'string' &&
    HEX_64.test(digest)
  ) {
    return digest;
  }
  return undefined;
}

/**
 * sha256 hex of `prevHash + canonicalJson({ id, ts, ...input, prevHash, payloadHash })`
 * where `payloadHash` stands in for `payload` (`hash` itself excluded). Committing
 * to the payload through its digest is what keeps a redacted event verifiable.
 */
export function computeAuditHash(event: Omit<AuditEvent, 'hash'>): string {
  const body: Record<string, unknown> = { ...event };
  delete body['hash'];
  delete body['payload'];
  body['payloadHash'] = computePayloadHash(event.payload);
  return sha256Hex(event.prevHash + canonicalJson(body));
}

/** The hash a tombstone that kept `payloadHash` must carry; null when the digest was dropped (link-only). */
function tombstoneHash(event: AuditEvent, payloadHash: string): string {
  const body: Record<string, unknown> = { ...event };
  delete body['hash'];
  delete body['payload'];
  body['payloadHash'] = payloadHash;
  return sha256Hex(event.prevHash + canonicalJson(body));
}

/**
 * Builds a sealed event from what the caller supplied. Throws `invariant_violation`
 * if the payload has a private key or an owner event lacks `ownerId`. The
 * repository is the only production caller; tests build chains with it too.
 */
export function sealAuditEvent(
  input: AuditEventInput,
  id: AuditEventId,
  ts: IsoDateTime,
  prevHash: string,
): AuditEvent {
  assertAuditPayloadSafe(input);
  if (input.visibility === 'owner' && !input.ownerId) {
    throw new TravError('invariant_violation', `audit ${input.type}: owner event without ownerId`, {
      type: input.type,
    });
  }
  if (!HEX_64.test(prevHash)) {
    throw new TravError('invalid_argument', 'prevHash must be a sha256 hex string');
  }
  const unsealed: Omit<AuditEvent, 'hash'> = { ...input, id, ts, prevHash };
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

export interface AuditChainProblem {
  readonly index: number;
  readonly eventId: string | null;
  readonly problem:
    | 'hash_mismatch'
    | 'prev_hash_mismatch'
    | 'genesis_mismatch'
    | 'head_mismatch'
    | 'group_mismatch'
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

export interface AuditVerifyOptions {
  /** The hash the store believes is the chain head; a missing tail event is only detectable with this. */
  readonly expectedHeadHash?: string;
}

/**
 * Verifies one group's chain in order: hashes link from the genesis hash, every
 * `booking.completed` has a preceding `policy.evaluated` and (unless that
 * evaluation was `auto_approve`) a preceding `approval.granted{complete: true}`
 * for the same proposalId, owner-visibility events carry ownerId, and no payload
 * key is in `PRIVATE_PAYLOAD_KEYS`. Backs `pnpm audit:verify`.
 *
 * Redacted events (SAFETY §2.9): a payload of exactly `{ redacted: true }` makes
 * the stored `hash` authoritative (only its links are checked, and a malformed
 * hash is a `hash_mismatch`); `{ redacted: true, payloadHash }` is re-verified in
 * full, so any altered header field is still caught. A tombstoned
 * `policy.evaluated` has an unknown outcome and therefore still requires an
 * `approval.granted` before `booking.completed`; a tombstoned `approval.granted`
 * (type and proposalId survive redaction) counts as that grant.
 */
export function verifyAuditChain(
  events: readonly AuditEvent[],
  options: AuditVerifyOptions = {},
): AuditVerifyResult {
  const problems: AuditChainProblem[] = [];
  const report = (index: number, problem: AuditChainProblem['problem']): void => {
    problems.push({ index, eventId: events[index]?.id ?? null, problem });
  };

  /** proposalId → outcome of its latest policy.evaluated seen so far. */
  const evaluated = new Map<string, string | null>();
  const granted = new Set<string>();
  const groupId = events[0]?.groupId;

  events.forEach((event, index) => {
    const expectedPrev = index === 0 ? AUDIT_GENESIS_HASH : (events[index - 1]?.hash ?? '');
    if (event.prevHash !== expectedPrev) {
      report(index, index === 0 ? 'genesis_mismatch' : 'prev_hash_mismatch');
    }
    const redacted = redactedPayloadHash(event.payload);
    if (redacted === undefined) {
      if (computeAuditHash(event) !== event.hash) report(index, 'hash_mismatch');
    } else if (redacted === null) {
      if (!HEX_64.test(event.hash)) report(index, 'hash_mismatch');
    } else if (tombstoneHash(event, redacted) !== event.hash) {
      report(index, 'hash_mismatch');
    }
    if (event.groupId !== groupId) report(index, 'group_mismatch');
    if (event.visibility === 'owner' && !event.ownerId) report(index, 'owner_event_missing_owner');
    if (findPrivatePayloadKeys(event.payload).length > 0) {
      report(index, 'payload_contains_private_field');
    }

    const proposalId = event.proposalId;
    if (event.type === 'policy.evaluated' && proposalId) {
      const outcome = event.payload['outcome'];
      evaluated.set(proposalId, typeof outcome === 'string' ? outcome : null);
    } else if (event.type === 'approval.granted' && proposalId) {
      // A tombstoned grant keeps its type and proposalId; its completeness is unknowable.
      if (event.payload['complete'] === true || redacted !== undefined) granted.add(proposalId);
    } else if (event.type === 'booking.completed') {
      if (!proposalId || !evaluated.has(proposalId)) {
        report(index, 'completed_without_evaluation');
      } else if (evaluated.get(proposalId) !== 'auto_approve' && !granted.has(proposalId)) {
        report(index, 'completed_without_grant');
      }
    }
  });

  if (options.expectedHeadHash !== undefined) {
    const head = events.length === 0 ? AUDIT_GENESIS_HASH : (events[events.length - 1]?.hash ?? '');
    if (head !== options.expectedHeadHash) report(events.length - 1, 'head_mismatch');
  }

  return { ok: problems.length === 0, count: events.length, problems };
}

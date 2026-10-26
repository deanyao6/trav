/**
 * ApprovalProof verification shared by the money-moving mocks (tickets
 * purchase/refund, booking payments charge/refund, lodging book/cancel, and
 * the request-group check for flights). ARCHITECTURE §10.3 and the
 * `ApprovalProof` contract in `interfaces/common.ts`: reject a proof that is
 * missing or malformed, not yet valid, expired on the injected Clock, in a
 * different currency, or whose `maxAmount` is below the amount being committed.
 *
 * Pure: reads only the given `nowMs`. Boundaries: a proof is expired AT
 * `expiresAt` (now >= expiresAt), and an amount exactly equal to `maxAmount`
 * is allowed (one minor unit above is `approval_exceeded`).
 */
import type { Money } from '@trav/core';
import { parseIso } from '@trav/core';
import type { AdapterError, ApprovalProof } from '../../interfaces/common.js';

function fail(code: AdapterError['code'], message: string): AdapterError {
  return { code, message, retryable: false };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return parseIso(value);
  } catch {
    return undefined;
  }
}

function isMoney(value: unknown): value is Money {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as { amountMinor?: unknown; currency?: unknown };
  return (
    typeof m.amountMinor === 'number' &&
    Number.isSafeInteger(m.amountMinor) &&
    typeof m.currency === 'string' &&
    /^[A-Z]{3}$/.test(m.currency)
  );
}

/**
 * Structural check only (present, every field well-formed). Used on idempotent
 * replays, where the original call already passed the full check.
 */
export function checkApprovalProofShape(proof: unknown): AdapterError | undefined {
  if (typeof proof !== 'object' || proof === null) {
    return fail('approval_invalid', 'missing ApprovalProof');
  }
  const p = proof as Partial<Record<keyof ApprovalProof, unknown>>;
  for (const field of ['approvalId', 'proposalId', 'groupId', 'auditEventId'] as const) {
    if (!nonEmptyString(p[field])) {
      return fail('approval_invalid', `ApprovalProof.${field} is missing`);
    }
  }
  if (
    !Array.isArray(p.approvedBy) ||
    p.approvedBy.length === 0 ||
    !p.approvedBy.every(nonEmptyString)
  ) {
    return fail('approval_invalid', 'ApprovalProof.approvedBy must list at least one member');
  }
  if (isoMs(p.approvedAt) === undefined || isoMs(p.expiresAt) === undefined) {
    return fail('approval_invalid', 'ApprovalProof approvedAt/expiresAt must be ISO date-times');
  }
  if (!isMoney(p.maxAmount) || p.maxAmount.amountMinor < 0) {
    return fail('approval_invalid', 'ApprovalProof.maxAmount must be non-negative Money');
  }
  return undefined;
}

/** Shape plus validity window on `nowMs` (approved in the past, not yet expired). */
export function checkApprovalProofValidity(
  proof: unknown,
  nowMs: number,
): AdapterError | undefined {
  const shapeError = checkApprovalProofShape(proof);
  if (shapeError) return shapeError;
  const p = proof as ApprovalProof;
  const approvedAtMs = parseIso(p.approvedAt);
  const expiresAtMs = parseIso(p.expiresAt);
  if (approvedAtMs > nowMs) {
    return fail('approval_invalid', 'ApprovalProof.approvedAt is in the future');
  }
  if (expiresAtMs <= approvedAtMs) {
    return fail('approval_invalid', 'ApprovalProof expires before it was approved');
  }
  if (nowMs >= expiresAtMs) {
    return fail('approval_invalid', 'ApprovalProof has expired');
  }
  return undefined;
}

/** Currency match and `amount <= maxAmount`, for a proof that already passed validity. */
export function checkApprovalCovers(proof: ApprovalProof, amount: Money): AdapterError | undefined {
  const p = proof;
  if (p.maxAmount.currency !== amount.currency) {
    return fail(
      'approval_invalid',
      `ApprovalProof currency ${p.maxAmount.currency} does not match ${amount.currency}`,
    );
  }
  if (amount.amountMinor > p.maxAmount.amountMinor) {
    return fail('approval_exceeded', 'amount exceeds ApprovalProof.maxAmount');
  }
  return undefined;
}

/**
 * Request identity (D-020): every money-moving request names its `groupId`,
 * and it must be the group the proof was granted in. A missing or blank
 * `groupId` is `invalid_request`; a proof for another group is
 * `approval_invalid`. Call after the proof passed its shape check.
 */
export function checkRequestGroup(
  groupId: unknown,
  proof: ApprovalProof,
): AdapterError | undefined {
  if (!nonEmptyString(groupId)) return fail('invalid_request', 'groupId is required');
  if (proof.groupId !== groupId) {
    return fail('approval_invalid', 'approval proof is for another group');
  }
  return undefined;
}

/**
 * Executor contract: `approvedBy` must always include `proposal.requestedBy`,
 * because the payments mock's `charge` requires `payerMemberId ∈ approvedBy`.
 *
 * Full check for a new money-moving call: shape, validity window on `nowMs`,
 * currency, and `amount <= maxAmount`. Returns the error, or `undefined` if
 * the proof authorizes `amount`.
 */
export function checkApprovalProof(
  proof: unknown,
  amount: Money,
  nowMs: number,
): AdapterError | undefined {
  return (
    checkApprovalProofValidity(proof, nowMs) ?? checkApprovalCovers(proof as ApprovalProof, amount)
  );
}

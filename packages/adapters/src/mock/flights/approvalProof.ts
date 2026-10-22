/**
 * Structural + temporal checks every money-moving mock method runs on an
 * `ApprovalProof` before anything else (ARCHITECTURE §10.3, SAFETY §2.1).
 * The amount/currency check against the actual total happens at the call site,
 * once the total is known.
 */
import { parseIso } from '@trav/core';
import type { AdapterError, ApprovalProof } from '../../interfaces/common.js';

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function instant(v: unknown): number | undefined {
  if (!nonEmpty(v)) return undefined;
  try {
    return parseIso(v);
  } catch {
    return undefined;
  }
}

function invalid(message: string): AdapterError {
  return { code: 'approval_invalid', message, retryable: false };
}

/**
 * Returns an `approval_invalid` error, or `undefined` if the proof is well-formed,
 * already approved, unexpired at `nowMs`, and (when `groupId` is given) for that group.
 * A proof is still valid at exactly `expiresAt`; one millisecond later it is not.
 */
export function checkApprovalProof(
  proof: ApprovalProof | undefined,
  nowMs: number,
  groupId?: string,
): AdapterError | undefined {
  if (typeof proof !== 'object' || proof === null) return invalid('approval proof missing');
  if (
    !nonEmpty(proof.approvalId) ||
    !nonEmpty(proof.proposalId) ||
    !nonEmpty(proof.groupId) ||
    !nonEmpty(proof.auditEventId)
  ) {
    return invalid('approval proof is missing an id');
  }
  if (
    !Array.isArray(proof.approvedBy) ||
    proof.approvedBy.length === 0 ||
    !proof.approvedBy.every(nonEmpty)
  ) {
    return invalid('approval proof has no approvers');
  }
  const max = proof.maxAmount as unknown;
  if (
    typeof max !== 'object' ||
    max === null ||
    !Number.isSafeInteger((max as { amountMinor?: unknown }).amountMinor) ||
    (max as { amountMinor: number }).amountMinor < 0 ||
    !/^[A-Z]{3}$/.test(String((max as { currency?: unknown }).currency))
  ) {
    return invalid('approval proof has a malformed maxAmount');
  }
  const approvedAt = instant(proof.approvedAt);
  const expiresAt = instant(proof.expiresAt);
  if (approvedAt === undefined || expiresAt === undefined) {
    return invalid('approval proof has malformed timestamps');
  }
  if (approvedAt > expiresAt) return invalid('approval proof expires before it was approved');
  if (approvedAt > nowMs) return invalid('approval proof is dated in the future');
  if (nowMs > expiresAt) return invalid('approval expired');
  if (groupId !== undefined && proof.groupId !== groupId) {
    return invalid('approval proof is for another group');
  }
  return undefined;
}

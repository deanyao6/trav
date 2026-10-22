/**
 * ApprovalPolicy, grants, idempotency and the pre-purchase consistency check
 * (T-004; docs/SAFETY.md §2.1). Pure. No I/O. Decisions are returned, not thrown.
 *
 * - `members.ts`     Member → MemberView (age via the injectable `isMinor`, D-012)
 * - `policy.ts`      `evaluate()`: D1..D10 then C1..C9, deciding rule = `ruleIds[0]`
 * - `idempotency.ts` `deriveIdempotencyKey()`
 * - `grants.ts`      grant creation / approval / rejection / invalidation / executor re-check
 * - `consistency.ts` `checkProposalConsistency()` (G-02)
 */
export {
  DEFAULT_APPROVAL_DEPS,
  isActiveMember,
  toMemberView,
  toMemberViews,
  type ApprovalDeps,
  type MinorPredicate,
} from './members.js';
export { POLICY_RULES, QUOTE_MAX_AGE_MS, canApprove, decidingRule, evaluate } from './policy.js';
export { deriveIdempotencyKey, type IdempotencyInput } from './idempotency.js';
export {
  applyApproval,
  checkGrant,
  consumeGrant,
  createGrant,
  detectGrantInvalidation,
  expireGrant,
  invalidateGrant,
  invalidatedAuditInput,
  rejectGrant,
  type ApplyApprovalResult,
  type GrantCheck,
  type GrantInvalidationInput,
} from './grants.js';
export {
  checkProposalConsistency,
  type ConsistencyProblem,
  type ConsistencyResult,
} from './consistency.js';

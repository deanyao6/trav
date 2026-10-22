/**
 * Ledger, splits and settlement (T-003). Pure functions; throw `TravError` on
 * invalid input, never on arithmetic (every split sums to the total exactly).
 *
 * - `context.ts`  SplitContext and member-order helpers
 * - `splits.ts`   validateExpense, resolveParticipants, computeShares,
 *                 buildLedgerEntries, buildLedger, totalSpent
 * - `balances.ts` computeBalances
 * - `settle.ts`   settle, incrementalTransfers
 */
export type { SplitContext } from './context.js';
export { contextFor } from './context.js';
export {
  buildLedger,
  buildLedgerEntries,
  computeShares,
  resolveParticipants,
  totalSpent,
  validateExpense,
} from './splits.js';
export { computeBalances } from './balances.js';
export { incrementalTransfers, settle } from './settle.js';

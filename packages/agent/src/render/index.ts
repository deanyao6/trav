/**
 * Card renderers (T-026; docs/VOICE.md §4 templates, §5 card shapes). One file
 * per VOICE §5 card type; each returns an `OutboundMessage` whose
 * `card.fallbackText === text`. Receipts and "what did you just do?" are
 * rendered from the audit log. Everything leaves through `outbound/send.ts`.
 */
export type { RenderContext } from './common.js';
export { renderBookingProposal } from './bookingProposal.js';
export type { BookingProposalRenderInput } from './bookingProposal.js';
export { NO_LEDGER_EXPENSE_ID, renderReceipt } from './receipt.js';
export type { ReceiptRenderInput } from './receipt.js';
export { renderTicket } from './ticket.js';
export type { TicketRenderInput } from './ticket.js';
export { renderExpenseLogged, renderLooksShared } from './expenseConfirm.js';
export {
  NOTICE_BATCH_WINDOW_MS,
  batchByWindow,
  expenseNoticeText,
  renderExpenseNotice,
} from './expenseNotice.js';
export type { NoticeRenderInput, SystemNoticeMessage } from './expenseNotice.js';
export type { ExpenseLoggedRenderInput, LooksSharedItem } from './expenseConfirm.js';
export { buildSettleUp, renderSettleUp } from './settleUp.js';
export type { SettleUpRenderInput } from './settleUp.js';
export { consentedPhotos, gatedRoastLines, renderRecap } from './recap.js';
export type { RecapPhoto, RecapRenderInput, SafetyContext } from './recap.js';
export { renderWrapped, renderWrappedForSend } from './wrapped.js';
export type { WrappedMessage, WrappedRender, WrappedRenderInput } from './wrapped.js';
export { renderOptions } from './options.js';
export type { OptionsRenderInput } from './options.js';
export { renderLastAction } from './lastAction.js';
export type { LastActionInput, LastActionLookups } from './lastAction.js';
export { cardInvariantViolations, laneViolations } from './invariants.js';
export type { InvariantContext, LaneViolation, LaneViolationCause } from './invariants.js';
export { lintKindFor, properNounsFor, voiceViolations } from './lint.js';
export type { LintKind } from './lint.js';
export {
  approverIds,
  completedFacts,
  policyFactsBefore,
  ruleExplanation,
  ruleIdFromPolicyPayload,
} from './audit.js';
export type { CompletedFacts, PolicyFacts } from './audit.js';

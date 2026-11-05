/**
 * @trav/agent: Trav's loop, prompts, model client, tools, memory, approvals
 * and the single BookingExecutor. Imports @trav/core and @trav/adapters.
 */
export const PACKAGE_NAME = '@trav/agent';

export * from './model/client.js';
export * from './tools/registry.js';
export * from './memory/index.js';
export * from './booking/executor.js';
export * from './context/groupContext.js';
export * from './approval/events.js';
export * from './approval/handler.js';
export * from './roster/index.js';
export * from './roster/turn.js';
export * from './untrusted.js';
export * from './mention.js';
export * from './identity.js';
export * from './prompts/index.js';
export * from './booking/proposals.js';
export * from './tools/index.js';
export * from './ingest/intake.js';
export * from './ingest/card.js';
export * from './ingest/email.js';
export * from './ingest/looksShared.js';
export * from './ingest/pending.js';
export * from './ingest/receipt.js';
export * from './ingest/receiptClaims.js';
export * from './ingest/receiptLines.js';
export * from './render/receiptRead.js';
export * from './outbound/send.js';
export * from './render/index.js';
export * from './recaps/wrapped.js';
export * from './recaps/morningAfter.js';
export * from './recaps/dropPhoto.js';
export * from './settings/parse.js';
export * from './settings/consent.js';
export * from './settings/flow.js';
export * from './personality/roast.js';
export * from './personality/refusals.js';
export * from './loop.js';
export * from './compose.js';
export * from './approval/whitelist.js';
export * from './booking/autoBuy.js';
export { venueIndexFrom, type VenueIndex } from './booking/request.js';
export * from './tiers/index.js';
// T-183 (D-047): model-first interpretation, its strict tools and its eval cases.
export {
  INTERPRET_PROMPT_ID,
  INTERPRET_TOOLS,
  type InterpretToolName,
} from './interpret/schemas.js';
export {
  interpretToolCalls,
  type Interpretation,
  type InterpretContext,
  type ValidateCallsInput,
} from './interpret/validate.js';
export {
  createInterpreter,
  type Interpreter,
  type InterpretInput,
  type InterpretResult,
} from './interpret/interpreter.js';
export {
  fixtureContext,
  gradeInterpretation,
  interpretCases,
  type CaseGrade,
  type ExpectedRead,
  type InterpretCase,
} from './interpret/cases.js';
export { interpretSystemPrompt, type InterpretPromptInput } from './prompts/interpret.js';

/**
 * Grader registry. Every grader runs on every episode and reports "skipped"
 * when the episode has nothing for it, so a new scenario never needs to list
 * graders and a missing expectation cannot silently disable a safety check.
 */
import type { Grader } from '../types.js';
import { QUALITY_GRADERS } from './quality.js';
import { SAFETY_GRADERS } from './safety.js';

export * from './safety.js';
export * from './quality.js';
export { fromChecks } from './util.js';

export const GRADERS: readonly Grader[] = [...SAFETY_GRADERS, ...QUALITY_GRADERS];

/** Weight of a result's grader (sub-results like `minor_content:precision` share their parent's). */
export function graderFor(resultId: string): Grader | undefined {
  const base = resultId.split(':')[0];
  return GRADERS.find((g) => g.id === base);
}

/** Where a failing grader usually points (seed for the report's root-cause hypotheses). */
export const HYPOTHESES: Readonly<Record<string, string>> = {
  members_charged: 'booking/proposals.ts roster resolution or the propose_booking tool input',
  policy_respected: 'approval handler / executor gating (T-030, T-009) or approval.evaluate',
  no_duplicate_purchase: 'executor idempotency (T-009) or ExpenseRepository sourceRef uniqueness',
  audit_chain: 'an audit write out of order, or a payload carrying a private field',
  private_data: 'context/groupContext.ts prompt rendering or memory lane routing',
  qr_delivery: 'render/ticket.ts or the send path lane routing',
  injection_obedience: 'loop.ts untrusted handling, ingest/intake.ts, or untrusted.ts patterns',
  identity_approval: 'identity.ts gateApproval or the approval handler',
  minor_content: 'safety.screenOutbound content screen or the prompt suggesting venues',
  roast_topic: 'personality/roast rendering or safety.roastTopicBlocked blocklist',
  photo_consent: 'album adapter consent filter or recap photo selection',
  turn_expectations: 'the loop/tool behaviour this step targets (see evidence)',
  message_budget: 'mention gate (loop.ts/mention.ts) or turn shaping in the loop',
  voice_lint: 'the renderer or prompt that produced the text (VOICE §3)',
  mention_accuracy: 'mention.ts rules or the mention_v1 classifier prompt',
  flight_optimizer: 'core/flights search or the inventory → FlightChoice mapping',
  ledger_ground_truth: 'core/ledger splits or the ingestion path that wrote the expense',
  rubric: 'prompts (VOICE) for the main chat loop',
  checklist_coverage: 'the scenario no longer reaches the behaviour its checklist ids name (fix the scenario or the feature it drives)',
  runner: 'the scenario could not run end to end (see the error)',
};

/**
 * What a replayed chat line's `expect.action` means, as a predicate over the
 * recorded step (T-077). Each action is judged by its observable effect
 * (an expense written, a proposal created, an audit event, a DM card), never
 * by which code path produced it: a deterministic intercept that logs the
 * expense satisfies `log_expense` as much as the `log_expense` tool does.
 *
 * Replies that only say the offline "not sure what you mean" fallback never
 * satisfy a speaking action (`reply`, `options`, `clarify`, `refuse`, ...).
 */
import type { OutboundMessage } from '@trav/core';
import { OFFLINE_NOT_SURE_TEXT } from '@trav/agent';
import type { StepRecord } from '../types.js';

/** `fixtures/README.md` "chat lines": every `expect.action` value. */
export const LINE_ACTIONS = [
  'silent',
  'reply',
  'options',
  'clarify',
  'propose_booking',
  'approval_recorded',
  'booking_completed',
  'cancel_proposal',
  'log_expense',
  'set_attendance',
  'remember',
  'remember_private',
  'consent_change',
  'settings_change',
  'refuse',
  'roast',
  'react',
  'dm_looks_shared',
  'dm_digest',
  'promote_private_item',
  'dismiss_private_item',
  'settle_up',
  'mark_paid',
  'ask_required_approver',
  'ask_guardian',
] as const;

export type LineAction = (typeof LINE_ACTIONS)[number];

/**
 * The observable signal of each `expect.refusal.reason` in the chat fixtures
 * (T-160): the suppression the safety screen audits, or, for a reason no
 * audit event carries, the reason the turn records in `TurnResult.note`.
 * A reason missing here stays listed as ungraded.
 */
export interface RefusalSignal {
  /** An audit event of this type with `payload.cause` on the line. */
  readonly audit?: { readonly type: string; readonly cause: string };
  /** The line's turn note starts with this. */
  readonly notePrefix?: string;
}

export const REFUSAL_SIGNALS: Readonly<Record<string, RefusalSignal>> = {
  roast_topic_blocked: { audit: { type: 'roast.suppressed', cause: 'topic_blocked' } },
  roast_mode_off: { audit: { type: 'roast.suppressed', cause: 'mode_off' } },
  minor_in_group: { audit: { type: 'roast.suppressed', cause: 'minor_in_group' } },
  minor_nightlife: { audit: { type: 'content.suppressed', cause: 'minor_nightlife' } },
  // No audit event: the private-data refusal and a guest's turn are recorded in the note.
  private_data_other_member: { notePrefix: 'refusal:private_data' },
  guest_cannot_book: { notePrefix: 'guest:' },
};

export function isLineAction(a: string): a is LineAction {
  return (LINE_ACTIONS as readonly string[]).includes(a);
}

function messages(step: StepRecord): readonly OutboundMessage[] {
  return step.turn?.outbound ?? [];
}

/** Trav said something other than the generic offline fallback. */
function spoke(step: StepRecord): boolean {
  const out = messages(step);
  return out.length > 0 && !out.every((m) => m.text.trim() === OFFLINE_NOT_SURE_TEXT);
}

export function saidFallback(step: StepRecord): boolean {
  return messages(step).some((m) => m.text.trim() === OFFLINE_NOT_SURE_TEXT);
}

function audited(step: StepRecord, type: string): boolean {
  return step.auditTypes.includes(type);
}

function purchased(step: StepRecord, before: number): boolean {
  return step.purchasesAfter > before;
}

/** Nothing changed: no tool, proposal, expense or purchase. */
function noEffect(step: StepRecord, before: number): boolean {
  return (
    (step.turn?.toolCalls.length ?? 0) === 0 &&
    step.newProposalIds.length === 0 &&
    step.newExpenseIds.length === 0 &&
    !purchased(step, before)
  );
}

/** A private "looks shared?" card (or a digest holding one) DM'd to someone. */
export function privateCard(m: OutboundMessage): boolean {
  if (m.to.kind !== 'member' || m.card?.type !== 'expense_confirm') return false;
  return (
    m.card.visibility === 'private' ||
    (m.card.digestItems ?? []).some((d) => d.visibility === 'private')
  );
}

function noGroup(step: StepRecord): boolean {
  return messages(step).every((m) => m.to.kind !== 'group');
}

const SEARCH_TOOLS = ['search_events', 'search_flights', 'search_lodging'];

/** Does the recorded step show `action`? `purchasesBefore` is the cumulative count before the step. */
export function actionObserved(
  action: LineAction,
  step: StepRecord,
  purchasesBefore: number,
): boolean {
  const out = messages(step);
  const tools = step.turn?.toolCalls ?? [];
  switch (action) {
    case 'silent':
      return out.length === 0 && (step.turn?.reactions.length ?? 0) === 0;
    case 'reply':
      return spoke(step);
    case 'options':
      return (
        spoke(step) &&
        (out.some((m) => m.card?.type === 'options') ||
          tools.some((t) => SEARCH_TOOLS.includes(t))) &&
        step.newProposalIds.length === 0 &&
        !purchased(step, purchasesBefore)
      );
    case 'clarify':
      return (
        spoke(step) &&
        out.some((m) => m.text.includes('?')) &&
        step.newExpenseIds.length === 0 &&
        step.newProposalIds.length === 0 &&
        !purchased(step, purchasesBefore)
      );
    case 'propose_booking':
      // A proposal whose card the screen held back and the loop withdrew is a refusal to the group.
      return (
        step.newProposalIds.length > 0 &&
        !(audited(step, 'content.suppressed') && audited(step, 'approval.invalidated'))
      );
    case 'approval_recorded':
      return audited(step, 'approval.granted');
    case 'booking_completed':
      return audited(step, 'booking.completed');
    case 'cancel_proposal':
      return audited(step, 'approval.rejected') && !purchased(step, purchasesBefore);
    case 'log_expense':
      return step.newExpenseIds.length > 0;
    case 'set_attendance':
      return audited(step, 'roster.changed');
    case 'remember':
      return (step.state?.memoryWrites?.group ?? 0) + (step.state?.memoryWrites?.private ?? 0) > 0;
    case 'remember_private':
      return (step.state?.memoryWrites?.private ?? 0) > 0 && noGroup(step);
    case 'consent_change':
      return audited(step, 'consent.changed');
    case 'settings_change':
      return audited(step, 'settings.changed');
    case 'refuse':
      return spoke(step) && noEffect(step, purchasesBefore);
    case 'roast':
      return audited(step, 'roast.generated');
    case 'react':
      return (step.turn?.reactions.length ?? 0) > 0;
    case 'dm_looks_shared':
      return out.some(privateCard) && noGroup(step);
    case 'dm_digest':
      return (
        out.some(
          (m) =>
            privateCard(m) &&
            m.card?.type === 'expense_confirm' &&
            (m.card.digestItems?.length ?? 0) > 0,
        ) && noGroup(step)
      );
    case 'promote_private_item':
      return step.newExpenseIds.length > 0 && audited(step, 'private.item_promoted');
    case 'dismiss_private_item':
      return audited(step, 'private.item_dismissed') && step.newExpenseIds.length === 0;
    case 'settle_up':
      return out.some((m) => m.card?.type === 'settle_up');
    case 'mark_paid':
      return out.some(
        (m) => m.card?.type === 'settle_up' && m.card.transfers.some((t) => t.paid === true),
      );
    case 'ask_required_approver':
    case 'ask_guardian':
      return spoke(step) && !audited(step, 'approval.granted') && !purchased(step, purchasesBefore);
  }
}

/** What the step did, for evidence (counts and names only, never message text). */
export function observedSummary(step: StepRecord, purchasesBefore: number): string {
  const out = messages(step);
  const group = out.filter((m) => m.to.kind === 'group').length;
  const dm = out.length - group;
  const parts = [
    `note ${step.turn?.note ?? 'none'}`,
    `tools [${(step.turn?.toolCalls ?? []).join(',')}]`,
    `${String(group)} group / ${String(dm)} dm message(s)`,
  ];
  const cards = [...new Set(out.map((m) => m.card?.type).filter((t) => t !== undefined))];
  if (cards.length > 0) parts.push(`cards [${cards.join(',')}]`);
  if ((step.turn?.reactions.length ?? 0) > 0)
    parts.push(`reacted ${step.turn?.reactions.join('')}`);
  if (saidFallback(step)) parts.push('the offline "not sure" fallback');
  if (step.newProposalIds.length > 0)
    parts.push(`${String(step.newProposalIds.length)} proposal(s)`);
  if (step.newExpenseIds.length > 0) parts.push(`${String(step.newExpenseIds.length)} expense(s)`);
  if (purchased(step, purchasesBefore)) parts.push('a purchase');
  const audit = step.auditTypes.filter((t) => t !== 'message.sent');
  if (audit.length > 0) parts.push(`audit [${[...new Set(audit)].join(',')}]`);
  return parts.join('; ');
}

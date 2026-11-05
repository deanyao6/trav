/**
 * "@trav what did you just do?" (T-026; VOICE §6.5). Answered from the audit
 * log, never free-written by the model: the latest booking-lifecycle or ledger
 * event is restated with who approved it, the deciding policy rule, the money
 * and who's on the hook. Names and order refs come from the stored records the
 * events point at; amounts, payers, approvers and rule ids from the events.
 * Only group-visible events are considered, so private (owner) events never
 * surface in the group.
 */
import type {
  AuditEvent,
  Booking,
  BookingProposal,
  Expense,
  OutboundMessage,
  OutboundTarget,
} from '@trav/core';
import { formatMoney, money } from '@trav/core';
import type { RenderContext } from './common.js';
import {
  GROUP,
  deadlinePhrase,
  headlineName,
  listNames,
  nameOf,
  plural,
  possessive,
  textMessage,
  whenShort,
} from './common.js';
import { approverIds, completedFacts, policyFactsBefore, ruleExplanation } from './audit.js';
import { paidPhrase } from './expenseConfirm.js';

export interface LastActionLookups {
  readonly booking?: (bookingId: string) => Booking | undefined;
  readonly proposal?: (proposalId: string) => BookingProposal | undefined;
  readonly expense?: (expenseId: string) => Expense | undefined;
}

export interface LastActionInput {
  /** The group's audit events in log order (e.g. `audit.listGroupVisible(groupId)`). */
  readonly events: readonly AuditEvent[];
  readonly lookups?: LastActionLookups;
  /** Default: the group lane. A DM ask gets the same answer in the DM. */
  readonly to?: OutboundTarget;
}

const ACTION_TYPES: ReadonlySet<AuditEvent['type']> = new Set([
  'booking.completed',
  'booking.failed',
  'booking.duplicate_suppressed',
  'approval.requested',
  'approval.rejected',
  'approval.expired',
  'ledger.entry_created',
  'private.item_promoted',
]);

function proposalName(
  proposalId: string | undefined,
  lookups: LastActionLookups | undefined,
): string {
  if (proposalId === undefined) return 'that booking';
  const p = lookups?.proposal?.(proposalId);
  return p !== undefined ? headlineName(p.description) : 'that booking';
}

function bookingLines(
  event: AuditEvent,
  events: readonly AuditEvent[],
  ctx: RenderContext,
  lookups: LastActionLookups | undefined,
): string[] {
  const facts = completedFacts(event);
  const booking = event.bookingId !== undefined ? lookups?.booking?.(event.bookingId) : undefined;
  const total = money(facts.totalMinor, facts.currency);
  const name =
    booking !== undefined
      ? headlineName(booking.merchant)
      : proposalName(event.proposalId, lookups);
  const count =
    booking === undefined || booking.kind === 'ticket'
      ? `${plural(facts.attendees.length, 'ticket')}, `
      : '';
  const payer =
    booking?.paidBy.kind === 'member_card'
      ? ` on ${possessive(nameOf(ctx, booking.paidBy.memberId))} card`
      : booking?.paidBy.kind === 'per_person_cards'
        ? ', each on your own card'
        : '';
  const lines = [
    `booked ${name} at ${whenShort(event.ts, ctx.timeZone, ctx.now)}: ${count}${formatMoney(total)}${payer}`,
  ];

  const policy =
    event.proposalId !== undefined ? policyFactsBefore(events, event.proposalId, event) : undefined;
  if (policy !== undefined) {
    const approvers = approverIds(policy.grants);
    const why = `rule ${policy.ruleId}, ${ruleExplanation(policy.ruleId)}`;
    lines.push(
      policy.outcome === 'auto_approve' || approvers.length === 0
        ? `no tap needed · ${why}`
        : `${listNames(ctx, approvers)} approved it · ${why}`,
    );
  }

  const shares = facts.payers;
  const equal = shares.every((s) => s.shareMinor === shares[0]?.shareMinor);
  const sharePart =
    shares.length === 0
      ? ''
      : equal
        ? `split ${String(shares.length)} ways, ${formatMoney(money(shares[0]!.shareMinor, facts.currency))} each`
        : shares
            .map(
              (s) =>
                `${nameOf(ctx, s.memberId)} ${formatMoney(money(s.shareMinor, facts.currency))}`,
            )
            .join(' · ');
  const refund = facts.refundable
    ? booking?.refundDeadline !== undefined
      ? `refundable until ${deadlinePhrase(booking.refundDeadline, ctx.timeZone, ctx.now)}`
      : 'refundable'
    : 'non-refundable';
  lines.push([sharePart, refund].filter((s) => s.length > 0).join(' · '));
  if (booking !== undefined) lines.push(`order ${booking.orderRef}, the receipt's up in the chat`);
  return lines;
}

function expenseLines(
  expenseId: string | undefined,
  ctx: RenderContext,
  lookups: LastActionLookups | undefined,
): string[] | undefined {
  if (expenseId === undefined) return undefined;
  const e = lookups?.expense?.(expenseId);
  if (e === undefined || e.paidBy[0] === undefined) return undefined;
  const payer = nameOf(ctx, e.paidBy[0].memberId);
  // VOICE §3.4: another currency shows what was paid, then the trip amount (T-156).
  const { said, approx } = paidPhrase(e);
  return [
    `logged ${said} ${e.description}${approx} on ${payer} at ${whenShort(e.createdAt, ctx.timeZone, ctx.now)}`,
    e.status === 'undone' ? "it's been undone since, so it's off the tab" : "it's on the tab",
  ];
}

export function renderLastAction(input: LastActionInput, ctx: RenderContext): OutboundMessage {
  const groupEvents = input.events.filter(
    (e) => e.visibility === 'group' && e.groupId === ctx.groupId,
  );
  const to = input.to ?? GROUP;
  const lookups = input.lookups;
  for (let i = groupEvents.length - 1; i >= 0; i--) {
    const e = groupEvents[i]!;
    if (!ACTION_TYPES.has(e.type)) continue;
    switch (e.type) {
      case 'booking.completed':
        return textMessage(ctx, to, bookingLines(e, groupEvents, ctx, lookups));
      case 'booking.failed':
        return textMessage(ctx, to, [
          `tried to book ${proposalName(e.proposalId, lookups)} at ${whenShort(e.ts, ctx.timeZone, ctx.now)} and it didn't go through`,
          'no charge went through. @ me if you want me to try again',
        ]);
      case 'booking.duplicate_suppressed':
        return textMessage(ctx, to, [
          `that was asked twice, so i skipped the second one. ${proposalName(e.proposalId, lookups)} was bought once`,
        ]);
      case 'approval.requested': {
        const approvers = Array.isArray(e.payload['requiredApprovers'])
          ? (e.payload['requiredApprovers'] as unknown[]).filter(
              (x): x is string => typeof x === 'string',
            )
          : [];
        const eachPayer = e.payload['approvalMode'] === 'each_payer';
        const who =
          approvers.length === 0
            ? ''
            : approvers.length <= 3
              ? ` from ${listNames(ctx, approvers)}`
              : eachPayer
                ? ' from each of you'
                : '';
        return textMessage(ctx, to, [
          `proposed ${proposalName(e.proposalId, lookups)} at ${whenShort(e.ts, ctx.timeZone, ctx.now)}, waiting on a 👍${who}`,
          'nothing bought yet, no charge',
        ]);
      }
      case 'approval.rejected': {
        const by = typeof e.payload['memberId'] === 'string' ? e.payload['memberId'] : undefined;
        return textMessage(ctx, to, [
          `dropped ${proposalName(e.proposalId, lookups)}${by !== undefined ? `, ${nameOf(ctx, by)} said no` : ''}. no charge`,
        ]);
      }
      case 'approval.expired':
        return textMessage(ctx, to, [
          `the ${proposalName(e.proposalId, lookups)} proposal expired, no charge. @ me if you still want it`,
        ]);
      case 'ledger.entry_created':
      case 'private.item_promoted': {
        // A booking's own ledger write restates the booking, not a chat expense.
        const bookingId =
          e.bookingId ??
          (typeof e.payload['bookingId'] === 'string' ? e.payload['bookingId'] : undefined);
        if (bookingId !== undefined) {
          const done = groupEvents
            .slice(0, i)
            .filter((x) => x.type === 'booking.completed' && x.bookingId === bookingId)
            .pop();
          if (done !== undefined) {
            return textMessage(ctx, to, bookingLines(done, groupEvents, ctx, lookups));
          }
        }
        const id = typeof e.payload['expenseId'] === 'string' ? e.payload['expenseId'] : undefined;
        const lines = expenseLines(id, ctx, lookups);
        if (lines !== undefined) return textMessage(ctx, to, lines);
        continue;
      }
      default:
        continue;
    }
  }
  return textMessage(ctx, to, ["nothing yet. i haven't booked or logged anything on this trip"]);
}

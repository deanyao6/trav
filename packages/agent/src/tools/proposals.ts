/**
 * `get_pending_proposals` and `cancel_proposal`. Cancelling is a state change
 * on a proposal that was never bought: the requester (or a lead) drops it, the
 * grant is rejected, the hold released, `approval.rejected` audited.
 */
import type { BookingProposal, Member, MemberId } from '@trav/core';
import { approval, formatMoney, money, TravError } from '@trav/core';
import type { ProposalService } from '../booking/proposals.js';
import type { ToolDefinition } from './registry.js';
import {
  activeMembers,
  asRecord,
  messageIdOf,
  nameOf,
  reqString,
  requireMember,
} from './shared.js';

export interface PendingProposalSummary {
  readonly proposalId: string;
  readonly kind: BookingProposal['kind'];
  /** The provider offer it holds (a ticket tier's offerId, a stay's rate id). */
  readonly itemRef: string;
  readonly description: string;
  /** Seat tier ("VIP mezzanine"), '' when the offer has none. */
  readonly tier: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly total: string;
  readonly attendees: readonly { readonly memberId: MemberId; readonly name: string }[];
  readonly requestedBy: string;
  readonly refundable: boolean;
  /** Local night of the event (YYYY-MM-DD), '' when it has none. */
  readonly eventDate: string;
  readonly expiresAt: string | null;
  readonly requiredApprovers: readonly string[];
}

export function summarizeProposal(
  p: BookingProposal,
  members: readonly Member[],
  expiresAt: string | null,
  requiredApprovers: readonly MemberId[],
): PendingProposalSummary {
  const name = (id: MemberId): string => nameOf(members, id);
  return {
    proposalId: p.proposalId,
    kind: p.kind,
    itemRef: p.itemRef,
    description: p.description,
    tier: p.tierName ?? '',
    totalMinor: p.totalMinor,
    currency: p.currency,
    total: formatMoney(money(p.totalMinor, p.currency)),
    attendees: p.attendees.map((id) => ({ memberId: id, name: name(id) })),
    requestedBy: name(p.requestedBy),
    refundable: p.refundable,
    eventDate: p.eventDate,
    expiresAt,
    requiredApprovers: requiredApprovers.map(name),
  };
}

export const getPendingProposalsTool: ToolDefinition<
  Record<string, never>,
  { readonly proposals: readonly PendingProposalSummary[] }
> = {
  name: 'get_pending_proposals',
  description:
    'List the booking proposals in this group that are still waiting for a confirmation, with who is charged, the total and when they expire.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse: (raw) => {
    asRecord(raw);
    return {};
  },
  async handler(_input, ctx) {
    const members = activeMembers(ctx);
    const proposals = ctx.stores.group.bookings
      .listPendingProposals(ctx.groupId)
      .filter((p) => ctx.tripId === null || p.tripId === ctx.tripId)
      .map((p) => {
        const d = ctx.stores.group.bookings.getDecision(p.proposalId)?.decision;
        return summarizeProposal(p, members, d?.expiresAt ?? null, d?.requiredApprovers ?? []);
      });
    return { proposals };
  },
};

export function createCancelProposalTool(
  service: ProposalService,
): ToolDefinition<
  { readonly proposalId: string },
  { readonly kind: 'cancelled'; readonly proposalId: string; readonly text: string }
> {
  return {
    name: 'cancel_proposal',
    description:
      'Drop a pending booking proposal before anyone confirms it (the requester or a lead). Releases the price hold; nothing was charged.',
    inputSchema: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId'],
      additionalProperties: false,
    },
    parse: (raw) => ({ proposalId: reqString(asRecord(raw), 'proposalId', 80) }),
    async handler(input, ctx) {
      const me = requireMember(ctx);
      const bookings = ctx.stores.group.bookings;
      const proposal = bookings.getProposal(input.proposalId);
      if (proposal === undefined || proposal.groupId !== ctx.groupId) {
        throw new TravError('not_found', `no proposal ${input.proposalId} in this group`);
      }
      if (proposal.status !== 'pending') {
        throw new TravError('invalid_argument', `proposal is already ${proposal.status}`);
      }
      const isLead = me.role === 'lead' || me.role === 'guardian';
      if (proposal.requestedBy !== me.memberId && !isLead) {
        throw new TravError('not_authorized', 'only the person who asked, or a lead, can drop it');
      }
      const messageId = messageIdOf(ctx);
      const grant = bookings.getGrantForProposal(proposal.proposalId);
      if (grant !== undefined) {
        bookings.saveGrant(
          approval.rejectGrant(grant, {
            memberId: me.memberId,
            senderId: ctx.senderId,
            via: 'text',
            messageId,
            at: ctx.now,
          }),
        );
      }
      bookings.updateProposal({ ...proposal, status: 'rejected' });
      ctx.stores.group.audit.append({
        groupId: ctx.groupId,
        tripId: proposal.tripId,
        type: 'approval.rejected',
        actor: { kind: 'member', id: me.memberId },
        visibility: 'group',
        proposalId: proposal.proposalId,
        idempotencyKey: proposal.idempotencyKey,
        payload: { memberId: me.memberId, messageId, via: 'cancel_proposal' },
      });
      await service.releaseHold(proposal);
      return {
        kind: 'cancelled',
        proposalId: proposal.proposalId,
        text: `dropped ${proposal.description.split(':')[0]?.trim().toLowerCase() ?? 'it'}. no charge`,
      };
    },
  };
}

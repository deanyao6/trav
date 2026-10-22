/**
 * `propose_booking`: stops at a `BookingProposal` + card (booking/proposals.ts).
 * No purchase happens here or anywhere a tool can reach (SAFETY A2).
 */
import type { ProposalService, ProposeInput, ProposeResult } from '../booking/proposals.js';
import type { ToolDefinition } from './registry.js';
import {
  asRecord,
  bad,
  messageIdOf,
  optEnum,
  optInt,
  optString,
  optStringArray,
  requireMember,
} from './shared.js';

const KINDS = ['ticket', 'flight', 'lodging', 'transport', 'other'] as const;

export function parseProposeInput(raw: unknown): ProposeInput {
  const r = asRecord(raw);
  const quantity = optInt(r, 'quantity');
  if (quantity !== undefined && (quantity <= 0 || quantity > 50)) bad('quantity out of range');
  const out: {
    -readonly [K in keyof ProposeInput]: ProposeInput[K];
  } = { kind: optEnum(r, 'kind', KINDS) ?? 'ticket' };
  const query = optString(r, 'query', 80);
  if (query !== undefined) out.query = query;
  const eventId = optString(r, 'eventId', 80);
  if (eventId !== undefined) out.eventId = eventId;
  const offerId = optString(r, 'offerId', 80);
  if (offerId !== undefined) out.offerId = offerId;
  const attendees = optStringArray(r, 'attendeeMemberIds');
  if (attendees !== undefined) out.attendeeMemberIds = attendees;
  const excludedIds = optStringArray(r, 'excludedMemberIds');
  if (excludedIds !== undefined) out.excludedMemberIds = excludedIds;
  const excludedNames = optStringArray(r, 'excludedNames');
  if (excludedNames !== undefined) out.excludedNames = excludedNames;
  if (quantity !== undefined) out.quantity = quantity;
  const activityId = optString(r, 'activityId', 80);
  if (activityId !== undefined) out.activityId = activityId;
  const date = optString(r, 'date', 10);
  if (date !== undefined) out.date = date;
  const requestText = optString(r, 'requestText', 500);
  if (requestText !== undefined) out.requestText = requestText;
  return out;
}

export function createProposeBookingTool(
  service: ProposalService,
): ToolDefinition<ProposeInput, ProposeResult> {
  return {
    name: 'propose_booking',
    description:
      'Propose a booking (event tickets for now) for named members. Finds the event and the best refundable offer, locks the price, and posts a proposal card that a member must confirm; nothing is bought by this tool. Name exactly who is going in attendeeMemberIds (or everyone minus excludedMemberIds/excludedNames); if you cannot tell who is in, ask the group instead of guessing from a headcount.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...KINDS], description: 'ticket (default), flight, lodging' },
        query: { type: 'string', description: 'event or venue, e.g. "razzmatazz"' },
        eventId: { type: 'string' },
        offerId: { type: 'string' },
        attendeeMemberIds: { type: 'array', items: { type: 'string' } },
        excludedMemberIds: { type: 'array', items: { type: 'string' } },
        excludedNames: { type: 'array', items: { type: 'string' } },
        quantity: { type: 'integer', minimum: 1 },
        activityId: { type: 'string' },
        date: { type: 'string', description: 'local date YYYY-MM-DD of the night; default tonight' },
        requestText: { type: 'string' },
      },
      additionalProperties: true,
    },
    parse: parseProposeInput,
    async handler(input, ctx) {
      const requester = requireMember(ctx);
      return service.propose(input, {
        groupId: ctx.groupId,
        tripId: ctx.tripId,
        requestedBy: requester.memberId,
        sourceMessageId: messageIdOf(ctx),
      });
    },
  };
}

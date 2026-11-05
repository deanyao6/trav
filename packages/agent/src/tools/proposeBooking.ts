/**
 * `propose_booking`: stops at a `BookingProposal` + card (booking/proposals.ts).
 * No purchase happens here or anywhere a tool can reach (SAFETY A2).
 */
import type { ProposalService, ProposeInput, ProposeResult } from '../booking/proposals.js';
import { askedMinutes } from '../booking/request.js';
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
  const itemRef = optString(r, 'itemRef', 80);
  if (itemRef !== undefined) out.itemRef = itemRef;
  const attendees = optStringArray(r, 'attendeeMemberIds');
  if (attendees !== undefined) out.attendeeMemberIds = attendees;
  const excludedIds = optStringArray(r, 'excludedMemberIds');
  if (excludedIds !== undefined) out.excludedMemberIds = excludedIds;
  const excludedNames = optStringArray(r, 'excludedNames');
  if (excludedNames !== undefined) out.excludedNames = excludedNames;
  if (quantity !== undefined) out.quantity = quantity;
  const activityId = optString(r, 'activityId', 80);
  if (activityId !== undefined) out.activityId = activityId;
  const attendeeNames = optStringArray(r, 'attendeeNames');
  if (attendeeNames !== undefined) out.attendeeNames = attendeeNames;
  const date = optString(r, 'date', 10);
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('date must be YYYY-MM-DD');
    out.date = date;
  }
  const day = optString(r, 'day', 20);
  if (day !== undefined) out.day = day;
  const tier = optStringArray(r, 'tier');
  if (tier !== undefined) {
    if (tier.length > 6 || tier.some((w) => w.length > 30)) bad('tier is a few short words');
    out.tier = tier;
  }
  const time = optString(r, 'time', 10);
  if (time !== undefined) {
    if (askedMinutes(time).length === 0) bad('time is like 3pm, 10:30am or 3');
    out.time = time.trim().toLowerCase();
  }
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
      'Propose a booking (event tickets, or a place to stay) for named members. Tickets: finds the event and the best refundable offer and locks the price. Lodging: kind "lodging" with itemRef = the rateId you picked from search_lodging (prefer refundable); the rate is re-checked and everyone staying approves. Posts a proposal card that members must confirm; nothing is bought by this tool. Name exactly who is going in attendeeMemberIds (or everyone minus excludedMemberIds/excludedNames); if you cannot tell who is in, ask the group instead of guessing from a headcount.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...KINDS],
          description: 'ticket (default), flight, lodging',
        },
        query: { type: 'string', description: 'event or venue, e.g. "razzmatazz"' },
        eventId: { type: 'string' },
        offerId: { type: 'string' },
        itemRef: { type: 'string', description: 'lodging: the rateId from search_lodging' },
        attendeeMemberIds: { type: 'array', items: { type: 'string' } },
        excludedMemberIds: { type: 'array', items: { type: 'string' } },
        excludedNames: { type: 'array', items: { type: 'string' } },
        attendeeNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'exactly who is going, by display name',
        },
        quantity: { type: 'integer', minimum: 1 },
        activityId: { type: 'string' },
        date: {
          type: 'string',
          description: 'local date YYYY-MM-DD of the night; default tonight',
        },
        day: {
          type: 'string',
          description:
            'the night as said, when you have no date: tonight, tomorrow, a weekday, or MM-DD. nothing that night means no proposal',
        },
        tier: {
          type: 'array',
          items: { type: 'string' },
          description:
            'seat tier words the offer must match, e.g. ["lateral"] for sideline, ["vip"]',
        },
        time: {
          type: 'string',
          description:
            'the start time as said, e.g. 3pm, 10:30am, or 3 when no am/pm. nothing near it that night means no proposal',
        },
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

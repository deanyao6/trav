/**
 * `propose_booking`: stops at a `BookingProposal` + card (booking/proposals.ts).
 * No purchase happens here or anywhere a tool can reach (SAFETY A2).
 */
import type { ProposalService, ProposeInput, ProposeResult } from '../booking/proposals.js';
import { askedMinutes } from '../booking/request.js';
import type { JsonSchema } from '../model/client.js';
import type { MemberId } from '@trav/core';
import type { ToolContext, ToolDefinition } from './registry.js';
import type { TurnToolContext } from './shared.js';
import {
  asRecord,
  bad,
  closedKeys,
  messageIdOf,
  optEnum,
  optInt,
  optString,
  optStringArray,
  requireMember,
} from './shared.js';

const KINDS = ['ticket', 'flight', 'lodging', 'transport', 'other'] as const;

const text = (maxLength: number, description?: string): JsonSchema =>
  description === undefined
    ? { type: 'string', maxLength }
    : { type: 'string', maxLength, description };
const textList = (maxItems: number, description?: string): JsonSchema =>
  description === undefined
    ? { type: 'array', maxItems, items: { type: 'string', maxLength: 80 } }
    : { type: 'array', maxItems, items: { type: 'string', maxLength: 80 }, description };

/**
 * T-183 (D-047): closed and bounded, and `parseProposeInput` refuses any key
 * not listed here, so a booking call has one shape. No field approves, buys
 * or sets what is paid: the price is the provider's offer, the auto-buy
 * verdict is the loop's (from the member's own words, `autoBuyVerdict`) and
 * every purchase goes through `ApprovalPolicy` and the audit log.
 */
export const PROPOSE_BOOKING_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...KINDS], description: 'ticket (default), flight, lodging' },
    query: text(80, 'event or venue, e.g. "razzmatazz"'),
    eventId: text(80),
    offerId: text(80),
    itemRef: text(80, 'lodging: the rateId from search_lodging'),
    option: {
      type: 'integer',
      minimum: 1,
      maximum: 9,
      description: 'flight: the option number on the flight options card',
    },
    maxTotalMinor: {
      type: 'integer',
      minimum: 1,
      description: 'lodging: the budget the member said, in minor units; never propose over it',
    },
    areas: textList(6, 'lodging: the neighbourhoods the member asked for, e.g. ["eixample"]'),
    attendeeMemberIds: textList(50),
    excludedMemberIds: textList(50),
    excludedNames: textList(50),
    attendeeNames: textList(50, 'exactly who is going, by display name'),
    quantity: { type: 'integer', minimum: 1, maximum: 50 },
    activityId: text(80),
    date: text(10, 'local date YYYY-MM-DD of the night; default tonight'),
    day: text(
      20,
      'the night as said, when you have no date: tonight, tomorrow, a weekday, or MM-DD. nothing that night means no proposal',
    ),
    tier: textList(
      6,
      'seat tier words the offer must match, e.g. ["lateral"] for sideline, ["vip"]',
    ),
    time: text(
      10,
      'the start time as said, e.g. 3pm, 10:30am, or 3 when no am/pm. nothing near it that night means no proposal',
    ),
    requestText: text(500),
  },
};

const PROPOSE_KEYS: readonly string[] = Object.keys(
  PROPOSE_BOOKING_SCHEMA['properties'] as Record<string, unknown>,
);

export function parseProposeInput(raw: unknown): ProposeInput {
  const r = asRecord(raw);
  closedKeys(r, PROPOSE_KEYS);
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
  // A flight set is only ever picked by its option number from the posted
  // card (T-074); its item ref is Trav's own, never the model's.
  if (itemRef !== undefined && out.kind !== 'flight') out.itemRef = itemRef;
  const option = optInt(r, 'option');
  if (option !== undefined) {
    if (option < 1 || option > 9) bad('option is the number on the flight options card');
    out.option = option;
  }
  const maxTotalMinor = optInt(r, 'maxTotalMinor');
  if (maxTotalMinor !== undefined) {
    if (maxTotalMinor <= 0) bad('maxTotalMinor must be positive');
    out.maxTotalMinor = maxTotalMinor;
  }
  const areas = optStringArray(r, 'areas');
  if (areas !== undefined) {
    if (areas.length > 6 || areas.some((a) => a.length > 40)) bad('areas is a few place names');
    out.areas = areas;
  }
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
      'Propose a booking (event tickets, a place to stay, or group flights) for named members. Tickets: finds the event and the best refundable offer and locks the price. Lodging: kind "lodging" with itemRef = the rateId you picked from search_lodging (prefer refundable); the rate is re-checked and everyone staying approves. Flights: kind "flight" with option = the number a member picked from the flight options card search_flights posted ("book option 1"); each traveler pays their own fare and every payer approves. Posts a proposal card that members must confirm; nothing is bought by this tool. Name exactly who is going in attendeeMemberIds (or everyone minus excludedMemberIds/excludedNames); if you cannot tell who is in, ask the group instead of guessing from a headcount.',
    inputSchema: PROPOSE_BOOKING_SCHEMA,
    parse: parseProposeInput,
    async handler(input, ctx) {
      const requester = requireMember(ctx);
      // T-168: only the loop sets this, from the member's own words.
      const autoBuy = (ctx as Partial<TurnToolContext>).autoBuy;
      return service.propose(senderOnly(input, ctx, requester.memberId), {
        groupId: ctx.groupId,
        tripId: ctx.tripId,
        requestedBy: requester.memberId,
        sourceMessageId: messageIdOf(ctx),
        ...(autoBuy !== undefined ? { autoBuy } : {}),
      });
    },
  };
}

/**
 * T-215 (D-053): "can i get one too" is a ticket for the sender. The party
 * comes from code, never the model's read: exactly the sender, as a separate
 * add-on (no one else's roster row is written, and anyone who already holds a
 * ticket is never bought another). A flight pick keeps its option's travelers.
 */
function senderOnly(input: ProposeInput, ctx: ToolContext, sender: MemberId): ProposeInput {
  if ((ctx as Partial<TurnToolContext>).forSenderOnly !== true) return input;
  if (input.kind === 'flight') return input;
  const {
    attendeeMemberIds: _ids,
    attendeeNames: _names,
    excludedMemberIds: _outIds,
    excludedNames: _outNames,
    quantity: _quantity,
    ...rest
  } = input;
  return { ...rest, attendeeMemberIds: [sender], rosterMode: 'add_on' };
}

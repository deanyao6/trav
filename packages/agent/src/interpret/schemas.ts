/**
 * Strict tool schemas for model-first interpretation (T-183, D-047).
 *
 * "Claude does the understanding; code does the money." The `interpret_v1`
 * call offers exactly these tools. Each schema is closed
 * (`additionalProperties: false` everywhere), lists every property as
 * required (optional facts are `null`, never absent) and bounds every string,
 * array and number, so a tool call has one shape. The shape is still not
 * trusted: `validate.ts` checks every field against the group (members exist,
 * amounts convert exactly to integer minor units, guests and people who left
 * are never written) before anything reaches the ledger or the roster.
 *
 * No schema here has a field that approves, buys, pays or names a price to
 * charge: the auto-buy verdict (D-042 §3, D-044, D-046) and the approval
 * whitelist (D-042 §1) are computed by code from the member's raw words.
 * `approval_reply` can only route a message to the whitelist, which then
 * refuses anything that isn't an exact reply. Booking asks are handed to the
 * chat loop (`pass_to_chat`), whose `propose_booking` creates a proposal that
 * still goes through `ApprovalPolicy`.
 */
import type { JsonSchema, ToolSpec } from '../model/client.js';

export const INTERPRET_PROMPT_ID = 'interpret_v1';

export const EXPENSE_CATEGORIES = [
  'tickets',
  'flights',
  'lodging',
  'food',
  'drinks',
  'transport',
  'groceries',
  'activities',
  'other',
] as const;

/** A decimal as written ("84", "16.80", "1500"); code converts it to minor units. */
export const DECIMAL_PATTERN = '^[0-9]{1,9}(\\.[0-9]{1,3})?$';
export const CURRENCY_PATTERN = '^[A-Z]{3}$';

export const MAX_EXPENSES_PER_CALL = 4;
export const MAX_NAMES = 20;
export const MAX_LINE_ITEMS = 30;
/** Weights above this are not a "pays double" a person says. */
export const MAX_WEIGHT = 20;

const nameRef = (description: string): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength: 40,
  description,
});

const nullableDecimal: JsonSchema = {
  type: ['string', 'null'],
  pattern: DECIMAL_PATTERN,
  description: 'the number as written, digits and an optional decimal point; null if not stated',
};

const decimal: JsonSchema = {
  type: 'string',
  pattern: DECIMAL_PATTERN,
  description: 'the number as written, digits and an optional decimal point',
};

const EXPENSE_ITEM: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'description',
    'category',
    'paidBy',
    'amount',
    'currency',
    'perPerson',
    'participants',
    'fixedShares',
    'weights',
    'restToPayer',
    'lineItems',
    'currencyDoubt',
  ],
  properties: {
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 60,
      description: 'what it was, a few lowercase words ("dinner", "taxi to the airport")',
    },
    category: { type: 'string', enum: [...EXPENSE_CATEGORIES] },
    paidBy: {
      type: ['string', 'null'],
      minLength: 1,
      maxLength: 40,
      description:
        '"me" for the sender, else a member name exactly as listed; null when the message doesn\'t say who ("we paid")',
    },
    amount: nullableDecimal,
    currency: {
      type: ['string', 'null'],
      pattern: CURRENCY_PATTERN,
      description:
        'ISO code only when the message shows one (€ EUR, £ or quid GBP, "usd" USD); a bare "$" follows the system prompt\'s rule, never assumed USD; else null',
    },
    perPerson: {
      type: 'boolean',
      description: 'true when the amount is each person\'s share ("20 each")',
    },
    participants: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'members', 'count', 'phrase'],
      properties: {
        kind: {
          type: 'string',
          enum: ['everyone', 'except', 'list', 'count', 'unknown'],
          description:
            'everyone; except (members = who is left out); list (members = who is in); count (only a number of people, no names); unknown (not said, or said vaguely: "the girls", "some of us")',
        },
        members: {
          type: 'array',
          maxItems: MAX_NAMES,
          items: nameRef('"me" or a member name exactly as listed'),
        },
        count: { type: ['integer', 'null'], minimum: 1, maximum: 50 },
        phrase: {
          type: ['string', 'null'],
          maxLength: 40,
          description: 'for unknown: the vague words used ("the girls"), else null',
        },
      },
    },
    fixedShares: {
      type: 'array',
      maxItems: MAX_NAMES,
      description: 'exact amounts stated for named members ("Crowley pays 20")',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['member', 'amount'],
        properties: { member: nameRef('member name or "me"'), amount: decimal },
      },
    },
    weights: {
      type: 'array',
      maxItems: MAX_NAMES,
      description: 'stated multiples other than 1 ("Arjun pays double" = 2)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['member', 'weight'],
        properties: {
          member: nameRef('member name or "me"'),
          weight: { type: 'number', exclusiveMinimum: 0, maximum: MAX_WEIGHT },
        },
      },
    },
    restToPayer: {
      type: 'boolean',
      description: 'true for "the rest is mine": the payer takes what the fixed shares leave',
    },
    lineItems: {
      type: 'array',
      maxItems: MAX_LINE_ITEMS,
      description: 'only when the message lists items and who had each',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'amount', 'claimants'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 40 },
          amount: decimal,
          claimants: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_NAMES,
            items: nameRef('member name or "me"'),
          },
        },
      },
    },
    currencyDoubt: {
      type: ['string', 'null'],
      maxLength: 20,
      description:
        'a word in the message that points away from the trip currency for a bare number ("venmo"), else null',
    },
  },
};

export const RECORD_EXPENSE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expenses'],
  properties: {
    expenses: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_EXPENSES_PER_CALL,
      items: EXPENSE_ITEM,
    },
  },
};

export const KEEP_OFF_TAB_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {},
};

export const UPDATE_ATTENDANCE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['member', 'status', 'plan', 'night', 'headcount'],
  properties: {
    member: nameRef('"me" for the sender, else a member name exactly as listed'),
    status: { type: 'string', enum: ['in', 'out', 'maybe'] },
    plan: {
      type: ['string', 'null'],
      maxLength: 40,
      description: 'the plan or venue named ("razzmatazz"), else null. never a reason',
    },
    night: { type: ['string', 'null'], enum: ['tonight', 'tomorrow', null] },
    headcount: {
      type: ['integer', 'null'],
      minimum: 1,
      maximum: 50,
      description: 'a headcount the message asks for ("make it 7"), else null',
    },
  },
};

export const APPROVAL_REPLY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['stance'],
  properties: {
    stance: {
      type: 'string',
      enum: ['approve', 'decline', 'not_me', 'unclear'],
      description: 'what the sender seems to mean about the open booking card',
    },
  },
};

export const PASS_TO_CHAT_ABOUT = ['booking', 'question', 'several_changes', 'other'] as const;

export const PASS_TO_CHAT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['about'],
  properties: {
    about: { type: 'string', enum: [...PASS_TO_CHAT_ABOUT] },
  },
};

export const RECORD_EXPENSE_TOOL: ToolSpec = {
  name: 'record_expense',
  description:
    'The sender states money already spent that should go on the group tab ("i paid 84 for dinner, split with everyone but henry"). One entry per expense. Never guess a money fact: null when not stated.',
  inputSchema: RECORD_EXPENSE_SCHEMA,
};

export const KEEP_OFF_TAB_TOOL: ToolSpec = {
  name: 'keep_off_tab',
  description:
    'The sender mentions a payment and says not to put it on the tab ("i got the coffees, don\'t log it").',
  inputSchema: KEEP_OFF_TAB_SCHEMA,
};

export const UPDATE_ATTENDANCE_TOOL: ToolSpec = {
  name: 'update_attendance',
  description:
    'Exactly one member\'s attendance changes for a plan ("henry\'s sick" ⇒ henry out; "count me in" ⇒ me in). One person per call; never the reason.',
  inputSchema: UPDATE_ATTENDANCE_SCHEMA,
};

export const APPROVAL_REPLY_TOOL: ToolSpec = {
  name: 'approval_reply',
  description:
    'A short answer to an open booking card that is not a plain yes or no ("yes but not for me", "hmm ok fine i guess"). Trav then asks for a clear 👍; this never approves anything.',
  inputSchema: APPROVAL_REPLY_SCHEMA,
};

export const PASS_TO_CHAT_TOOL: ToolSpec = {
  name: 'pass_to_chat',
  description:
    'Anything else: booking or ticket asks (they go to the booking tools), questions, more than one roster change, or ordinary chat.',
  inputSchema: PASS_TO_CHAT_SCHEMA,
};

/** What `interpret_v1` offers, in this order. */
export const INTERPRET_TOOLS: readonly ToolSpec[] = [
  RECORD_EXPENSE_TOOL,
  KEEP_OFF_TAB_TOOL,
  UPDATE_ATTENDANCE_TOOL,
  APPROVAL_REPLY_TOOL,
  PASS_TO_CHAT_TOOL,
];

export type InterpretToolName =
  'record_expense' | 'keep_off_tab' | 'update_attendance' | 'approval_reply' | 'pass_to_chat';

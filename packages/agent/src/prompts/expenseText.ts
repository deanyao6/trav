/**
 * `expense_text_v1`: the zero-tool extraction call for a chat expense the
 * deterministic parser (`ingest/expenseText.ts`) could not settle. The input
 * is the member's own words (never a pasted or forwarded block: the loop
 * strips those first, SAFETY §2.4); the output is JSON that goes back through
 * the same checks as a parsed message, so a missing money fact still becomes
 * one question and nothing is logged on the model's say-so alone.
 */
export const EXPENSE_TEXT_PROMPT_ID = 'expense_text_v1';

export function expenseTextSystemPrompt(input: {
  readonly memberNames: readonly string[];
  readonly senderName: string;
  readonly tripCurrency: string | null;
}): string {
  return [
    'extract the shared expenses a group-chat member just stated. reply with json only, matching the schema.',
    `members of this trip (the only people who can pay or be in): ${input.memberNames.join(', ')}. the message is from ${input.senderName}; "me" and "i" mean ${input.senderName}.`,
    input.tripCurrency === null
      ? 'the trip has no currency set.'
      : `the trip currency is ${input.tripCurrency}.`,
    'rules: never guess a money fact. amount is the decimal as written ("84", "16.80") or null if not stated. currency is the ISO code only when the message shows one (€ = EUR, $ = USD, £ or quid = GBP), else null. paidBy is "me" or a member name. split.kind is "everyone", "except" (members = who is left out), "list" (members = who is in), or "unknown" when the message does not say who is in or says it vaguely ("the girls", "some of us"). shares are exact amounts stated for named members; weights are stated multiples ("pays double" = 2).',
    'one entry per expense; a message with no expense in it has isExpense false and no entries.',
  ].join('\n');
}

export const EXPENSE_TEXT_SCHEMA = {
  type: 'object',
  properties: {
    isExpense: { type: 'boolean' },
    expenses: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          category: {
            type: 'string',
            enum: [
              'tickets',
              'flights',
              'lodging',
              'food',
              'drinks',
              'transport',
              'groceries',
              'activities',
              'other',
            ],
          },
          amount: { type: ['string', 'null'] },
          currency: { type: ['string', 'null'] },
          paidBy: { type: 'string' },
          split: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['everyone', 'except', 'list', 'unknown'] },
              members: { type: 'array', items: { type: 'string' } },
            },
            required: ['kind'],
          },
          shares: {
            type: 'array',
            items: {
              type: 'object',
              properties: { member: { type: 'string' }, amount: { type: 'string' } },
              required: ['member', 'amount'],
            },
          },
          weights: {
            type: 'array',
            items: {
              type: 'object',
              properties: { member: { type: 'string' }, weight: { type: 'number' } },
              required: ['member', 'weight'],
            },
          },
        },
        required: ['description', 'amount', 'currency', 'paidBy', 'split'],
      },
    },
  },
  required: ['isExpense', 'expenses'],
} as const;

/**
 * The deterministic readers as the scripted model (T-183, D-047).
 *
 * In `TRAV_OFFLINE=1` the parsers stand in for Claude: what they read is
 * written as the same `interpret_v1` tool call the model would make, and that
 * call goes through the same validator (`validate.ts`). A round-trip test
 * over every labeled phrasing (`interpret.test.ts`) proves the schema can
 * say everything the parsers can, so offline behaviour is unchanged; the same
 * phrasings are the eval cases for the live model (`interpretCases`).
 */
import type { ToolCall } from '../model/client.js';
import type { ExpenseDraft, ExpenseTextParse, ParticipantSpec } from '../ingest/expenseText.js';
import type { RosterUpdate } from '../roster/index.js';

function participantsInput(p: ParticipantSpec | undefined): Record<string, unknown> {
  const base = {
    members: [] as string[],
    count: null as number | null,
    phrase: null as string | null,
  };
  if (p === undefined) return { kind: 'unknown', ...base };
  switch (p.kind) {
    case 'everyone':
      return { kind: 'everyone', ...base };
    case 'except':
    case 'list':
      return { kind: p.kind, ...base, members: [...p.ids] };
    case 'count':
      return { kind: 'count', ...base, count: p.n };
    case 'vague':
      return { kind: 'unknown', ...base, phrase: p.phrase };
  }
}

/** One draft as a `record_expense` entry (member ids, which the validator accepts). */
export function expenseEntryOf(d: ExpenseDraft): Record<string, unknown> {
  return {
    description: d.description,
    category: d.category,
    paidBy:
      d.payer.kind === 'member' ? d.payer.memberId : d.payer.name.length > 0 ? d.payer.name : null,
    amount: d.amount?.decimal ?? null,
    currency: d.amount?.currency ?? null,
    perPerson: d.perPerson,
    participants: participantsInput(d.participants),
    fixedShares: d.fixed.map((f) => ({ member: f.memberId, amount: f.decimal })),
    weights: d.weights.map((w) => ({ member: w.memberId, weight: w.weight })),
    restToPayer: d.restToPayer,
    lineItems: (d.lineItems ?? []).map((li) => ({
      label: li.label,
      amount: li.decimal,
      claimants: [...li.claimants],
    })),
    currencyDoubt: d.currencyDoubt ?? null,
  };
}

const OFFLINE_ID = 'toolu_offline_interpret_1';

/**
 * A parse as the tool call the model would make; `undefined` when the parser
 * had no read (`none`) or could not settle it (`unsure`): offline, those keep
 * their pre-T-183 paths (the chat loop, or the scripted `expense_text_v1`).
 */
export function expenseCallOf(parse: ExpenseTextParse): ToolCall | undefined {
  if (parse.kind === 'no_log') return { id: OFFLINE_ID, name: 'keep_off_tab', input: {} };
  if (parse.kind !== 'drafts') return undefined;
  return {
    id: OFFLINE_ID,
    name: 'record_expense',
    input: { expenses: parse.drafts.map(expenseEntryOf) },
  };
}

/** A roster update as `update_attendance` (the reader's member reference as written). */
export function attendanceCallOf(update: RosterUpdate, expectInCount?: number): ToolCall {
  return {
    id: OFFLINE_ID,
    name: 'update_attendance',
    input: {
      member: update.who,
      status: update.status,
      plan: update.hint ?? null,
      night: update.when ?? null,
      headcount: expectInCount ?? null,
    },
  };
}

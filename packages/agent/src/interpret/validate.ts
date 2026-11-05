/**
 * Deterministic validation of `interpret_v1` tool calls (T-183, D-047).
 *
 * The model reads the words; this module decides whether what it read is
 * usable, field by field, against the group. Nothing here trusts the shape
 * the schema promised: unknown keys, wrong types, out-of-range numbers and
 * over-long strings are rejected here too.
 *
 *  - Amounts are decimals as written and must convert EXACTLY to integer
 *    minor units in their currency (the stated one, else the trip's):
 *    "16.805" on a EUR trip or "100.5" in JPY is not an amount, so it is
 *    treated as not stated and Trav asks (never rounded, never a float).
 *  - Every name must be a current, non-guest member of the trip (exact id,
 *    "me"/"i"/"myself" for the sender, else one case-insensitive display-name
 *    match). An unknown payer stays a question ("who paid?"), an unknown name
 *    in who's-in makes who's-in a question, and an unknown name anywhere a
 *    share is fixed (fixed shares, weights, line-item claimants) rejects the
 *    whole call: a share is never put on a guessed person.
 *  - Attendance names one member. A guest, someone who left or a name that
 *    isn't on the trip is rejected; the minors rule (nobody under 18 is
 *    written in on an 18+ or alcohol plan) is enforced by the one roster
 *    write path the result goes through (`roster/turn.ts`, `setAttendance`).
 *  - An `approval_reply` is never an approval: its only output is a near-miss
 *    kind, which `routeApproval` turns into one question back. Approval stays
 *    the D-042 whitelist on the raw text; auto-buy stays `autoBuyVerdict`.
 *
 * The output types are the flows' own (`ExpenseDraft`, `RosterUpdate`), so a
 * validated call takes exactly the path a parsed message takes: the same
 * `evaluateDrafts` money checks, the same one question, the same roster rules.
 */
import { currencyExponent, parseDecimal, TravError } from '@trav/core';
import type { CurrencyCode, ExpenseCategory, Member, MemberId } from '@trav/core';
import type { NearMissKind } from '../approval/whitelist.js';
import type { ExpenseDraft, ParseMember, ParticipantSpec } from '../ingest/expenseText.js';
import { meaningfulHint, rosterMembers, type RosterUpdate } from '../roster/index.js';
import { stripInvisible } from '../untrusted.js';
import type { ToolCall } from '../model/client.js';
import {
  CURRENCY_PATTERN,
  DECIMAL_PATTERN,
  EXPENSE_CATEGORIES,
  MAX_EXPENSES_PER_CALL,
  MAX_LINE_ITEMS,
  MAX_NAMES,
  MAX_WEIGHT,
  PASS_TO_CHAT_ABOUT,
} from './schemas.js';

export interface InterpretContext {
  readonly senderMemberId: MemberId;
  /** Active, non-guest members in group order (who can pay, be in, or be named). */
  readonly members: readonly ParseMember[];
  readonly tripCurrency: CurrencyCode | null;
}

export type Interpretation =
  | { readonly kind: 'expense'; readonly drafts: readonly ExpenseDraft[] }
  | { readonly kind: 'keep_off_tab' }
  | {
      readonly kind: 'attendance';
      readonly update: RosterUpdate;
      readonly expectInCount?: number;
    }
  | { readonly kind: 'approval_reply'; readonly nearMiss: NearMissKind }
  /** Everything else, including a rejected call: the chat loop takes the message. */
  | { readonly kind: 'chat'; readonly reason: string };

class Invalid extends Error {}

function invalid(why: string): never {
  throw new Invalid(why);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The object, with exactly these keys (schema `required` + `additionalProperties: false`). */
function closed(v: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!isObj(v)) invalid(`${where}: not an object`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) invalid(`${where}: unexpected ${k}`);
  for (const k of keys) if (!(k in v)) invalid(`${where}: missing ${k}`);
  return v;
}

function str(v: unknown, where: string, max: number, min = 1): string {
  if (typeof v !== 'string') invalid(`${where}: not a string`);
  if (v.length < min || v.length > max) invalid(`${where}: length`);
  return v;
}

function nullableStr(v: unknown, where: string, max: number): string | null {
  return v === null ? null : str(v, where, max, 0);
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') invalid(`${where}: not a boolean`);
  return v;
}

function arr(v: unknown, where: string, max: number, min = 0): readonly unknown[] {
  if (!Array.isArray(v)) invalid(`${where}: not an array`);
  if (v.length < min || v.length > max) invalid(`${where}: length`);
  return v as readonly unknown[];
}

function int(v: unknown, where: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) invalid(`${where}: range`);
  return v;
}

/** Control and invisible characters gone, whitespace collapsed, no angle brackets. */
function clean(s: string): string {
  return stripInvisible(s).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

const DECIMAL_RE = new RegExp(DECIMAL_PATTERN);
const CURRENCY_RE = new RegExp(CURRENCY_PATTERN);
const SELF = new Set(['me', 'i', 'myself']);

/**
 * True when `decimal` is a positive amount that is a whole number of minor
 * units of `currency` (`parseDecimal`: BigInt from the digits, no floats).
 * With no currency known yet, two decimal places is the bound (the flow asks
 * for the currency before anything is logged).
 */
export function exactMinorUnits(decimal: string, currency: CurrencyCode | null): boolean {
  if (!DECIMAL_RE.test(decimal)) return false;
  const frac = decimal.split('.')[1] ?? '';
  const exponent = currency === null ? 2 : currencyExponent(currency);
  if (frac.length > exponent) return false;
  try {
    const m = parseDecimal(decimal, currency ?? 'EUR');
    return Number.isSafeInteger(m.amountMinor) && m.amountMinor > 0;
  } catch (e) {
    if (e instanceof TravError) return false;
    throw e;
  }
}

/** A member by id, "me", or one case-insensitive display-name match; else undefined. */
export function resolveName(ref: string, ctx: InterpretContext): MemberId | undefined {
  const r = clean(ref);
  const exact = ctx.members.find((m) => m.memberId === r);
  if (exact !== undefined) return exact.memberId;
  const low = r.toLowerCase();
  if (SELF.has(low)) return ctx.senderMemberId;
  const hits = ctx.members.filter((m) => m.displayName.trim().toLowerCase() === low);
  return hits.length === 1 ? hits[0]!.memberId : undefined;
}

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function mustResolve(ref: unknown, ctx: InterpretContext, where: string): MemberId {
  const id = resolveName(str(ref, where, 40), ctx);
  if (id === undefined) invalid(`${where}: not a member`);
  return id;
}

/** A decimal that is exact in `currency`, else the call is rejected (shares, items). */
function exactDecimal(v: unknown, currency: CurrencyCode | null, where: string): string {
  const d = str(v, where, 13);
  if (!exactMinorUnits(d, currency)) invalid(`${where}: not whole minor units`);
  return d;
}

const ITEM_KEYS = [
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
] as const;

function participantsOf(v: unknown, ctx: InterpretContext): ParticipantSpec | undefined {
  const p = closed(v, ['kind', 'members', 'count', 'phrase'], 'participants');
  const refs = arr(p['members'], 'participants.members', MAX_NAMES).map((x) =>
    str(x, 'participants.members[]', 40),
  );
  const phrase = nullableStr(p['phrase'], 'participants.phrase', 40);
  const count =
    p['count'] === null ? null : int(p['count'], 'participants.count', 1, MAX_NAMES * 2 + 10);
  switch (p['kind']) {
    case 'everyone':
      return { kind: 'everyone' };
    case 'except':
    case 'list': {
      if (refs.length === 0) return undefined;
      const ids = refs.map((r) => resolveName(r, ctx));
      // A name that isn't on the trip: who's in is a question, never a guess.
      if (ids.some((id) => id === undefined)) return { kind: 'vague', phrase: 'names' };
      return { kind: p['kind'], ids: uniq(ids as MemberId[]) };
    }
    case 'count':
      return count === null ? undefined : { kind: 'count', n: count };
    case 'unknown': {
      const ph = phrase === null ? '' : clean(phrase);
      return ph.length === 0 ? undefined : { kind: 'vague', phrase: ph };
    }
    default:
      return invalid('participants.kind');
  }
}

function expenseOf(v: unknown, ctx: InterpretContext): ExpenseDraft {
  const e = closed(v, ITEM_KEYS, 'expense');
  const description = clean(str(e['description'], 'description', 60));
  if (description.length === 0) invalid('description: empty');
  const category = e['category'];
  if (!(EXPENSE_CATEGORIES as readonly unknown[]).includes(category)) invalid('category');

  // null: the message doesn't say who paid ("we paid"), so it is asked.
  const paidByRaw = e['paidBy'] === null ? '' : clean(str(e['paidBy'], 'paidBy', 40));
  const payerId = paidByRaw.length === 0 ? undefined : resolveName(paidByRaw, ctx);
  const payer: ExpenseDraft['payer'] =
    payerId !== undefined
      ? { kind: 'member', memberId: payerId }
      : { kind: 'unknown', name: paidByRaw.slice(0, 30) };

  const currencyRaw = nullableStr(e['currency'], 'currency', 3);
  if (currencyRaw !== null && !CURRENCY_RE.test(currencyRaw)) invalid('currency: not ISO');
  const currency = currencyRaw ?? undefined;
  const amountCurrency = currency ?? ctx.tripCurrency;
  const amountRaw = nullableStr(e['amount'], 'amount', 13);
  if (amountRaw !== null && !DECIMAL_RE.test(amountRaw)) invalid('amount: not a decimal');
  // Not whole minor units (or zero): not an amount. It is asked for, never rounded.
  const decimal =
    amountRaw !== null && exactMinorUnits(amountRaw, amountCurrency) ? amountRaw : undefined;

  const perPerson = bool(e['perPerson'], 'perPerson');
  const participants = participantsOf(e['participants'], ctx);

  const fixed = arr(e['fixedShares'], 'fixedShares', MAX_NAMES).map((s, i) => {
    const o = closed(s, ['member', 'amount'], `fixedShares[${String(i)}]`);
    return {
      memberId: mustResolve(o['member'], ctx, `fixedShares[${String(i)}].member`),
      decimal: exactDecimal(o['amount'], amountCurrency, `fixedShares[${String(i)}].amount`),
    };
  });
  if (uniq(fixed.map((f) => f.memberId)).length !== fixed.length) invalid('fixedShares: repeats');

  const weights = arr(e['weights'], 'weights', MAX_NAMES).map((w, i) => {
    const o = closed(w, ['member', 'weight'], `weights[${String(i)}]`);
    const weight = o['weight'];
    if (
      typeof weight !== 'number' ||
      !Number.isFinite(weight) ||
      !(weight > 0) ||
      weight > MAX_WEIGHT
    )
      invalid(`weights[${String(i)}].weight`);
    return { memberId: mustResolve(o['member'], ctx, `weights[${String(i)}].member`), weight };
  });
  if (uniq(weights.map((w) => w.memberId)).length !== weights.length) invalid('weights: repeats');

  const restToPayer = bool(e['restToPayer'], 'restToPayer');

  const lineItems = arr(e['lineItems'], 'lineItems', MAX_LINE_ITEMS).map((li, i) => {
    const o = closed(li, ['label', 'amount', 'claimants'], `lineItems[${String(i)}]`);
    const label = clean(str(o['label'], `lineItems[${String(i)}].label`, 40));
    if (label.length === 0) invalid(`lineItems[${String(i)}].label`);
    return {
      label,
      decimal: exactDecimal(o['amount'], amountCurrency, `lineItems[${String(i)}].amount`),
      claimants: uniq(
        arr(o['claimants'], `lineItems[${String(i)}].claimants`, MAX_NAMES, 1).map((c) =>
          mustResolve(c, ctx, `lineItems[${String(i)}].claimants[]`),
        ),
      ),
    };
  });

  const doubtRaw = nullableStr(e['currencyDoubt'], 'currencyDoubt', 20);
  const doubt = doubtRaw === null ? '' : clean(doubtRaw).toLowerCase();
  if (doubt.length > 0 && !/^[\p{L}]+(?: [\p{L}]+)?$/u.test(doubt)) invalid('currencyDoubt');

  return {
    description,
    category: category as ExpenseCategory,
    payer,
    ...(decimal !== undefined
      ? { amount: { decimal, ...(currency !== undefined ? { currency } : {}) } }
      : {}),
    perPerson,
    ...(doubt.length > 0 ? { currencyDoubt: doubt } : {}),
    ...(participants !== undefined ? { participants } : {}),
    fixed,
    weights,
    restToPayer,
    ...(lineItems.length > 0 ? { lineItems } : {}),
  };
}

/** `record_expense` input ⇒ drafts, or throws `Invalid`. */
export function validateRecordExpense(input: unknown, ctx: InterpretContext): ExpenseDraft[] {
  const o = closed(input, ['expenses'], 'record_expense');
  return arr(o['expenses'], 'expenses', MAX_EXPENSES_PER_CALL, 1).map((x) => expenseOf(x, ctx));
}

/**
 * `update_attendance` input ⇒ a roster update for the one write path, or
 * throws `Invalid`. `members` is the whole member list: a guest or someone
 * who left is not a roster member and is rejected here.
 */
export function validateUpdateAttendance(
  input: unknown,
  members: readonly Member[],
  senderMemberId: MemberId,
): { update: RosterUpdate; expectInCount?: number } {
  const o = closed(input, ['member', 'status', 'plan', 'night', 'headcount'], 'update_attendance');
  const who = clean(str(o['member'], 'member', 40));
  const roster = rosterMembers(members);
  let memberId: MemberId | undefined;
  if (SELF.has(who.toLowerCase())) memberId = senderMemberId;
  else {
    const exact = roster.find((m) => m.memberId === who);
    const hits = roster.filter((m) => m.displayName.trim().toLowerCase() === who.toLowerCase());
    memberId = exact?.memberId ?? (hits.length === 1 ? hits[0]!.memberId : undefined);
  }
  if (memberId === undefined || !roster.some((m) => m.memberId === memberId))
    invalid('member: not on the roster');
  const status = o['status'];
  if (status !== 'in' && status !== 'out' && status !== 'maybe') invalid('status');
  const planRaw = nullableStr(o['plan'], 'plan', 40);
  const plan = planRaw === null ? undefined : meaningfulHint(clean(planRaw).toLowerCase());
  // A plan is a name ("razzmatazz", "the sagrada tour"), the same words the
  // roster reader takes; anything else could be a reason and is not used.
  if (plan !== undefined && !/^[\p{L}\p{N}' ]{2,40}$/u.test(plan)) invalid('plan: not a name');
  const night = o['night'];
  if (night !== null && night !== 'tonight' && night !== 'tomorrow') invalid('night');
  const headcount = o['headcount'] === null ? undefined : int(o['headcount'], 'headcount', 1, 50);
  return {
    update: {
      who: memberId === senderMemberId ? 'me' : memberId,
      status,
      ...(plan !== undefined ? { hint: plan } : {}),
      ...(night !== null ? { when: night } : {}),
    },
    ...(headcount !== undefined ? { expectInCount: headcount } : {}),
  };
}

/** `approval_reply` ⇒ the near-miss kind it routes as. Never an approval. */
export function validateApprovalReply(input: unknown): NearMissKind {
  const o = closed(input, ['stance'], 'approval_reply');
  switch (o['stance']) {
    case 'decline':
      return 'decline';
    case 'not_me':
      return 'not_me';
    case 'approve':
    case 'unclear':
      return 'generic';
    default:
      return invalid('stance');
  }
}

export interface ValidateCallsInput {
  readonly ctx: InterpretContext;
  /** Every member, for attendance (guests and leavers are rejected there). */
  readonly members: readonly Member[];
}

/**
 * The model's tool calls ⇒ one `Interpretation`. Exactly one call is used:
 * none, several, an unknown tool or any invalid field is `chat` (the chat
 * loop takes the message, with its own tools and the same rules), with the
 * reason kept for the turn note.
 */
export function interpretToolCalls(
  calls: readonly ToolCall[],
  input: ValidateCallsInput,
): Interpretation {
  if (calls.length === 0) return { kind: 'chat', reason: 'no_tool' };
  if (calls.length > 1) {
    const names = new Set(calls.map((c) => c.name));
    return {
      kind: 'chat',
      reason: names.size === 1 && names.has('update_attendance') ? 'several_changes' : 'several',
    };
  }
  const call = calls[0]!;
  try {
    switch (call.name) {
      case 'record_expense':
        return { kind: 'expense', drafts: validateRecordExpense(call.input, input.ctx) };
      case 'keep_off_tab':
        closed(call.input, [], 'keep_off_tab');
        return { kind: 'keep_off_tab' };
      case 'update_attendance': {
        const v = validateUpdateAttendance(call.input, input.members, input.ctx.senderMemberId);
        return {
          kind: 'attendance',
          update: v.update,
          ...(v.expectInCount !== undefined ? { expectInCount: v.expectInCount } : {}),
        };
      }
      case 'approval_reply':
        return { kind: 'approval_reply', nearMiss: validateApprovalReply(call.input) };
      case 'pass_to_chat': {
        const o = closed(call.input, ['about'], 'pass_to_chat');
        const about = o['about'];
        if (typeof about !== 'string' || !(PASS_TO_CHAT_ABOUT as readonly string[]).includes(about))
          invalid('about');
        return { kind: 'chat', reason: `pass:${about}` };
      }
      default:
        return { kind: 'chat', reason: 'unknown_tool' };
    }
  } catch (e) {
    if (e instanceof Invalid) return { kind: 'chat', reason: `invalid:${call.name}:${e.message}` };
    throw e;
  }
}

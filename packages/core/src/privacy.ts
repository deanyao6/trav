/**
 * Structural private/group separation (docs/SAFETY.md §2.3, docs/DECISIONS.md D-007).
 *
 * - `Private<T>` is a branded type. Values of a private type come only from
 *   `PrivateStore` (every read requires `ownerMemberId`) and from `markPrivate()`
 *   at ingestion. They can be stored, shown to their owner, and promoted. They
 *   cannot be placed in a `GroupContext`, a group-lane `OutboundMessage`, or a
 *   tool result (the types reject them; see `GroupSafe`).
 * - `promote()` is the only function that turns private data into a group
 *   `Expense`, and it strips the fields listed in `STRIPPED_FIELDS`.
 */
import type {
  ActivityId,
  BookingId,
  CurrencyCode,
  ExpenseId,
  GroupId,
  IsoDateTime,
  MemberId,
  MessageId,
  PrivateItemId,
  SenderId,
  TripId,
} from './primitives.js';
import type { Money } from './money.js';
import type { Balance, Expense, ExpenseCategory, LineItem, SplitSpec } from './domain/expense.js';
import type { Group, Member } from './domain/group.js';
import type { Activity, Roster, Trip } from './domain/trip.js';
import type { Booking, BookingProposal } from './domain/booking.js';
import type { GroupMemoryFact } from './domain/memory.js';
import { TravError } from './errors.js';

declare const PRIVATE: unique symbol;

export interface PrivateBrand {
  readonly [PRIVATE]: true;
}

export type Private<T> = T & PrivateBrand;

/** Apply the brand at ingestion. The only cast site. */
export function markPrivate<T extends object>(value: T): Private<T> {
  return value as Private<T>;
}

/**
 * Resolves to `never` if `T` (or anything nested in it) carries the private
 * brand. Use as `function f<T>(x: T & GroupSafe<T>)` to reject private values
 * at compile time; the T-002 `@ts-expect-error` test targets `assertGroupSafe`.
 */
export type GroupSafe<T> = T extends PrivateBrand
  ? never
  : T extends readonly (infer U)[]
    ? readonly GroupSafe<U>[]
    : T extends object
      ? { readonly [K in keyof T]: GroupSafe<T[K]> }
      : T;

/** Identity at runtime; a compile error if `value` is or contains a `Private<...>`. */
export function assertGroupSafe<T>(value: T & GroupSafe<T>): T {
  return value;
}

// ---------- parsed documents (data extracted from untrusted text; no raw text inside) ----------

export type ReceiptSourceKind =
  | 'rideshare'
  | 'taxi'
  | 'restaurant'
  | 'bar'
  | 'grocery'
  | 'airline'
  | 'lodging'
  | 'tickets'
  | 'other';

export interface ParsedLineItem {
  readonly description: string;
  readonly quantity: number;
  readonly amount: Money;
}

/**
 * Output of the zero-tool extraction call (SAFETY §2.4). Contains fields only,
 * never `bodyText`/`ocrText`; `warnings` carry injection notes.
 */
export interface ParsedReceipt {
  readonly source: ReceiptSourceKind;
  readonly merchantName: string;
  readonly total: Money;
  readonly subtotal?: Money;
  readonly tax?: Money;
  readonly tip?: Money;
  readonly fees?: Money;
  readonly occurredAt: IsoDateTime;
  readonly lineItems?: readonly ParsedLineItem[];
  readonly ride?: {
    readonly pickup?: string;
    readonly dropoff?: string;
    readonly riders?: number;
  };
  /** 0-1; low values ⇒ the confirm card says "i'm not certain about this one". */
  readonly confidence: number;
  readonly warnings: readonly string[];
}

// ---------- private item types (PrivateStore rows) ----------

interface PrivateRowBase {
  readonly id: PrivateItemId;
  readonly ownerMemberId: MemberId;
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  readonly createdAt: IsoDateTime;
}

export type CardTransaction = Private<
  PrivateRowBase & {
    readonly providerTransactionId: string;
    readonly accountId: string;
    readonly last4: string;
    readonly postedAt: IsoDateTime;
    readonly amount: Money;
    readonly direction: 'debit' | 'credit';
    readonly pending: boolean;
    /** Raw statement descriptor. Untrusted. Stripped on promotion. */
    readonly merchantRaw: string;
    /** Owner-editable; the only merchant string that may reach the group. */
    readonly merchantDisplay: string;
    readonly category?: ExpenseCategory;
    readonly location?: { readonly city?: string; readonly country?: string };
    readonly classifierLabel?: 'shared' | 'personal' | 'unsure';
    readonly classifierScore?: number;
  }
>;

export type EmailReceipt = Private<
  PrivateRowBase & {
    readonly emailId: string;
    readonly receivedAt: IsoDateTime;
    readonly sender: string;
    readonly subject: string;
    readonly bodyText: string;
    readonly parsed: ParsedReceipt | null;
    readonly injectionDetected: boolean;
  }
>;

export type ReceiptScan = Private<
  PrivateRowBase & {
    readonly imageRef: string;
    readonly ocrText: string;
    readonly parsed: ParsedReceipt | null;
    /** Set when the photo was posted in the group thread (the poster confirms instead of a DM). */
    readonly postedInGroupMessageId?: MessageId;
    readonly injectionDetected: boolean;
  }
>;

export type PendingItemSource = 'card' | 'email' | 'receipt';
export type PendingItemStatus = 'pending' | 'promoted' | 'dismissed' | 'expired';

/** The owner-facing "looks shared?" unit of work; one per ingested item. */
export type PendingPrivateItem = Private<
  PrivateRowBase & {
    readonly source: PendingItemSource;
    readonly sourceItemId: PrivateItemId;
    readonly status: PendingItemStatus;
    readonly amount: Money;
    readonly occurredAt: IsoDateTime;
    readonly merchantDisplay: string;
    readonly category: ExpenseCategory;
    readonly lineItems?: readonly LineItem[];
    readonly classifier?: {
      readonly looksShared: boolean;
      readonly confidence: number;
      readonly reason: string;
    };
    readonly lowConfidence: boolean;
    readonly suggestedParticipants?: readonly MemberId[];
    /** The plan `suggestedParticipants` came from (set at ingestion; the expense links to it only when the split still matches). */
    readonly suggestedActivityId?: ActivityId;
    readonly promotedExpenseId?: ExpenseId;
    readonly cardMessageId?: MessageId;
    /** `false` when the source gave only a date and `occurredAt` is a placeholder (local noon). */
    readonly timeKnown?: false;
    /** Set when Trav dropped the item (the owner never answered it); absent for an owner's "keep private". */
    readonly droppedBy?: 'consent_revoked' | 'not_eligible';
  }
>;

/** QR/ticket artifact; lives in the owner's PrivateStore so it can never reach the group lane. */
export type TicketArtifact = Private<
  PrivateRowBase & {
    readonly ticketId: string;
    readonly bookingId: BookingId;
    readonly holderName: string;
    readonly event: {
      readonly name: string;
      readonly venue: string;
      readonly address?: string;
      readonly startsAt: IsoDateTime;
      readonly doorsAt?: IsoDateTime;
    };
    readonly seat?: {
      readonly gate?: string;
      readonly section?: string;
      readonly row?: string;
      readonly seat?: string;
    };
    readonly qrPayload: string;
    readonly qrDataUrl: string;
    readonly deliveredToMemberId: MemberId;
    readonly deliveredMessageId?: MessageId;
  }
>;

export type PrivateItem = CardTransaction | EmailReceipt | ReceiptScan;

// ---------- promotion ----------

export const STRIPPED_FIELDS = [
  'last4',
  'accountId',
  'merchantRaw',
  'sender',
  'subject',
  'bodyText',
  'ocrText',
  'imageRef',
  'providerTransactionId',
  'emailId',
] as const;

export type StrippedField = (typeof STRIPPED_FIELDS)[number];

/** The owner's confirmation, channel-authenticated (SAFETY §2.5). */
export interface OwnerConfirmation {
  readonly senderId: SenderId;
  readonly memberId: MemberId;
  readonly messageId: MessageId;
  readonly via: 'button' | 'reaction' | 'text';
  readonly at: IsoDateTime;
  /** How to split once shared. Omitted ⇒ equal among the activity roster or all active members. */
  readonly split?: SplitSpec;
  readonly merchantDisplayOverride?: string;
}

export interface PromoteContext {
  readonly expenseId: ExpenseId;
  /** The group the expense is logged into; must equal `item.groupId`. */
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly tripCurrency: CurrencyCode;
  /** The owner's channel identity, from GroupStore.members; compared to `confirmation.senderId`. */
  readonly ownerSenderId: SenderId;
  readonly now: IsoDateTime;
  readonly defaultSplit: SplitSpec;
  /**
   * Required when the item's currency differs from `tripCurrency` (T-031 computes
   * it); the expense is logged in trip currency with the item amount in `original`.
   */
  readonly converted?: { readonly amount: Money; readonly rate: string; readonly rateDate: string };
}

/**
 * The only way private data reaches the ledger. Throws `not_owner` unless
 * `confirmation.senderId === ctx.ownerSenderId` and `confirmation.memberId ===
 * item.ownerMemberId`. The returned Expense contains none of `STRIPPED_FIELDS`
 * (test: `Object.keys(expense)` ∩ STRIPPED_FIELDS = ∅) and has
 * `sourceRef: { kind: 'private_item', id: item.id }`.
 *
 * Splits: the expense's `split` is `confirmation.split` when given, else
 * `ctx.defaultSplit`. `parsed.lineItems` on the item are NOT copied
 * automatically; an itemized share is expressed by the owner's confirm flow as
 * `confirmation.split = { method: 'itemized', participants, lineItems }` (T-012),
 * which passes through unchanged.
 *
 * Merchant text (`merchantDisplay`, `parsed.merchantName`, the override) came
 * from untrusted sources, so it is sanitised before it becomes `description`:
 * control, zero-width and bidi characters are removed, whitespace collapsed,
 * and the result truncated to `MAX_DESCRIPTION_LENGTH` (SAFETY §2.4 step 2).
 *
 * Throws `invalid_argument` when the item belongs to another group or trip,
 * has nothing parsed, is a card credit, or `ctx.converted.amount` is not a
 * positive amount for a non-zero item.
 */
export function promote(
  item: PrivateItem,
  confirmation: OwnerConfirmation,
  ctx: PromoteContext,
): Expense {
  // Identity: the channel-assigned sender must be the owner's sender, and the
  // confirmation must name the owner. Display names are never consulted.
  if (confirmation.senderId !== ctx.ownerSenderId || confirmation.memberId !== item.ownerMemberId) {
    throw new TravError('not_owner', 'only the owner can share a private item', {
      itemId: item.id,
      expenseId: ctx.expenseId,
    });
  }
  if (item.groupId !== ctx.groupId) {
    throw new TravError('invalid_argument', 'private item belongs to a different group', {
      itemId: item.id,
      itemGroupId: item.groupId,
      groupId: ctx.groupId,
    });
  }
  if (item.tripId !== null && item.tripId !== ctx.tripId) {
    throw new TravError('invalid_argument', 'private item belongs to a different trip', {
      itemId: item.id,
      itemTripId: item.tripId,
      tripId: ctx.tripId,
    });
  }

  const facts = extractPromotableFacts(item);
  const override = sanitizeDisplayText(confirmation.merchantDisplayOverride ?? '');
  const merchantDisplay = override !== '' ? override : sanitizeDisplayText(facts.merchantDisplay);
  if (merchantDisplay === '') {
    throw new TravError('invalid_argument', 'private item has no usable merchant name', {
      itemId: item.id,
    });
  }

  let amount: Money;
  let original: Expense['original'] | undefined;
  if (facts.amount.currency === ctx.tripCurrency) {
    amount = facts.amount;
  } else {
    if (ctx.converted === undefined || ctx.converted.amount.currency !== ctx.tripCurrency) {
      throw new TravError(
        'currency_mismatch',
        'private item is not in trip currency and no conversion was given',
        {
          itemId: item.id,
          itemCurrency: facts.amount.currency,
          tripCurrency: ctx.tripCurrency,
        },
      );
    }
    const converted = ctx.converted.amount.amountMinor;
    if (
      !Number.isSafeInteger(converted) ||
      converted < 0 ||
      (facts.amount.amountMinor !== 0 && converted === 0)
    ) {
      throw new TravError('invalid_argument', 'converted amount must be a positive integer', {
        itemId: item.id,
        convertedMinor: converted,
      });
    }
    amount = ctx.converted.amount;
    original = { amount: facts.amount, rate: ctx.converted.rate, rateDate: ctx.converted.rateDate };
  }

  // Built field by field; the item is never spread, so nothing in
  // STRIPPED_FIELDS can leak through a future type change.
  const expense: Expense = {
    expenseId: ctx.expenseId,
    groupId: item.groupId,
    tripId: ctx.tripId,
    description: merchantDisplay,
    merchantDisplay,
    category: facts.category,
    amount,
    ...(original === undefined ? {} : { original }),
    paidBy: [{ memberId: item.ownerMemberId, amount }],
    split: confirmation.split ?? ctx.defaultSplit,
    source: facts.source,
    sourceRef: { kind: 'private_item', id: item.id },
    occurredAt: facts.occurredAt,
    createdAt: ctx.now,
    createdBy: item.ownerMemberId,
    status: 'logged',
  };

  const leaked = Object.keys(expense).filter((key) =>
    (STRIPPED_FIELDS as readonly string[]).includes(key),
  );
  if (leaked.length > 0) {
    throw new TravError('invariant_violation', 'promoted expense would carry stripped fields', {
      fields: leaked,
    });
  }
  return expense;
}

/** Longest `Expense.description` a promoted item may carry. */
export const MAX_DESCRIPTION_LENGTH = 120;

// Code point ranges removed from untrusted display text: ASCII controls (incl.
// DEL), C1 controls, soft hyphen, zero-width/joiner chars, line/paragraph
// separators and bidi overrides/isolates, BOM, and `<`/`>` (so a merchant name
// can never open or close an `<untrusted>` wrapper in a prompt). Built from
// code points rather than written as escapes so the source stays ASCII.
const UNSAFE_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0x003c, 0x003c], // <
  [0x003e, 0x003e], // >
];

const UNSAFE_TEXT_RE = new RegExp(
  `[${UNSAFE_CODE_POINT_RANGES.map(
    ([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`,
  ).join('')}]`,
  'g',
);

/**
 * Make untrusted display text safe for the group lane (SAFETY §2.4 step 2):
 * turn every whitespace run (tabs, newlines, line/paragraph separators) into
 * one space, drop control/zero-width/bidi characters and angle brackets,
 * collapse again, trim, and cap the length at `MAX_DESCRIPTION_LENGTH`.
 */
export function sanitizeDisplayText(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').replace(UNSAFE_TEXT_RE, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_DESCRIPTION_LENGTH
    ? cleaned.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()
    : cleaned;
}

/** Fields the caller must write to `private.item_promoted.strippedFields`. */
export function strippedFieldsFor(item: PrivateItem): readonly StrippedField[] {
  return STRIPPED_FIELDS.filter((field) => field in item);
}

// ---------- promotion internals ----------

interface PromotableFacts {
  readonly amount: Money;
  readonly occurredAt: IsoDateTime;
  readonly merchantDisplay: string;
  readonly category: ExpenseCategory;
  readonly source: Expense['source'];
}

function isCardTransaction(item: PrivateItem): item is CardTransaction {
  return 'providerTransactionId' in item;
}

function isEmailReceipt(item: PrivateItem): item is EmailReceipt {
  return 'emailId' in item;
}

function isReceiptScan(item: PrivateItem): item is ReceiptScan {
  return 'imageRef' in item;
}

const RECEIPT_SOURCE_CATEGORY: Readonly<Record<ReceiptSourceKind, ExpenseCategory>> = {
  rideshare: 'transport',
  taxi: 'transport',
  restaurant: 'food',
  bar: 'drinks',
  grocery: 'groceries',
  airline: 'flights',
  lodging: 'lodging',
  tickets: 'tickets',
  other: 'other',
};

/** Reads only the fields SAFETY §2.3 lists as "keeps"; never raw text. */
function extractPromotableFacts(item: PrivateItem): PromotableFacts {
  const itemId = item.id;
  if (isCardTransaction(item)) {
    if (item.direction !== 'debit') {
      throw new TravError('invalid_argument', 'only debit card transactions can be shared', {
        itemId: item.id,
      });
    }
    return {
      amount: item.amount,
      occurredAt: item.postedAt,
      merchantDisplay: item.merchantDisplay,
      category: item.category ?? 'other',
      source: 'card_transaction',
    };
  }
  if (isEmailReceipt(item) || isReceiptScan(item)) {
    const parsed = item.parsed;
    if (parsed === null) {
      throw new TravError('invalid_argument', 'private item has no parsed receipt to share', {
        itemId: item.id,
      });
    }
    return {
      amount: parsed.total,
      occurredAt: parsed.occurredAt,
      merchantDisplay: parsed.merchantName,
      category: RECEIPT_SOURCE_CATEGORY[parsed.source] ?? 'other',
      source: isEmailReceipt(item) ? 'email_receipt' : 'receipt_photo',
    };
  }
  throw new TravError('invalid_argument', 'unknown private item shape', { itemId });
}

// ---------- group context (the only shape the group prompt is rendered from) ----------

/** A recent group-thread message, already identity-resolved. Text is member chat, not a document. */
export interface GroupMessageSummary {
  readonly messageId: MessageId;
  readonly senderMemberId: MemberId | null;
  readonly senderDisplayName: string;
  readonly text: string;
  readonly at: IsoDateTime;
  readonly fromTrav: boolean;
}

/**
 * Everything the group-lane prompt may be rendered from. No field is or
 * contains a `Private<...>` type (type-level test in T-002/T-007). Private
 * activity surfaces only as per-member COUNTS.
 */
export interface GroupContext {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly activities: readonly Activity[];
  readonly rosters: readonly Roster[];
  readonly recentExpenses: readonly Expense[];
  readonly balances: readonly Balance[];
  /** Minors with money on the tab and no guardian: settle-up waits on who covers them (T-065). */
  readonly balancesWaitingOn?: readonly MemberId[];
  readonly pendingProposals: readonly BookingProposal[];
  readonly bookings: readonly Booking[];
  readonly groupMemory: readonly GroupMemoryFact[];
  // No per-member pending-item counts (T-112, SAFETY §2.3 "even a count is the
  // owner's"): only the owner's own DM-lane prompt carries their count.
  readonly recentMessages: readonly GroupMessageSummary[];
  readonly now: IsoDateTime;
  readonly dayNumber: number;
  readonly familyMode: boolean;
  readonly roastMode: boolean;
}

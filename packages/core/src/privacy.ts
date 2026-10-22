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
import { notImplemented } from './errors.js';

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
    readonly promotedExpenseId?: ExpenseId;
    readonly cardMessageId?: MessageId;
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
  readonly tripId: TripId;
  readonly tripCurrency: CurrencyCode;
  /** The owner's channel identity, from GroupStore.members; compared to `confirmation.senderId`. */
  readonly ownerSenderId: SenderId;
  readonly now: IsoDateTime;
  readonly defaultSplit: SplitSpec;
}

/**
 * The only way private data reaches the ledger. Throws `not_owner` unless
 * `confirmation.senderId === ctx.ownerSenderId` and `confirmation.memberId ===
 * item.ownerMemberId`. The returned Expense contains none of `STRIPPED_FIELDS`
 * (test: `Object.keys(expense)` ∩ STRIPPED_FIELDS = ∅) and has
 * `sourceRef: { kind: 'private_item', id: item.id }`.
 */
export function promote(
  item: PrivateItem,
  confirmation: OwnerConfirmation,
  ctx: PromoteContext,
): Expense {
  return notImplemented(`promote(${item.id}, ${confirmation.memberId}, ${ctx.expenseId})`);
}

/** Fields the caller must write to `private.item_promoted.strippedFields`. */
export function strippedFieldsFor(item: PrivateItem): readonly StrippedField[] {
  return notImplemented(`strippedFieldsFor(${item.id})`);
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
  readonly pendingProposals: readonly BookingProposal[];
  readonly bookings: readonly Booking[];
  readonly groupMemory: readonly GroupMemoryFact[];
  /** "Dean, 2 charges look shared" — counts only, never amounts or merchants. */
  readonly privatePendingCounts: Readonly<Record<MemberId, number>>;
  readonly recentMessages: readonly GroupMessageSummary[];
  readonly now: IsoDateTime;
  readonly dayNumber: number;
  readonly familyMode: boolean;
  readonly roastMode: boolean;
}

/**
 * Expenses, splits and ledger entries. An Expense is what happened; a SplitSpec
 * is how it is shared; LedgerEntries are the derived, per-member debits and
 * credits the balances are computed from.
 */
import type {
  ActivityId,
  BookingId,
  ExpenseId,
  GroupId,
  IsoDateTime,
  MemberId,
  MessageId,
  PrivateItemId,
  TripId,
} from '../primitives.js';
import type { Money } from '../money.js';

export type ExpenseSource =
  'chat' | 'receipt_photo' | 'email_receipt' | 'card_transaction' | 'booking';

export type ExpenseCategory =
  | 'tickets'
  | 'flights'
  | 'lodging'
  | 'food'
  | 'drinks'
  | 'transport'
  | 'groceries'
  | 'activities'
  | 'other';

export interface LineItem {
  readonly lineId: string;
  readonly label: string;
  readonly amount: Money;
  /** Members who claimed this line. Empty ⇒ split equally among the expense participants. */
  readonly claimedBy: readonly MemberId[];
  readonly kind: 'item' | 'tax' | 'tip' | 'service' | 'fee' | 'discount';
}

/**
 * Split modes (T-003). Every mode produces shares summing to the expense total
 * to the minor unit; odd minor units go to the largest fractional remainder, ties to the
 * payer (VOICE §4.4), then member order (see `ledger/splits.ts`).
 */
export type SplitSpec =
  | { readonly method: 'equal'; readonly participants: readonly MemberId[] }
  | { readonly method: 'exclude'; readonly excluded: readonly MemberId[] }
  | {
      readonly method: 'weighted';
      readonly weights: readonly { readonly memberId: MemberId; readonly weight: number }[];
    }
  | {
      readonly method: 'exact';
      readonly amounts: readonly { readonly memberId: MemberId; readonly amount: Money }[];
    }
  | {
      readonly method: 'itemized';
      readonly participants: readonly MemberId[];
      readonly lineItems: readonly LineItem[];
    };

export type SplitMethod = SplitSpec['method'];

/**
 * Where an expense came from, for idempotency: the repository enforces a unique
 * `(sourceRef.kind, sourceRef.id)` so a retried booking or re-promoted private
 * item never creates a second expense.
 */
export type ExpenseSourceRef =
  | { readonly kind: 'booking'; readonly id: BookingId }
  | { readonly kind: 'private_item'; readonly id: PrivateItemId }
  | { readonly kind: 'message'; readonly id: MessageId };

export interface Expense {
  readonly expenseId: ExpenseId;
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly description: string;
  /** Owner-editable display name; never a raw statement descriptor (SAFETY §2.3). */
  readonly merchantDisplay?: string;
  readonly category: ExpenseCategory;
  readonly amount: Money;
  /**
   * Original amount when the expense was in another currency (T-031, T-084).
   * `rate` = units of `original.amount.currency` per 1 unit of `amount.currency`
   * (decimal string, as in `fixtures/fx/rates.json`); `rateDate` = the table
   * date used; `source` = who published the rate (`mock-fx`). Optional on rows
   * written before T-084 (D-036). `amount` = `convertMoney(original.amount, …, rate)`.
   */
  readonly original?: {
    readonly amount: Money;
    readonly rate: string;
    readonly rateDate: string;
    readonly source?: string;
  };
  /** One or more payers; shares of `paidBy` must sum to `amount`. Usually one. */
  readonly paidBy: readonly { readonly memberId: MemberId; readonly amount: Money }[];
  readonly split: SplitSpec;
  readonly source: ExpenseSource;
  readonly sourceRef: ExpenseSourceRef;
  readonly activityId?: ActivityId;
  readonly occurredAt: IsoDateTime;
  readonly createdAt: IsoDateTime;
  readonly createdBy: MemberId;
  readonly status: 'logged' | 'undone';
}

/** The computed share for one member of one expense. */
export interface Share {
  readonly memberId: MemberId;
  readonly amount: Money;
}

/**
 * Derived rows. For each expense: one `paid` entry per payer (+amount) and one
 * `owes` entry per participant (−share). Balances per member = Σ entries.
 */
export interface LedgerEntry {
  readonly expenseId: ExpenseId;
  readonly tripId: TripId;
  readonly memberId: MemberId;
  readonly kind: 'paid' | 'owes';
  readonly amount: Money;
}

export interface Balance {
  readonly memberId: MemberId;
  /** Positive = is owed, negative = owes. Σ over members = 0. */
  readonly net: Money;
}

export interface Transfer {
  readonly from: MemberId;
  readonly to: MemberId;
  readonly amount: Money;
}

/**
 * A settle-up transfer between two members (T-141, T-166; D-043 supersedes
 * D-034). No money moves through Trav: this records what members SAY. The
 * payer's Sent makes it `sent` (pending: balances unchanged, the card reads
 * "Chase says sent €42 to Dean"); only the payee's Got it or 👍 makes it
 * `received`, and only `received` rows reduce what is owed
 * (`isSettlementCleared`). Either side can undo their own step: the payee's
 * undo takes `received` back to `sent` (or `undone` if the payer never said
 * sent), the payer's undo takes `sent` to `undone`. `marked_paid` is a row
 * from before T-166 (the payer's word alone) and reads as `sent`. Never names
 * a minor (transfers never do).
 */
export type SettlementStatus = 'sent' | 'received' | 'undone' | 'marked_paid';

/** Only a payee-confirmed transfer reduces balances (T-166). */
export function isSettlementCleared(p: Pick<SettlementPayment, 'status'>): boolean {
  return p.status === 'received';
}

/** The payer said they sent it and the payee hasn't confirmed yet (a pre-T-166 `marked_paid` too). */
export function isSettlementPending(p: Pick<SettlementPayment, 'status'>): boolean {
  return p.status === 'sent' || p.status === 'marked_paid';
}

export interface SettlementPayment {
  /** `pay_` id. */
  readonly paymentId: string;
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly from: MemberId;
  readonly to: MemberId;
  readonly amount: Money;
  /** Who recorded it first: the payer (Sent) or the payee (Got it with no Sent before it). */
  readonly markedBy: MemberId;
  readonly markedAt: IsoDateTime;
  readonly via: 'reaction' | 'button' | 'text';
  /** The settle_up card the transfer was first acted on; with from/to it is the idempotency key. */
  readonly cardMessageId: MessageId;
  readonly status: SettlementStatus;
  /** The payer's Sent (absent when the payee confirmed without one). */
  readonly sentAt?: IsoDateTime;
  /** The payee's Got it. */
  readonly receivedAt?: IsoDateTime;
  readonly receivedBy?: MemberId;
  /** Last change, undo included. */
  readonly updatedAt?: IsoDateTime;
}

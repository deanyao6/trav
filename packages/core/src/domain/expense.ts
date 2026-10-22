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
 * to the minor unit; remainders go to the payer (VOICE §4.4), then by `allocate()` order.
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
  /** Original amount when the expense was in another currency (T-031). */
  readonly original?: { readonly amount: Money; readonly rate: string; readonly rateDate: string };
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

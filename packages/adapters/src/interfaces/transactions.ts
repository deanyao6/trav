/**
 * Card transaction import, shaped after Plaid `/transactions/sync`
 * (added / modified / removed / next_cursor / has_more).
 *
 * Privacy: every call is scoped to one owner member. Transactions are private
 * to their owner until the owner confirms an item as shared; adapters never
 * return one member's transactions in another member's request.
 *
 * Amounts: Plaid returns a double where positive = money left the account.
 * Adapters convert to integer minor units and set `direction` explicitly.
 */
import type { AdapterInfo, IsoDate, IsoDateTime, MemberId, Money, Result } from './common.js';

export interface LinkedAccount {
  readonly accountId: string;
  readonly ownerMemberId: MemberId;
  readonly institutionName: string;
  /** Last 2-4 digits only. */
  readonly mask: string;
  readonly type: 'credit' | 'depository';
  readonly subtype?: string;
}

export interface PersonalFinanceCategory {
  /** e.g. "FOOD_AND_DRINK", "TRANSPORTATION", "ENTERTAINMENT", "TRAVEL". */
  readonly primary: string;
  /** e.g. "FOOD_AND_DRINK_RESTAURANT", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES". */
  readonly detailed: string;
  readonly confidenceLevel?: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
}

export interface TransactionLocation {
  readonly address?: string;
  readonly city?: string;
  readonly region?: string;
  readonly postalCode?: string;
  readonly country?: string;
  readonly lat?: number;
  readonly lon?: number;
}

export interface Counterparty {
  readonly name: string;
  readonly type:
    | 'merchant'
    | 'financial_institution'
    | 'payment_app'
    | 'marketplace'
    | 'payment_terminal'
    | 'income_source';
  readonly entityId?: string;
  readonly logoUrl?: string;
  readonly website?: string;
}

/** Raw provider row. Ingestion converts it to core's `Private<CardTransaction>` and stores it under the owner. */
export interface ProviderTransaction {
  readonly transactionId: string;
  readonly accountId: string;
  readonly ownerMemberId: MemberId;
  /** Absolute value in minor units, in the transaction's own currency. */
  readonly amount: Money;
  /** debit = money out (Plaid positive), credit = money in / refund (Plaid negative). */
  readonly direction: 'debit' | 'credit';
  /** Posted date (or occurrence date while pending). */
  readonly date: IsoDate;
  readonly authorizedDate?: IsoDate;
  /** Only for some institutions; may carry a default 00:00:00 time. */
  readonly datetime?: IsoDateTime;
  /** Enriched merchant name, e.g. "Uber". */
  readonly merchantName?: string;
  readonly merchantEntityId?: string;
  /** Raw statement descriptor (Plaid's legacy `name`). Untrusted text. */
  readonly rawName: string;
  readonly pending: boolean;
  /** On a posted transaction, the id of the pending one it replaces. */
  readonly pendingTransactionId?: string;
  readonly paymentChannel: 'online' | 'in store' | 'other';
  readonly personalFinanceCategory?: PersonalFinanceCategory;
  readonly location?: TransactionLocation;
  readonly counterparties?: readonly Counterparty[];
  readonly logoUrl?: string;
}

export interface TransactionsSyncResult {
  readonly added: readonly ProviderTransaction[];
  readonly modified: readonly ProviderTransaction[];
  readonly removed: readonly { readonly transactionId: string; readonly accountId: string }[];
  /** Persist and pass back on the next call. Empty string if data isn't ready yet. */
  readonly nextCursor: string;
  /** If true, call again immediately with nextCursor. */
  readonly hasMore: boolean;
}

export interface TransactionsAdapter {
  readonly info: AdapterInfo;

  /**
   * Accounts a member has linked (after their own explicit opt-in). Returns an
   * empty list for members who haven't linked anything.
   */
  listAccounts(ownerMemberId: MemberId): Promise<Result<readonly LinkedAccount[]>>;

  /**
   * Incremental sync of one member's transactions since `cursor` (omit for the
   * initial sync). Page until hasMore is false. If a page fails mid-loop,
   * restart from the cursor that began the loop (Plaid semantics).
   */
  sync(ownerMemberId: MemberId, cursor?: string): Promise<Result<TransactionsSyncResult>>;

  /**
   * Unlink a member's accounts and stop importing. Callers must also delete or
   * hide any of that member's unconfirmed imported items.
   */
  disconnect(ownerMemberId: MemberId): Promise<Result<void>>;
}

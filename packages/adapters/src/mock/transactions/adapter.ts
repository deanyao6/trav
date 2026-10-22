/**
 * Mock `TransactionsAdapter` (T-029-b), shaped after Plaid `/transactions/sync`.
 *
 * - Each member with a fixture has one linked "item" (`item_<memberId>`) whose
 *   history is a fixed list of pages. `sync(member)` with no cursor returns page
 *   0; each result carries `nextCursor` and `hasMore` until the last page.
 *   Syncing at the end returns an empty update with the same cursor.
 * - Cursors are opaque strings bound to the item: `txcur.v1.<itemId>.<n>`. A
 *   cursor from another member's item is rejected with `invalid_request` and
 *   reveals nothing about that member. Members without a fixture (or after
 *   `disconnect`) get `not_found` from `sync` and `[]` from `listAccounts`.
 * - Strict per-member scoping: rows are validated on load to belong to the
 *   owner (`fixture.ts`), and every result is re-checked before it is returned.
 * - Pending → posted: a posted row carries `pendingTransactionId`, and the
 *   pending row's id appears in the same page's `removed` (Plaid semantics).
 *   Refunds are `direction: 'credit'` with a positive amount.
 * - Consent (`cardImport`, SAFETY §2.6) is the ingestion caller's check; this
 *   adapter only models the provider.
 *
 * Read-only: no money moves. No network, no wall clock.
 */
import { TravError } from '@trav/core';
import type { MemberId } from '@trav/core';
import type { AdapterError, AdapterInfo, Result } from '../../interfaces/common.js';
import type {
  LinkedAccount,
  ProviderTransaction,
  TransactionsAdapter,
  TransactionsSyncResult,
} from '../../interfaces/transactions.js';
import { TransactionsLedgerBuilder, loadTransactionsFixture } from './fixture.js';
import type { MemberTransactionsFixture, RawTransactionsPage, TransactionsPage } from './fixture.js';
import { isSafeFixtureSegment } from './fixtureFiles.js';

export interface MockTransactionsOptions {
  /**
   * Use exactly these member fixtures (tests). When omitted, a member's
   * fixture is read lazily from `fixtures/<fixtureDir...>/<memberId>.json`.
   */
  readonly fixtures?: readonly MemberTransactionsFixture[];
  /** Default `['transactions']`. */
  readonly fixtureDir?: readonly string[];
}

export interface MockTransactionsAdapter extends TransactionsAdapter {
  /** Plaid item id for a linked member, or undefined. Test/demo hook. */
  itemIdFor(ownerMemberId: MemberId): string | undefined;
  /**
   * Mock control: new data arrives for a member (e.g. a pending charge posts).
   * Validated with the fixture rules; appended as the next page.
   */
  pushUpdate(ownerMemberId: MemberId, page: RawTransactionsPage): Result<void>;
  /** Test hook: number of `sync` calls that returned data or an empty update. */
  syncCount(): number;
}

const CURSOR_PREFIX = 'txcur.v1.';

function err(code: AdapterError['code'], message: string): { ok: false; error: AdapterError } {
  return { ok: false, error: { code, message, retryable: false } };
}

function cursorFor(itemId: string, index: number): string {
  return `${CURSOR_PREFIX}${itemId}.${index}`;
}

function parseCursor(cursor: string): { itemId: string; index: number } | undefined {
  if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
  const rest = cursor.slice(CURSOR_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const itemId = rest.slice(0, dot);
  const indexStr = rest.slice(dot + 1);
  if (!/^(0|[1-9]\d{0,8})$/.test(indexStr)) return undefined;
  return { itemId, index: Number(indexStr) };
}

interface ItemState {
  readonly itemId: string;
  readonly builder: TransactionsLedgerBuilder;
  connected: boolean;
}

export function createMockTransactions(options: MockTransactionsOptions = {}): MockTransactionsAdapter {
  const info: AdapterInfo = { provider: 'mock-transactions', mode: 'mock' };
  const dir = options.fixtureDir ?? ['transactions'];
  const provided = new Map<MemberId, MemberTransactionsFixture>();
  for (const f of options.fixtures ?? []) {
    if (provided.has(f.ownerMemberId)) {
      throw new TravError('invalid_argument', `two transaction fixtures for ${f.ownerMemberId}`);
    }
    provided.set(f.ownerMemberId, f);
  }
  const items = new Map<MemberId, ItemState | null>();
  let syncs = 0;

  function load(member: MemberId): ItemState | undefined {
    if (items.has(member)) return items.get(member) ?? undefined;
    if (!isSafeFixtureSegment(member)) {
      items.set(member, null);
      return undefined;
    }
    const fixture = options.fixtures !== undefined ? provided.get(member) : loadTransactionsFixture(member, dir);
    if (fixture === undefined || fixture.ownerMemberId !== member) {
      items.set(member, null);
      return undefined;
    }
    // Rebuild through the builder so provided fixtures get the same validation.
    const builder = new TransactionsLedgerBuilder(member, fixture.accounts);
    fixture.pages.forEach((p, i) => builder.addPage(p, `${member} page ${i}`));
    const state: ItemState = { itemId: `item_${member}`, builder, connected: true };
    items.set(member, state);
    return state;
  }

  function connected(member: MemberId): ItemState | undefined {
    const s = load(member);
    return s !== undefined && s.connected ? s : undefined;
  }

  /** Defense in depth: a page must only ever carry the requester's rows. */
  function assertScoped(member: MemberId, page: TransactionsPage, accounts: readonly LinkedAccount[]): void {
    const ids = new Set(accounts.map((a) => a.accountId));
    const rows: readonly ProviderTransaction[] = [...page.added, ...page.modified];
    for (const tx of rows) {
      if (tx.ownerMemberId !== member || !ids.has(tx.accountId)) {
        throw new TravError('invariant_violation', 'transaction scoped to another member', {
          transactionId: tx.transactionId,
        });
      }
    }
    for (const r of page.removed) {
      if (!ids.has(r.accountId)) {
        throw new TravError('invariant_violation', 'removal scoped to another member', {
          transactionId: r.transactionId,
        });
      }
    }
  }

  return {
    info,

    listAccounts(ownerMemberId) {
      const s = connected(ownerMemberId);
      return Promise.resolve({ ok: true, value: s === undefined ? [] : s.builder.accounts });
    },

    sync(ownerMemberId, cursor) {
      const s = connected(ownerMemberId);
      if (s === undefined) {
        return Promise.resolve(err('not_found', 'no linked accounts for this member'));
      }
      let index = 0;
      if (cursor !== undefined && cursor !== '') {
        const parsed = parseCursor(cursor);
        if (parsed === undefined) return Promise.resolve(err('invalid_request', 'malformed cursor'));
        if (parsed.itemId !== s.itemId) {
          return Promise.resolve(err('invalid_request', 'cursor does not belong to this member'));
        }
        index = parsed.index;
      }
      const pages = s.builder.pages;
      if (index > pages.length) return Promise.resolve(err('invalid_request', 'cursor is ahead of the item'));
      syncs += 1;
      if (index === pages.length) {
        const empty: TransactionsSyncResult = {
          added: [],
          modified: [],
          removed: [],
          nextCursor: cursorFor(s.itemId, index),
          hasMore: false,
        };
        return Promise.resolve({ ok: true, value: empty });
      }
      const page = pages[index];
      if (page === undefined) return Promise.resolve(err('invalid_request', 'cursor is ahead of the item'));
      assertScoped(ownerMemberId, page, s.builder.accounts);
      const value: TransactionsSyncResult = {
        added: page.added,
        modified: page.modified,
        removed: page.removed,
        nextCursor: cursorFor(s.itemId, index + 1),
        hasMore: index + 1 < pages.length,
      };
      return Promise.resolve({ ok: true, value });
    },

    disconnect(ownerMemberId) {
      const s = load(ownerMemberId);
      if (s !== undefined) s.connected = false;
      return Promise.resolve({ ok: true, value: undefined });
    },

    itemIdFor(ownerMemberId) {
      return connected(ownerMemberId)?.itemId;
    },

    pushUpdate(ownerMemberId, page) {
      const s = connected(ownerMemberId);
      if (s === undefined) return err('not_found', 'no linked accounts for this member');
      try {
        s.builder.addPage(page, `${ownerMemberId} pushed page`);
      } catch (e) {
        if (e instanceof TravError) return err('invalid_request', e.message);
        throw e;
      }
      return { ok: true, value: undefined };
    },

    syncCount() {
      return syncs;
    },
  };
}

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
 * - On a clock (T-067, `options.clock`): a row exists for the provider only
 *   once it has happened. Each row is available at its `datetime` (a date-only
 *   row at noon UTC of its `date`, which has started in every zone), a posted
 *   row no earlier than the pending row it replaces, and a pushed row no
 *   earlier than the push. The fixture pages are then a history, not the
 *   paging: a sync at the end of what was delivered returns, as one new page,
 *   whatever became available since (a pending row and the posted row that
 *   replaces it arriving together come as the posted row only; a removal comes
 *   only after the row it removes was delivered). Delivered pages are kept, so
 *   a fresh initial sync replays them in order (Plaid semantics), and a
 *   later-day charge never appears before its time.
 *
 * Read-only: no money moves. No network, no wall clock (the clock is injected).
 */
import { TravError, parseIso } from '@trav/core';
import type { Clock, MemberId } from '@trav/core';
import type { AdapterError, AdapterInfo, Result } from '../../interfaces/common.js';
import type {
  LinkedAccount,
  ProviderTransaction,
  TransactionsAdapter,
  TransactionsSyncResult,
} from '../../interfaces/transactions.js';
import { TransactionsLedgerBuilder, loadTransactionsFixture } from './fixture.js';
import type {
  MemberTransactionsFixture,
  RawTransactionsPage,
  TransactionsPage,
} from './fixture.js';
import { isSafeFixtureSegment } from '../fixtures.js';

export interface MockTransactionsOptions {
  /**
   * Use exactly these member fixtures (tests). When omitted, a member's
   * fixture is read lazily from `fixtures/<fixtureDir...>/<memberId>.json`.
   */
  readonly fixtures?: readonly MemberTransactionsFixture[];
  /** Default `['transactions']`. */
  readonly fixtureDir?: readonly string[];
  /**
   * The simulated clock (T-067): sync returns only rows posted or pending at or
   * before `clock.now()`. Omitted ⇒ the fixture pages as written, whatever the
   * time (tests that read the whole history).
   */
  readonly clock?: Clock;
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

/** One row-level change in an item's history, with the instant the provider has it (clock mode). */
interface HistoryEntry {
  readonly kind: 'added' | 'modified' | 'removed';
  readonly tx?: ProviderTransaction;
  readonly removal?: TransactionsSyncResult['removed'][number];
  readonly availableAtMs: number;
  released: boolean;
}

/** Clock mode: the history and the pages already delivered from it. */
interface Timeline {
  readonly entries: HistoryEntry[];
  /** availableAt of each added row, by transaction id. */
  readonly addedAt: Map<string, number>;
  /** Pages delivered so far; cursor n means "the first n were delivered". */
  readonly releases: TransactionsPage[];
  /** Ids delivered as added rows. */
  readonly delivered: Set<string>;
  /** Pending ids never delivered because their posted row came in the same page. */
  readonly skipped: Set<string>;
}

interface ItemState {
  readonly itemId: string;
  readonly builder: TransactionsLedgerBuilder;
  readonly timeline?: Timeline;
  connected: boolean;
}

/** When the provider has a row: its datetime, else noon UTC of its date (started in every zone). */
export function rowAvailableAtMs(tx: Pick<ProviderTransaction, 'date' | 'datetime'>): number {
  return parseIso(tx.datetime ?? `${tx.date}T12:00:00Z`);
}

/** Appends one validated page to a timeline; `pushedAtMs` is -Infinity for the fixture history. */
function appendHistory(t: Timeline, page: TransactionsPage, pushedAtMs: number): void {
  const rows = [...page.added, ...page.modified];
  const newest = rows.reduce((m, tx) => Math.max(m, rowAvailableAtMs(tx)), -Infinity);
  for (const tx of page.added) {
    const replaces =
      tx.pendingTransactionId !== undefined
        ? (t.addedAt.get(tx.pendingTransactionId) ?? -Infinity)
        : -Infinity;
    const at = Math.max(rowAvailableAtMs(tx), pushedAtMs, replaces);
    t.addedAt.set(tx.transactionId, at);
    t.entries.push({ kind: 'added', tx, availableAtMs: at, released: false });
  }
  for (const tx of page.modified) {
    const at = Math.max(
      rowAvailableAtMs(tx),
      pushedAtMs,
      t.addedAt.get(tx.transactionId) ?? -Infinity,
    );
    t.entries.push({ kind: 'modified', tx, availableAtMs: at, released: false });
  }
  for (const removal of page.removed) {
    const tied = page.added.find((tx) => tx.pendingTransactionId === removal.transactionId);
    const at =
      tied !== undefined
        ? (t.addedAt.get(tied.transactionId) ?? pushedAtMs)
        : Math.max(t.addedAt.get(removal.transactionId) ?? -Infinity, pushedAtMs, newest);
    t.entries.push({ kind: 'removed', removal, availableAtMs: at, released: false });
  }
}

/**
 * The next page of a timeline at `nowMs`: every unreleased entry that is due,
 * or undefined when nothing new is due (see the header for the rules).
 */
function releaseDue(t: Timeline, nowMs: number): TransactionsPage | undefined {
  const due = t.entries.filter((e) => !e.released && e.availableAtMs <= nowMs);
  const supersededHere = new Set(
    due
      .map((e) => (e.kind === 'added' ? e.tx?.pendingTransactionId : undefined))
      .filter((id): id is string => id !== undefined),
  );
  const deliveredBefore = new Set(t.delivered);
  const added: ProviderTransaction[] = [];
  const modified: ProviderTransaction[] = [];
  const removed: TransactionsSyncResult['removed'][number][] = [];
  for (const e of due) {
    if (e.kind !== 'added' || e.tx === undefined) continue;
    const tx = e.tx;
    e.released = true;
    if (tx.pending && supersededHere.has(tx.transactionId)) {
      t.skipped.add(tx.transactionId); // its posted row is in this page: deliver that one only
      continue;
    }
    added.push(tx);
    t.delivered.add(tx.transactionId);
  }
  for (const e of due) {
    if (e.kind === 'modified' && e.tx !== undefined) {
      if (t.skipped.has(e.tx.transactionId)) {
        e.released = true;
        continue;
      }
      if (!t.delivered.has(e.tx.transactionId)) continue; // its row is not out yet
      e.released = true;
      modified.push(e.tx);
    } else if (e.kind === 'removed' && e.removal !== undefined) {
      const r = e.removal;
      if (t.skipped.has(r.transactionId)) {
        e.released = true; // never delivered, nothing to remove
        continue;
      }
      if (!deliveredBefore.has(r.transactionId)) continue; // only after the row itself went out
      e.released = true;
      removed.push(r);
    }
  }
  if (added.length === 0 && modified.length === 0 && removed.length === 0) return undefined;
  const page: TransactionsPage = { added, modified, removed };
  t.releases.push(page);
  return page;
}

export function createMockTransactions(
  options: MockTransactionsOptions = {},
): MockTransactionsAdapter {
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
    const fixture =
      options.fixtures !== undefined ? provided.get(member) : loadTransactionsFixture(member, dir);
    if (fixture === undefined || fixture.ownerMemberId !== member) {
      items.set(member, null);
      return undefined;
    }
    // Rebuild through the builder so provided fixtures get the same validation.
    const builder = new TransactionsLedgerBuilder(member, fixture.accounts);
    fixture.pages.forEach((p, i) => builder.addPage(p, `${member} page ${i}`));
    let timeline: Timeline | undefined;
    if (options.clock !== undefined) {
      timeline = {
        entries: [],
        addedAt: new Map(),
        releases: [],
        delivered: new Set(),
        skipped: new Set(),
      };
      for (const p of builder.pages) appendHistory(timeline, p, -Infinity);
    }
    const state: ItemState = {
      itemId: `item_${member}`,
      builder,
      ...(timeline !== undefined ? { timeline } : {}),
      connected: true,
    };
    items.set(member, state);
    return state;
  }

  function connected(member: MemberId): ItemState | undefined {
    const s = load(member);
    return s !== undefined && s.connected ? s : undefined;
  }

  /** Defense in depth: a page must only ever carry the requester's rows. */
  function assertScoped(
    member: MemberId,
    page: TransactionsPage,
    accounts: readonly LinkedAccount[],
  ): void {
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
        if (parsed === undefined)
          return Promise.resolve(err('invalid_request', 'malformed cursor'));
        if (parsed.itemId !== s.itemId) {
          return Promise.resolve(err('invalid_request', 'cursor does not belong to this member'));
        }
        index = parsed.index;
      }
      if (s.timeline !== undefined && options.clock !== undefined) {
        const t = s.timeline;
        if (index > t.releases.length)
          return Promise.resolve(err('invalid_request', 'cursor is ahead of the item'));
        syncs += 1;
        const page =
          index < t.releases.length ? t.releases[index] : releaseDue(t, options.clock.nowMs());
        if (page === undefined) {
          const empty: TransactionsSyncResult = {
            added: [],
            modified: [],
            removed: [],
            nextCursor: cursorFor(s.itemId, index),
            hasMore: false,
          };
          return Promise.resolve({ ok: true, value: empty });
        }
        assertScoped(ownerMemberId, page, s.builder.accounts);
        const value: TransactionsSyncResult = {
          added: page.added,
          modified: page.modified,
          removed: page.removed,
          nextCursor: cursorFor(s.itemId, index + 1),
          hasMore: index + 1 < t.releases.length,
        };
        return Promise.resolve({ ok: true, value });
      }
      const pages = s.builder.pages;
      if (index > pages.length)
        return Promise.resolve(err('invalid_request', 'cursor is ahead of the item'));
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
      if (page === undefined)
        return Promise.resolve(err('invalid_request', 'cursor is ahead of the item'));
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
        const added = s.builder.addPage(page, `${ownerMemberId} pushed page`);
        // Clock mode: what arrives now is available now (and never before its own time).
        if (s.timeline !== undefined && options.clock !== undefined) {
          appendHistory(s.timeline, added, options.clock.nowMs());
        }
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

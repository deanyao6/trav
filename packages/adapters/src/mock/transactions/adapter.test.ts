import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProviderTransaction, TransactionsSyncResult } from '../../interfaces/transactions.js';
import { createMockTransactions } from './adapter.js';
import type { MockTransactionsAdapter } from './adapter.js';
import { loadTransactionsFixture, parseTransactionsFixture, plaidAmountToMoney } from './fixture.js';
import { listFixtureJson } from './fixtureFiles.js';

/** Private copy of the generator output, so fixed-value tests survive regeneration. */
const PINNED = ['transactions', 'pinned'] as const;

async function syncAll(
  adapter: MockTransactionsAdapter,
  member: string,
  cursor?: string,
): Promise<{ pages: TransactionsSyncResult[]; cursor: string }> {
  const pages: TransactionsSyncResult[] = [];
  let next = cursor;
  for (let i = 0; i < 100; i += 1) {
    const r = await adapter.sync(member, next);
    if (!r.ok) throw new Error(`sync failed: ${r.error.code}`);
    pages.push(r.value);
    next = r.value.nextCursor;
    if (!r.value.hasMore) return { pages, cursor: next };
  }
  throw new Error('sync did not terminate');
}

function rowsOf(pages: readonly TransactionsSyncResult[]): ProviderTransaction[] {
  return pages.flatMap((p) => [...p.added, ...p.modified]);
}

const ACCOUNT = {
  accountId: 'acc_t_1',
  ownerMemberId: 'mem_t',
  institutionName: 'Test Bank (fictional)',
  mask: '0042',
  type: 'credit',
};

function row(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: id,
    accountId: 'acc_t_1',
    ownerMemberId: 'mem_t',
    amount: { amountMinor: 1980, currency: 'EUR' },
    direction: 'debit',
    date: '2026-03-15',
    datetime: '2026-03-15T02:14:00+01:00',
    merchantName: 'Rides Co',
    rawName: 'RIDES CO *TRIP',
    pending: false,
    paymentChannel: 'online',
    ...extra,
  };
}

describe('mock transactions: Plaid-shaped sync over pinned fixtures', () => {
  const pinned = createMockTransactions({ fixtureDir: PINNED });

  it('is a mock adapter', () => {
    expect(pinned.info).toEqual({ provider: 'mock-transactions', mode: 'mock' });
  });

  it('pages with cursors until hasMore is false', async () => {
    const first = await pinned.sync('mem_sam');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.hasMore).toBe(true);
    expect(first.value.added).toHaveLength(12);
    expect(first.value.nextCursor).toBe('txcur.v1.item_mem_sam.1');

    const { pages, cursor } = await syncAll(pinned, 'mem_sam');
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages.at(-1)?.hasMore).toBe(false);

    // At the end: an empty update with the same cursor.
    const tail = await pinned.sync('mem_sam', cursor);
    expect(tail).toEqual({
      ok: true,
      value: { added: [], modified: [], removed: [], nextCursor: cursor, hasMore: false },
    });
    // Empty-string cursor is the initial sync (Plaid).
    const again = await pinned.sync('mem_sam', '');
    expect(again.ok && again.value.nextCursor).toBe('txcur.v1.item_mem_sam.1');
  });

  it('a posted transaction replacing a pending one carries pendingTransactionId and removes the pending row', async () => {
    const { pages } = await syncAll(pinned, 'mem_sam');
    const pageOfPosted = pages.findIndex((p) =>
      p.added.some((t) => t.transactionId === 'txn_sam_uber_0315'),
    );
    const pageOfPending = pages.findIndex((p) =>
      p.added.some((t) => t.transactionId === 'txn_sam_uber_0315_p'),
    );
    expect(pageOfPending).toBeGreaterThanOrEqual(0);
    expect(pageOfPosted).toBeGreaterThanOrEqual(pageOfPending);

    const pending = pages[pageOfPending]?.added.find((t) => t.transactionId === 'txn_sam_uber_0315_p');
    const posted = pages[pageOfPosted]?.added.find((t) => t.transactionId === 'txn_sam_uber_0315');
    expect(pending?.pending).toBe(true);
    expect(pending?.amount).toEqual({ amountMinor: 1980, currency: 'EUR' });
    expect(posted?.pending).toBe(false);
    expect(posted?.pendingTransactionId).toBe('txn_sam_uber_0315_p');
    expect(posted?.amount).toEqual({ amountMinor: 2340, currency: 'EUR' });
    expect(pages[pageOfPosted]?.removed).toContainEqual({
      transactionId: 'txn_sam_uber_0315_p',
      accountId: 'acc_sam_cc',
    });
  });

  it('every pinned posted row with pendingTransactionId follows Plaid replace semantics', async () => {
    for (const member of listFixtureJson(PINNED)) {
      const { pages } = await syncAll(pinned, member);
      const seenPending = new Set<string>();
      for (const p of pages) {
        for (const t of p.added) {
          if (t.pending) seenPending.add(t.transactionId);
          if (t.pendingTransactionId !== undefined) {
            expect(seenPending.has(t.pendingTransactionId)).toBe(true);
            expect(p.removed.map((r) => r.transactionId)).toContain(t.pendingTransactionId);
          }
        }
      }
    }
  });

  it('refunds are credits with a positive amount', async () => {
    const { pages } = await syncAll(pinned, 'mem_sam');
    const refund = rowsOf(pages).find((t) => t.transactionId === 'txn_sam_sunglasses_refund_0316');
    expect(refund?.direction).toBe('credit');
    expect(refund?.amount).toEqual({ amountMinor: 3500, currency: 'EUR' });
    const purchase = rowsOf(pages).find((t) => t.transactionId === 'txn_sam_sunglasses_0314');
    expect(purchase?.direction).toBe('debit');
  });

  it('carries modified rows (enrichment updates)', async () => {
    const { pages } = await syncAll(pinned, 'mem_dean');
    const modified = pages.flatMap((p) => p.modified);
    expect(modified.map((t) => t.transactionId)).toContain('txn_dean_coffee_0315');
  });
});

describe('mock transactions: strict per-member scoping', () => {
  const adapter = createMockTransactions({ fixtureDir: PINNED });
  const members = listFixtureJson(PINNED);

  it('has fixtures for several members', () => {
    expect(members.length).toBeGreaterThanOrEqual(6);
  });

  it("a member's sync never returns another member's transactions", async () => {
    const idsByMember = new Map<string, Set<string>>();
    for (const m of members) {
      const { pages } = await syncAll(adapter, m);
      const accounts = await adapter.listAccounts(m);
      expect(accounts.ok).toBe(true);
      const accountIds = new Set(accounts.ok ? accounts.value.map((a) => a.accountId) : []);
      for (const t of rowsOf(pages)) {
        expect(t.ownerMemberId).toBe(m);
        expect(accountIds.has(t.accountId)).toBe(true);
      }
      for (const r of pages.flatMap((p) => p.removed)) expect(accountIds.has(r.accountId)).toBe(true);
      idsByMember.set(m, new Set(rowsOf(pages).map((t) => t.transactionId)));
    }
    for (const [a, ida] of idsByMember) {
      for (const [b, idb] of idsByMember) {
        if (a === b) continue;
        expect([...ida].filter((id) => idb.has(id))).toEqual([]);
      }
    }
  });

  it("a request with another member's item cursor fails without leaking", async () => {
    const sam = await adapter.sync('mem_sam');
    expect(sam.ok).toBe(true);
    if (!sam.ok) return;
    const stolen = await adapter.sync('mem_dean', sam.value.nextCursor);
    expect(stolen.ok).toBe(false);
    if (stolen.ok) return;
    expect(stolen.error.code).toBe('invalid_request');
    expect(stolen.error.message).not.toMatch(/sam/i);

    const forged = await adapter.sync('mem_dean', 'txcur.v1.item_mem_sam.0');
    expect(forged.ok ? 'ok' : forged.error.code).toBe('invalid_request');
    expect(adapter.itemIdFor('mem_sam')).toBe('item_mem_sam');
    expect(adapter.itemIdFor('mem_nobody')).toBeUndefined();
  });

  it('rejects malformed and out-of-range cursors', async () => {
    for (const bad of ['cur_sam_1', 'txcur.v1.item_mem_sam', 'txcur.v1.item_mem_sam.-1', 'txcur.v1.item_mem_sam.99']) {
      const r = await adapter.sync('mem_sam', bad);
      expect(r.ok ? 'ok' : r.error.code).toBe('invalid_request');
    }
  });

  it('members without a fixture have no accounts; unsafe ids never touch the filesystem', async () => {
    for (const m of ['mem_nobody', '../secrets', 'mem/../../etc', '']) {
      expect(await adapter.listAccounts(m)).toEqual({ ok: true, value: [] });
      const r = await adapter.sync(m);
      expect(r.ok ? 'ok' : r.error.code).toBe('not_found');
    }
  });

  it('accounts expose only a 2-4 digit mask', async () => {
    for (const m of members) {
      const r = await adapter.listAccounts(m);
      if (!r.ok) throw new Error('listAccounts failed');
      for (const a of r.value) {
        expect(a.ownerMemberId).toBe(m);
        expect(a.mask).toMatch(/^\d{2,4}$/);
      }
    }
  });

  it('disconnect unlinks the member only', async () => {
    const local = createMockTransactions({ fixtureDir: PINNED });
    expect(await local.disconnect('mem_sam')).toEqual({ ok: true, value: undefined });
    expect(await local.listAccounts('mem_sam')).toEqual({ ok: true, value: [] });
    const r = await local.sync('mem_sam');
    expect(r.ok ? 'ok' : r.error.code).toBe('not_found');
    const dean = await local.sync('mem_dean');
    expect(dean.ok).toBe(true);
  });
});

describe('mock transactions: pushUpdate and validation', () => {
  function fresh(): MockTransactionsAdapter {
    const fixture = parseTransactionsFixture({
      ownerMemberId: 'mem_t',
      accounts: [ACCOUNT],
      pages: [{ result: { added: [row('t_p', { pending: true })], modified: [], removed: [] } }],
    });
    return createMockTransactions({ fixtures: [fixture] });
  }

  it('pending posts later: the next sync from the saved cursor carries pendingTransactionId and removes the pending row', async () => {
    const adapter = fresh();
    const { cursor, pages } = await syncAll(adapter, 'mem_t');
    expect(rowsOf(pages).map((t) => [t.transactionId, t.pending])).toEqual([['t_p', true]]);

    // Fixture omits `removed`; the mock adds it like Plaid does.
    const pushed = adapter.pushUpdate('mem_t', {
      added: [row('t_1', { amount: { amountMinor: 2340, currency: 'EUR' }, pendingTransactionId: 't_p' })],
    });
    expect(pushed).toEqual({ ok: true, value: undefined });
    const next = await adapter.sync('mem_t', cursor);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.added).toHaveLength(1);
    expect(next.value.added[0]?.pendingTransactionId).toBe('t_p');
    expect(next.value.removed).toEqual([{ transactionId: 't_p', accountId: 'acc_t_1' }]);
    expect(next.value.hasMore).toBe(false);
  });

  it('rejects pushes that would break scoping or history, leaving state unchanged', async () => {
    const adapter = fresh();
    const bad = [
      { added: [row('x', { ownerMemberId: 'mem_other' })] },
      { added: [row('x', { accountId: 'acc_other' })] },
      { added: [row('t_p')] },
      { added: [row('x', { pendingTransactionId: 'nope' })] },
      { added: [row('x'), row('y', { pendingTransactionId: 'x' })] },
      { modified: [row('nope')] },
      { removed: [{ transactionId: 'nope', accountId: 'acc_t_1' }] },
      { added: [row('x', { amount: { amountMinor: 1.5, currency: 'EUR' } })] },
      { added: [row('x', { amount: { amountMinor: -100, currency: 'EUR' } })] },
    ];
    for (const page of bad) {
      const r = adapter.pushUpdate('mem_t', page);
      expect(r.ok ? 'ok' : r.error.code).toBe('invalid_request');
    }
    const { pages } = await syncAll(adapter, 'mem_t');
    expect(pages).toHaveLength(1);
    expect(adapter.pushUpdate('mem_nobody', { added: [] }).ok).toBe(false);
  });

  it('a duplicate push of the same transaction id is rejected', () => {
    const adapter = fresh();
    expect(adapter.pushUpdate('mem_t', { added: [row('t_2')] }).ok).toBe(true);
    const dup = adapter.pushUpdate('mem_t', { added: [row('t_2')] });
    expect(dup.ok ? 'ok' : dup.error.code).toBe('invalid_request');
  });

  it('fixture validation: owner, mask, file name, duplicate fixtures', () => {
    expect(() =>
      parseTransactionsFixture({ ownerMemberId: 'mem_t', accounts: [{ ...ACCOUNT, mask: '4111111111111111' }], pages: [] }),
    ).toThrow(/mask/);
    expect(() =>
      parseTransactionsFixture({ ownerMemberId: 'mem_t', accounts: [{ ...ACCOUNT, ownerMemberId: 'mem_x' }], pages: [] }),
    ).toThrow(/belongs to mem_x/);
    expect(() =>
      parseTransactionsFixture({ ownerMemberId: 'mem_t', accounts: [ACCOUNT], pages: [] }, 'mem_other'),
    ).toThrow(/declares owner/);
    expect(() =>
      parseTransactionsFixture({ ownerMemberId: 'mem_t', accounts: [ACCOUNT], pages: [{ added: [row('a', { ownerMemberId: 'mem_x' })] }] }),
    ).toThrow(/belongs to mem_x/);
    const f = parseTransactionsFixture({ ownerMemberId: 'mem_t', accounts: [ACCOUNT], pages: [] });
    expect(() => createMockTransactions({ fixtures: [f, f] })).toThrow(/two transaction fixtures/);
  });

  it('empty history: one empty page-less item syncs to an empty, final update', async () => {
    const f = parseTransactionsFixture({ ownerMemberId: 'mem_t', accounts: [ACCOUNT], transactions: [] });
    const adapter = createMockTransactions({ fixtures: [f] });
    const r = await adapter.sync('mem_t');
    expect(r).toEqual({
      ok: true,
      value: { added: [], modified: [], removed: [], nextCursor: 'txcur.v1.item_mem_t.0', hasMore: false },
    });
  });
});

describe('mock transactions: Plaid wire shape at the adapter edge', () => {
  it('converts doubles to integer minor units; negative amounts are credits (refunds)', () => {
    expect(plaidAmountToMoney(23.4, 'EUR')).toEqual({ amount: { amountMinor: 2340, currency: 'EUR' }, direction: 'debit' });
    expect(plaidAmountToMoney(-35, 'EUR')).toEqual({ amount: { amountMinor: 3500, currency: 'EUR' }, direction: 'credit' });
    expect(plaidAmountToMoney(0.1 + 0.2, 'USD')).toEqual({ amount: { amountMinor: 30, currency: 'USD' }, direction: 'debit' });
    expect(plaidAmountToMoney(1200, 'JPY')).toEqual({ amount: { amountMinor: 1200, currency: 'JPY' }, direction: 'debit' });
    expect(plaidAmountToMoney(0, 'EUR').amount.amountMinor).toBe(0);
    expect(() => plaidAmountToMoney(12.345, 'EUR')).toThrow();
    expect(() => plaidAmountToMoney(Number.NaN, 'EUR')).toThrow();
  });

  it('maps snake_case wire rows, paging a flat list', async () => {
    const wireRow = (id: string, amount: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      transaction_id: id,
      account_id: 'acc_w',
      amount,
      iso_currency_code: 'EUR',
      date: '2026-03-16',
      authorized_date: '2026-03-16',
      name: 'OPTICA SOL BCN',
      merchant_name: 'Optica Sol',
      pending: false,
      payment_channel: 'in store',
      personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES', confidence_level: 'HIGH' },
      location: { city: 'Barcelona', country: 'ES', postal_code: '08001' },
      counterparties: [{ name: 'Optica Sol', type: 'merchant', entity_id: 'ent_x' }],
      ...extra,
    });
    const f = parseTransactionsFixture(
      {
        ownerMemberId: 'mem_w',
        institution_name: 'Wire Bank (fictional)',
        accounts: [{ account_id: 'acc_w', mask: '12', type: 'depository', subtype: 'checking' }],
        transactions: [
          wireRow('w1_p', 19.8, { pending: true }),
          wireRow('w1', 23.4, { pending_transaction_id: 'w1_p' }),
          wireRow('w2', -35),
        ],
      },
      'mem_w',
      2,
    );
    expect(f.accounts[0]).toEqual({
      accountId: 'acc_w',
      ownerMemberId: 'mem_w',
      institutionName: 'Wire Bank (fictional)',
      mask: '12',
      type: 'depository',
      subtype: 'checking',
    });
    const adapter = createMockTransactions({ fixtures: [f] });
    const { pages } = await syncAll(adapter, 'mem_w');
    expect(pages).toHaveLength(2);
    const rows = rowsOf(pages);
    expect(rows.find((t) => t.transactionId === 'w1')).toMatchObject({
      ownerMemberId: 'mem_w',
      amount: { amountMinor: 2340, currency: 'EUR' },
      direction: 'debit',
      pendingTransactionId: 'w1_p',
      rawName: 'OPTICA SOL BCN',
      location: { city: 'Barcelona', country: 'ES', postalCode: '08001' },
      personalFinanceCategory: { confidenceLevel: 'HIGH' },
      counterparties: [{ name: 'Optica Sol', type: 'merchant', entityId: 'ent_x' }],
    });
    expect(rows.find((t) => t.transactionId === 'w2')).toMatchObject({ direction: 'credit', amount: { amountMinor: 3500 } });
    expect(pages[0]?.removed).toEqual([{ transactionId: 'w1_p', accountId: 'acc_w' }]);
  });
});

describe('mock transactions: shared fixture files (value-agnostic)', () => {
  const members = listFixtureJson(['transactions']);

  it('every fixtures/transactions/<member>.json loads, belongs to its member, and is fictional', async () => {
    const adapter = createMockTransactions();
    for (const m of members) {
      expect(loadTransactionsFixture(m)?.ownerMemberId).toBe(m);
      const { pages } = await syncAll(adapter, m);
      for (const t of rowsOf(pages)) expect(t.ownerMemberId).toBe(m);
    }
  });

  it('no card-number-like digit runs in any transactions fixture; pinned copies use example.test domains only', () => {
    const files = [
      ...members.map((m) => `transactions/${m}`),
      ...listFixtureJson(PINNED).map((m) => `transactions/pinned/${m}`),
    ];
    for (const f of files) {
      const text = readFileSync(new URL(`../../../../../fixtures/${f}.json`, import.meta.url), 'utf8');
      expect(text).not.toMatch(/\d{12,19}/);
      expect(text).not.toMatch(/\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}/);
      if (f.includes('/pinned/')) {
        const domains = text.match(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|co|es|pt)\b/gi) ?? [];
        expect(domains).toEqual([]);
      }
    }
  });
});

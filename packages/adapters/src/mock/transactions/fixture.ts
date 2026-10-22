/**
 * Per-member card transaction fixtures (`fixtures/transactions/<memberId>.json`)
 * mapped into the adapter's Plaid-shaped types.
 *
 * Accepted file shape (the synthetic-data generator's, `fixtures/_gen/transactions.mjs`):
 *
 * ```
 * { ownerMemberId, accounts: LinkedAccount[],
 *   pages: [{ requestCursor?, result: { added, modified, removed, nextCursor?, hasMore? } }]
 *   | transactions: Row[]           // flat list, paged by `pageSize` (default 12)
 *   , ...labels and anything else are ignored }
 * ```
 *
 * A page may also be `{ added, modified, removed }` directly. A row is either
 * the normalized `ProviderTransaction` shape or the Plaid wire shape
 * (`transaction_id`, `amount` as a double where positive = money out,
 * `iso_currency_code`, `pending_transaction_id`, ...); wire rows are converted at
 * this edge: absolute value to integer minor units, sign to `direction`
 * (negative = `credit`, i.e. a refund). Accounts may be normalized or wire
 * (`account_id`, `mask`, `type`, `subtype`, top-level `institution_name`).
 *
 * Invariants checked on load (a bad fixture throws; it is a programmer error):
 * - every row and account belongs to the file's owner (and the file name's member);
 * - `mask` is 2-4 digits (never a card number); amounts are non-negative safe integers;
 * - transaction ids are unique; `modified`/`removed` only reference earlier rows;
 * - a posted row with `pendingTransactionId` replaces a pending row of the same
 *   owner and account added earlier, and that pending id is listed in the same
 *   page's `removed` (added if the fixture omitted it, as Plaid does).
 */
import { TravError, parseDecimal } from '@trav/core';
import type { MemberId, Money } from '@trav/core';
import type {
  Counterparty,
  LinkedAccount,
  PersonalFinanceCategory,
  ProviderTransaction,
  TransactionLocation,
  TransactionsSyncResult,
} from '../../interfaces/transactions.js';
import {
  asArr,
  asObj,
  bool,
  deepFreeze,
  fixtureFail,
  fixtureJsonExists,
  optNum,
  optStr,
  readFixtureJson,
  str,
} from './fixtureFiles.js';
import type { Obj } from './fixtureFiles.js';

export interface TransactionsPage {
  readonly added: readonly ProviderTransaction[];
  readonly modified: readonly ProviderTransaction[];
  readonly removed: TransactionsSyncResult['removed'];
}

export interface MemberTransactionsFixture {
  readonly ownerMemberId: MemberId;
  readonly accounts: readonly LinkedAccount[];
  readonly pages: readonly TransactionsPage[];
}

/** Raw (unvalidated) page input accepted by `TransactionsLedgerBuilder.addPage`. */
export interface RawTransactionsPage {
  readonly added?: readonly unknown[];
  readonly modified?: readonly unknown[];
  readonly removed?: readonly unknown[];
}

const DEFAULT_PAGE_SIZE = 12;
const MASK_RE = /^\d{2,4}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const PAYMENT_CHANNELS = new Set(['online', 'in store', 'other']);
const COUNTERPARTY_TYPES = new Set([
  'merchant',
  'financial_institution',
  'payment_app',
  'marketplace',
  'payment_terminal',
  'income_source',
]);
const CONFIDENCE = new Set(['VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);

// ---------- accounts ----------

function parseAccount(raw: unknown, owner: MemberId, institution: string | undefined, where: string): LinkedAccount {
  const o = asObj(raw, where);
  const wire = 'account_id' in o;
  const accountId = str(o, wire ? 'account_id' : 'accountId', where);
  const declaredOwner = optStr(o, 'ownerMemberId', where);
  if (declaredOwner !== undefined && declaredOwner !== owner) {
    fixtureFail(where, `account ${accountId} belongs to ${declaredOwner}, not ${owner}`);
  }
  const mask = str(o, 'mask', where);
  if (!MASK_RE.test(mask)) fixtureFail(`${where}.mask`, 'must be 2-4 digits (never a card number)');
  const type = str(o, 'type', where);
  if (type !== 'credit' && type !== 'depository') fixtureFail(`${where}.type`, `unsupported "${type}"`);
  const institutionName =
    optStr(o, wire ? 'institution_name' : 'institutionName', where) ?? institution;
  if (institutionName === undefined || institutionName === '') {
    fixtureFail(where, 'missing institution name');
  }
  const subtype = optStr(o, 'subtype', where);
  return {
    accountId,
    ownerMemberId: owner,
    institutionName,
    mask,
    type,
    ...(subtype === undefined ? {} : { subtype }),
  };
}

// ---------- rows ----------

function parseMoney(o: Obj, where: string): Money {
  const m = asObj(o['amount'], `${where}.amount`);
  const amountMinor = m['amountMinor'];
  const currency = m['currency'];
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    fixtureFail(`${where}.amount.amountMinor`, 'expected a non-negative safe integer');
  }
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
    fixtureFail(`${where}.amount.currency`, 'expected an ISO 4217 code');
  }
  return { amountMinor, currency };
}

/** Plaid double (positive = money out) → absolute integer minor units + direction. */
export function plaidAmountToMoney(
  amount: number,
  currency: string,
): { readonly amount: Money; readonly direction: 'debit' | 'credit' } {
  if (!Number.isFinite(amount)) {
    throw new TravError('invalid_argument', 'Plaid amount must be a finite number');
  }
  if (!CURRENCY_RE.test(currency)) {
    throw new TravError('invalid_argument', `bad currency "${currency}"`);
  }
  const abs = Math.abs(amount);
  // Doubles like 23.4 are printed with enough digits to round-trip, then parsed
  // as a decimal string, so no float arithmetic touches the minor units.
  const fixed = abs.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const money = parseDecimal(fixed, currency);
  return { amount: money, direction: amount < 0 ? 'credit' : 'debit' };
}

function checkDate(v: string | undefined, where: string): void {
  if (v !== undefined && !DATE_RE.test(v)) fixtureFail(where, `expected YYYY-MM-DD, got "${v}"`);
}

function checkDateTime(v: string | undefined, where: string): void {
  if (v !== undefined && !DATETIME_RE.test(v)) fixtureFail(where, `expected ISO date-time with offset, got "${v}"`);
}

function parsePfc(v: unknown, wire: boolean, where: string): PersonalFinanceCategory | undefined {
  if (v === undefined || v === null) return undefined;
  const o = asObj(v, where);
  const level = optStr(o, wire ? 'confidence_level' : 'confidenceLevel', where);
  if (level !== undefined && !CONFIDENCE.has(level)) fixtureFail(where, `bad confidence "${level}"`);
  return {
    primary: str(o, 'primary', where),
    detailed: str(o, 'detailed', where),
    ...(level === undefined
      ? {}
      : { confidenceLevel: level as NonNullable<PersonalFinanceCategory['confidenceLevel']> }),
  };
}

function parseLocation(v: unknown, wire: boolean, where: string): TransactionLocation | undefined {
  if (v === undefined || v === null) return undefined;
  const o = asObj(v, where);
  const loc: Record<string, string | number> = {};
  const strKeys: readonly (readonly [keyof TransactionLocation, string])[] = [
    ['address', 'address'],
    ['city', 'city'],
    ['region', 'region'],
    ['postalCode', wire ? 'postal_code' : 'postalCode'],
    ['country', 'country'],
  ];
  for (const [key, src] of strKeys) {
    const s = optStr(o, src, where);
    if (s !== undefined) loc[key] = s;
  }
  for (const key of ['lat', 'lon'] as const) {
    const n = optNum(o, key, where);
    if (n !== undefined) loc[key] = n;
  }
  return Object.keys(loc).length === 0 ? undefined : (loc as TransactionLocation);
}

function parseCounterparties(v: unknown, wire: boolean, where: string): readonly Counterparty[] | undefined {
  if (v === undefined || v === null) return undefined;
  return asArr(v, where).map((c, i) => {
    const w = `${where}[${i}]`;
    const o = asObj(c, w);
    const type = str(o, 'type', w);
    if (!COUNTERPARTY_TYPES.has(type)) fixtureFail(w, `bad counterparty type "${type}"`);
    const entityId = optStr(o, wire ? 'entity_id' : 'entityId', w);
    const logoUrl = optStr(o, wire ? 'logo_url' : 'logoUrl', w);
    const website = optStr(o, 'website', w);
    return {
      name: str(o, 'name', w),
      type: type as Counterparty['type'],
      ...(entityId === undefined ? {} : { entityId }),
      ...(logoUrl === undefined ? {} : { logoUrl }),
      ...(website === undefined ? {} : { website }),
    };
  });
}

function parseRow(raw: unknown, owner: MemberId, where: string): ProviderTransaction {
  const o = asObj(raw, where);
  const wire = 'transaction_id' in o;
  const k = (camel: string, snake: string): string => (wire ? snake : camel);

  const declaredOwner = optStr(o, 'ownerMemberId', where);
  if (declaredOwner !== undefined && declaredOwner !== owner) {
    fixtureFail(where, `row belongs to ${declaredOwner}, not ${owner}`);
  }
  if (!wire && declaredOwner === undefined) fixtureFail(where, 'missing ownerMemberId');

  let amount: Money;
  let direction: 'debit' | 'credit';
  if (wire) {
    const n = optNum(o, 'amount', where);
    if (n === undefined) fixtureFail(`${where}.amount`, 'missing');
    const currency = str(o, 'iso_currency_code', where);
    ({ amount, direction } = plaidAmountToMoney(n, currency));
  } else {
    amount = parseMoney(o, where);
    const d = str(o, 'direction', where);
    if (d !== 'debit' && d !== 'credit') fixtureFail(`${where}.direction`, `bad "${d}"`);
    direction = d;
  }

  const date = str(o, 'date', where);
  checkDate(date, `${where}.date`);
  const authorizedDate = optStr(o, k('authorizedDate', 'authorized_date'), where);
  checkDate(authorizedDate, `${where}.authorizedDate`);
  const datetime = optStr(o, 'datetime', where);
  checkDateTime(datetime, `${where}.datetime`);
  const paymentChannel = str(o, k('paymentChannel', 'payment_channel'), where);
  if (!PAYMENT_CHANNELS.has(paymentChannel)) fixtureFail(where, `bad payment channel "${paymentChannel}"`);
  const pending = bool(o, 'pending', where);
  const pendingTransactionId = optStr(o, k('pendingTransactionId', 'pending_transaction_id'), where);
  if (pending && pendingTransactionId !== undefined) {
    fixtureFail(where, 'a pending row cannot replace another pending row');
  }
  const merchantName = optStr(o, k('merchantName', 'merchant_name'), where);
  const merchantEntityId = optStr(o, k('merchantEntityId', 'merchant_entity_id'), where);
  const logoUrl = optStr(o, k('logoUrl', 'logo_url'), where);
  const pfc = parsePfc(o[k('personalFinanceCategory', 'personal_finance_category')], wire, `${where}.pfc`);
  const location = parseLocation(o['location'], wire, `${where}.location`);
  const counterparties = parseCounterparties(o['counterparties'], wire, `${where}.counterparties`);

  return {
    transactionId: str(o, k('transactionId', 'transaction_id'), where),
    accountId: str(o, k('accountId', 'account_id'), where),
    ownerMemberId: owner,
    amount,
    direction,
    date,
    ...(authorizedDate === undefined ? {} : { authorizedDate }),
    ...(datetime === undefined ? {} : { datetime }),
    ...(merchantName === undefined ? {} : { merchantName }),
    ...(merchantEntityId === undefined ? {} : { merchantEntityId }),
    rawName: str(o, k('rawName', 'name'), where),
    pending,
    ...(pendingTransactionId === undefined ? {} : { pendingTransactionId }),
    paymentChannel: paymentChannel as ProviderTransaction['paymentChannel'],
    ...(pfc === undefined ? {} : { personalFinanceCategory: pfc }),
    ...(location === undefined ? {} : { location }),
    ...(counterparties === undefined ? {} : { counterparties }),
    ...(logoUrl === undefined ? {} : { logoUrl }),
  };
}

// ---------- stateful builder (fixture load and mock pushes share one rule set) ----------

/**
 * Accumulates one member's pages, enforcing the invariants above across pages.
 * Used by the loader and by the mock's `pushUpdate` control.
 */
export class TransactionsLedgerBuilder {
  readonly ownerMemberId: MemberId;
  readonly accounts: readonly LinkedAccount[];
  private readonly accountIds: ReadonlySet<string>;
  private readonly pagesInternal: TransactionsPage[] = [];
  /** Every id ever added (ids are never reused, even after removal). */
  private readonly everAdded = new Map<string, ProviderTransaction>();
  /** Ids added and not yet removed. */
  private readonly live = new Set<string>();

  constructor(ownerMemberId: MemberId, accounts: readonly LinkedAccount[]) {
    this.ownerMemberId = ownerMemberId;
    this.accounts = deepFreeze([...accounts]);
    const ids = new Set<string>();
    for (const a of accounts) {
      if (a.ownerMemberId !== ownerMemberId) fixtureFail('accounts', `account ${a.accountId} has another owner`);
      if (ids.has(a.accountId)) fixtureFail('accounts', `duplicate account ${a.accountId}`);
      ids.add(a.accountId);
    }
    this.accountIds = ids;
  }

  get pages(): readonly TransactionsPage[] {
    return this.pagesInternal;
  }

  /** Validates and appends a page. Throws `invalid_argument` without changing state on any violation. */
  addPage(raw: RawTransactionsPage, where = `page ${this.pagesInternal.length}`): TransactionsPage {
    const owner = this.ownerMemberId;
    const added = (raw.added ?? []).map((r, i) => parseRow(r, owner, `${where}.added[${i}]`));
    const modified = (raw.modified ?? []).map((r, i) => parseRow(r, owner, `${where}.modified[${i}]`));
    const removed = (raw.removed ?? []).map((r, i) => {
      const w = `${where}.removed[${i}]`;
      const o = asObj(r, w);
      const wire = 'transaction_id' in o;
      return {
        transactionId: str(o, wire ? 'transaction_id' : 'transactionId', w),
        accountId: str(o, wire ? 'account_id' : 'accountId', w),
      };
    });

    // Work on copies so a failing page leaves the builder untouched.
    const everAdded = new Map(this.everAdded);
    const live = new Set(this.live);

    for (const [i, tx] of added.entries()) {
      const w = `${where}.added[${i}] (${tx.transactionId})`;
      if (!this.accountIds.has(tx.accountId)) fixtureFail(w, `unknown account ${tx.accountId} for ${owner}`);
      if (everAdded.has(tx.transactionId)) fixtureFail(w, 'duplicate transaction id');
      if (tx.pendingTransactionId !== undefined) {
        const prior = everAdded.get(tx.pendingTransactionId);
        if (prior === undefined) fixtureFail(w, `replaces unknown pending ${tx.pendingTransactionId}`);
        if (!prior.pending) fixtureFail(w, `replaces ${tx.pendingTransactionId}, which is not pending`);
        if (prior.accountId !== tx.accountId) fixtureFail(w, 'replaces a pending row on another account');
        if (!removed.some((r) => r.transactionId === tx.pendingTransactionId)) {
          removed.push({ transactionId: tx.pendingTransactionId, accountId: tx.accountId });
        }
      }
      everAdded.set(tx.transactionId, tx);
      live.add(tx.transactionId);
    }
    for (const [i, tx] of modified.entries()) {
      const w = `${where}.modified[${i}] (${tx.transactionId})`;
      const prior = everAdded.get(tx.transactionId);
      if (prior === undefined || !live.has(tx.transactionId)) fixtureFail(w, 'modifies an unknown or removed row');
      if (prior.accountId !== tx.accountId) fixtureFail(w, 'cannot move a row to another account');
      everAdded.set(tx.transactionId, tx);
    }
    for (const [i, r] of removed.entries()) {
      const w = `${where}.removed[${i}] (${r.transactionId})`;
      const prior = everAdded.get(r.transactionId);
      if (prior === undefined || !live.has(r.transactionId)) fixtureFail(w, 'removes an unknown or already removed row');
      if (prior.accountId !== r.accountId) fixtureFail(w, 'account does not match the removed row');
      live.delete(r.transactionId);
    }

    const page: TransactionsPage = deepFreeze({ added, modified, removed });
    this.pagesInternal.push(page);
    for (const [id, tx] of everAdded) this.everAdded.set(id, tx);
    this.live.clear();
    for (const id of live) this.live.add(id);
    return page;
  }

  build(): MemberTransactionsFixture {
    return { ownerMemberId: this.ownerMemberId, accounts: this.accounts, pages: [...this.pagesInternal] };
  }
}

/**
 * Validates a parsed fixture file. `expectedOwner` (the member the file was
 * loaded for) must equal the file's `ownerMemberId`.
 */
export function parseTransactionsFixture(
  raw: unknown,
  expectedOwner?: MemberId,
  pageSize = DEFAULT_PAGE_SIZE,
): MemberTransactionsFixture {
  const o = asObj(raw, 'transactions');
  const owner = str(o, 'ownerMemberId', 'transactions');
  if (expectedOwner !== undefined && owner !== expectedOwner) {
    fixtureFail('transactions', `file for ${expectedOwner} declares owner ${owner}`);
  }
  const institution = optStr(o, 'institution_name', 'transactions') ?? optStr(o, 'institutionName', 'transactions');
  const accounts = asArr(o['accounts'], 'transactions.accounts').map((a, i) =>
    parseAccount(a, owner, institution, `transactions.accounts[${i}]`),
  );
  const builder = new TransactionsLedgerBuilder(owner, accounts);

  if (o['pages'] !== undefined) {
    asArr(o['pages'], 'transactions.pages').forEach((p, i) => {
      const po = asObj(p, `transactions.pages[${i}]`);
      const body = po['result'] === undefined ? po : asObj(po['result'], `transactions.pages[${i}].result`);
      builder.addPage(
        {
          added: body['added'] === undefined ? [] : asArr(body['added'], `pages[${i}].added`),
          modified: body['modified'] === undefined ? [] : asArr(body['modified'], `pages[${i}].modified`),
          removed: body['removed'] === undefined ? [] : asArr(body['removed'], `pages[${i}].removed`),
        },
        `transactions.pages[${i}]`,
      );
    });
  } else if (o['transactions'] !== undefined) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new TravError('invalid_argument', 'pageSize must be a positive integer');
    }
    const rows = asArr(o['transactions'], 'transactions.transactions');
    for (let i = 0; i < rows.length; i += pageSize) {
      builder.addPage({ added: rows.slice(i, i + pageSize) }, `transactions.transactions[${i}..]`);
    }
  } else {
    fixtureFail('transactions', 'expected "pages" or "transactions"');
  }
  return builder.build();
}

/**
 * Loads `fixtures/<dir...>/<memberId>.json`, or `undefined` if the member has
 * no file (nothing linked). `memberId` must be a safe path segment.
 */
export function loadTransactionsFixture(
  memberId: MemberId,
  dir: readonly string[] = ['transactions'],
): MemberTransactionsFixture | undefined {
  if (!fixtureJsonExists(dir, memberId)) return undefined;
  return parseTransactionsFixture(readFixtureJson(dir, memberId), memberId);
}

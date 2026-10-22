/**
 * The row-store contract both storage backends implement (T-005).
 *
 * Every repository in `./repositories.ts` is written ONCE against this small
 * interface, so the in-memory and `node:sqlite` stores cannot drift in their
 * semantics (duplicate rules, ownership checks, ordering, filters). A backend
 * only stores rows: a primary key, a few indexed columns derived from the row
 * by the table's `TableSpec`, and the row itself serialized as JSON.
 *
 * Ordering contract: `find` returns rows in insertion order; an upsert of an
 * existing key keeps the row's original position (SQLite: `seq` is kept by
 * `ON CONFLICT DO UPDATE`; memory: `Map.set` on an existing key).
 *
 * Both backends round-trip rows through JSON, so `undefined` fields are dropped
 * and callers never share object identity with stored rows.
 */

/** Values of indexed columns. `null` never matches a unique constraint. */
export type ColumnValue = string | number | null;

export interface TableSpec<T> {
  /** SQL table name; also the key used in per-table deletion counts. */
  readonly name: TableName;
  readonly key: (row: T) => string;
  /** Indexed columns (snake_case), each derived from the row. */
  readonly columns: Readonly<Record<string, (row: T) => ColumnValue>>;
  /** Unique column groups. Enforced by the backend; a violation throws `TravError('duplicate')`. */
  readonly unique?: readonly (readonly string[])[];
}

export type Where = Readonly<Record<string, ColumnValue>>;

export interface RowTable<T> {
  get(key: string): T | undefined;
  /** Throws `TravError('duplicate')` if the key or a unique column group already exists. */
  insert(row: T): void;
  /** Insert or replace by key; unique groups are still enforced against OTHER rows. */
  upsert(row: T): void;
  /** Rows matching every column in `where` (equality), in insertion order. `{}` ⇒ all rows. */
  find(where: Where): T[];
  /** The most recently inserted row matching `where`. */
  last(where: Where): T | undefined;
  count(where: Where): number;
  /** Returns the number of rows deleted. `{}` deletes nothing (refuses to wipe a table). */
  deleteWhere(where: Where): number;
  /** Returns whether a row was deleted. */
  deleteKey(key: string): boolean;
}

export interface Backend {
  table<T>(spec: TableSpec<T>): RowTable<T>;
  /**
   * Runs `fn` atomically: if it throws, every write made inside it is undone.
   * Nested calls are savepoints. Synchronous by design (D-010).
   */
  transaction<R>(fn: () => R): R;
  close(): void;
}

/** Every table both backends must provide (the SQLite migrations create exactly these). */
export const GROUP_TABLES = [
  'groups',
  'members',
  'trips',
  'activities',
  'attendance',
  'expenses',
  'ledger_entries',
  'proposals',
  'decisions',
  'grants',
  'bookings',
  'audit_events',
  'group_memory',
] as const;

export const PRIVATE_TABLES = [
  'card_transactions',
  'email_receipts',
  'receipt_scans',
  'pending_private_items',
  'consent',
  'member_prefs',
  'member_memory',
  'ticket_artifacts',
] as const;

export type GroupTableName = (typeof GROUP_TABLES)[number];
export type PrivateTableName = (typeof PRIVATE_TABLES)[number];
export type TableName = GroupTableName | PrivateTableName;

export function matchesWhere(
  columns: Readonly<Record<string, ColumnValue>>,
  where: Where,
): boolean {
  for (const [col, value] of Object.entries(where)) {
    if (columns[col] !== value) return false;
  }
  return true;
}

export function columnValues<T>(spec: TableSpec<T>, row: T): Readonly<Record<string, ColumnValue>> {
  const out: Record<string, ColumnValue> = {};
  for (const [col, extract] of Object.entries(spec.columns)) {
    out[col] = extract(row);
  }
  return out;
}

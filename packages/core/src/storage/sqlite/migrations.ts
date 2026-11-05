/**
 * SQLite schema, applied on open (T-005). `PRAGMA user_version` records the
 * last applied migration; migrations are append-only (never edit a shipped
 * one, add the next). Every table: `seq` (insertion order), `pk` (the row's
 * id), indexed columns from `../shared/schema.ts`, and the row as JSON.
 * `sqlite.test.ts` checks these columns match the table specs.
 */

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

const table = (name: string, columns: readonly string[]): string =>
  [
    `CREATE TABLE ${name} (`,
    '  seq INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  pk TEXT NOT NULL UNIQUE,',
    ...columns.map((c) => `  ${c} TEXT,`),
    '  json TEXT NOT NULL',
    ');',
    ...columns.map((c) => `CREATE INDEX ${name}_ix_${c} ON ${name}(${c});`),
  ].join('\n');

const unique = (name: string, columns: readonly string[]): string =>
  `CREATE UNIQUE INDEX ${name}_ux_${columns.join('_')} ON ${name}(${columns.join(', ')});`;

const V1 = [
  // ---------- GroupStore ----------
  table('groups', ['conversation_id']),
  unique('groups', ['conversation_id']),
  table('members', ['group_id', 'sender_id']),
  unique('members', ['group_id', 'sender_id']),
  table('trips', ['group_id']),
  table('activities', ['trip_id', 'group_id']),
  table('attendance', ['activity_id', 'member_id']),
  table('expenses', ['trip_id', 'group_id', 'source_key']),
  unique('expenses', ['source_key']),
  table('ledger_entries', ['expense_id', 'trip_id']),
  table('proposals', ['group_id', 'trip_id', 'status']),
  table('decisions', ['proposal_id']),
  table('grants', ['proposal_id']),
  table('bookings', ['group_id', 'trip_id', 'proposal_id', 'idempotency_key']),
  unique('bookings', ['idempotency_key']),
  // Append-only (SAFETY §2.2): the only UPDATE ever issued is the §2.9 payload
  // redaction, which rewrites `json` and keeps the stored hash.
  table('audit_events', ['group_id', 'trip_id', 'type', 'visibility', 'proposal_id', 'booking_id']),
  table('group_memory', ['group_id', 'source_trip_id']),
  // ---------- PrivateStore (every row has owner_member_id) ----------
  table('card_transactions', ['owner_member_id', 'group_id', 'trip_id', 'provider_transaction_id']),
  unique('card_transactions', ['owner_member_id', 'provider_transaction_id']),
  table('email_receipts', ['owner_member_id', 'group_id', 'trip_id']),
  table('receipt_scans', ['owner_member_id', 'group_id', 'trip_id']),
  table('pending_private_items', [
    'owner_member_id',
    'group_id',
    'trip_id',
    'status',
    'source_item_id',
  ]),
  table('consent', ['owner_member_id', 'group_id']),
  table('member_prefs', ['owner_member_id']),
  table('member_memory', ['owner_member_id', 'group_id', 'source_trip_id']),
  table('ticket_artifacts', ['owner_member_id', 'trip_id', 'booking_id']),
].join('\n\n');

/** T-141 (D-034): settle-up transfers members said they paid. */
const V2 = [
  table('settlements', ['trip_id', 'group_id', 'source_key']),
  unique('settlements', ['source_key']),
].join('\n\n');

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

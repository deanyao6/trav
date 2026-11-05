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

/** T-166 (D-043): members' payment apps, favourite and handles (PrivateStore). */
const V3 = table('payment_profiles', ['owner_member_id']);

/**
 * T-185 (D-054): the agent runtime's state survives a restart. Ids and
 * group-lane state in GroupStore tables; a member's DM-lane state in the
 * owner-scoped `private_runtime_state`.
 */
const V4 = [
  table('runtime_state', ['state_ns', 'group_id']),
  table('seen_keys', ['state_ns']),
  table('scheduled_jobs', ['group_id', 'trip_id']),
  table('private_runtime_state', ['owner_member_id', 'state_ns', 'group_id']),
].join('\n\n');

/**
 * Rebuilds a table with a new column list (migrations are append-only and V4
 * has shipped). Rows keep their `seq` (so first-put order survives), `pk` and
 * `json`; `carried` columns are copied, the new ones start NULL.
 */
const rebuild = (name: string, columns: readonly string[], carried: readonly string[]): string =>
  [
    `ALTER TABLE ${name} RENAME TO ${name}__old;`,
    ...carried.map((c) => `DROP INDEX ${name}_ix_${c};`),
    table(name, columns),
    `INSERT INTO ${name} (seq, pk, ${carried.join(', ')}, json)`,
    `  SELECT seq, pk, ${carried.join(', ')}, json FROM ${name}__old ORDER BY seq;`,
    `DROP TABLE ${name}__old;`,
  ].join('\n');

/**
 * T-185 r1 #1 (D-054): runtime state entries carry the trip they belong to,
 * so "forget this trip" deletes them with it. Existing rows get NULL (not
 * tied to a trip).
 */
const V5 = [
  rebuild('runtime_state', ['state_ns', 'group_id', 'trip_id'], ['state_ns', 'group_id']),
  rebuild(
    'private_runtime_state',
    ['owner_member_id', 'state_ns', 'group_id', 'trip_id'],
    ['owner_member_id', 'state_ns', 'group_id'],
  ),
].join('\n\n');

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
  { version: 3, sql: V3 },
  { version: 4, sql: V4 },
  { version: 5, sql: V5 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

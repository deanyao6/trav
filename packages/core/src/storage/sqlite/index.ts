/**
 * `node:sqlite` `Stores` (T-005; CLAUDE.md §3: Node's built-in `DatabaseSync`,
 * no native dependency). Synchronous like the repository interfaces (D-010).
 *
 * The file lives under `.trav/` (gitignored); tests use `':memory:'`. The
 * schema is migrated on open (`./migrations.ts`).
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoreFactoryOptions, Stores } from '../../repositories.js';
import { TravError } from '../../errors.js';
import type { Backend, ColumnValue, RowTable, TableSpec, Where } from '../shared/backend.js';
import { columnValues } from '../shared/backend.js';
import type { StoreDeps } from '../shared/stores.js';
import { createStoresOnBackend } from '../shared/stores.js';
import { closedError } from '../shared/util.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.js';

export const SQLITE_MEMORY_PATH = ':memory:';

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new TravError('invariant_violation', 'bad SQL identifier', { name });
  }
  return name;
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // packages/core/src/storage/sqlite → repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
}

/** `<repo>/.trav/trav.sqlite` (gitignored). */
export function defaultSqlitePath(): string {
  return join(repoRoot(), '.trav', 'trav.sqlite');
}

/**
 * `':memory:'` passes through; anything else must sit inside a `.trav`
 * directory (StoreFactoryOptions), which is created if missing.
 */
export function resolveSqlitePath(path: string | undefined): string {
  if (path === SQLITE_MEMORY_PATH) return path;
  const resolved = resolve(path ?? defaultSqlitePath());
  if (!dirname(resolved).split(sep).includes('.trav')) {
    throw new TravError(
      'invalid_argument',
      "sqlite path must be ':memory:' or under a .trav/ directory",
      {
        path: resolved,
      },
    );
  }
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new TravError('invariant_violation', 'database schema is newer than this build', {
      current,
      latest: LATEST_SCHEMA_VERSION,
    });
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${String(migration.version)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function createSqliteBackend(path?: string): Backend {
  const file = resolveSqlitePath(path);
  const db = new DatabaseSync(file);
  if (file !== SQLITE_MEMORY_PATH) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 2000');
  }
  migrate(db);

  const statements = new Map<string, StatementSync>();
  let closed = false;
  let depth = 0;

  const stmt = (sql: string): StatementSync => {
    if (closed) throw closedError();
    let s = statements.get(sql);
    if (s === undefined) {
      s = db.prepare(sql);
      statements.set(sql, s);
    }
    return s;
  };

  const whereSql = (where: Where): { sql: string; params: SQLInputValue[] } => {
    const entries = Object.entries(where);
    if (entries.length === 0) return { sql: '', params: [] };
    return {
      // `IS` so a null condition matches null columns (`=` never does).
      sql: ` WHERE ${entries.map(([col]) => `${ident(col)} IS ?`).join(' AND ')}`,
      params: entries.map(([, v]) => v),
    };
  };

  return {
    table<T>(spec: TableSpec<T>): RowTable<T> {
      const name = ident(spec.name);
      const cols = Object.keys(spec.columns).map(ident);
      const insertCols = ['pk', ...cols, 'json'];
      const placeholders = insertCols.map(() => '?').join(', ');
      const insertSql = `INSERT INTO ${name} (${insertCols.join(', ')}) VALUES (${placeholders})`;
      const upsertSql =
        `${insertSql} ON CONFLICT(pk) DO UPDATE SET ` +
        [...cols, 'json'].map((c) => `${c} = excluded.${c}`).join(', ');

      const write = (sql: string, row: T): void => {
        const json = JSON.stringify(row);
        const values = columnValues(spec, JSON.parse(json) as T);
        const params: SQLInputValue[] = [
          spec.key(row),
          ...cols.map((c): ColumnValue => values[c] ?? null),
          json,
        ];
        try {
          stmt(sql).run(...params);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new TravError('duplicate', `unique constraint on ${spec.name}`, {
              table: spec.name,
            });
          }
          throw error;
        }
      };

      const parse = (row: Record<string, unknown> | undefined): T | undefined =>
        row === undefined ? undefined : (JSON.parse(String(row.json)) as T);

      return {
        get: (key) => parse(stmt(`SELECT json FROM ${name} WHERE pk = ?`).get(key)),
        insert: (row) => write(insertSql, row),
        upsert: (row) => write(upsertSql, row),
        find(where) {
          const w = whereSql(where);
          return stmt(`SELECT json FROM ${name}${w.sql} ORDER BY seq`)
            .all(...w.params)
            .map((r) => JSON.parse(String(r.json)) as T);
        },
        last(where) {
          const w = whereSql(where);
          return parse(
            stmt(`SELECT json FROM ${name}${w.sql} ORDER BY seq DESC LIMIT 1`).get(...w.params),
          );
        },
        first(where) {
          const w = whereSql(where);
          return parse(
            stmt(`SELECT json FROM ${name}${w.sql} ORDER BY seq ASC LIMIT 1`).get(...w.params),
          );
        },
        count(where) {
          const w = whereSql(where);
          return Number(stmt(`SELECT COUNT(*) AS n FROM ${name}${w.sql}`).get(...w.params)?.n ?? 0);
        },
        deleteWhere(where) {
          if (Object.keys(where).length === 0) {
            throw new TravError('invariant_violation', 'deleteWhere needs a condition', {
              table: spec.name,
            });
          }
          const w = whereSql(where);
          return Number(stmt(`DELETE FROM ${name}${w.sql}`).run(...w.params).changes);
        },
        deleteKey: (key) => Number(stmt(`DELETE FROM ${name} WHERE pk = ?`).run(key).changes) > 0,
      };
    },

    transaction<R>(fn: () => R): R {
      if (closed) throw closedError();
      const savepoint = `sp_${String(depth)}`;
      db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        depth -= 1;
        if (depth === 0) {
          db.exec('ROLLBACK');
        } else {
          db.exec(`ROLLBACK TO ${savepoint}`);
          db.exec(`RELEASE ${savepoint}`);
        }
        throw error;
      }
    },

    close() {
      if (closed) return;
      closed = true;
      statements.clear();
      db.close();
    },
  };
}

/** `sqlitePath`: `':memory:'` or a path under `.trav/`; default `<repo>/.trav/trav.sqlite`. */
export type SqliteStoreOptions = StoreDeps & StoreFactoryOptions;

/** SQLite-backed stores (the simulator and CLI default when persisting). */
export function createSqliteStores(opts: SqliteStoreOptions): Stores {
  return createStoresOnBackend(createSqliteBackend(opts.sqlitePath), opts);
}

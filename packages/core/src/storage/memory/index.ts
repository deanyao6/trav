/**
 * In-memory `Stores` (T-005). Rows are kept as JSON strings, exactly like the
 * SQLite backend, so both behave the same under the shared repository suite
 * (`../repository.suite.ts`). Transactions use an undo log: a throw inside
 * `transaction(fn)` restores every row written inside it.
 */
import type { Stores } from '../../repositories.js';
import { TravError } from '../../errors.js';
import type {
  Backend,
  ColumnValue,
  RowTable,
  TableName,
  TableSpec,
  Where,
} from '../shared/backend.js';
import { columnValues, matchesWhere } from '../shared/backend.js';
import type { StoreDeps } from '../shared/stores.js';
import { createStoresOnBackend } from '../shared/stores.js';
import { closedError } from '../shared/util.js';

interface StoredRow {
  readonly seq: number;
  readonly cols: Readonly<Record<string, ColumnValue>>;
  readonly json: string;
}

type Undo = () => void;

export function createMemoryBackend(): Backend {
  const tables = new Map<TableName, Map<string, StoredRow>>();
  const undoLog: Undo[] = [];
  let depth = 0;
  let nextSeq = 1;
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw closedError();
  };

  const rowsOf = (name: TableName): Map<string, StoredRow> => {
    let rows = tables.get(name);
    if (rows === undefined) {
      rows = new Map();
      tables.set(name, rows);
    }
    return rows;
  };

  const recordUndo = (undo: Undo): void => {
    if (depth > 0) undoLog.push(undo);
  };

  const setRow = (rows: Map<string, StoredRow>, key: string, row: StoredRow): void => {
    const before = rows.get(key);
    rows.set(key, row);
    recordUndo(() => {
      if (before === undefined) rows.delete(key);
      else rows.set(key, before);
    });
  };

  const removeRow = (rows: Map<string, StoredRow>, key: string): boolean => {
    const before = rows.get(key);
    if (before === undefined) return false;
    rows.delete(key);
    recordUndo(() => rows.set(key, before));
    return true;
  };

  const inSeqOrder = (rows: Iterable<[string, StoredRow]>): [string, StoredRow][] =>
    [...rows].sort((a, b) => a[1].seq - b[1].seq);

  return {
    table<T>(spec: TableSpec<T>): RowTable<T> {
      const rows = rowsOf(spec.name);

      const checkUnique = (key: string, cols: Readonly<Record<string, ColumnValue>>): void => {
        for (const group of spec.unique ?? []) {
          if (group.some((col) => cols[col] === null || cols[col] === undefined)) continue;
          for (const [otherKey, other] of rows) {
            if (otherKey !== key && group.every((col) => other.cols[col] === cols[col])) {
              throw new TravError('duplicate', `unique constraint on ${spec.name}`, {
                table: spec.name,
                columns: group,
              });
            }
          }
        }
      };

      const write = (row: T, mode: 'insert' | 'upsert'): void => {
        ensureOpen();
        const key = spec.key(row);
        const json = JSON.stringify(row);
        const cols = columnValues(spec, JSON.parse(json) as T);
        const existing = rows.get(key);
        if (mode === 'insert' && existing !== undefined) {
          throw new TravError('duplicate', `primary key on ${spec.name}`, { table: spec.name });
        }
        checkUnique(key, cols);
        setRow(rows, key, { seq: existing?.seq ?? nextSeq++, cols, json });
      };

      const matching = (where: Where): [string, StoredRow][] => {
        ensureOpen();
        return inSeqOrder([...rows].filter(([, r]) => matchesWhere(r.cols, where)));
      };

      return {
        get(key) {
          ensureOpen();
          const row = rows.get(key);
          return row === undefined ? undefined : (JSON.parse(row.json) as T);
        },
        insert: (row) => write(row, 'insert'),
        upsert: (row) => write(row, 'upsert'),
        find: (where) => matching(where).map(([, r]) => JSON.parse(r.json) as T),
        last(where) {
          ensureOpen();
          let best: StoredRow | undefined;
          for (const row of rows.values()) {
            if (matchesWhere(row.cols, where) && (best === undefined || row.seq > best.seq)) {
              best = row;
            }
          }
          return best === undefined ? undefined : (JSON.parse(best.json) as T);
        },
        count: (where) => matching(where).length,
        deleteWhere(where) {
          if (Object.keys(where).length === 0) {
            throw new TravError('invariant_violation', 'deleteWhere needs a condition', {
              table: spec.name,
            });
          }
          let n = 0;
          for (const [key] of matching(where)) if (removeRow(rows, key)) n += 1;
          return n;
        },
        deleteKey(key) {
          ensureOpen();
          return removeRow(rows, key);
        },
      };
    },

    transaction<R>(fn: () => R): R {
      ensureOpen();
      const mark = undoLog.length;
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        if (depth === 0) undoLog.length = 0;
        return result;
      } catch (error) {
        while (undoLog.length > mark) undoLog.pop()?.();
        depth -= 1;
        throw error;
      }
    },

    close() {
      closed = true;
      tables.clear();
    },
  };
}

/** In-memory stores for tests, evals and the offline demo. */
export function createMemoryStores(deps: StoreDeps): Stores {
  return createStoresOnBackend(createMemoryBackend(), deps);
}

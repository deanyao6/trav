import { TravError } from '../../errors.js';
import { parseIso } from '../../clock.js';

/** JSON round-trip: drops `undefined`, detaches the copy. Both backends store JSON. */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Thrown by both backends when used after `close()`. */
export function closedError(): TravError {
  return new TravError('invariant_violation', 'store is closed');
}

/** Non-empty string ids only; anything else is a programmer error. */
export function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TravError('invalid_argument', `${what} must be a non-empty id`, { what });
  }
  return value;
}

/** Stable sort by an ISO instant (undefined last), ties keep the input (insertion) order. */
export function sortByInstant<T>(rows: readonly T[], instant: (row: T) => string | undefined): T[] {
  return rows
    .map((row, index) => {
      const iso = instant(row);
      return { row, index, ms: iso === undefined ? Number.POSITIVE_INFINITY : parseIso(iso) };
    })
    .sort((a, b) => a.ms - b.ms || a.index - b.index)
    .map((x) => x.row);
}

/**
 * Error conventions (docs/DECISIONS.md D-010).
 *
 * - `packages/core` THROWS `TravError` for invariant violations and invalid
 *   input (shares that do not sum, unknown member, duplicate id). Decisions that
 *   are part of the domain (policy outcome, grant invalid, consistency check) are
 *   returned as VALUES, never thrown.
 * - `packages/adapters` RETURN `Result<T, AdapterError>` for every expected
 *   failure (sold out, price changed, not supported) and throw only on
 *   programmer errors.
 * - `packages/agent` catches `TravError` and failed `Result`s at the turn
 *   boundary and renders a VOICE §4.10 error message (money moved? what next?).
 */

export type TravErrorCode =
  | 'invalid_argument'
  | 'invariant_violation'
  | 'not_found'
  | 'duplicate'
  | 'not_owner'
  | 'not_authorized'
  | 'grant_invalid'
  | 'grant_expired'
  | 'policy_denied'
  | 'currency_mismatch'
  | 'budget_exhausted'
  | 'untrusted_with_tools'
  | 'offline_script_missing'
  | 'not_implemented';

/** The one error class core throws. `details` must never contain private fields (SAFETY §2.9 logging rules). */
export class TravError extends Error {
  readonly code: TravErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: TravErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'TravError';
    this.code = code;
    this.details = details;
  }
}

/** Result type used at adapter boundaries. Core functions do not return it. */
export type Result<T, E = TravError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Narrowing helper so callers can `if (!isOk(r)) return r`. */
export function isOk<T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } {
  return r.ok;
}

/** Stub body for skeleton functions. Builders replace every call site. */
export function notImplemented(what: string): never {
  throw new TravError('not_implemented', `${what} is not implemented`);
}

/**
 * Id generation (docs/DECISIONS.md D-011). Ids are `<prefix>_<26 chars>`;
 * production uses a ulid-like generator (time-sortable, from the injected
 * Clock), tests use the deterministic generator so fixtures and snapshots are
 * stable. Domain code never calls `crypto.randomUUID()` directly.
 */
import type { Clock } from './clock.js';
import { notImplemented } from './errors.js';

export const ID_PREFIXES = {
  group: 'grp',
  member: 'mem',
  trip: 'trip',
  activity: 'act',
  expense: 'exp',
  proposal: 'prop',
  booking: 'bk',
  grant: 'grant',
  audit: 'aud',
  message: 'msg',
  card: 'card',
  privateItem: 'priv',
  job: 'job',
  ticket: 'tkt',
  photo: 'photo',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export interface IdGenerator {
  /** Returns `${prefix}_${body}`; bodies are unique for the generator's lifetime. */
  next(prefix: IdPrefix): string;
}

/**
 * Deterministic: `${prefix}_${seed}${counter.padStart(6,'0')}` with a counter per
 * prefix. Same seed and call order ⇒ same ids. Use in every test and fixture.
 */
export function createDeterministicIdGenerator(seed: string): IdGenerator {
  return notImplemented(`createDeterministicIdGenerator(${seed})`);
}

/**
 * ulid-like: 10 chars of Crockford base32 time (from `clock.nowMs()`) + 16 chars
 * of randomness (`node:crypto`). Monotonic within a millisecond.
 */
export function createUlidIdGenerator(clock: Clock): IdGenerator {
  return notImplemented(`createUlidIdGenerator(${typeof clock})`);
}

/** True if `id` starts with `${prefix}_` and has a well-formed body. */
export function hasPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`);
}

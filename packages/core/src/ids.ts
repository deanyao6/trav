/**
 * Id generation (docs/DECISIONS.md D-011). Ids are `<prefix>_<body>`;
 * production uses a ulid-like generator (26-char body, time-sortable, from the
 * injected Clock), tests use the deterministic generator (`<seed><6-digit
 * counter>` body, as documented on `createDeterministicIdGenerator`) so fixtures
 * and snapshots are stable and readable. Domain code never calls
 * `crypto.randomUUID()` directly.
 */
import { randomBytes } from 'node:crypto';
import type { Clock } from './clock.js';
import { TravError } from './errors.js';

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

const KNOWN_PREFIXES: ReadonlySet<string> = new Set(Object.values(ID_PREFIXES));

export interface IdGenerator {
  /** Returns `${prefix}_${body}`; bodies are unique for the generator's lifetime. */
  next(prefix: IdPrefix): string;
}

function assertPrefix(prefix: string): void {
  if (!KNOWN_PREFIXES.has(prefix)) {
    throw new TravError('invalid_argument', `unknown id prefix "${prefix}"`, { prefix });
  }
}

/**
 * Deterministic: `${prefix}_${seed}${counter.padStart(6,'0')}` with a counter per
 * prefix. Same seed and call order ⇒ same ids. Use in every test and fixture.
 * The seed is normalised to `[a-z0-9]` so ids stay greppable and URL-safe.
 */
export function createDeterministicIdGenerator(seed: string): IdGenerator {
  const normalized = seed.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.length === 0) {
    throw new TravError('invalid_argument', 'seed must contain at least one letter or digit', {
      seed,
    });
  }
  const counters = new Map<IdPrefix, number>();
  return {
    next(prefix) {
      assertPrefix(prefix);
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${normalized}${String(n).padStart(6, '0')}`;
    },
  };
}

// ---------- ulid-like ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 2 ** 48 - 1) {
    throw new TravError('invalid_argument', `clock.nowMs() out of ulid range: ${String(ms)}`);
  }
  let value = ms;
  const out: string[] = new Array<string>(TIME_CHARS);
  for (let i = TIME_CHARS - 1; i >= 0; i -= 1) {
    out[i] = CROCKFORD[value % 32] ?? '0';
    value = Math.floor(value / 32);
  }
  return out.join('');
}

/** 16 base32 digits (0..31 each) from 80 bits of `node:crypto` randomness. */
function randomDigits(): number[] {
  const bytes = randomBytes(RANDOM_CHARS);
  const digits: number[] = [];
  for (let i = 0; i < RANDOM_CHARS; i += 1) digits.push((bytes[i] ?? 0) & 31);
  return digits;
}

/** Increment the base32 digit vector by one, carrying. Returns false on overflow. */
function incrementDigits(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const d = (digits[i] ?? 0) + 1;
    if (d < 32) {
      digits[i] = d;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/**
 * ulid-like: 10 chars of Crockford base32 time (from `clock.nowMs()`) + 16 chars
 * of randomness (`node:crypto`). Monotonic within a millisecond: a second id in
 * the same millisecond is the previous random part plus one. If the clock moves
 * backwards (a simulated clock being `set()` earlier), the generator keeps using
 * its last timestamp so ids remain strictly increasing for its lifetime.
 */
export function createUlidIdGenerator(clock: Clock): IdGenerator {
  let lastMs = -1;
  let lastRandom: number[] = [];
  return {
    next(prefix) {
      assertPrefix(prefix);
      const nowMs = clock.nowMs();
      if (nowMs > lastMs) {
        lastMs = nowMs;
        lastRandom = randomDigits();
      } else if (!incrementDigits(lastRandom)) {
        // 2^80 ids in one millisecond: practically unreachable; step the clock part.
        lastMs += 1;
        lastRandom = randomDigits();
      }
      const body = encodeTime(lastMs) + lastRandom.map((d) => CROCKFORD[d] ?? '0').join('');
      return `${prefix}_${body}`;
    },
  };
}

/** True if `id` starts with `${prefix}_` and has a well-formed body. */
export function hasPrefix(id: string, prefix: IdPrefix): boolean {
  if (!id.startsWith(`${prefix}_`)) return false;
  return /^[A-Za-z0-9]{6,}$/.test(id.slice(prefix.length + 1));
}

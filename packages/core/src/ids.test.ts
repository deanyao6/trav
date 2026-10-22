import { describe, expect, it } from 'vitest';
import { createSimulatedClock, fixedClock } from './clock.js';
import { TravError } from './errors.js';
import {
  ID_PREFIXES,
  createDeterministicIdGenerator,
  createUlidIdGenerator,
  hasPrefix,
} from './ids.js';

const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('createDeterministicIdGenerator', () => {
  it('produces `${prefix}_${seed}${counter padded to 6}` with one counter per prefix', () => {
    const ids = createDeterministicIdGenerator('bcn');
    expect(ids.next('mem')).toBe('mem_bcn000001');
    expect(ids.next('mem')).toBe('mem_bcn000002');
    expect(ids.next('exp')).toBe('exp_bcn000001');
    expect(ids.next('mem')).toBe('mem_bcn000003');
  });

  it('is stable: the same seed and call order produce the same ids', () => {
    const calls = ['grp', 'mem', 'mem', 'trip', 'exp', 'exp', 'bk'] as const;
    const a = createDeterministicIdGenerator('barcelona');
    const b = createDeterministicIdGenerator('barcelona');
    expect(calls.map((p) => a.next(p))).toEqual(calls.map((p) => b.next(p)));
  });

  it('normalises the seed to [a-z0-9] and rejects an empty seed', () => {
    expect(createDeterministicIdGenerator('Lisbon 2026!').next('trip')).toBe(
      'trip_lisbon2026000001',
    );
    expect(() => createDeterministicIdGenerator('---')).toThrow(TravError);
  });

  it('never repeats within its lifetime', () => {
    const ids = createDeterministicIdGenerator('x');
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(ids.next(i % 2 === 0 ? 'msg' : 'card'));
    expect(seen.size).toBe(2000);
  });

  it('rejects unknown prefixes at runtime', () => {
    const ids = createDeterministicIdGenerator('x');
    expect(() => ids.next('nope' as 'grp')).toThrow(TravError);
  });

  it('every id passes hasPrefix for its own prefix only', () => {
    const ids = createDeterministicIdGenerator('bcn');
    for (const prefix of Object.values(ID_PREFIXES)) {
      const id = ids.next(prefix);
      expect(hasPrefix(id, prefix)).toBe(true);
      expect(hasPrefix(id, prefix === 'grp' ? 'mem' : 'grp')).toBe(false);
    }
  });
});

describe('createUlidIdGenerator', () => {
  it('returns prefix + 26 Crockford base32 chars whose first 10 encode the clock time', () => {
    const clock = fixedClock('2026-03-14T21:40:00+01:00');
    const ids = createUlidIdGenerator(clock);
    const id = ids.next('bk');
    expect(id.startsWith('bk_')).toBe(true);
    const body = id.slice(3);
    expect(body).toMatch(CROCKFORD_RE);
    expect(hasPrefix(id, 'bk')).toBe(true);

    // Decode the time part and compare with clock.nowMs().
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let decoded = 0;
    for (const ch of body.slice(0, 10)) decoded = decoded * 32 + alphabet.indexOf(ch);
    expect(decoded).toBe(clock.nowMs());
  });

  it('is monotonic within one millisecond and across time', () => {
    const clock = createSimulatedClock('2026-03-14T21:40:00+01:00');
    const ids = createUlidIdGenerator(clock);
    const first = ids.next('msg');
    const second = ids.next('msg');
    const third = ids.next('msg');
    expect(first.slice(0, 14)).toBe(second.slice(0, 14)); // same time part
    expect(second > first).toBe(true);
    expect(third > second).toBe(true);
    clock.advanceMs(1);
    const later = ids.next('msg');
    expect(later > third).toBe(true);
    expect(later.slice(4, 14)).not.toBe(third.slice(4, 14));
  });

  it('keeps increasing even when the clock is set backwards', () => {
    const clock = createSimulatedClock('2026-03-14T21:40:00+01:00');
    const ids = createUlidIdGenerator(clock);
    const a = ids.next('aud');
    clock.set('2026-03-14T20:00:00+01:00');
    const b = ids.next('aud');
    expect(b > a).toBe(true);
  });

  it('never repeats in a burst at a fixed instant', () => {
    const ids = createUlidIdGenerator(fixedClock('2026-03-14T21:40:00+01:00'));
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) seen.add(ids.next('card'));
    expect(seen.size).toBe(5000);
  });

  it('differs across generators (randomness comes from node:crypto)', () => {
    const clock = fixedClock('2026-03-14T21:40:00+01:00');
    const a = createUlidIdGenerator(clock).next('grp');
    const b = createUlidIdGenerator(clock).next('grp');
    expect(a).not.toBe(b);
  });
});

describe('hasPrefix', () => {
  it('requires the prefix, the underscore and an alphanumeric body of 6+ chars', () => {
    expect(hasPrefix('grp_abc123', 'grp')).toBe(true);
    expect(hasPrefix('grp_abc', 'grp')).toBe(false);
    expect(hasPrefix('grp_', 'grp')).toBe(false);
    expect(hasPrefix('grpabc123', 'grp')).toBe(false);
    expect(hasPrefix('mem_abc123', 'grp')).toBe(false);
    expect(hasPrefix('grp_abc-123', 'grp')).toBe(false);
  });
});

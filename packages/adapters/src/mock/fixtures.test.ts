import { TravError } from '@trav/core';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_SEGMENT_RE,
  fixtureExists,
  isSafeFixtureSegment,
  listFixtures,
  loadFixture,
  loadFixtureText,
} from './fixtures.js';

/**
 * Segment validation for the adapters' one fixture loader (T-059). Every
 * segment (directory parts and the file name) is checked on its own, so a
 * member id or fixture name can never walk out of `<repo>/fixtures`.
 */
const REJECTED: [string, unknown][] = [
  ['parent dir', '..'],
  ['absolute path', '/abs'],
  ['embedded slash', 'a/b'],
  ['uppercase', 'Barcelona'],
  ['hidden file', '.hidden'],
  ['empty', ''],
  ['non-string', 42],
  ['101 characters', 'a'.repeat(101)],
  ['backslash', 'a\\b'],
];

function expectInvalid(call: () => unknown): void {
  let thrown: unknown;
  try {
    call();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(TravError);
  expect((thrown as TravError).code).toBe('invalid_argument');
}

describe('adapters fixture loader: segment validation', () => {
  it.each(REJECTED)('rejects %s as a file name and as a directory', (_label, segment) => {
    if (typeof segment === 'string') expect(isSafeFixtureSegment(segment)).toBe(false);
    const s = segment as string;
    expectInvalid(() => loadFixture('flights', s));
    expectInvalid(() => loadFixtureText('flights', s));
    expectInvalid(() => fixtureExists('flights', s));
    expectInvalid(() => loadFixture(s, 'barcelona'));
    expectInvalid(() => loadFixture(['transactions', s], 'mem_dean'));
    expectInvalid(() => listFixtures(s));
    expectInvalid(() => listFixtures(['transactions', s]));
  });

  it('accepts the 100-character cap, digits, underscores and hyphens; must start alphanumeric', () => {
    expect(isSafeFixtureSegment('a'.repeat(100))).toBe(true);
    for (const ok of ['mem_dean', 'barcelona-duffel', '2026']) {
      expect(FIXTURE_SEGMENT_RE.test(ok)).toBe(true);
    }
    for (const bad of ['_x', '-x']) expect(FIXTURE_SEGMENT_RE.test(bad)).toBe(false);
  });

  it('loads an accepted nested path', () => {
    expect(fixtureExists(['transactions', 'pinned'], 'mem_dean')).toBe(true);
    expect(typeof loadFixture(['transactions', 'pinned'], 'mem_dean')).toBe('object');
    expect(loadFixtureText(['transactions', 'pinned'], 'mem_dean')).toContain('mem_dean');
    expect(listFixtures(['transactions', 'pinned'])).toContain('mem_dean');
  });

  it('a well-formed name that does not exist is not_found; a missing directory lists nothing', () => {
    expect(fixtureExists('flights', 'no-such-fixture')).toBe(false);
    expect(() => loadFixture('flights', 'no-such-fixture')).toThrow(/fixture not found/);
    expect(listFixtures(['no-such-dir'])).toEqual([]);
  });
});

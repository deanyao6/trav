import { describe, expect, it } from 'vitest';
import { TravError } from '../errors.js';
import {
  fixtureExists,
  listFixtures,
  loadFixture,
  loadFixtureJsonl,
  loadFixtureText,
} from './fixtures.js';

/**
 * Path validation for core's one fixture loader (T-059). Paths are
 * `/`-separated and relative to `<repo>/fixtures`, so `safety/x.json` is a
 * legitimate nested path here; what must never pass is anything that could
 * leave the fixtures tree or name a file outside the lowercase convention.
 */
const REJECTED: [string, unknown][] = [
  ['parent dir', '..'],
  ['parent dir inside a path', 'safety/../../package.json'],
  ['parent dir as a prefix', '../package.json'],
  ['absolute path', '/etc/passwd'],
  ['empty path', ''],
  ['empty segment', 'safety//voice-examples.json'],
  ['trailing slash', 'safety/'],
  ['uppercase', 'Safety/voice-examples.json'],
  ['hidden file', '.gitkeep'],
  ['hidden segment', 'safety/.hidden'],
  ['backslash', 'safety\\voice-examples.json'],
  ['101-character segment', 'a'.repeat(101)],
  ['non-string', 42],
  ['undefined', undefined],
];

describe('core testkit fixture loader: path validation', () => {
  it.each(REJECTED)('rejects %s without touching the disk', (_label, rel) => {
    for (const call of [
      () => loadFixture(rel as string),
      () => loadFixtureText(rel as string),
      () => loadFixtureJsonl(rel as string),
      () => fixtureExists(rel as string),
      () => listFixtures(rel as string),
    ]) {
      let thrown: unknown;
      try {
        call();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(TravError);
      expect((thrown as TravError).code).toBe('invalid_argument');
    }
  });

  it('accepts a 100-character segment (the cap) and reports it missing', () => {
    expect(fixtureExists('a'.repeat(100))).toBe(false);
  });

  it('loads an accepted nested path', () => {
    expect(fixtureExists('safety/voice-examples.json')).toBe(true);
    const parsed = loadFixture('safety/voice-examples.json');
    expect(typeof parsed).toBe('object');
    expect(loadFixtureText('safety/voice-examples.json')).toContain('{');
    expect(listFixtures('safety')).toContain('voice-examples.json');
  });

  it('a well-formed path that does not exist is not_found', () => {
    expect(fixtureExists('safety/no-such-fixture.json')).toBe(false);
    expect(() => loadFixture('safety/no-such-fixture.json')).toThrow(/fixture not found/);
    expect(listFixtures('no-such-dir')).toEqual([]);
  });
});

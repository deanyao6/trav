/**
 * The one fixture loader for `@trav/core` (T-059). Test-only: core's
 * production code never reads `fixtures/` (it stays pure and I/O-free); its
 * tests read the shared synthetic data through `loadFixture` and friends.
 * Not exported from the package index.
 *
 * Paths are relative to `<repo>/fixtures/`, e.g. `'groups/barcelona.json'`.
 * Each segment is validated, so a test can never read outside the fixtures
 * tree. Local file reads only; no network.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TravError } from '../errors.js';

/** `<repo>/fixtures` (this file lives in packages/core/src/testkit). */
const FIXTURES_ROOT = fileURLToPath(new URL('../../../../fixtures', import.meta.url));

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function fixturePath(rel: string): string {
  const segments = rel.split('/');
  for (const s of segments) {
    if (!SEGMENT_RE.test(s) || s.includes('..')) {
      throw new TravError('invalid_argument', `bad fixture path "${rel}"`);
    }
  }
  return join(FIXTURES_ROOT, ...segments);
}

/** True if `fixtures/<rel>` exists. */
export function fixtureExists(rel: string): boolean {
  return existsSync(fixturePath(rel));
}

/** Raw text of `fixtures/<rel>`. Throws `not_found` if missing. */
export function loadFixtureText(rel: string): string {
  const file = fixturePath(rel);
  if (!existsSync(file)) throw new TravError('not_found', `fixture not found: fixtures/${rel}`);
  return readFileSync(file, 'utf8');
}

/** JSON-parses `fixtures/<rel>`. The type parameter is the caller's claim, not a validation. */
export function loadFixture<T = unknown>(rel: string): T {
  return JSON.parse(loadFixtureText(rel)) as T;
}

/** Parses `fixtures/<rel>` as JSON Lines (one value per non-empty line). */
export function loadFixtureJsonl<T = unknown>(rel: string): T[] {
  return loadFixtureText(rel)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** File names directly inside `fixtures/<dir>` ending in `ext` (default `.json`), sorted. */
export function listFixtures(dir: string, ext = '.json'): string[] {
  const path = fixturePath(dir);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => e.name)
    .sort();
}

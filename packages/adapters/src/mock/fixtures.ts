/**
 * The one fixture loader for `@trav/adapters` (T-059). Every mock that reads
 * synthetic data from disk (flights, fx, transactions, email, album) goes
 * through `loadFixture`. Tickets and lodging import their JSON statically
 * instead (they must not touch `fs`; see their hygiene tests), which is
 * bundling, not loading, and stays as is.
 *
 * Resolves `fixtures/<dir...>/<name>.json` from the repo root (the directory
 * holding `pnpm-workspace.yaml`), never from `process.cwd()` (ARCHITECTURE §8).
 * Every path segment is validated, so a member id or fixture name can never
 * walk out of the fixtures tree. Local file reads only; no network.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TravError } from '@trav/core';

let cachedRoot: string | undefined;

function repoRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new TravError('not_found', 'could not locate the repo root (pnpm-workspace.yaml)');
}

/** Lowercase letters, digits, `_` and `-`; must start with a letter or digit. */
export const FIXTURE_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;

export function isSafeFixtureSegment(segment: string): boolean {
  return FIXTURE_SEGMENT_RE.test(segment);
}

/** A fixture directory: `'flights'` or `['transactions', 'pinned']`. */
export type FixtureDir = string | readonly string[];

function segmentsOf(dir: FixtureDir): readonly string[] {
  if (typeof dir === 'string') return [dir];
  if (Array.isArray(dir)) return dir;
  throw new TravError('invalid_argument', `bad fixture directory "${String(dir)}"`);
}

function fixturePath(segments: readonly string[]): string {
  for (const s of segments) {
    if (typeof s !== 'string' || !isSafeFixtureSegment(s)) {
      throw new TravError('invalid_argument', `bad fixture path segment "${String(s)}"`);
    }
  }
  return join(repoRoot(), 'fixtures', ...segments);
}

function jsonFile(dir: FixtureDir, name: string): { file: string; label: string } {
  const segments = [...segmentsOf(dir), name];
  return { file: `${fixturePath(segments)}.json`, label: `fixtures/${segments.join('/')}.json` };
}

/** True if `fixtures/<dir...>/<name>.json` exists. */
export function fixtureExists(dir: FixtureDir, name: string): boolean {
  return existsSync(jsonFile(dir, name).file);
}

/**
 * Raw text of `fixtures/<dir...>/<name>.json`, for hygiene scans that must see
 * the file exactly as committed. Throws on a bad segment or a missing file.
 */
export function loadFixtureText(dir: FixtureDir, name: string): string {
  const { file, label } = jsonFile(dir, name);
  if (!existsSync(file)) throw new TravError('not_found', `fixture not found: ${label}`);
  return readFileSync(file, 'utf8');
}

/** Reads and JSON-parses `fixtures/<dir...>/<name>.json`. Throws on a bad segment or a missing file. */
export function loadFixture(dir: FixtureDir, name: string): unknown {
  return JSON.parse(loadFixtureText(dir, name)) as unknown;
}

/** Names (without `.json`) of the JSON files directly inside `fixtures/<dir...>/`, sorted. */
export function listFixtures(dir: FixtureDir): readonly string[] {
  const path = fixturePath(segmentsOf(dir));
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.slice(0, -'.json'.length))
    .filter(isSafeFixtureSegment)
    .sort();
}

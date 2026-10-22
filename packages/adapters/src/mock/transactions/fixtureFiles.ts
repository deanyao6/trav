/**
 * Fixture file access for the private-data mocks (transactions, email, album).
 * Resolves `fixtures/<segments...>` from the repo root (the directory holding
 * `pnpm-workspace.yaml`), never from `process.cwd()` (ARCHITECTURE §8). Every
 * path segment is validated, so a member id can never walk out of the
 * fixtures tree. Local file reads only; no network.
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

function fixturePath(segments: readonly string[]): string {
  for (const s of segments) {
    if (!isSafeFixtureSegment(s)) {
      throw new TravError('invalid_argument', `bad fixture path segment "${s}"`);
    }
  }
  return join(repoRoot(), 'fixtures', ...segments);
}

/** True if `fixtures/<dir...>/<name>.json` exists. */
export function fixtureJsonExists(dir: readonly string[], name: string): boolean {
  return existsSync(`${fixturePath([...dir, name])}.json`);
}

/** Reads and JSON-parses `fixtures/<dir...>/<name>.json`. Throws on a bad segment or a missing file. */
export function readFixtureJson(dir: readonly string[], name: string): unknown {
  const file = `${fixturePath([...dir, name])}.json`;
  if (!existsSync(file)) {
    throw new TravError('not_found', `fixture not found: fixtures/${[...dir, name].join('/')}.json`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

/** Names (without `.json`) of the JSON files directly inside `fixtures/<dir...>/`, sorted. */
export function listFixtureJson(dir: readonly string[]): readonly string[] {
  const path = fixturePath(dir);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name.slice(0, -'.json'.length))
    .filter(isSafeFixtureSegment)
    .sort();
}

// ---------- tiny validators shared by the three mocks (fixture errors are programmer errors) ----------

export type Obj = Record<string, unknown>;

export function fixtureFail(where: string, msg: string): never {
  throw new TravError('invalid_argument', `fixture ${where}: ${msg}`);
}

export function asObj(v: unknown, where: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fixtureFail(where, 'expected an object');
  return v as Obj;
}

export function asArr(v: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(v)) fixtureFail(where, 'expected an array');
  return v;
}

export function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') fixtureFail(`${where}.${key}`, 'expected a non-empty string');
  return v;
}

export function optStr(o: Obj, key: string, where: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fixtureFail(`${where}.${key}`, 'expected a string');
  return v;
}

export function optNum(o: Obj, key: string, where: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) fixtureFail(`${where}.${key}`, 'expected a number');
  return v;
}

export function bool(o: Obj, key: string, where: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') fixtureFail(`${where}.${key}`, 'expected a boolean');
  return v;
}

/** Recursively freezes a plain JSON-like value and returns it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

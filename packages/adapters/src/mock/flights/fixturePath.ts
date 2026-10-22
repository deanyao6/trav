/**
 * Resolves `fixtures/<dir>/<name>.json` from the repo root (the directory with
 * `pnpm-workspace.yaml`), never from `process.cwd()` (ARCHITECTURE §8). Local
 * file reads only; no network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TravError } from '@trav/core';

let cachedRoot: string | undefined;

function repoRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // packages/adapters/src/mock/flights → repo root.
  cachedRoot = resolve(here, '../../../../..');
  return cachedRoot;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Reads and JSON-parses `fixtures/<dir>/<name>.json`. Throws on a bad name or missing file. */
export function readRepoFixtureJson(dir: string, name: string): unknown {
  if (!NAME_RE.test(dir) || !NAME_RE.test(name)) {
    throw new TravError('invalid_argument', `bad fixture path "${dir}/${name}"`);
  }
  const file = join(repoRoot(), 'fixtures', dir, `${name}.json`);
  if (!existsSync(file)) {
    throw new TravError('not_found', `fixture not found: fixtures/${dir}/${name}.json`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

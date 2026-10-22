/**
 * Repo-root-relative paths for the model layer. Resolved from this file's
 * location, never from `process.cwd()` (ARCHITECTURE §8), so the CLI, the
 * simulator and vitest all find the same `fixtures/` and `.trav/`.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;

/** The directory that contains `pnpm-workspace.yaml`. */
export function repoRoot(): string {
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
  // Fallback: packages/agent/src/model → repo root.
  cachedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  return cachedRoot;
}

/** `<repo>/.trav` (gitignored): spend.json, offline-misses.jsonl, trav.sqlite. */
export function defaultStateDir(): string {
  return join(repoRoot(), '.trav');
}

/** `<repo>/fixtures/scripts`. */
export function defaultScriptsDir(): string {
  return join(repoRoot(), 'fixtures', 'scripts');
}

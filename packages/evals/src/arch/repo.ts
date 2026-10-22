/**
 * Thin filesystem layer for the architectural checks (T-054). The root comes
 * from this module's own location (`import.meta.url`), never `process.cwd()`,
 * so the checks see the same tree whichever directory vitest was started in.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceFile } from './source.js';

/** `packages/evals/src/arch/repo.ts` → the monorepo root (four levels up). */
export function repoRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

/** Directory names never walked: dependencies, caches, VCS and agent config. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.trav',
  '.claude',
  'dist',
  'coverage',
]);

/** Files we never read as text (binary fixtures, local databases). */
const BINARY_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.sqlite',
  '.db',
  '.zip',
  '.gz',
  '.woff',
  '.woff2',
];

export function isBinaryPath(path: string): boolean {
  const lower = path.toLowerCase();
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Every non-binary file under `root` whose repo-relative POSIX path passes
 * `select`, with its UTF-8 content. Sorted by path for stable output.
 */
export function readRepoFiles(root: string, select: (path: string) => boolean): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (absDir: string, relDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(abs, rel);
      } else if (
        entry.isFile() &&
        // Never open secrets files, whatever a check selects (CLAUDE.md §2).
        !entry.name.startsWith('.env') &&
        !isBinaryPath(rel) &&
        select(rel)
      ) {
        files.push({ path: rel, content: readFileSync(abs, 'utf8') });
      }
    }
  };
  walk(root, '');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

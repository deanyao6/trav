/**
 * T-180 guard: no pattern anywhere repeats a named capture group, because
 * Node 22 (allowed by `engines`) throws "Duplicate capture group name" when
 * such a module is imported.
 *
 * This file must not import any `@trav/*` module statically: the RegExp
 * recorder has to be installed before the package graph is evaluated
 * (vitest gives every test file its own module graph).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  duplicateGroupNames,
  namedGroups,
  recordRegExps,
  regexLiteralViolations,
  type RegExpRecorder,
} from './regexGroups.js';
import { readRepoFiles, repoRoot } from './repo.js';
import { isCodeFile } from './source.js';

const ROOT = repoRoot();

/** A pattern source with `name` twice, built at runtime so no literal in this file repeats a group. */
const planted = (name: string): string => [`(?<${name}>a)`, `(?<${name}>b)`].join('|');

/** Every `.ts` entry in the `exports` of each workspace package (packages/*, apps/*). */
function entryPoints(): string[] {
  const out: string[] = [];
  const collect = (dir: string, v: unknown): void => {
    if (typeof v === 'string') {
      if (/\.tsx?$/.test(v)) out.push(join(dir, v));
    } else if (v !== null && typeof v === 'object') {
      for (const x of Object.values(v)) collect(dir, x);
    }
  };
  for (const group of ['packages', 'apps']) {
    for (const e of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = join(ROOT, group, e.name);
      let pkg: { exports?: unknown; main?: unknown };
      try {
        pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as typeof pkg;
      } catch {
        continue;
      }
      collect(dir, pkg.exports ?? pkg.main);
    }
  }
  return [...new Set(out)].sort();
}

describe('namedGroups', () => {
  it('lists named groups in order, repeats kept', () => {
    expect(namedGroups(String.raw`^(?<a>x)(?:y|(?<b>z))(?<a>w)$`)).toEqual(['a', 'b', 'a']);
  });

  it('ignores escapes, character classes and lookbehinds', () => {
    expect(namedGroups(String.raw`\(?<a>x)[(?<b>]` + '(?<=c)(?<!d)')).toEqual([]);
    expect(namedGroups(String.raw`[\](?<a>]` + '(?<b>x)')).toEqual(['b']);
    expect(namedGroups(String.raw`\\(?<a>x)`)).toEqual(['a']);
  });

  it('a `[` inside a class is literal unless the `v` flag nests classes', () => {
    expect(duplicateGroupNames('[[]' + planted('a'))).toEqual(['a']);
    expect(duplicateGroupNames('[^[]' + planted('a'), 'u')).toEqual(['a']);
    expect(namedGroups('[[a]](?<b>x)', 'v')).toEqual(['b']);
    expect(namedGroups('[[a](?<b>x)]', 'v')).toEqual([]);
  });

  it('accepts unicode and $/_ group names', () => {
    expect(namedGroups('(?<$x_1>a)(?<über>b)')).toEqual(['$x_1', 'über']);
  });

  it('duplicateGroupNames reports each repeated name once', () => {
    expect(duplicateGroupNames(planted('n') + '|(?<n>c)(?<m>d)(?<m>e)(?<k>f)')).toEqual(['n', 'm']);
    expect(duplicateGroupNames('(?<a>x)(?<b>y)')).toEqual([]);
  });
});

describe('runtime guard: importing every package entry point', () => {
  let rec: RegExpRecorder;
  beforeAll(() => {
    rec = recordRegExps();
  });
  afterAll(() => rec.restore());

  const entries = entryPoints();

  it('finds the workspace entry points', () => {
    const rel = entries.map((e) => e.slice(ROOT.length).replaceAll('\\', '/'));
    for (const p of [
      'packages/core/src/index.ts',
      'packages/core/src/storage/index.ts',
      'packages/agent/src/index.ts',
      'packages/adapters/src/index.ts',
      'packages/evals/src/index.ts',
      'apps/simulator/src/index.ts',
    ]) {
      expect(rel).toContain(p);
    }
  });

  it('builds no RegExp that repeats a named group', async () => {
    const before = rec.hits.length;
    const builtBefore = rec.built.length;
    for (const entry of entries) await import(pathToFileURL(entry).href);
    expect(rec.hits.slice(before)).toEqual([]);
    // Not vacuous: the recorder saw the roster parser's `new RegExp(String.raw…)`
    // patterns (the ones that broke Node 22), so the graph was evaluated under it.
    const built = rec.built.slice(builtBefore);
    expect(built.some((s) => s.includes('(?<name>') && s.startsWith(String.raw`^add\s+`))).toBe(
      true,
    );
    expect(built.some((s) => s.includes('(?<n>') && s.includes('(?<all>'))).toBe(true);
  });

  it('fails on a planted duplicate in an imported module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trav-regex-guard-'));
    try {
      const file = join(dir, 'planted.mjs');
      writeFileSync(
        file,
        `export const re = new RegExp(${JSON.stringify(planted('name'))}, 'u');\n`,
      );
      const before = rec.hits.length;
      // Node 25 accepts the pattern; Node 22 throws on import. Either way it is recorded.
      await import(pathToFileURL(file).href).catch(() => undefined);
      const hits = rec.hits.slice(before);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.duplicates).toEqual(['name']);
      expect(hits[0]!.site).toContain('planted.mjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records RegExp called without new, and a RegExp source', () => {
    const before = rec.hits.length;
    const tryBuild = (f: () => unknown): void => {
      try {
        f();
      } catch {
        // Node 22 refuses the pattern; the hit is recorded first.
      }
    };
    tryBuild(() => RegExp(planted('when')));
    tryBuild(() => new RegExp(new RegExp('(?<hint>a)'), 'g'));
    const hits = rec.hits.slice(before);
    expect(hits.map((h) => h.duplicates)).toEqual([['when']]);
  });
});

describe('static guard: regex literals and constant RegExp patterns in source', () => {
  it('flags a planted literal, a planted string pattern and a planted String.raw', () => {
    const lit = `/${planted('a')}/u`;
    const files = [
      { path: 'x/lit.ts', content: `const ok = /(?<a>1)(?<b>2)/;\nconst bad = ${lit};\n` },
      {
        path: 'x/str.ts',
        content: `export const r = new RegExp(${JSON.stringify(planted('b'))});`,
      },
      { path: 'x/raw.mjs', content: `const r = RegExp(String.raw\`${planted('c')}\`, 'i');` },
      {
        path: 'x/global.ts',
        content: `const r = new globalThis.RegExp(${JSON.stringify(planted('d'))});`,
      },
      {
        path: 'x/fine.tsx',
        content: `const r = new RegExp(\`(?<a>\${x})|(?<b>y)\`); <div>/</div>;`,
      },
    ];
    const v = regexLiteralViolations(files);
    expect(v.map((x) => [x.path, x.line])).toEqual([
      ['x/lit.ts', 2],
      ['x/str.ts', 1],
      ['x/raw.mjs', 1],
      ['x/global.ts', 1],
    ]);
    expect(v[0]!.message).toContain('"a"');
  });

  it('finds none in the repo (packages, apps, scripts, fixtures generators)', () => {
    const files = readRepoFiles(
      ROOT,
      (p) =>
        isCodeFile(p) &&
        ['packages/', 'apps/', 'scripts/', 'fixtures/', 'evals/'].some((r) => p.startsWith(r)),
    );
    // Guard against a vacuous pass: the roster parser alone is in scope.
    expect(files.map((f) => f.path)).toContain('packages/agent/src/roster/index.ts');
    expect(files.length).toBeGreaterThan(100);
    expect(regexLiteralViolations(files)).toEqual([]);
  });
});

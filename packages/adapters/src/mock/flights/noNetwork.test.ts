/**
 * SAFETY H1 / T13: the mock flights and FX adapters never touch the network and
 * never read the wall clock. Static scan of every source file in both dirs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [here, join(here, '..', 'fx')];

const sources = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: join(dir, f), text: stripComments(readFileSync(join(dir, f), 'utf8')) })),
);

/** Doc comments may name the forbidden APIs ("no Date.now()"); code may not. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const FORBIDDEN: [string, RegExp][] = [
  ['fetch', /\bfetch\s*\(/],
  [
    'node:http/https/net/tls/dgram/dns',
    /from\s+['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/,
  ],
  [
    'require of a network module',
    /require\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/,
  ],
  ['undici/axios/got/ws', /from\s+['"](undici|axios|got|node-fetch|ws)['"]/],
  ['XMLHttpRequest/WebSocket', /\b(XMLHttpRequest|WebSocket|EventSource)\b/],
  ['child_process', /(child_process)/],
  ['Date.now()', /Date\.now\s*\(/],
  ['new Date()', /new\s+Date\s*\(\s*\)/],
  ['process.env', /process\.env/],
];

describe('mock flights + fx: no network, no wall clock, no env', () => {
  it('scans a non-empty set of source files', () => {
    expect(sources.length).toBeGreaterThanOrEqual(6);
  });

  for (const [name, re] of FORBIDDEN) {
    it(`no ${name}`, () => {
      const hits = sources.filter((s) => re.test(s.text)).map((s) => s.file);
      expect(hits).toEqual([]);
    });
  }
});

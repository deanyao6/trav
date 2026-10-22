/**
 * SAFETY H1: the private-data mocks (transactions, email, album) never touch
 * the network, never read the wall clock or the environment. Static scan of
 * every source file in the three directories.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [here, join(here, '..', 'email'), join(here, '..', 'transactions')];

/** Doc comments may name the forbidden APIs ("no Date.now()"); code may not. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const sources = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: join(dir, f), text: stripComments(readFileSync(join(dir, f), 'utf8')) })),
);

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

describe('mock transactions + email + album: no network, no wall clock, no env', () => {
  it('scans a non-empty set of source files', () => {
    expect(sources.length).toBeGreaterThanOrEqual(10);
  });

  for (const [name, re] of FORBIDDEN) {
    it(`no ${name}`, () => {
      expect(sources.filter((s) => re.test(s.text)).map((s) => s.file)).toEqual([]);
    });
  }
});

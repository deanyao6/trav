/**
 * Containment for the lodging + settle-up mocks: no network, no wall clock,
 * no randomness, no env, no money-moving call sites (the BookingExecutor is
 * the only caller of `.book(`, D-004), settle-up never touches the payments
 * mock, and the package root exports factories only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSimulatedClock } from '@trav/core';
import { describe, expect, it } from 'vitest';
import * as root from '../../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const DIRS = [here, join(here, '..', 'lodging')];

/** Doc comments may name the forbidden APIs ("no Date.now()"); code may not. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const sources = DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({
      name: `${dir.split(/[\\/]/).pop() ?? ''}/${f}`,
      text: stripComments(readFileSync(join(dir, f), 'utf8')),
    })),
);

const FORBIDDEN: [string, RegExp][] = [
  [
    'network module',
    /(?:from|import|require)\s*\(?\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|undici|ws|axios|node-fetch|got)(?:\/[^'"]*)?['"]/,
  ],
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest/WebSocket', /\b(XMLHttpRequest|WebSocket|EventSource)\b/],
  ['child_process', /child_process/],
  ['fs', /['"](?:node:)?fs(?:\/promises)?['"]/],
  ['Date.now()', /Date\.now\s*\(/],
  ['new Date()', /new\s+Date\s*\(\s*\)/],
  ['Math.random', /Math\.random/],
  ['process.env', /process\.env/],
  ['money-moving call', /\.(purchase|charge|book|createOrder|refund|transfer|payout)\s*\(/],
];

describe('lodging + settle-up mock hygiene', () => {
  it('scans the expected files', () => {
    expect(sources.map((s) => s.name).sort()).toEqual(
      expect.arrayContaining([
        'lodging/adapter.ts',
        'lodging/index.ts',
        'lodging/inventory.ts',
        'settleup/adapter.ts',
        'settleup/index.ts',
        'settleup/links.ts',
      ]),
    );
  });

  for (const [label, re] of FORBIDDEN) {
    it(`no ${label}`, () => {
      expect(sources.filter((s) => re.test(s.text)).map((s) => s.name)).toEqual([]);
    });
  }

  it('settle-up imports nothing that can move money', () => {
    for (const s of sources.filter((x) => x.name.startsWith('settleup/'))) {
      expect(s.text).not.toMatch(/payments\/|tickets\/|flights\/|lodging\//);
    }
  });

  it('the package root exports the factories and no bare booking function', () => {
    expect(typeof root.createMockLodging).toBe('function');
    expect(typeof root.createMockSettleUp).toBe('function');
    for (const [name, v] of Object.entries(root)) {
      if (typeof v === 'function')
        expect(name).not.toMatch(/^(book|cancel|markPaid|transfer|pay)/i);
    }
  });

  it('a fresh adapter reports mock mode', () => {
    const clock = createSimulatedClock('2026-03-15T10:00:00+01:00');
    expect(root.createMockSettleUp({ clock }).info.mode).toBe('mock');
    expect(root.createMockLodging({ clock }).info.mode).toBe('mock');
  });
});

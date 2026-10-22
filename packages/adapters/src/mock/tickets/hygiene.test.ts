/**
 * Containment checks for the money-moving mocks (tickets + payments):
 * no network imports, no wall clock, no money-moving call sites (the
 * BookingExecutor is the only one, D-004), and factories-only exports.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as root from '../../index.js';
import * as payments from '../payments/index.js';
import * as tickets from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const DIRS = [here, join(here, '..', 'payments')];

function sourceFiles(): { file: string; text: string }[] {
  return DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => ({ file: join(dir, f), text: readFileSync(join(dir, f), 'utf8') })),
  );
}

const NETWORK_MODULE =
  /(?:from|import)\s*\(?\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|undici|ws|axios|node-fetch|got)(?:\/[^'"]*)?['"]/;

describe('tickets/payments mock hygiene', () => {
  const files = sourceFiles();

  it('scans the expected files', () => {
    const names = files.map((f) => f.file.split(/[\\/]/).pop());
    expect(names).toEqual(
      expect.arrayContaining(['index.ts', 'inventory.ts', 'qr.ts', 'proof.ts']),
    );
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files.map((f) => [f.file.split(/[\\/]mock[\\/]/).pop() ?? f.file, f.text]))(
    '%s: no network, no wall clock, no money-moving call sites',
    (_name, text) => {
      expect(text).not.toMatch(NETWORK_MODULE);
      expect(text).not.toMatch(/\bfetch\s*\(/);
      expect(text).not.toMatch(/XMLHttpRequest|WebSocket|EventSource/);
      expect(text).not.toMatch(/Date\.now\s*\(/);
      expect(text).not.toMatch(/new Date\(\s*\)/);
      expect(text).not.toMatch(/Math\.random/);
      expect(text).not.toMatch(/\.(purchase|charge|book|createOrder)\s*\(/);
    },
  );

  it('exports factories and helpers only; no bare purchase/charge/refund functions', () => {
    const forbidden = /^(purchase|charge|book|createOrder|refund|hold)$/i;
    for (const mod of [tickets, payments, root]) {
      for (const [name, value] of Object.entries(mod)) {
        expect(name).not.toMatch(forbidden);
        if (typeof value === 'function') {
          expect(name).not.toMatch(/purchase|charge(?!d)|^book/i);
        }
      }
    }
    expect(typeof root.createMockTickets).toBe('function');
    expect(typeof root.createMockBookingPayments).toBe('function');
  });
});

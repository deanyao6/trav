/** T-184: live next to offline, from two report summaries (no transcripts involved). */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { areaOf, areaRows, compareMain, renderComparison } from './compare.js';
import type { RunSummary, ScenarioSummary } from './reports.js';
import type { Totals } from './scoring.js';

function sc(id: string, score: number | null, failing: string[] = []): ScenarioSummary {
  return {
    id,
    score,
    passed: score === 1,
    tags: ['heldout', 'paraphrase'],
    failing,
    checklist: [],
  };
}

function run(mode: 'offline' | 'live', scenarios: ScenarioSummary[], extra = {}): RunSummary {
  return {
    version: 2,
    stamp: mode === 'live' ? '2026-11-05T16-00-00Z' : '2026-11-05T15-00-00Z',
    mode,
    modeNote: mode,
    selection: `split all, tags paraphrase: ${String(scenarios.length)} of 9 scenarios`,
    exitCode: 0,
    totals: {} as Totals,
    scenarios,
    safetyFailures: [],
    ...extra,
  };
}

const OFF = run('offline', [
  sc('para_razz_01', 1),
  sc('para_razz_02', 0.5, ['members_charged:proposed']),
  sc('para_settle_01', 0.9, ['turn_expectations']),
  sc('razzmatazz_flagship_full', 1),
  sc('para_expense_01', 0.5),
]);
const LIVE = run(
  'live',
  [
    sc('para_razz_01', 1),
    sc('para_razz_02', 1),
    sc('para_settle_01', 1),
    sc('razzmatazz_flagship_full', 0.8, ['qr_delivery']),
  ],
  {
    spend: { totalUsd: 4.25, runUsd: 4.25, maxRunUsd: 15, budgetUsd: 45 },
    models: { main: 'claude-sonnet-5-5' },
  },
);

describe('compare', () => {
  it('areaOf: paraphrase ids by area, the rest as other', () => {
    expect(areaOf('para_razz_07')).toBe('razz');
    expect(areaOf('para_exclusion_21')).toBe('exclusion');
    expect(areaOf('razzmatazz_flagship_full')).toBe('other');
    expect(areaOf('para_razz')).toBe('other');
  });

  it('areaRows: only scenarios in both runs, mean scores and pass counts, plus an all row', () => {
    const rows = areaRows(OFF, LIVE);
    expect(rows.map((r) => r.area)).toEqual(['razz', 'settle', 'other', 'all']);
    const razz = rows[0];
    expect(razz).toEqual({
      area: 'razz',
      n: 2,
      a: { score: 0.75, passed: 1 },
      b: { score: 1, passed: 2 },
    });
    const all = rows[3];
    expect(all?.n).toBe(4);
    expect(all?.a.passed).toBe(2);
    expect(all?.b.passed).toBe(3);
  });

  it('renders both runs, spend, deltas, failing graders, and one-run-only scenarios', () => {
    const md = renderComparison(OFF, LIVE, { a: 'offline', b: 'live' });
    expect(md).toContain('| razz | 2 | 75.0% | 1/2 | 100.0% | 2/2 | +25.0 |');
    expect(md).toContain('| razzmatazz_flagship_full | 100.0% | 80.0% | -20.0 |  | qr_delivery |');
    expect(md).toContain('total $4.25, this run $4.25, run cap $15.00, budget $45.00');
    expect(md).toContain('models main=claude-sonnet-5-5');
    expect(md).toContain('- only offline: para_expense_01');
    expect(md).not.toContain('only live');
  });

  it('compareMain writes the markdown to --out, and exits 2 on bad usage or a non-summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trav-compare-'));
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    writeFileSync(a, JSON.stringify(OFF));
    writeFileSync(b, JSON.stringify(LIVE));
    const logs: string[] = [];
    const out = join(dir, 'cmp.md');
    expect(compareMain([a, b, '--out', out], (l) => logs.push(l))).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('# Trav eval: live vs offline');
    expect(compareMain([a], (l) => logs.push(l))).toBe(2);
    expect(compareMain([a, b, '--out'], (l) => logs.push(l))).toBe(2);
    writeFileSync(b, JSON.stringify({ hello: 1 }));
    expect(() => compareMain([a, b], () => undefined)).toThrow(/not an eval report summary/);
  });
});

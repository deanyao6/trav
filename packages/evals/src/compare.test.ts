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
      a: { score: 0.75, passed: 1, liveCalls: null, graderFailed: 0, graderSkipped: 0 },
      b: { score: 1, passed: 2, liveCalls: null, graderFailed: 0, graderSkipped: 0 },
    });
    const all = rows[3];
    expect(all?.n).toBe(4);
    expect(all?.a.passed).toBe(2);
    expect(all?.b.passed).toBe(3);
  });

  it('renders both runs, spend, deltas, failing graders, and one-run-only scenarios', () => {
    const md = renderComparison(OFF, LIVE, { a: 'offline', b: 'live' });
    expect(md).toContain(
      '| razz | 2 | 75.0% | 1/2 | 100.0% | 2/2 | +25.0 | offline | not recorded | 0 / 0 | 0 / 0 |',
    );
    expect(md).not.toContain('## Read this first');
    expect(md).toContain('| razzmatazz_flagship_full | 100.0% | 80.0% | -20.0 |  | qr_delivery |');
    expect(md).toContain('total $4.25, this run $4.25, run cap $15.00, budget $45.00');
    expect(md).toContain('models main=claude-sonnet-5-5');
    expect(md).toContain('- only offline: para_expense_01');
    expect(md).not.toContain('only live');
  });

  it('counts live Trav calls per area; an area with none is marked deterministic', () => {
    const withCalls = (id: string, calls: Record<string, number>): ScenarioSummary => ({
      ...sc(id, 1),
      modelCalls: calls,
    });
    const off = run('offline', [
      withCalls('para_expense_01', {}),
      withCalls('para_razz_01', { script: 1 }),
    ]);
    const live = run('live', [
      withCalls('para_expense_01', {}),
      withCalls('para_razz_01', { live: 3 }),
    ]);
    const rows = areaRows(off, live);
    expect(rows.find((r) => r.area === 'expense')?.b.liveCalls).toBe(0);
    expect(rows.find((r) => r.area === 'razz')?.b.liveCalls).toBe(3);
    expect(rows.find((r) => r.area === 'all')?.b.liveCalls).toBe(3);
    // Offline script calls are not live calls.
    expect(rows.find((r) => r.area === 'razz')?.a.liveCalls).toBe(0);
    const md = renderComparison(off, live);
    expect(md).toMatch(/\| expense \|.*\| offline \| 0: no live calls \(deterministic path\) \|/);
    expect(md).toMatch(/\| razz \|.*\| offline \| 3 \|/);
  });

  it('counts failed grader calls apart from other skips, and says plainly how many rubric calls failed', () => {
    const failed = 'grader call failed: live model call failed: Error (status 400)';
    const withSkips = (id: string, reasons: string[]): ScenarioSummary => ({
      ...sc(id, 1),
      skipped: [
        ...reasons.map((reason) => ({ graderId: 'rubric', reason })),
        { graderId: 'qr_delivery', reason: 'no tickets in this episode' },
      ],
    });
    const off = run('offline', [
      withSkips('para_razz_01', ['rubric graders run live only']),
      withSkips('para_razz_02', ['rubric graders run live only']),
    ]);
    const allFailed = run('live', [
      withSkips('para_razz_01', [failed, failed]),
      withSkips('para_razz_02', [failed]),
    ]);
    const razz = areaRows(off, allFailed)[0];
    expect(razz?.a).toMatchObject({ graderFailed: 0, graderSkipped: 4 });
    expect(razz?.b).toMatchObject({ graderFailed: 3, graderSkipped: 2 });
    const md = renderComparison(off, allFailed, { a: 'offline', b: 'live' }, ['hand note']);
    expect(md).toContain('## Read this first');
    expect(md).toContain(
      `**live (\`2026-11-05T16-00-00Z\`): 3 rubric grader calls failed, in 2 of 2 scenarios**: ${failed}.`,
    );
    expect(md).toContain("so the rubric part of those scenarios' scores is missing");
    expect(md).toContain('- hand note');
    expect(md).toMatch(/\| razz \|.*\| 0 \/ 4 \| 3 \/ 2 \|/);
    // One failed call: singular, and only the scenario that carries it.
    const oneFailed = run('live', [
      withSkips('para_razz_01', [failed]),
      withSkips('para_razz_02', []),
    ]);
    expect(renderComparison(off, oneFailed)).toContain(
      'live (`2026-11-05T16-00-00Z`): 1 rubric grader call failed, in 1 of 2 scenarios',
    );
    expect(renderComparison(off, off)).not.toContain('## Read this first');
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
    expect(compareMain([a, b, '--note'], (l) => logs.push(l))).toBe(2);
    expect(compareMain([a, b, '--out', out, '--note', 'checked by hand'], () => undefined)).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('- checked by hand');
    writeFileSync(b, JSON.stringify({ hello: 1 }));
    expect(() => compareMain([a, b], () => undefined)).toThrow(/not an eval report summary/);
  });
});

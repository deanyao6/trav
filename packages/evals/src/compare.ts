/**
 * T-184: a live run next to an offline run of the same scenarios. Reads two
 * report summaries (`evals/reports/<stamp>.json`) and writes one markdown
 * table: per area (the paraphrase set's `para_<area>_NN` ids, everything
 * else as `other`), then per scenario. Scores and failing grader ids only:
 * the summaries hold no transcripts, so a held-out comparison leaks nothing
 * the score-only held-out table does not already show.
 *
 *   node --import tsx packages/evals/src/compare.ts <offline.json> <live.json> [--out <file.md>]
 *   (or, from packages/evals: pnpm compare …)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { RunSummary, ScenarioSummary } from './reports.js';

const USAGE =
  'usage: node --import tsx packages/evals/src/compare.ts <a.json> <b.json> [--out <file.md>]';

export function areaOf(id: string): string {
  return /^para_([a-z]+)_\d+$/.exec(id)?.[1] ?? 'other';
}

function pct(x: number | null | undefined): string {
  return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

function pts(a: number | null | undefined, b: number | null | undefined): string {
  if (a === null || a === undefined || b === null || b === undefined) return 'n/a';
  const d = (b - a) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}`;
}

function mean(xs: readonly (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, x) => a + x, 0) / v.length;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

export interface AreaRow {
  readonly area: string;
  readonly n: number;
  readonly a: { readonly score: number | null; readonly passed: number };
  readonly b: { readonly score: number | null; readonly passed: number };
}

/** Scenarios present in both runs, grouped by area (sorted, `other` last). */
export function areaRows(a: RunSummary, b: RunSummary): AreaRow[] {
  const bById = new Map(b.scenarios.map((s) => [s.id, s]));
  const pairs = a.scenarios.flatMap((s) => {
    const t = bById.get(s.id);
    return t === undefined ? [] : [[s, t] as const];
  });
  const areas = [...new Set(pairs.map(([s]) => areaOf(s.id)))].sort((x, y) =>
    x === 'other' ? 1 : y === 'other' ? -1 : x.localeCompare(y),
  );
  const row = (area: string, ps: readonly (readonly [ScenarioSummary, ScenarioSummary])[]) => ({
    area,
    n: ps.length,
    a: { score: mean(ps.map(([s]) => s.score)), passed: ps.filter(([s]) => s.passed).length },
    b: { score: mean(ps.map(([, t]) => t.score)), passed: ps.filter(([, t]) => t.passed).length },
  });
  const rows = areas.map((area) =>
    row(
      area,
      pairs.filter(([s]) => areaOf(s.id) === area),
    ),
  );
  return pairs.length > 1 ? [...rows, row('all', pairs)] : rows;
}

function spendLine(s: RunSummary): string {
  if (s.spend === undefined) return 'no live spend';
  const parts = [`total $${s.spend.totalUsd.toFixed(2)}`];
  if (s.spend.runUsd !== undefined) parts.push(`this run $${s.spend.runUsd.toFixed(2)}`);
  if (s.spend.maxRunUsd !== undefined) parts.push(`run cap $${s.spend.maxRunUsd.toFixed(2)}`);
  if (s.spend.budgetUsd !== undefined) parts.push(`budget $${s.spend.budgetUsd.toFixed(2)}`);
  return parts.join(', ');
}

/** Markdown: run headers, per-area table, per-scenario table, scenarios in only one run. */
export function renderComparison(
  a: RunSummary,
  b: RunSummary,
  labels: { readonly a: string; readonly b: string; readonly title?: string } = {
    a: a.mode,
    b: b.mode,
  },
): string {
  const out: string[] = [];
  out.push(`# ${labels.title ?? `Trav eval: ${labels.b} vs ${labels.a}`}`);
  out.push('');
  for (const [label, s] of [
    [labels.a, a],
    [labels.b, b],
  ] as const) {
    out.push(
      `- **${label}:** report \`${s.stamp}\`, mode \`${s.mode}\`${s.modeNote !== undefined ? ` (${s.modeNote})` : ''}; ${s.selection ?? 'selection unknown'}; ${spendLine(s)}${
        s.models !== undefined
          ? `; models ${Object.entries(s.models)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}`
          : ''
      }${s.stoppedEarly !== undefined ? `; stopped early: ${s.stoppedEarly}` : ''}; safety failures ${String(s.safetyFailures.length)}`,
    );
  }
  out.push('');
  out.push('## By area');
  out.push('');
  out.push(
    `| area | scenarios | ${labels.a} score | ${labels.a} passed | ${labels.b} score | ${labels.b} passed | Δ (pts) |`,
  );
  out.push('|---|---|---|---|---|---|---|');
  for (const r of areaRows(a, b)) {
    out.push(
      `| ${r.area} | ${String(r.n)} | ${pct(r.a.score)} | ${String(r.a.passed)}/${String(r.n)} | ${pct(r.b.score)} | ${String(r.b.passed)}/${String(r.n)} | ${pts(r.a.score, r.b.score)} |`,
    );
  }
  out.push('');
  out.push('## By scenario');
  out.push('');
  out.push(
    `| scenario | ${labels.a} | ${labels.b} | Δ (pts) | failing in ${labels.a} | failing in ${labels.b} |`,
  );
  out.push('|---|---|---|---|---|---|');
  const bById = new Map(b.scenarios.map((s) => [s.id, s]));
  for (const s of [...a.scenarios].sort((x, y) => x.id.localeCompare(y.id))) {
    const t = bById.get(s.id);
    if (t === undefined) continue;
    out.push(
      `| ${s.id} | ${pct(s.score)} | ${pct(t.score)} | ${pts(s.score, t.score)} | ${cell(s.failing.join(', '))} | ${cell(t.failing.join(', '))} |`,
    );
  }
  const onlyA = a.scenarios.filter((s) => !bById.has(s.id)).map((s) => s.id);
  const aIds = new Set(a.scenarios.map((s) => s.id));
  const onlyB = b.scenarios.filter((s) => !aIds.has(s.id)).map((s) => s.id);
  if (onlyA.length > 0 || onlyB.length > 0) {
    out.push('');
    out.push('## In one run only');
    out.push('');
    if (onlyA.length > 0) out.push(`- only ${labels.a}: ${onlyA.join(', ')}`);
    if (onlyB.length > 0) out.push(`- only ${labels.b}: ${onlyB.join(', ')}`);
  }
  out.push('');
  return out.join('\n');
}

function readSummary(path: string): RunSummary {
  const s = JSON.parse(readFileSync(path, 'utf8')) as RunSummary;
  if (typeof s.stamp !== 'string' || !Array.isArray(s.scenarios))
    throw new Error(`${path} is not an eval report summary`);
  return s;
}

export function compareMain(
  argv: readonly string[],
  log: (l: string) => void = (l) => console.log(l),
): number {
  const files: string[] = [];
  let out: string | undefined;
  let bad = false;
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i] ?? '';
    if (x === '--out') {
      out = argv[i + 1];
      if (out === undefined || out === '' || out.startsWith('--')) bad = true;
      i += 1;
    } else if (x.startsWith('--') && x !== '--') bad = true;
    else if (x !== '--') files.push(x);
  }
  const [fa, fb] = files;
  if (bad || fa === undefined || fb === undefined || files.length !== 2) {
    log(USAGE);
    return 2;
  }
  const a = readSummary(fa);
  const b = readSummary(fb);
  const md = renderComparison(a, b, { a: a.mode, b: b.mode });
  if (out !== undefined) {
    writeFileSync(out, md);
    log(`comparison: ${out}`);
  } else log(md);
  return 0;
}

if (process.argv[1] !== undefined && /compare\.ts$/.test(process.argv[1])) {
  try {
    process.exitCode = compareMain(process.argv.slice(2));
  } catch (e) {
    console.error(`trav eval:compare: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}

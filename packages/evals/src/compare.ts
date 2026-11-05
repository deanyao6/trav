/**
 * T-184: a live run next to an offline run of the same scenarios. Reads two
 * report summaries (`evals/reports/<stamp>.json`) and writes one markdown
 * table: per area (the paraphrase set's `para_<area>_NN` ids, everything
 * else as `other`), then per scenario. Scores and failing grader ids only:
 * the summaries hold no transcripts, so a held-out comparison leaks nothing
 * the score-only held-out table does not already show.
 *
 * Per area it also counts Trav's live model calls (an area with none took the
 * deterministic path, so live and offline agree by construction) and grader
 * results skipped because the grader call failed. A run whose rubric calls
 * failed is called out at the top. `--note` adds facts the summaries lack.
 *
 *   node --import tsx packages/evals/src/compare.ts <offline.json> <live.json> [--out <file.md>] [--note <text>]...
 *   (or, from packages/evals: pnpm compare …)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { RunSummary, ScenarioSummary } from './reports.js';

const USAGE =
  'usage: node --import tsx packages/evals/src/compare.ts <a.json> <b.json> [--out <file.md>] [--note <text>]...';

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

export interface AreaSide {
  readonly score: number | null;
  readonly passed: number;
  /** Trav's live model calls; null when no scenario summary recorded `modelCalls`. */
  readonly liveCalls: number | null;
  /** Grader results skipped because the grader's own (live) call failed. */
  readonly graderFailed: number;
  /** Every other skipped grader result (nothing to grade, offline-only, …). */
  readonly graderSkipped: number;
}

export interface AreaRow {
  readonly area: string;
  readonly n: number;
  readonly a: AreaSide;
  readonly b: AreaSide;
}

const FAILED_CALL = /^grader call failed/;

function side(ss: readonly ScenarioSummary[]): AreaSide {
  const recorded = ss.filter((s) => s.modelCalls !== undefined);
  const skipped = ss.flatMap((s) => s.skipped ?? []);
  return {
    score: mean(ss.map((s) => s.score)),
    passed: ss.filter((s) => s.passed).length,
    liveCalls:
      recorded.length === 0
        ? null
        : recorded.reduce((t, s) => t + (s.modelCalls?.['live'] ?? 0), 0),
    graderFailed: skipped.filter((k) => FAILED_CALL.test(k.reason)).length,
    graderSkipped: skipped.filter((k) => !FAILED_CALL.test(k.reason)).length,
  };
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
  const row = (
    area: string,
    ps: readonly (readonly [ScenarioSummary, ScenarioSummary])[],
  ): AreaRow => ({
    area,
    n: ps.length,
    a: side(ps.map(([s]) => s)),
    b: side(ps.map(([, t]) => t)),
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

function liveCallsCell(run: RunSummary, x: AreaSide): string {
  if (run.mode !== 'live') return 'offline';
  if (x.liveCalls === null) return 'not recorded';
  return x.liveCalls === 0 ? '0: no live calls (deterministic path)' : String(x.liveCalls);
}

/**
 * Plain-language warnings derived from a summary: rubric grader calls that
 * failed leave those scenarios without rubric signal (the results are
 * skipped, never passes), and the reader must not miss that.
 */
export function runWarnings(label: string, s: RunSummary): string[] {
  const failed = s.scenarios.flatMap((x) =>
    (x.skipped ?? []).filter((k) => k.graderId === 'rubric' && FAILED_CALL.test(k.reason)),
  );
  const out: string[] = [];
  if (failed.length > 0) {
    const reasons = [...new Set(failed.map((k) => k.reason))].slice(0, 2).join('; ');
    // A graded rubric result is not in `skipped`, so a summary cannot prove that
    // *every* call failed; state the count, and what it means for the scores.
    const n = String(failed.length);
    const scenarios = s.scenarios.filter((x) =>
      (x.skipped ?? []).some((k) => k.graderId === 'rubric' && FAILED_CALL.test(k.reason)),
    ).length;
    out.push(
      `**${label} (\`${s.stamp}\`): ${n} rubric grader call${n === '1' ? '' : 's'} failed, in ${String(scenarios)} of ${String(s.scenarios.length)} scenarios**: ${reasons}. Those results are skipped, never passes, so the rubric part of those scenarios' scores is missing.`,
    );
  }
  return out;
}

/** Markdown: run headers, notes, per-area table, per-scenario table, scenarios in only one run. */
export function renderComparison(
  a: RunSummary,
  b: RunSummary,
  labels: { readonly a: string; readonly b: string; readonly title?: string } = {
    a: a.mode,
    b: b.mode,
  },
  notes: readonly string[] = [],
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
  const warnings = [...runWarnings(labels.a, a), ...runWarnings(labels.b, b), ...notes];
  if (warnings.length > 0) {
    out.push('');
    out.push('## Read this first');
    out.push('');
    for (const w of warnings) out.push(`- ${w}`);
  }
  out.push('');
  out.push('## By area');
  out.push('');
  out.push(
    "Live Trav calls: model calls Trav made (from the summary's `modelCalls`); `0: no live calls (deterministic path)` means the score measures code, not the model. Grader calls: results skipped because the grader call itself failed / all other skipped results.",
  );
  out.push('');
  out.push(
    `| area | scenarios | ${labels.a} score | ${labels.a} passed | ${labels.b} score | ${labels.b} passed | Δ (pts) | ${labels.a} live Trav calls | ${labels.b} live Trav calls | ${labels.a} grader calls failed / skipped | ${labels.b} grader calls failed / skipped |`,
  );
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of areaRows(a, b)) {
    out.push(
      `| ${r.area} | ${String(r.n)} | ${pct(r.a.score)} | ${String(r.a.passed)}/${String(r.n)} | ${pct(r.b.score)} | ${String(r.b.passed)}/${String(r.n)} | ${pts(r.a.score, r.b.score)} | ${liveCallsCell(a, r.a)} | ${liveCallsCell(b, r.b)} | ${String(r.a.graderFailed)} / ${String(r.a.graderSkipped)} | ${String(r.b.graderFailed)} / ${String(r.b.graderSkipped)} |`,
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
  const notes: string[] = [];
  let out: string | undefined;
  let bad = false;
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i] ?? '';
    if (x === '--out') {
      out = argv[i + 1];
      if (out === undefined || out === '' || out.startsWith('--')) bad = true;
      i += 1;
    } else if (x === '--note') {
      const n = argv[i + 1];
      if (n === undefined || n.trim() === '') bad = true;
      else notes.push(n);
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
  const md = renderComparison(a, b, { a: a.mode, b: b.mode }, notes);
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

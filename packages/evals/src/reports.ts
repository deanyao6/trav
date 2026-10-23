/**
 * Reports: `evals/reports/<timestamp>.md` (for people) plus a sidecar
 * `<timestamp>.json` summary (machine-readable, and the next run's baseline
 * for deltas). Deltas compare against the newest earlier summary in the same
 * directory.
 *
 * The report is honest about what it did not test: offline fallback turns
 * are counted, skipped graders never count as passes, known gaps (scenarios
 * waiting on an unbuilt task) are listed apart, every safety failure names
 * its SAFETY §3 checklist id, and every §3.I hard id is listed with where it
 * was exercised (or why it was not).
 *
 * Privacy: reports carry synthetic group transcripts only. DM lines are never
 * rendered (they can hold tickets, card or email details), prompts are never
 * rendered, and a final `redact` pass removes every private string, QR
 * payload, card mask and email subject the run knows about. No environment
 * values or key material.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './arch/repo.js';
import {
  GRADED_IDS,
  HARD_IDS,
  STATIC_IDS,
  UNGRADED_HARD,
  checklistTitle,
  coverageOf,
} from './checklist.js';
import { GRADERS, HYPOTHESES } from './graders/index.js';
import { episodeSecrets, privateFixtureStrings, redact } from './redact.js';
import type { SafetyFailure, ScenarioOutcome, StaticCheck, Totals } from './scoring.js';
import { scenarioPassed, staticSafetyFailures, totals, turnSources } from './scoring.js';
import type { EvalMode, GraderResult } from './types.js';

export function reportsDir(): string {
  return join(repoRoot(), 'evals', 'reports');
}

export const SUMMARY_VERSION = 2;

export interface ScenarioSummary {
  readonly id: string;
  readonly score: number | null;
  readonly passed: boolean;
  readonly tags: readonly string[];
  /** Task a known-gap scenario waits on. */
  readonly waitsOn?: string;
  readonly crashed?: boolean;
  /** Failing grader ids, `grader [SAFETY id]` when the result carried one. */
  readonly failing: readonly string[];
  /** Declared checklist ids and their status in this run. */
  readonly checklist: readonly { readonly id: string; readonly status: string }[];
}

export interface RunSummary {
  readonly version: number;
  readonly stamp: string;
  readonly mode: EvalMode;
  readonly modeNote?: string;
  readonly selection?: string;
  readonly exitCode?: number;
  readonly totals: Totals;
  readonly scenarios: readonly ScenarioSummary[];
  readonly safetyFailures: readonly {
    readonly scenarioId: string;
    readonly graderId: string;
    readonly safetyId: string;
    readonly checklistItem?: string;
    readonly evidence?: readonly string[];
  }[];
  readonly staticChecks?: readonly { id: string; ok: boolean }[];
}

export interface RunMeta {
  readonly stamp: string;
  readonly mode: EvalMode;
  /** One line on how the mode was chosen (never the key). */
  readonly modeNote: string;
  readonly models?: Readonly<Record<string, string>>;
  /** Spend at the end of a live run (from the spend guard). */
  readonly spendUsd?: number;
  /** Which scenarios were selected (`all`, `dev`, `heldout`, `regression`, plus filters). */
  readonly selection?: string;
  /** Architectural checks run with the scenarios (absent when skipped). */
  readonly staticChecks?: readonly StaticCheck[];
}

/** `2026-10-22T15:04:05.123Z` → `2026-10-22T15-04-05Z` (sortable, filename-safe). */
export function stampOf(iso: string): string {
  return `${iso.slice(0, 19).replace(/:/g, '-')}Z`;
}

/** Every hard failure of the run: scenario safety failures, then static ones. */
export function allSafetyFailures(
  outcomes: readonly ScenarioOutcome[],
  staticChecks: readonly StaticCheck[] = [],
): SafetyFailure[] {
  return [...outcomes.flatMap((o) => o.safetyFailures), ...staticSafetyFailures(staticChecks)];
}

/** 0 when there is no hard failure, else 1 (the CLI uses 2 for its own crashes). */
export function exitCodeOf(
  outcomes: readonly ScenarioOutcome[],
  staticChecks: readonly StaticCheck[] = [],
): number {
  return allSafetyFailures(outcomes, staticChecks).length > 0 ? 1 : 0;
}

/** Every string a report for these outcomes must not contain. */
export function runSecrets(outcomes: readonly ScenarioOutcome[]): string[] {
  return [...privateFixtureStrings(), ...outcomes.flatMap((o) => episodeSecrets(o.episode))];
}

function failingIds(results: readonly GraderResult[]): string[] {
  return [
    ...new Set(
      failing(results).map((r) =>
        r.safetyId !== undefined ? `${r.graderId} [${r.safetyId}]` : r.graderId,
      ),
    ),
  ];
}

export function summarize(outcomes: readonly ScenarioOutcome[], meta: RunMeta): RunSummary {
  const staticChecks = meta.staticChecks ?? [];
  const secrets = runSecrets(outcomes);
  return {
    version: SUMMARY_VERSION,
    stamp: meta.stamp,
    mode: meta.mode,
    modeNote: meta.modeNote,
    ...(meta.selection !== undefined ? { selection: meta.selection } : {}),
    exitCode: exitCodeOf(outcomes, staticChecks),
    totals: totals(outcomes, staticChecks),
    scenarios: outcomes.map((o) => ({
      id: o.scenario.id,
      score: o.score,
      passed: scenarioPassed(o),
      tags: o.scenario.tags,
      ...(o.waitsOn !== undefined ? { waitsOn: o.waitsOn } : {}),
      ...(o.crashed !== undefined ? { crashed: true } : {}),
      failing: failingIds(o.results),
      checklist: o.coverage.map((c) => ({ id: c.id, status: c.status })),
    })),
    safetyFailures: allSafetyFailures(outcomes, staticChecks).map((f) => ({
      scenarioId: f.scenarioId,
      graderId: f.graderId,
      safetyId: f.safetyId,
      checklistItem: checklistTitle(f.safetyId),
      evidence: f.evidence.slice(0, 5).map((e) => redact(e, secrets)),
    })),
    ...(meta.staticChecks !== undefined
      ? { staticChecks: meta.staticChecks.map((c) => ({ id: c.id, ok: c.ok })) }
      : {}),
  };
}

/** Every valid summary in `dir` whose stamp sorts before `stamp`, newest first. */
export function earlierSummaries(dir: string, stamp: string): RunSummary[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f.slice(0, -5) < stamp)
    .sort()
    .reverse();
  const out: RunSummary[] = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunSummary;
      if (
        (s.version === 1 || s.version === SUMMARY_VERSION) &&
        typeof s.stamp === 'string' &&
        Array.isArray(s.scenarios) &&
        typeof s.totals === 'object' &&
        s.totals !== null
      ) {
        out.push(s);
      }
    } catch {
      // Not a summary; keep looking.
    }
  }
  return out;
}

/** Newest summary in `dir` whose stamp sorts before `stamp`. */
export function previousSummary(dir: string, stamp: string): RunSummary | undefined {
  return earlierSummaries(dir, stamp)[0];
}

/**
 * What a selection is, without its counts: `split all, tags booking: 9 of 52
 * scenarios` → `split all, tags booking`, so adding a scenario does not make
 * two full runs incomparable.
 */
export function selectionKey(selection: string | undefined): string | undefined {
  if (selection === undefined) return undefined;
  return selection.replace(/: \d+ of \d+ scenarios$/, '');
}

/**
 * What a run is compared with. A filtered run (`--filter`, `--tag`,
 * `--regression`, `--heldout`) must never become the baseline that hides a
 * full run's regressions, so:
 *
 * - each scenario is compared with the newest earlier run that contains it;
 * - totals, per-tag scores and "not in this run" use the newest earlier run
 *   with the same selection (absent ⇒ those deltas read "new");
 * - static-check failures are compared with the newest earlier run that ran them.
 */
export interface Baseline {
  readonly sameSelection?: RunSummary;
  readonly byScenario: ReadonlyMap<string, RunSummary>;
  readonly statics?: RunSummary;
  /** How many earlier summaries there were at all. */
  readonly available: number;
}

export function baselineFrom(
  summaries: readonly RunSummary[],
  selection: string | undefined,
  ids: readonly string[],
): Baseline {
  const key = selectionKey(selection);
  const sameSelection = summaries.find((s) => selectionKey(s.selection) === key);
  const byScenario = new Map<string, RunSummary>();
  for (const id of ids) {
    const s = summaries.find((x) => x.scenarios.some((y) => y.id === id));
    if (s !== undefined) byScenario.set(id, s);
  }
  const statics = summaries.find((s) => s.staticChecks !== undefined);
  return {
    ...(sameSelection !== undefined ? { sameSelection } : {}),
    byScenario,
    ...(statics !== undefined ? { statics } : {}),
    available: summaries.length,
  };
}

export function loadBaseline(
  dir: string,
  stamp: string,
  selection: string | undefined,
  ids: readonly string[],
): Baseline {
  return baselineFrom(earlierSummaries(dir, stamp), selection, ids);
}

function isBaseline(x: Baseline | RunSummary): x is Baseline {
  return 'byScenario' in x;
}

/** A single earlier summary as a baseline (tests, and callers that already picked one). */
export function asBaseline(
  prev: Baseline | RunSummary | undefined,
  outcomes: readonly ScenarioOutcome[],
  selection: string | undefined,
): Baseline {
  if (prev === undefined) return { byScenario: new Map(), available: 0 };
  if (isBaseline(prev)) return prev;
  return baselineFrom(
    [prev],
    selection,
    outcomes.map((o) => o.scenario.id),
  );
}

export function priorScenario(b: Baseline, id: string): ScenarioSummary | undefined {
  return b.byScenario.get(id)?.scenarios.find((s) => s.id === id);
}

/** One line naming the baseline(s) used. */
export function baselineNote(b: Baseline, outcomes: readonly ScenarioOutcome[]): string {
  if (b.available === 0) return 'nothing (first report)';
  const parts: string[] = [];
  parts.push(
    b.sameSelection !== undefined
      ? `totals vs ${b.sameSelection.stamp} (${b.sameSelection.mode}, same selection)`
      : 'totals: no earlier run with this selection, so totals deltas read "new"',
  );
  const counts = new Map<string, number>();
  let fresh = 0;
  for (const o of outcomes) {
    const s = b.byScenario.get(o.scenario.id);
    if (s === undefined) fresh += 1;
    else counts.set(s.stamp, (counts.get(s.stamp) ?? 0) + 1);
  }
  const per = [...counts.entries()]
    .sort((x, y) => (x[0] < y[0] ? 1 : -1))
    .map(([stamp, n]) => `${String(n)} vs ${stamp}`);
  if (fresh > 0) per.push(`${String(fresh)} new`);
  parts.push(
    `per scenario: the newest earlier run containing it (${per.length === 0 ? 'none' : per.join(', ')})`,
  );
  return parts.join('; ');
}

function pct(x: number | null | undefined): string {
  return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

/** Points moved since the previous run: `+3.2`, `-1.0`, `±0`, or `new`. */
export function delta(now: number | null | undefined, before: number | null | undefined): string {
  if (now === null || now === undefined || before === null || before === undefined) return 'new';
  const d = (now - before) * 100;
  if (Math.abs(d) < 0.05) return '±0';
  return `${d > 0 ? '+' : ''}${d.toFixed(1)}`;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ');
}

function failing(results: readonly GraderResult[]): GraderResult[] {
  return results.filter((r) => !r.pass && r.skipped === undefined);
}

function idLabel(id: string): string {
  const title = checklistTitle(id);
  return title === '' ? `**${id}**` : `**${id}** ${title}`;
}

function sourcesCell(o: ScenarioOutcome): string {
  const s = turnSources(o.episode);
  const keys = Object.keys(s).sort();
  return keys.length === 0 ? '' : keys.map((k) => `${k} ${String(s[k])}`).join(', ');
}

function statusOf(o: ScenarioOutcome): string {
  if (o.crashed !== undefined)
    return o.waitsOn !== undefined ? `crashed, known gap (${o.waitsOn})` : 'crashed';
  return o.waitsOn !== undefined ? `known gap (${o.waitsOn})` : 'ran';
}

/** Group-lane transcript lines; DM lines show only that a private message was exchanged. */
export function transcriptExcerpt(o: ScenarioOutcome, max = 14): string[] {
  const ep = o.episode;
  if (ep === undefined) return [];
  const lines = ep.transcript
    .filter((t) => t.type === 'message' || t.type === 'reaction')
    .map((t) => {
      const who = t.direction === 'outbound' ? 'trav' : t.fromName;
      if (t.lane === 'dm') {
        const to =
          t.direction === 'outbound' && 'dmName' in t && t.dmName !== undefined
            ? ` → dm ${t.dmName}`
            : ' (dm)';
        return `${who}${to}: [private message, not shown]`;
      }
      const body =
        t.type === 'message'
          ? t.text.replace(/\n/g, ' ⏎ ')
          : `[${t.reaction} on ${t.targetMessageId}]`;
      return `${who}: ${body}`;
    });
  return lines.length <= max ? lines : ['…', ...lines.slice(-max)];
}

/**
 * Worst dev-set episodes first: hard failures, then failing built scenarios,
 * then known gaps, each by score. Held-out scenarios never appear here (their
 * transcripts and evidence would leak the held-out set into the build loop);
 * they get the score-only table instead (also in a `--heldout` run, whose
 * report lands in the same directory the build loop reads).
 */
export function worstEpisodes(outcomes: readonly ScenarioOutcome[], n = 5): ScenarioOutcome[] {
  return rankWorst(
    outcomes.filter((o) => !o.scenario.tags.includes('heldout')),
    n,
  );
}

function rankWorst(outcomes: readonly ScenarioOutcome[], n: number): ScenarioOutcome[] {
  const rank = (o: ScenarioOutcome) => [
    o.safetyFailures.length > 0 ? 0 : 1,
    scenarioPassed(o) ? 1 : 0,
    o.waitsOn !== undefined ? 1 : 0,
    o.score ?? 1,
  ];
  return outcomes
    .filter((o) => o.score !== null || o.crashed !== undefined)
    .slice()
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i += 1) {
        const d = (ra[i] ?? 0) - (rb[i] ?? 0);
        if (d !== 0) return d;
      }
      return a.scenario.id.localeCompare(b.scenario.id);
    })
    .slice(0, n);
}

export interface RunChanges {
  readonly newlyFailing: readonly string[];
  readonly newlyPassing: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Score moves of at least 5 points among scenarios in both runs. */
  readonly moved: readonly { readonly id: string; readonly delta: string }[];
  /** `scenario/SAFETY id` pairs failing now that were not failing before. */
  readonly newSafetyFailures: readonly string[];
  readonly fixedSafetyFailures: readonly string[];
}

export function changesSince(
  outcomes: readonly ScenarioOutcome[],
  previous: RunSummary,
  staticChecks: readonly StaticCheck[] = [],
): RunChanges {
  const before = new Map(previous.scenarios.map((s) => [s.id, s]));
  const now = new Set(outcomes.map((o) => o.scenario.id));
  const newlyFailing: string[] = [];
  const newlyPassing: string[] = [];
  const added: string[] = [];
  const moved: { id: string; delta: string }[] = [];
  for (const o of outcomes) {
    const b = before.get(o.scenario.id);
    if (b === undefined) {
      added.push(o.scenario.id);
      continue;
    }
    const passed = scenarioPassed(o);
    if (b.passed === true && !passed) newlyFailing.push(o.scenario.id);
    if (b.passed === false && passed) newlyPassing.push(o.scenario.id);
    if (o.score !== null && b.score !== null && Math.abs(o.score - b.score) >= 0.05) {
      moved.push({ id: o.scenario.id, delta: delta(o.score, b.score) });
    }
  }
  const key = (f: { scenarioId: string; safetyId: string }) => `${f.scenarioId}/${f.safetyId}`;
  const nowSafety = new Set(allSafetyFailures(outcomes, staticChecks).map(key));
  const prevSafety = new Set(previous.safetyFailures.map(key));
  return {
    newlyFailing,
    newlyPassing,
    added,
    removed: [...before.keys()].filter((id) => !now.has(id)),
    moved,
    newSafetyFailures: [...nowSafety].filter((k) => !prevSafety.has(k)).sort(),
    fixedSafetyFailures: [...prevSafety].filter((k) => !nowSafety.has(k)).sort(),
  };
}

/** One row per §3 id worth listing: every hard id, every graded id, every id any scenario declared. */
function checklistRows(
  outcomes: readonly ScenarioOutcome[],
  t: Totals,
  staticChecks: readonly StaticCheck[],
): string[] {
  const declared = new Set(outcomes.flatMap((o) => o.scenario.checklist ?? []));
  const ids = [
    ...new Set([...HARD_IDS, ...GRADED_IDS, ...declared, ...Object.keys(t.checklist)]),
  ].sort();
  const rows: string[] = [];
  for (const id of ids) {
    const kind = coverageOf(id);
    const c = t.checklist[id];
    const waits = [
      ...new Set(
        outcomes
          .filter((o) => o.waitsOn !== undefined && (o.scenario.checklist ?? []).includes(id))
          .map((o) => o.waitsOn ?? ''),
      ),
    ].sort();
    const parts: string[] = [];
    if (c !== undefined && c.fail > 0) parts.push(`**FAIL in ${String(c.fail)}**`);
    if (c !== undefined && c.pass > 0) parts.push(`pass in ${String(c.pass)}`);
    if (c !== undefined && c.notExercised > 0)
      parts.push(`declared but not exercised in ${String(c.notExercised)}`);
    if (kind === 'static') {
      const sc = staticChecks.filter((s) => s.id === id);
      parts.push(
        sc.length === 0
          ? 'static check not run'
          : sc.every((s) => s.ok)
            ? 'static check ok'
            : '**static check FAIL**',
      );
    }
    if (parts.length === 0) {
      if (kind === 'grader') parts.push('not exercised by any scenario in this run');
      else if (UNGRADED_HARD[id] !== undefined) parts.push(`no grader: ${UNGRADED_HARD[id] ?? ''}`);
      else parts.push('no eval grader (unit tests / review only)');
    }
    if (waits.length > 0) parts.push(`known-gap scenarios wait on ${waits.join(', ')}`);
    const hard = HARD_IDS.includes(id) ? 'hard' : '';
    rows.push(`| ${cell(idLabel(id))} | ${hard} | ${kind} | ${parts.join('; ')} |`);
  }
  return rows;
}

function changesSection(
  out: string[],
  c: RunChanges | undefined,
  previous: RunSummary | undefined,
): void {
  out.push('## Changes since the previous run');
  out.push('');
  if (previous === undefined || c === undefined) {
    out.push('No earlier report in this directory; every delta reads "new".');
    out.push('');
    return;
  }
  const list = (xs: readonly string[]) => (xs.length === 0 ? 'none' : xs.join(', '));
  out.push(`Compared with ${previous.stamp} (${previous.mode}).`);
  out.push('');
  out.push(`- **New safety failures:** ${list(c.newSafetyFailures)}`);
  out.push(`- **Safety failures fixed:** ${list(c.fixedSafetyFailures)}`);
  out.push(`- **Newly failing (passed last run):** ${list(c.newlyFailing)}`);
  out.push(`- **Newly passing:** ${list(c.newlyPassing)}`);
  out.push(
    `- **Score moves ≥ 5 pts:** ${c.moved.length === 0 ? 'none' : c.moved.map((m) => `${m.id} ${m.delta}`).join(', ')}`,
  );
  if (c.added.length > 0) out.push(`- **New scenarios:** ${c.added.join(', ')}`);
  if (c.removed.length > 0) out.push(`- **Not in this run:** ${c.removed.join(', ')}`);
  out.push('');
}

export function renderReport(
  outcomes: readonly ScenarioOutcome[],
  meta: RunMeta,
  previous: RunSummary | undefined,
): string {
  const staticChecks = meta.staticChecks ?? [];
  const t = totals(outcomes, staticChecks);
  const prevScore = new Map(previous?.scenarios.map((s) => [s.id, s.score]) ?? []);
  const out: string[] = [];
  const safety = allSafetyFailures(outcomes, staticChecks);
  const sourceTotals: Record<string, number> = {};
  for (const o of outcomes) {
    for (const [k, n] of Object.entries(turnSources(o.episode)))
      sourceTotals[k] = (sourceTotals[k] ?? 0) + n;
  }
  const turnsTotal = Object.values(sourceTotals).reduce((a, n) => a + n, 0);

  out.push(`# Trav eval report: ${meta.stamp}`);
  out.push('');
  out.push(
    `- **Mode:** \`${meta.mode}\`${meta.mode === 'live' ? ' (LIVE model calls)' : ''} (${meta.modeNote})`,
  );
  if (meta.selection !== undefined) out.push(`- **Selection:** ${meta.selection}`);
  if (meta.models !== undefined) {
    out.push(
      `- **Models:** ${Object.entries(meta.models)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    );
  }
  if (meta.spendUsd !== undefined)
    out.push(`- **Live spend so far:** $${meta.spendUsd.toFixed(2)}`);
  out.push(
    `- **Result:** ${safety.length === 0 ? 'PASS (no safety failures), exit 0' : `FAIL: ${String(safety.length)} safety failure(s), hard fail, exit 1`}`,
  );
  out.push(
    `- **Compared with:** ${previous === undefined ? 'nothing (first report)' : `${previous.stamp} (${previous.mode})`}`,
  );
  if (meta.mode === 'offline') {
    const fb = sourceTotals['fallback'] ?? 0;
    out.push(
      `- **Offline caveat:** ${String(fb)} of ${String(turnsTotal)} Trav turns were answered by the generic offline fallback (no script for that line), so offline scores measure safety invariants, scripted paths and pure components, not reply quality. Rubric graders (tone, helpfulness, brevity, clarifying questions) only run live and are skipped here.`,
    );
  }
  out.push('');
  out.push('## Totals');
  out.push('');
  out.push('| | score | Δ vs previous (pts) |');
  out.push('|---|---|---|');
  out.push(
    `| overall (dev set: everything not held out, known gaps included) | ${pct(t.overall)} | ${delta(t.overall, previous?.totals.overall)} |`,
  );
  out.push(
    `| ready (dev set without known gaps) | ${pct(t.ready)} | ${delta(t.ready, previous?.totals.ready)} |`,
  );
  out.push(
    `| held-out (reported apart, never tuned against) | ${pct(t.heldout)} | ${delta(t.heldout, previous?.totals.heldout)} |`,
  );
  out.push(
    `| regression suite passed | ${String(t.regression.passed)} / ${String(t.regression.ran)} | |`,
  );
  out.push(`| scenarios run / of which known gaps | ${String(t.ran)} / ${String(t.knownGaps)} | |`);
  out.push(
    `| safety failures | ${String(t.safetyFailures)} | ${previous === undefined ? 'new' : String(t.safetyFailures - previous.totals.safetyFailures)} |`,
  );
  out.push('');

  out.push('## Safety failures (hard)');
  out.push('');
  if (safety.length === 0) {
    out.push(
      'None. Every safety grader that had something to grade passed. Skipped graders are not passes; see the checklist coverage below.',
    );
  } else {
    out.push('| SAFETY §3 | checklist item | scenario | grader | evidence |');
    out.push('|---|---|---|---|---|');
    for (const f of safety) {
      out.push(
        `| **${f.safetyId}** | ${cell(checklistTitle(f.safetyId))} | ${f.scenarioId} | ${f.graderId} | ${cell(f.evidence.slice(0, 3).join('; '))} |`,
      );
    }
  }
  out.push('');

  changesSection(
    out,
    previous === undefined ? undefined : changesSince(outcomes, previous, staticChecks),
    previous,
  );

  out.push('## Regression suite');
  out.push('');
  out.push(
    'Scenarios tagged `regression` must pass every grader that grades them (also enforced by `src/regression.test.ts` in `pnpm test`, and runnable alone with `pnpm eval --split regression`).',
  );
  out.push('');
  if (t.regression.failing.length === 0) {
    out.push(`All ${String(t.regression.ran)} regression scenario(s) passed.`);
  } else {
    for (const id of t.regression.failing) {
      const o = outcomes.find((x) => x.scenario.id === id);
      out.push(`- **${id}** regressed: ${failingIds(o?.results ?? []).join(', ')}`);
    }
  }
  out.push('');

  out.push('## Held-out set');
  out.push('');
  out.push(
    'Not used for tuning. Excluded from the overall score. Run alone with `pnpm eval --heldout`.',
  );
  out.push('');
  const held = outcomes.filter((o) => o.scenario.tags.includes('heldout'));
  if (held.length === 0) {
    out.push('No held-out scenarios in this selection.');
  } else {
    out.push('| scenario | status | score | Δ (pts) | failing graders |');
    out.push('|---|---|---|---|---|');
    for (const o of held) {
      out.push(
        `| ${o.scenario.id} | ${statusOf(o)} | ${pct(o.score)} | ${delta(o.score, prevScore.get(o.scenario.id))} | ${failingIds(o.results).join(', ')} |`,
      );
    }
  }
  out.push('');

  const gaps = outcomes.filter((o) => o.waitsOn !== undefined);
  if (gaps.length > 0) {
    out.push('## Known gaps');
    out.push('');
    out.push(
      'These scenarios ran, but the feature they drive waits on an unbuilt task, so their feature failures are expected (scored, not hard). Their safety graders stay hard. A known gap that passes everything should drop its `pending` marker.',
    );
    out.push('');
    out.push('| scenario | waits on | score | failing graders | note |');
    out.push('|---|---|---|---|---|');
    for (const o of gaps) {
      const bad = failingIds(o.results);
      out.push(
        `| ${o.scenario.id} | ${o.waitsOn ?? ''} | ${pct(o.score)} | ${bad.length === 0 ? '**passes now: drop `pending`**' : bad.join(', ')} | ${cell(o.scenario.pendingNote ?? '')} |`,
      );
    }
    out.push('');
  }

  out.push('## SAFETY §3 checklist coverage');
  out.push('');
  out.push(
    '`grader` ids are checked per episode; `static` ids by the architectural checks over the source tree; `none` have no eval grader. "Not exercised" means the episode never did the thing the grader checks, which is never counted as a pass.',
  );
  out.push('');
  out.push('| SAFETY §3 | §3.I | coverage | this run |');
  out.push('|---|---|---|---|');
  out.push(...checklistRows(outcomes, t, staticChecks));
  out.push('');

  if (staticChecks.length > 0) {
    out.push('## Static checks');
    out.push('');
    out.push('| check | result | files scanned | notes |');
    out.push('|---|---|---|---|');
    for (const c of staticChecks) {
      const notes = [...c.violations.slice(0, 3), ...c.warnings.slice(0, 2)].join('; ');
      out.push(
        `| ${c.id}${c.safety ? '' : ' (decision)'} | ${c.ok ? 'ok' : '**FAIL**'} | ${String(c.filesScanned)} | ${cell(notes)} |`,
      );
    }
    out.push('');
  }

  out.push('## Scores by tag');
  out.push('');
  out.push('| tag | score | Δ (pts) |');
  out.push('|---|---|---|');
  for (const [tag, score] of Object.entries(t.byTag)) {
    out.push(`| ${tag} | ${pct(score)} | ${delta(score, previous?.totals.byTag[tag])} |`);
  }
  out.push('');

  out.push('## Worst 5 episodes');
  out.push('');
  out.push(
    'Dev set only (held-out transcripts are never shown). Hard failures first, then failing scenarios that are built, then known gaps, each by score. Transcripts show the group lane only.',
  );
  out.push('');
  const worst = worstEpisodes(outcomes);
  if (worst.length === 0) {
    out.push('No dev-set episodes in this selection.');
    out.push('');
  }
  for (const o of worst) {
    out.push(
      `### ${o.scenario.id}: ${pct(o.score)}${o.waitsOn !== undefined ? ` (known gap, waits on ${o.waitsOn})` : ''}`,
    );
    out.push('');
    out.push(`${o.scenario.title} · tags: ${o.scenario.tags.join(', ')}`);
    out.push('');
    const bad = failing(o.results);
    if (bad.length === 0) {
      out.push('All graders passed (lowest score among a passing set).');
    } else {
      for (const r of bad) {
        out.push(
          `- **${r.graderId}**${r.safetyId !== undefined ? ` (SAFETY ${r.safetyId})` : ''}, score ${r.score.toFixed(2)}: ${cell(r.evidence.slice(0, 4).join('; '))}`,
        );
        const hint = HYPOTHESES[r.graderId.split(':')[0] ?? ''];
        if (hint !== undefined) out.push(`  - likely area: ${hint}`);
      }
    }
    const excerpt = transcriptExcerpt(o);
    if (excerpt.length > 0) {
      out.push('');
      out.push('```');
      out.push(...excerpt);
      out.push('```');
    }
    out.push('');
  }

  out.push('## Scenarios');
  out.push('');
  out.push(
    '| scenario | tags | status | score | Δ (pts) | turns by source | SAFETY §3 (declared) | failing graders |',
  );
  out.push('|---|---|---|---|---|---|---|---|');
  for (const o of outcomes) {
    const cov = o.coverage.map((c) => `${c.id} ${c.status.replace('_', ' ')}`).join(', ');
    out.push(
      `| ${o.scenario.id} | ${o.scenario.tags.join(', ')} | ${statusOf(o)} | ${pct(o.score)} | ${delta(o.score, prevScore.get(o.scenario.id))} | ${sourcesCell(o)} | ${cov} | ${failingIds(o.results).join(', ')} |`,
    );
  }
  out.push('');

  const sources = new Map<string, number>();
  let skippedLines = 0;
  for (const o of outcomes) {
    for (const p of o.episode?.prompts ?? []) {
      const key = `${p.kind}:${p.source ?? '?'}`;
      sources.set(key, (sources.get(key) ?? 0) + 1);
    }
    skippedLines += o.episode?.skippedLines.length ?? 0;
  }
  out.push('## Model calls');
  out.push('');
  out.push(
    sources.size === 0
      ? 'No model calls.'
      : [...sources.entries()]
          .sort()
          .map(([k, n]) => `${k} ${String(n)}`)
          .join(' · '),
  );
  if (meta.mode === 'offline') {
    out.push('');
    out.push(
      '`fallback` completions are offline script misses (logged to the run state dir) and usually mean a feature or script is not built yet.',
    );
  }
  if (skippedLines > 0) {
    out.push('');
    out.push(
      `${String(skippedLines)} replayed chat line(s) were skipped (membership changes and system ingestion events are not replayed yet).`,
    );
  }
  out.push('');
  out.push('## Graders');
  out.push('');
  out.push('| grader | SAFETY §3 | kind | weight |');
  out.push('|---|---|---|---|');
  for (const g of GRADERS) {
    out.push(
      `| ${g.id} | ${g.safetyId ?? ''} | ${g.kind}${g.kind === 'rubric' ? ' (live only)' : ''} | ${String(g.weight)} |`,
    );
  }
  out.push(`| checklist_coverage | | deterministic | 1 |`);
  out.push(
    `| runner | (checklist ids of a built safety scenario that crashed) | deterministic | 3 |`,
  );
  out.push(`| static (arch) | ${STATIC_IDS.join(', ')} | deterministic | hard |`);
  out.push('');
  return redact(out.join('\n'), runSecrets(outcomes));
}

export interface WrittenReport {
  readonly markdownPath: string;
  readonly summaryPath: string;
  readonly summary: RunSummary;
  readonly markdown: string;
}

export function writeReport(
  outcomes: readonly ScenarioOutcome[],
  meta: RunMeta,
  dir = reportsDir(),
): WrittenReport {
  mkdirSync(dir, { recursive: true });
  // Two runs in the same second never overwrite each other.
  let stamp = meta.stamp;
  for (
    let i = 2;
    existsSync(join(dir, `${stamp}.md`)) || existsSync(join(dir, `${stamp}.json`));
    i += 1
  ) {
    stamp = `${meta.stamp}-${String(i)}`;
  }
  const m: RunMeta = { ...meta, stamp };
  const previous = previousSummary(dir, stamp);
  const markdown = renderReport(outcomes, m, previous);
  const summary = summarize(outcomes, m);
  const markdownPath = join(dir, `${stamp}.md`);
  const summaryPath = join(dir, `${stamp}.json`);
  writeFileSync(markdownPath, `${markdown}\n`, 'utf8');
  writeFileSync(
    summaryPath,
    `${redact(JSON.stringify(summary, null, 2), runSecrets(outcomes))}\n`,
    'utf8',
  );
  return { markdownPath, summaryPath, summary, markdown };
}

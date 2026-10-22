/**
 * Reports: `evals/reports/<timestamp>.md` (for people) plus a sidecar
 * `<timestamp>.json` summary (for the next run's deltas). Deltas compare
 * against the newest earlier summary in the same directory.
 *
 * Reports contain transcripts of synthetic fixtures only; no prompts, no
 * environment, no key material.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './arch/repo.js';
import { GRADERS, HYPOTHESES } from './graders/index.js';
import type { ScenarioOutcome, Totals } from './scoring.js';
import { totals } from './scoring.js';
import type { EvalMode, GraderResult } from './types.js';

export function reportsDir(): string {
  return join(repoRoot(), 'evals', 'reports');
}

export interface RunSummary {
  readonly version: 1;
  readonly stamp: string;
  readonly mode: EvalMode;
  readonly totals: Totals;
  readonly scenarios: readonly {
    readonly id: string;
    readonly status: 'ran' | 'pending';
    readonly score: number | null;
    readonly tags: readonly string[];
    readonly pending?: string;
  }[];
  readonly safetyFailures: readonly { scenarioId: string; graderId: string; safetyId: string }[];
}

export interface RunMeta {
  readonly stamp: string;
  readonly mode: EvalMode;
  /** One line on how the mode was chosen (never the key). */
  readonly modeNote: string;
  readonly models?: Readonly<Record<string, string>>;
  /** Spend at the end of a live run (from the spend guard). */
  readonly spendUsd?: number;
}

/** `2026-10-22T15:04:05.123Z` → `2026-10-22T15-04-05Z` (sortable, filename-safe). */
export function stampOf(iso: string): string {
  return `${iso.slice(0, 19).replace(/:/g, '-')}Z`;
}

export function summarize(outcomes: readonly ScenarioOutcome[], meta: RunMeta): RunSummary {
  return {
    version: 1,
    stamp: meta.stamp,
    mode: meta.mode,
    totals: totals(outcomes),
    scenarios: outcomes.map((o) => ({
      id: o.scenario.id,
      status: o.status,
      score: o.score,
      tags: o.scenario.tags,
      ...(o.scenario.pending !== undefined ? { pending: o.scenario.pending } : {}),
    })),
    safetyFailures: outcomes.flatMap((o) =>
      o.safetyFailures.map((f) => ({ scenarioId: f.scenarioId, graderId: f.graderId, safetyId: f.safetyId })),
    ),
  };
}

/** Newest summary in `dir` whose stamp sorts before `stamp`. */
export function previousSummary(dir: string, stamp: string): RunSummary | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f.slice(0, -5) < stamp)
    .sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    try {
      const s = JSON.parse(readFileSync(join(dir, files[i]!), 'utf8')) as RunSummary;
      if (s.version === 1 && typeof s.stamp === 'string') return s;
    } catch {
      // Not a summary; keep looking.
    }
  }
  return undefined;
}

function pct(x: number | null | undefined): string {
  return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

function delta(now: number | null | undefined, before: number | null | undefined): string {
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

function transcriptExcerpt(o: ScenarioOutcome, max = 14): string[] {
  const ep = o.episode;
  if (ep === undefined) return [];
  const lines = ep.transcript
    .filter((t) => t.type === 'message' || t.type === 'reaction')
    .map((t) => {
      const who = t.direction === 'outbound' ? 'trav' : t.fromName;
      const lane = t.lane === 'dm' ? ` → dm ${'dmName' in t && t.dmName !== undefined ? t.dmName : ''}`.trimEnd() : '';
      const body =
        t.type === 'message' ? t.text.replace(/\n/g, ' ⏎ ') : `[${t.reaction} on ${t.targetMessageId}]`;
      return `${who}${lane}: ${body}`;
    });
  return lines.length <= max ? lines : ['…', ...lines.slice(-max)];
}

export function renderReport(
  outcomes: readonly ScenarioOutcome[],
  meta: RunMeta,
  previous: RunSummary | undefined,
): string {
  const t = totals(outcomes);
  const prevScore = new Map(previous?.scenarios.map((s) => [s.id, s.score]) ?? []);
  const out: string[] = [];
  const safety = outcomes.flatMap((o) => o.safetyFailures);
  out.push(`# Trav eval report: ${meta.stamp}`);
  out.push('');
  out.push(`- **Mode:** \`${meta.mode}\` (${meta.modeNote})`);
  if (meta.models !== undefined) {
    out.push(`- **Models:** ${Object.entries(meta.models).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (meta.spendUsd !== undefined) out.push(`- **Live spend so far:** $${meta.spendUsd.toFixed(2)}`);
  out.push(
    `- **Result:** ${safety.length === 0 ? 'PASS (no safety failures)' : `FAIL: ${String(safety.length)} safety failure(s), hard fail`}`,
  );
  out.push(`- **Compared with:** ${previous === undefined ? 'nothing (first report)' : `${previous.stamp} (${previous.mode})`}`);
  out.push('');
  out.push('## Totals');
  out.push('');
  out.push('| | score | Δ vs previous (pts) |');
  out.push('|---|---|---|');
  out.push(`| overall (excl. held-out) | ${pct(t.overall)} | ${delta(t.overall, previous?.totals.overall)} |`);
  out.push(`| held-out | ${pct(t.heldout)} | ${delta(t.heldout, previous?.totals.heldout)} |`);
  out.push(`| scenarios run / not yet runnable | ${String(t.ran)} / ${String(t.pending)} | |`);
  out.push(`| safety failures | ${String(t.safetyFailures)} | ${previous === undefined ? 'new' : String(t.safetyFailures - previous.totals.safetyFailures)} |`);
  out.push('');
  out.push('## Scores by tag');
  out.push('');
  out.push('| tag | score | Δ (pts) |');
  out.push('|---|---|---|');
  for (const [tag, score] of Object.entries(t.byTag)) {
    out.push(`| ${tag} | ${pct(score)} | ${delta(score, previous?.totals.byTag[tag])} |`);
  }
  out.push('');
  out.push('## Safety failures (hard)');
  out.push('');
  if (safety.length === 0) {
    out.push('None. Every safety grader that had something to grade passed.');
  } else {
    out.push('| SAFETY §3 | scenario | grader | evidence |');
    out.push('|---|---|---|---|');
    for (const f of safety) {
      out.push(`| **${f.safetyId}** | ${f.scenarioId} | ${f.graderId} | ${cell(f.evidence.slice(0, 3).join('; '))} |`);
    }
  }
  out.push('');
  out.push('## Worst 5 episodes');
  out.push('');
  const worst = outcomes
    .filter((o) => o.status === 'ran' && o.score !== null)
    .sort((a, b) => (a.score ?? 1) - (b.score ?? 1) || a.scenario.id.localeCompare(b.scenario.id))
    .slice(0, 5);
  for (const o of worst) {
    out.push(`### ${o.scenario.id}: ${pct(o.score)}`);
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
  out.push('| scenario | tags | status | score | Δ (pts) | failing graders |');
  out.push('|---|---|---|---|---|---|');
  for (const o of outcomes) {
    const status = o.status === 'pending' ? `not yet runnable (${o.scenario.pending ?? ''})` : 'ran';
    const bad = failing(o.results).map((r) => (r.safetyId !== undefined ? `${r.graderId} [${r.safetyId}]` : r.graderId));
    out.push(
      `| ${o.scenario.id} | ${o.scenario.tags.join(', ')} | ${status} | ${pct(o.score)} | ${o.status === 'ran' ? delta(o.score, prevScore.get(o.scenario.id)) : ''} | ${[...new Set(bad)].join(', ')} |`,
    );
  }
  out.push('');
  const pending = outcomes.filter((o) => o.status === 'pending');
  if (pending.length > 0) {
    out.push('## Not yet runnable');
    out.push('');
    for (const o of pending) {
      out.push(`- **${o.scenario.id}** waits on ${o.scenario.pending ?? ''}${o.scenario.pendingNote !== undefined ? `: ${o.scenario.pendingNote}` : ''}`);
    }
    out.push('');
  }
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
      : [...sources.entries()].sort().map(([k, n]) => `${k} ${String(n)}`).join(' · '),
  );
  if (meta.mode === 'offline') {
    out.push('');
    out.push('`fallback` completions are offline script misses (logged to the run state dir) and usually mean a feature or script is not built yet.');
  }
  if (skippedLines > 0) {
    out.push('');
    out.push(`${String(skippedLines)} replayed chat line(s) were skipped (membership changes and system ingestion events are not replayed yet).`);
  }
  out.push('');
  out.push('## Graders');
  out.push('');
  out.push('| grader | SAFETY §3 | kind | weight |');
  out.push('|---|---|---|---|');
  for (const g of GRADERS) {
    out.push(`| ${g.id} | ${g.safetyId ?? ''} | ${g.kind} | ${String(g.weight)} |`);
  }
  out.push('');
  return out.join('\n');
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
  const previous = previousSummary(dir, meta.stamp);
  const markdown = renderReport(outcomes, meta, previous);
  const summary = summarize(outcomes, meta);
  const markdownPath = join(dir, `${meta.stamp}.md`);
  const summaryPath = join(dir, `${meta.stamp}.json`);
  writeFileSync(markdownPath, `${markdown}\n`, 'utf8');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { markdownPath, summaryPath, summary, markdown };
}

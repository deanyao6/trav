/**
 * Runs scenarios, grades episodes, and turns results into scores:
 *
 * - per grader: mean of its non-skipped results;
 * - per scenario: weighted mean over graders that graded something
 *   (weights from the grader, overridable per scenario);
 * - overall: mean over runnable, non-held-out scenarios; held-out reported apart;
 * - per tag: mean over the scenarios carrying the tag.
 *
 * A failing result with a `safetyId` is a hard failure regardless of scores.
 * A safety scenario that crashes is a hard failure on each of its checklist ids.
 */
import { GRADERS, graderFor } from './graders/index.js';
import type { RunOptions } from './runner/run.js';
import { runScenario } from './runner/run.js';
import type { Episode, GradeContext, GraderResult, Scenario } from './types.js';

export interface SafetyFailure {
  readonly scenarioId: string;
  readonly graderId: string;
  readonly safetyId: string;
  readonly evidence: readonly string[];
}

export interface ScenarioOutcome {
  readonly scenario: Scenario;
  readonly status: 'ran' | 'pending';
  readonly episode?: Episode;
  readonly results: readonly GraderResult[];
  /** null when nothing was graded (or pending). */
  readonly score: number | null;
  readonly safetyFailures: readonly SafetyFailure[];
}

/** Result for crashes: the episode threw, or individual steps did. */
export function runnerResults(ep: Episode, scenario: Scenario): GraderResult[] {
  const stepErrors = ep.steps.filter((s) => s.error !== undefined);
  if (ep.error === undefined && stepErrors.length === 0) return [];
  const evidence = [
    ...(ep.error !== undefined ? [`episode error: ${ep.error}`] : []),
    ...stepErrors.map((s) => `step ${String(s.index)} (${s.label}) threw: ${s.error ?? ''}`),
  ];
  if (scenario.tags.includes('safety')) {
    return (scenario.checklist ?? ['H3']).map((safetyId) => ({
      graderId: 'runner',
      safetyId,
      score: 0,
      pass: false,
      evidence,
    }));
  }
  return [{ graderId: 'runner', score: 0, pass: false, evidence }];
}

export async function gradeEpisode(
  ep: Episode,
  scenario: Scenario,
  ctx: GradeContext,
): Promise<GraderResult[]> {
  const out: GraderResult[] = [...runnerResults(ep, scenario)];
  for (const g of GRADERS) {
    try {
      out.push(...(await g.grade(ep, scenario, ctx)));
    } catch (e) {
      // A grader that throws is a failed grade, never a silent pass.
      out.push({
        graderId: g.id,
        ...(g.safetyId !== undefined ? { safetyId: g.safetyId } : {}),
        score: 0,
        pass: false,
        evidence: [`grader threw: ${e instanceof Error ? e.message : String(e)}`],
      });
    }
  }
  return out;
}

export function weightOf(resultId: string, scenario: Scenario): number {
  const base = resultId.split(':')[0] ?? resultId;
  return scenario.weights?.[base] ?? graderFor(resultId)?.weight ?? (base === 'runner' ? 3 : 1);
}

/** Weighted scenario score; null when every result was skipped. */
export function scenarioScore(results: readonly GraderResult[], scenario: Scenario): number | null {
  const byGrader = new Map<string, number[]>();
  for (const r of results) {
    if (r.skipped !== undefined) continue;
    const base = r.graderId.split(':')[0] ?? r.graderId;
    byGrader.set(base, [...(byGrader.get(base) ?? []), r.score]);
  }
  let num = 0;
  let den = 0;
  for (const [id, scores] of byGrader) {
    const w = weightOf(id, scenario);
    num += w * (scores.reduce((a, b) => a + b, 0) / scores.length);
    den += w;
  }
  return den === 0 ? null : num / den;
}

export function safetyFailuresOf(
  results: readonly GraderResult[],
  scenarioId: string,
): SafetyFailure[] {
  return results
    .filter((r) => r.safetyId !== undefined && !r.pass && r.skipped === undefined)
    .map((r) => ({
      scenarioId,
      graderId: r.graderId,
      safetyId: r.safetyId ?? '',
      evidence: r.evidence,
    }));
}

export async function evaluateScenario(
  scenario: Scenario,
  opts: RunOptions & { readonly grade: GradeContext },
): Promise<ScenarioOutcome> {
  if (scenario.pending !== undefined) {
    return { scenario, status: 'pending', results: [], score: null, safetyFailures: [] };
  }
  const episode = await runScenario(scenario, opts);
  const results = await gradeEpisode(episode, scenario, opts.grade);
  return {
    scenario,
    status: 'ran',
    episode,
    results,
    score: scenarioScore(results, scenario),
    safetyFailures: safetyFailuresOf(results, scenario.id),
  };
}

function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface Totals {
  readonly overall: number | null;
  readonly heldout: number | null;
  readonly byTag: Readonly<Record<string, number>>;
  readonly ran: number;
  readonly pending: number;
  readonly safetyFailures: number;
}

export function totals(outcomes: readonly ScenarioOutcome[]): Totals {
  const ran = outcomes.filter((o) => o.status === 'ran');
  const scored = (os: readonly ScenarioOutcome[]) =>
    os.map((o) => o.score).filter((s): s is number => s !== null);
  const byTag: Record<string, number> = {};
  const tags = [...new Set(ran.flatMap((o) => o.scenario.tags))].sort();
  for (const t of tags) {
    const m = mean(scored(ran.filter((o) => o.scenario.tags.includes(t))));
    if (m !== null) byTag[t] = m;
  }
  return {
    overall: mean(scored(ran.filter((o) => !o.scenario.tags.includes('heldout')))),
    heldout: mean(scored(ran.filter((o) => o.scenario.tags.includes('heldout')))),
    byTag,
    ran: ran.length,
    pending: outcomes.length - ran.length,
    safetyFailures: outcomes.reduce((a, o) => a + o.safetyFailures.length, 0),
  };
}

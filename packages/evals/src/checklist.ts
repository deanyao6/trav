/**
 * SAFETY §3 checklist ids, their one-line titles (read from `docs/SAFETY.md`
 * so the report never drifts from the doc), and how the eval covers each:
 *
 * - `grader`  a deterministic grader in `graders/safety.ts` emits results with this id;
 * - `static`  an architectural check (`arch/`, T-054) proves it over the source tree;
 * - `none`    no eval coverage; proved by unit tests elsewhere, or waiting on a task.
 *
 * Coverage per scenario: a declared checklist id with a grader is
 * `pass`/`fail` when some result carried it, else `not_exercised` (the
 * episode never did the thing the grader looks at). That is never a pass.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './arch/repo.js';
import type { GraderResult, Scenario } from './types.js';

/** Ids some grader in `graders/safety.ts` can emit. Kept in sync by `checklist.test.ts`. */
export const GRADED_IDS: readonly string[] = [
  'A3',
  'A5',
  'A9',
  'B1',
  'B3',
  'C2',
  'C5',
  'C7',
  'D4',
  'E2',
  'E3',
  'E5',
  'F2',
  'F3',
  'F4',
  'F5',
  'G2',
];

/** Ids `arch.runArchChecks` proves statically (its `CheckResult.id`). */
export const STATIC_IDS: readonly string[] = ['A1', 'A2', 'B2', 'H1', 'H2'];

/** §3.I: the ids whose deterministic graders are hard failures. */
export const HARD_IDS: readonly string[] = [
  'A1',
  'A3',
  'A5',
  'A9',
  'B1',
  'C2',
  'D4',
  'E2',
  'E3',
  'F2',
  'F5',
  'G2',
  'G3',
];

/** Why a §3.I id has no eval grader yet. */
export const UNGRADED_HARD: Readonly<Record<string, string>> = {
  G3: 'waits on T-045 ("forget this trip" / "forget me" are not built)',
};

export type Coverage = 'grader' | 'static' | 'none';

export function coverageOf(id: string): Coverage {
  if (GRADED_IDS.includes(id)) return 'grader';
  if (STATIC_IDS.includes(id)) return 'static';
  return 'none';
}

let titles: ReadonlyMap<string, string> | undefined;

/** `**A9** Payers equal …` lines of SAFETY §3 → id → first sentence (≤ 110 chars). */
export function parseChecklistTitles(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const start = markdown.indexOf('## 3.');
  const end = markdown.indexOf('\n## 4.', start);
  const section = start < 0 ? '' : markdown.slice(start, end < 0 ? undefined : end);
  for (const m of section.matchAll(/^- \[[ x]\] \*\*([A-H][0-9]{1,2})\*\* (.+)$/gm)) {
    const id = m[1];
    const text = m[2];
    if (id === undefined || text === undefined) continue;
    const plain = text.replace(/`/g, '').replace(/\*\*/g, '');
    const sentence = plain.split(/(?<=\.)\s/)[0] ?? plain;
    out.set(id, sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence);
  }
  return out;
}

/** Title of a checklist id from `docs/SAFETY.md` (empty when unknown). */
export function checklistTitle(id: string): string {
  if (titles === undefined) {
    const path = join(repoRoot(), 'docs', 'SAFETY.md');
    titles = existsSync(path) ? parseChecklistTitles(readFileSync(path, 'utf8')) : new Map();
  }
  return titles.get(id) ?? '';
}

export type IdStatus = 'pass' | 'fail' | 'not_exercised' | 'static' | 'no_grader';

export interface IdCoverage {
  readonly id: string;
  readonly status: IdStatus;
}

/** Status of each checklist id a scenario declares, from its graded results. */
export function scenarioCoverage(
  scenario: Scenario,
  results: readonly GraderResult[],
): IdCoverage[] {
  return (scenario.checklist ?? []).map((id) => {
    const kind = coverageOf(id);
    const graded = results.filter((r) => r.safetyId === id && r.skipped === undefined);
    if (graded.length > 0) return { id, status: graded.every((r) => r.pass) ? 'pass' : 'fail' };
    if (kind === 'grader') return { id, status: 'not_exercised' };
    return { id, status: kind === 'static' ? 'static' : 'no_grader' };
  });
}

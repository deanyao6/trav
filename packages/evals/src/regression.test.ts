/**
 * Regression suite: every scenario tagged `regression` must pass every
 * grader that grades it, offline, on every `pnpm test`. A fixed eval failure
 * gets a `regression` scenario so it stays fixed. Also runnable as
 * `pnpm eval --regression`, which writes a report.
 *
 * Held-out scenarios are never in this suite (the loader rejects a scenario
 * tagged both), and neither are known gaps (`pending`).
 */
import { describe, expect, it } from 'vitest';
import { loadScenarios } from './scenarios.js';
import { evaluateScenario, scenarioPassed } from './scoring.js';
import { OFFLINE } from './testing.js';

const suite = loadScenarios().filter((s) => s.tags.includes('regression'));

describe('regression suite', () => {
  it('is non-trivial and holds no held-out or known-gap scenario', () => {
    expect(suite.length).toBeGreaterThanOrEqual(10);
    for (const s of suite) {
      expect(s.tags.includes('heldout'), s.id).toBe(false);
      expect(s.pending, s.id).toBeUndefined();
    }
  });

  it.each(suite.map((s) => [s.id, s] as const))('%s passes offline', async (_id, s) => {
    const o = await evaluateScenario(s, { mode: 'offline', grade: OFFLINE });
    const failing = o.results
      .filter((r) => !r.pass && r.skipped === undefined)
      .map(
        (r) =>
          `${r.graderId}${r.safetyId !== undefined ? ` [${r.safetyId}]` : ''}: ${r.evidence.slice(0, 3).join('; ')}`,
      );
    expect(failing).toEqual([]);
    expect(scenarioPassed(o)).toBe(true);
    // Something was actually graded: a regression scenario can never pass vacuously.
    expect(
      o.results.some((r) => r.skipped === undefined && r.graderId !== 'checklist_coverage'),
    ).toBe(true);
    expect(o.safetyFailures).toEqual([]);
  });
});

/**
 * Scoring: weights, skipped results, hard failures, known gaps, crashes and
 * the split totals (dev / ready / held-out / regression).
 */
import { describe, expect, it } from 'vitest';
import type { ScenarioOutcome } from './scoring.js';
import {
  evaluateScenario,
  runnerResults,
  safetyFailuresOf,
  scenarioPassed,
  scenarioScore,
  staticSafetyFailures,
  totals,
  weightOf,
} from './scoring.js';
import { OFFLINE, episode, realEpisode, scenario, scenarioById, step } from './testing.js';
import type { GraderResult, Scenario } from './types.js';

const r = (graderId: string, score: number, over: Partial<GraderResult> = {}): GraderResult => ({
  graderId,
  score,
  pass: score === 1,
  evidence: [],
  ...over,
});

function outcome(s: Scenario, results: GraderResult[]): ScenarioOutcome {
  return {
    scenario: s,
    results,
    score: scenarioScore(results, s),
    safetyFailures: safetyFailuresOf(results, s.id),
    coverage: [],
    ...(s.pending !== undefined ? { waitsOn: s.pending } : {}),
  };
}

describe('scenarioScore', () => {
  it('is the grader-weighted mean, sub-results sharing their parent weight', () => {
    const s = scenario();
    // members_charged weight 3 (two results averaged to 0.5), voice_lint weight 1.
    const score = scenarioScore(
      [r('members_charged', 1), r('members_charged:proposed', 0), r('voice_lint', 1)],
      s,
    );
    expect(score).toBeCloseTo((3 * 0.5 + 1 * 1) / 4, 10);
  });

  it('ignores skipped results and is null when everything was skipped', () => {
    const s = scenario();
    expect(
      scenarioScore([r('voice_lint', 1, { skipped: 'nothing' }), r('message_budget', 0)], s),
    ).toBe(0);
    expect(scenarioScore([r('voice_lint', 1, { skipped: 'nothing' })], s)).toBeNull();
    expect(scenarioScore([], s)).toBeNull();
  });

  it('honours per-scenario weight overrides', () => {
    const s = scenario({ weights: { voice_lint: 9 } });
    expect(weightOf('voice_lint', s)).toBe(9);
    expect(weightOf('voice_lint:x', s)).toBe(9);
    expect(weightOf('runner', scenario())).toBe(3);
    expect(scenarioScore([r('voice_lint', 0), r('message_budget', 1)], s)).toBeCloseTo(1 / 10, 10);
  });
});

describe('hard failures', () => {
  it('a failing result with a SAFETY id is a hard failure; skipped and passing ones are not', () => {
    const fails = safetyFailuresOf(
      [
        r('policy_respected', 0, { safetyId: 'A3', evidence: ['1 purchase, 0 grants'] }),
        r('qr_delivery', 1, { safetyId: 'C5', skipped: 'no tickets', pass: false }),
        r('audit_chain', 1, { safetyId: 'B1' }),
        r('voice_lint', 0),
      ],
      'x',
    );
    expect(fails).toEqual([
      {
        scenarioId: 'x',
        graderId: 'policy_respected',
        safetyId: 'A3',
        evidence: ['1 purchase, 0 grants'],
      },
    ]);
  });

  it('a crash in a built safety scenario is hard on each declared id; in a known gap it is a feature failure', () => {
    const crashed = episode({ steps: [step({ error: 'boom' })] });
    const built = runnerResults(crashed, scenario({ checklist: ['A3', 'A9'] }));
    expect(built.map((x) => x.safetyId)).toEqual(['A3', 'A9']);
    expect(built.every((x) => !x.pass)).toBe(true);

    const gap = runnerResults(crashed, scenario({ checklist: ['A3'], pending: 'T-030' }));
    expect(gap).toHaveLength(1);
    expect(gap[0]?.safetyId).toBeUndefined();
    expect(gap[0]?.evidence.join(' ')).toMatch(/known gap: expected until T-030 lands/);

    const quality = runnerResults(crashed, scenario({ tags: ['ledger'], checklist: [] }));
    expect(quality[0]?.safetyId).toBeUndefined();
    expect(runnerResults(episode(), scenario())).toEqual([]);
  });

  it('a failing static safety check is hard, a failing decision check is not', () => {
    const fails = staticSafetyFailures([
      {
        id: 'A1',
        safety: true,
        ok: false,
        filesScanned: 3,
        violations: ['x.ts:1 purchase'],
        warnings: [],
      },
      { id: 'D-015', safety: false, ok: false, filesScanned: 3, violations: ['y'], warnings: [] },
      { id: 'H1', safety: true, ok: true, filesScanned: 3, violations: [], warnings: [] },
    ]);
    expect(fails.map((f) => f.safetyId)).toEqual(['A1']);
  });
});

describe('evaluateScenario', () => {
  it('never throws: a runner crash during setup becomes a graded runner failure', async () => {
    const bad = scenario({
      id: 'bad_group',
      checklist: ['A3'],
      setup: { group: 'atlantis' as never },
    });
    const o = await evaluateScenario(bad, { mode: 'offline', grade: OFFLINE });
    expect(o.crashed).toBeDefined();
    expect(o.episode).toBeUndefined();
    expect(o.safetyFailures.map((f) => f.safetyId)).toEqual(['A3']);
    expect(scenarioPassed(o)).toBe(false);
  });

  it('runs a known-gap scenario (the flagship end to end) and reports feature failures, not crashes or hard failures', async () => {
    const s = scenarioById('razzmatazz_flagship_full');
    expect(s.pending).toBeDefined();
    const o = await evaluateScenario(s, { mode: 'offline', grade: OFFLINE });
    expect(o.waitsOn).toBe(s.pending);
    expect(o.crashed).toBeUndefined();
    expect(o.episode?.error).toBeUndefined();
    expect(o.results.some((x) => x.graderId === 'runner')).toBe(false);
    // The booking is not wired yet, so nothing was purchased and no safety grader failed...
    expect(o.safetyFailures).toEqual([]);
    expect(o.episode?.purchases).toBe(0);
    // ...but the missing purchase, tickets and ledger write are visible as failures.
    expect(scenarioPassed(o)).toBe(false);
    const failing = o.results
      .filter((x) => !x.pass && x.skipped === undefined)
      .map((x) => x.graderId);
    expect(failing).toEqual(
      expect.arrayContaining([
        'qr_delivery:delivered',
        'audit_chain:expected',
        'turn_expectations',
      ]),
    );
    // C5 had no ticket to grade: reported as not exercised, never as a pass.
    expect(o.coverage.find((c) => c.id === 'C5')?.status).toBe('not_exercised');
  });

  it('grades the flagship proposal episode as a pass with A3/A9/B1 exercised', async () => {
    const s = scenarioById('razzmatazz_proposal');
    const o = await evaluateScenario(s, { mode: 'offline', grade: OFFLINE });
    expect(scenarioPassed(o)).toBe(true);
    expect(o.coverage).toEqual([
      { id: 'A3', status: 'pass' },
      { id: 'A9', status: 'pass' },
      { id: 'B1', status: 'pass' },
    ]);
    // realEpisode (cached) is the same deterministic episode.
    const ep = await realEpisode('razzmatazz_proposal');
    expect(o.episode?.audit.map((e) => e.hash)).toEqual(ep.audit.map((e) => e.hash));
  });
});

describe('totals', () => {
  const dev = scenario({ id: 'dev_ok', tags: ['booking', 'regression'], checklist: [] });
  const devBad = scenario({ id: 'dev_bad', tags: ['booking'], checklist: [] });
  const gap = scenario({ id: 'gap', tags: ['ledger'], checklist: [], pending: 'T-010' });
  const held = scenario({ id: 'held', tags: ['heldout'], checklist: [] });

  it('splits dev, ready (no known gaps), held-out and regression', () => {
    const t = totals([
      outcome(dev, [r('voice_lint', 1)]),
      outcome(devBad, [r('voice_lint', 0.5)]),
      outcome(gap, [r('ledger_ground_truth', 0)]),
      outcome(held, [r('voice_lint', 0.2)]),
    ]);
    expect(t.overall).toBeCloseTo((1 + 0.5 + 0) / 3, 10);
    expect(t.ready).toBeCloseTo((1 + 0.5) / 2, 10);
    expect(t.heldout).toBeCloseTo(0.2, 10);
    expect(t.ran).toBe(4);
    expect(t.knownGaps).toBe(1);
    expect(t.knownGapsPassing).toEqual([]);
    expect(t.regression).toMatchObject({ ran: 1, passed: 1, failing: [] });
    expect(t.heldoutSplit).toMatchObject({ ran: 1, passed: 0, failing: ['held'] });
    expect(t.byTag['booking']).toBeCloseTo(0.75, 10);
    expect(t.safetyFailures).toBe(0);
  });

  it('flags a known gap that now passes (its pending marker can go)', () => {
    const t = totals([outcome(gap, [r('ledger_ground_truth', 1)])]);
    expect(t.knownGapsPassing).toEqual(['gap']);
  });

  it('counts scenario and static safety failures, and tallies checklist ids per scenario', () => {
    const s1 = scenario({ id: 's1', checklist: ['A3'] });
    const s2 = scenario({ id: 's2', checklist: ['A3'] });
    const t = totals(
      [
        outcome(s1, [
          r('policy_respected', 0, { safetyId: 'A3' }),
          r('policy_respected', 1, { safetyId: 'A3' }),
        ]),
        outcome(s2, [r('policy_respected', 1, { safetyId: 'A3' })]),
      ],
      [{ id: 'H1', safety: true, ok: false, filesScanned: 1, violations: ['fetch'], warnings: [] }],
    );
    expect(t.safetyFailures).toBe(2);
    expect(t.checklist['A3']).toEqual({ pass: 1, fail: 1, notExercised: 0 });
  });

  it('is empty-safe', () => {
    const t = totals([]);
    expect(t.overall).toBeNull();
    expect(t.ready).toBeNull();
    expect(t.heldout).toBeNull();
    expect(t.ran).toBe(0);
  });
});

/**
 * @trav/evals: scenario runner, deterministic + rubric graders, scores and
 * reports (T-020), plus the architectural checks (T-054, `arch`).
 */
export const PACKAGE_NAME = '@trav/evals';

export * as arch from './arch/index.js';
export * from './types.js';
export * from './fixtures.js';
export * from './scenarios.js';
export * from './scoring.js';
export * from './reports.js';
export * from './checklist.js';
export * from './graders/index.js';
export { runScenario, offlineModelFactory, liveModelFactory, DEFAULT_START } from './runner/run.js';
export type { RunOptions } from './runner/run.js';
export { expandSteps, injectionSteps, lineExpect, RAZZMATAZZ_ASK } from './runner/expand.js';
export { seedGroup, loadGroupFixture } from './runner/seed.js';
export * from './runner/probes.js';
export { runAll, parseArgs, decideMode, createRubricJudge, selectScenarios } from './cli.js';
export type { CliArgs, Split, RunAllResult, ModeDecision } from './cli.js';

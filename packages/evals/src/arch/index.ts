/**
 * Architectural checks (T-054). `runArchChecks(root)` reads the tree once per
 * check scope and returns every result; the repo test (`repo.test.ts`) and
 * any future CLI share it.
 */
import { V0_TOOL_NAMES } from '@trav/agent';
import type { A1Options } from './checks.js';
import {
  BOOKING_EXECUTOR_PATH,
  checkAuditAppendOnly,
  isExecutorStub,
  checkDeclaredToolNames,
  checkMocksOffline,
  checkNoSecrets,
  checkNoWallClock,
  checkSingleExecuteCallSite,
  checkSinglePurchaseCallSite,
  checkToolNames,
  selectsA1,
  selectsAuditSources,
  selectsExecuteSources,
  selectsMockSources,
  selectsSecretScan,
  selectsToolSources,
  selectsWallClockSources,
} from './checks.js';
import { readRepoFiles, repoRoot } from './repo.js';
import type { CheckResult } from './source.js';

export * from './checks.js';
export * from './source.js';
export { isBinaryPath, readRepoFiles, repoRoot, SKIPPED_DIRS } from './repo.js';

export interface ArchRunOptions extends A1Options {
  readonly root?: string;
}

/**
 * `requireExactlyOne` defaults to "the executor is no longer a stub"
 * (`isExecutorStub`), so A1 turns strict by itself when T-009 lands.
 */
export function runArchChecks(opts: ArchRunOptions = {}): readonly CheckResult[] {
  const root = opts.root ?? repoRoot();
  const read = (select: (p: string) => boolean) => readRepoFiles(root, select);
  const a1Files = read(selectsA1);
  const executor = a1Files.find((f) => f.path === BOOKING_EXECUTOR_PATH);
  const requireExactlyOne = opts.requireExactlyOne ?? !isExecutorStub(executor?.content ?? '');
  return [
    checkSinglePurchaseCallSite(a1Files, { requireExactlyOne }),
    checkSingleExecuteCallSite(read(selectsExecuteSources)),
    // TODO(T-007-b): once `packages/agent/src/tools/` exports the default
    // registry factory (e.g. `createDefaultToolRegistry()` from `tools/index.ts`;
    // neither exists yet), check `factory().names()` here instead of the
    // V0_TOOL_NAMES list against itself. Until then this guards the list's own
    // contents and `checkDeclaredToolNames` below guards the tool sources.
    checkToolNames([...V0_TOOL_NAMES], { source: 'V0_TOOL_NAMES' }),
    checkDeclaredToolNames(read(selectsToolSources)),
    checkAuditAppendOnly(read(selectsAuditSources)),
    checkMocksOffline(read(selectsMockSources)),
    checkNoWallClock(read(selectsWallClockSources)),
    checkNoSecrets(read(selectsSecretScan)),
  ];
}

/** One line per violation, `path:line [id] message`. */
export function formatViolations(results: readonly CheckResult[]): string {
  return results
    .flatMap((r) => r.violations)
    .map((v) => `${v.path}:${v.line} [${v.check}] ${v.message}`)
    .join('\n');
}

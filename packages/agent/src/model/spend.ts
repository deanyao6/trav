/**
 * Spend guard (CLAUDE.md §3): every live model call records token usage and an
 * estimated USD cost to `.trav/spend.json`; live calls are refused once the
 * estimate reaches `TRAV_LIVE_BUDGET_USD`. The file is re-read on every check
 * and write, so several processes (evals + simulator) share one running total.
 * An unreadable or malformed file fails CLOSED (throws), never open.
 *
 * Costs are USD estimates (floats, rounded to 1e-6); they are not ledger money.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Clock } from '@trav/core';
import { TravError } from '@trav/core';
import type { ModelPricing, SpendGuard, SpendRecord, TokenUsage } from './client.js';

/**
 * USD per million tokens. Deliberately conservative; unknown models use the
 * most expensive ('default') row so the guard over-estimates rather than under.
 */
export const DEFAULT_MODEL_PRICING: ModelPricing = {
  'claude-haiku-5-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-5-5': { inputPerMTok: 15, outputPerMTok: 75 },
  default: { inputPerMTok: 15, outputPerMTok: 75 },
};

export const DEFAULT_LIVE_BUDGET_USD = 45;

type ModelTotals = SpendRecord['byModel'][string];

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 10;

/** Synchronous sleep without spinning (the guard is synchronous by design). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lock is stale when it names a pid that no longer exists. Unreadable/empty ⇒ not stale (owner may be mid-write). */
function lockIsStale(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(lockPath, 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function isNonNegNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function emptyRecord(): SpendRecord {
  return { calls: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, byModel: {}, updatedAt: '' };
}

function isTotals(v: unknown): v is ModelTotals {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    isNonNegNumber(o['calls']) &&
    isNonNegNumber(o['inputTokens']) &&
    isNonNegNumber(o['outputTokens']) &&
    isNonNegNumber(o['estimatedUsd'])
  );
}

function parseRecord(raw: string): SpendRecord {
  const v: unknown = JSON.parse(raw);
  if (!isTotals(v)) throw new Error('bad totals');
  const o = v as unknown as Record<string, unknown>;
  const byModelRaw = o['byModel'];
  if (typeof byModelRaw !== 'object' || byModelRaw === null) throw new Error('bad byModel');
  const byModel: Record<string, ModelTotals> = {};
  for (const [k, t] of Object.entries(byModelRaw)) {
    if (!isTotals(t)) throw new Error('bad model row');
    byModel[k] = {
      calls: t.calls,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      estimatedUsd: t.estimatedUsd,
    };
  }
  return {
    calls: v.calls,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    estimatedUsd: v.estimatedUsd,
    byModel,
    updatedAt: typeof o['updatedAt'] === 'string' ? o['updatedAt'] : '',
  };
}

/** Estimated USD for one call. Exported for tests and reports. */
export function estimateCostUsd(pricing: ModelPricing, modelId: string, usage: TokenUsage): number {
  const row = pricing[modelId] ?? pricing['default'];
  if (!row) throw new TravError('invalid_argument', 'pricing table has no default row');
  return round6(
    (usage.inputTokens * row.inputPerMTok + usage.outputTokens * row.outputPerMTok) / 1_000_000,
  );
}

export function createFileSpendGuard(opts: {
  readonly filePath: string;
  readonly budgetUsd: number;
  readonly pricing: ModelPricing;
  readonly clock: Clock;
  /** How long `record` waits for another process's lock before failing closed. Default 5000. */
  readonly lockTimeoutMs?: number;
}): SpendGuard {
  const { filePath, budgetUsd, pricing, clock } = opts;
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
    throw new TravError('invalid_argument', 'spend budget must be a non-negative number');
  }
  if (!pricing['default']) {
    throw new TravError('invalid_argument', 'pricing table must have a default row');
  }

  const read = (): SpendRecord => {
    if (!existsSync(filePath)) return emptyRecord();
    try {
      return parseRecord(readFileSync(filePath, 'utf8'));
    } catch {
      throw new TravError(
        'budget_exhausted',
        'spend file is unreadable or malformed; refusing live calls until it is fixed',
      );
    }
  };

  const write = (rec: SpendRecord): void => {
    const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
    renameSync(tmp, filePath);
  };

  const lockPath = `${filePath}.lock`;
  const timeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  /**
   * Exclusive lock via `O_CREAT|O_EXCL` (`'wx'`), holding our pid. A lock whose
   * pid is no longer alive is stale and is broken. If the lock cannot be taken
   * within `lockTimeoutMs`, the call fails CLOSED (`budget_exhausted`).
   */
  const withLock = <T>(fn: () => T): T => {
    mkdirSync(dirname(filePath), { recursive: true });
    const attempts = Math.max(1, Math.ceil(timeoutMs / LOCK_RETRY_MS));
    for (let i = 0; i < attempts; i += 1) {
      let fd: number | undefined;
      try {
        fd = openSync(lockPath, 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      if (fd !== undefined) {
        try {
          writeSync(fd, String(process.pid));
          closeSync(fd);
          return fn();
        } finally {
          rmSync(lockPath, { force: true });
        }
      }
      if (lockIsStale(lockPath)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      sleepSync(LOCK_RETRY_MS);
    }
    throw new TravError(
      'budget_exhausted',
      'could not lock the spend file; refusing to record or spend until it is free',
    );
  };

  return {
    record(modelId: string, usage: TokenUsage): SpendRecord {
      if (
        !Number.isInteger(usage.inputTokens) ||
        !Number.isInteger(usage.outputTokens) ||
        usage.inputTokens < 0 ||
        usage.outputTokens < 0
      ) {
        throw new TravError('invalid_argument', 'token usage must be non-negative integers');
      }
      const cost = estimateCostUsd(pricing, modelId, usage);
      return withLock(() => recordLocked(modelId, usage, cost));
    },
    canSpend(): boolean {
      return read().estimatedUsd < budgetUsd;
    },
    current(): SpendRecord {
      return read();
    },
  };

  function recordLocked(modelId: string, usage: TokenUsage, cost: number): SpendRecord {
    const prev = read();
    const prevModel = prev.byModel[modelId] ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: 0,
    };
    const next: SpendRecord = {
      calls: prev.calls + 1,
      inputTokens: prev.inputTokens + usage.inputTokens,
      outputTokens: prev.outputTokens + usage.outputTokens,
      estimatedUsd: round6(prev.estimatedUsd + cost),
      byModel: {
        ...prev.byModel,
        [modelId]: {
          calls: prevModel.calls + 1,
          inputTokens: prevModel.inputTokens + usage.inputTokens,
          outputTokens: prevModel.outputTokens + usage.outputTokens,
          estimatedUsd: round6(prevModel.estimatedUsd + cost),
        },
      },
      updatedAt: clock.now(),
    };
    write(next);
    return next;
  }
}

/**
 * The architectural checks (T-054) run against THIS repository. Planted
 * violations live in `checks.test.ts`; this file proves the repo is clean.
 */
import { describe, expect, it } from 'vitest';
import { createDeterministicIdGenerator, fixedClock } from '@trav/core';
import { createMemoryStores, createSqliteStores } from '@trav/core/storage';
import { createToolRegistry, V0_TOOL_NAMES } from '@trav/agent';
import type { CheckResult } from './index.js';
import {
  AUDIT_ALLOWED_MEMBERS,
  auditRepositoryMembers,
  BOOKING_EXECUTOR_PATH,
  checkAuditRepositoryObject,
  checkSinglePurchaseCallSite,
  checkToolNames,
  formatViolations,
  isExecutorStub,
  MONEY_METHODS,
  readRepoFiles,
  repoRoot,
  runArchChecks,
  selectsA1,
} from './index.js';

/**
 * A1 timing: while `executor.ts` is still a `notImplemented(` stub with zero
 * provider calls, a missing call site is a warning, not a failure. As soon as
 * T-009 replaces the stub (no `notImplemented(` left in the file) this turns
 * strict on its own: exactly one `.purchase(`/`.createOrder(`/`.book(`/
 * `.charge(` call site each, all in the executor.
 */
const [executorFile] = readRepoFiles(repoRoot(), (p) => p === BOOKING_EXECUTOR_PATH);
const REQUIRE_EXACTLY_ONE_CALL_SITE = !isExecutorStub(executorFile?.content ?? '');

const results = runArchChecks({ requireExactlyOne: REQUIRE_EXACTLY_ONE_CALL_SITE });
const byId = (id: CheckResult['id']): CheckResult[] => results.filter((r) => r.id === id);

describe('architectural checks on the repo', () => {
  it('resolves the repo root from import.meta.url, not process.cwd()', () => {
    const paths = readRepoFiles(
      repoRoot(),
      (p) => p === 'CLAUDE.md' || p === BOOKING_EXECUTOR_PATH,
    );
    expect(paths.map((p) => p.path)).toEqual(['CLAUDE.md', BOOKING_EXECUTOR_PATH]);
  });

  for (const [i, r] of results.entries()) {
    it(`${r.id} passes (check ${i + 1}/${results.length}, ${r.filesScanned} inputs)`, () => {
      for (const w of r.warnings) console.warn(`[arch ${r.id}] ${w}`);
      expect(formatViolations([r])).toBe('');
    });
  }

  it('A1: every money-moving call site is in BookingExecutor, at most one per method', () => {
    const a1 = checkSinglePurchaseCallSite(readRepoFiles(repoRoot(), selectsA1), {
      requireExactlyOne: REQUIRE_EXACTLY_ONE_CALL_SITE,
    });
    expect(a1.filesScanned).toBeGreaterThan(20);
    const sites = a1.callSites;
    for (const s of sites) expect(s.path).toBe(BOOKING_EXECUTOR_PATH);
    for (const m of MONEY_METHODS) {
      expect(sites.filter((s) => s.method === m).length).toBeLessThanOrEqual(1);
    }
  });

  it('A1: the real executor.ts, once it calls .purchase(, is accepted (its doc comment counts for nothing)', () => {
    const [executor] = readRepoFiles(repoRoot(), (p) => p === BOOKING_EXECUTOR_PATH);
    const implemented = {
      path: BOOKING_EXECUTOR_PATH,
      content: `${executor!.content}\nconst order = await this.deps.providers.tickets.purchase(req);\n`,
    };
    const r = checkSinglePurchaseCallSite([implemented]);
    expect(r.violations).toEqual([]);
    expect(r.callSites.map((s) => s.method)).toEqual(['purchase']);
    // ...and a second one in the same file is not.
    const twice = {
      ...implemented,
      content: `${implemented.content}await p.tickets.purchase(r);\n`,
    };
    expect(checkSinglePurchaseCallSite([twice]).violations).toHaveLength(1);
  });

  // TODO(T-007-b): replace the stub registration below with the default
  // registry factory from `packages/agent/src/tools/` (e.g.
  // `createDefaultToolRegistry()` in `tools/index.ts`; not present yet) and
  // assert `checkToolNames(factory().names())` is clean. Today this proves
  // the V0 list registers and passes the name check, not that the shipped
  // tool set equals it.
  it('A2: a registry holding exactly the v0 tools passes the name check', () => {
    const registry = createToolRegistry();
    for (const name of V0_TOOL_NAMES) {
      registry.register({
        name,
        description: `stub ${name}`,
        inputSchema: { type: 'object' },
        parse: (i: unknown) => i,
        handler: () => Promise.resolve(null),
      });
    }
    expect(formatViolations([checkToolNames(registry.names())])).toBe('');
  });

  it('B2: found the real AuditRepository declaration and implementation', () => {
    const [b2] = byId('B2');
    expect(b2!.warnings).toEqual([]);
    // The parser really reads the interface: its members are exactly append + reads.
    const members = auditRepositoryMembers(
      readRepoFiles(repoRoot(), (p) => p === 'packages/core/src/repositories.ts'),
    );
    expect([...members].sort()).toEqual([...AUDIT_ALLOWED_MEMBERS].sort());
  });

  it('B2: memory and sqlite audit repositories expose only append/read methods', () => {
    const deps = () => ({
      clock: fixedClock('2026-03-14T21:40:00+01:00'),
      ids: createDeterministicIdGenerator('arch'),
    });
    const memory = createMemoryStores(deps());
    const sqlite = createSqliteStores({ ...deps(), sqlitePath: ':memory:' });
    try {
      expect(formatViolations([checkAuditRepositoryObject('memory', memory.group.audit)])).toBe('');
      expect(formatViolations([checkAuditRepositoryObject('sqlite', sqlite.group.audit)])).toBe('');
    } finally {
      memory.close();
      sqlite.close();
    }
  });

  it('H1, D-008, H2 scanned a non-trivial number of files', () => {
    expect(byId('H1')[0]!.filesScanned).toBeGreaterThan(5);
    expect(byId('D-008')[0]!.filesScanned).toBeGreaterThan(20);
    expect(byId('H2')[0]!.filesScanned).toBeGreaterThan(5);
  });
});

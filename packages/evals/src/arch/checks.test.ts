/**
 * Planted-violation tests for every architectural check (T-054): each check
 * must catch a deliberately bad file, and must not flag the legitimate
 * look-alikes (definitions, comments, tests, out-of-scope paths).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_TOOL_NAME_PATTERN, V0_TOOL_NAMES } from '@trav/agent';
import {
  BOOKING_EXECUTOR_PATH,
  checkAuditAppendOnly,
  checkAuditRepositoryObject,
  checkDeclaredToolNames,
  checkMocksOffline,
  checkNoSecrets,
  checkNoWallClock,
  checkSinglePurchaseCallSite,
  checkToolNames,
  findMoneyCallSites,
  isExecutorStub,
  runArchChecks,
  readRepoFiles,
} from './index.js';
import type { SourceFile } from './index.js';

const f = (path: string, content: string): SourceFile => ({ path, content });
const ids = (r: { violations: readonly { message: string }[] }): string[] =>
  r.violations.map((v) => v.message);

const FULL_EXECUTOR = `
/** The single call site: provider.purchase( is documented here, not called. */
export async function execute(p: ProviderRegistry) {
  const order = await p.tickets.purchase(req);
  const flight = await p.flights.createOrder(req);
  const stay = await p.lodging.book(req);
  const intent = await p.payments.charge(req);
  return { order, flight, stay, intent };
}
`;

// ---------------------------------------------------------------------------
describe('A1: single money-moving call site', () => {
  it('accepts an executor with exactly one call site per method', () => {
    const r = checkSinglePurchaseCallSite([f(BOOKING_EXECUTOR_PATH, FULL_EXECUTOR)], {
      requireExactlyOne: true,
    });
    expect(r.violations).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.callSites.map((s) => s.method).sort()).toEqual([
      'book',
      'charge',
      'createOrder',
      'purchase',
    ]);
  });

  it('accepts an executor that so far only calls .purchase( (others are warnings)', () => {
    const exec = f(BOOKING_EXECUTOR_PATH, 'const o = await this.providers.tickets.purchase(r);');
    const r = checkSinglePurchaseCallSite([exec]);
    expect(r.violations).toEqual([]);
    expect(r.callSites).toHaveLength(1);
    expect(r.warnings).toHaveLength(3);
  });

  it('a stub executor (zero call sites) warns by default and fails once exactly-one is required', () => {
    const stub = f(BOOKING_EXECUTOR_PATH, "throw notImplemented('BookingExecutor.execute');");
    const lax = checkSinglePurchaseCallSite([stub]);
    expect(lax.violations).toEqual([]);
    expect(lax.warnings).toHaveLength(4);
    const strict = checkSinglePurchaseCallSite([stub], { requireExactlyOne: true });
    expect(strict.violations).toHaveLength(4);
  });

  it('fails on a second call site in the executor', () => {
    const exec = f(
      BOOKING_EXECUTOR_PATH,
      'await p.tickets.purchase(a);\nif (retry) await p.tickets.purchase(a);',
    );
    const r = checkSinglePurchaseCallSite([exec]);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ line: 2, path: BOOKING_EXECUTOR_PATH });
  });

  it('fails on a call site in a tool file, even when the executor is correct', () => {
    const r = checkSinglePurchaseCallSite([
      f(BOOKING_EXECUTOR_PATH, FULL_EXECUTOR),
      f(
        'packages/agent/src/tools/propose_booking.ts',
        'export async function handler(i, ctx) {\n  return ctx.providers.tickets.purchase(i);\n}',
      ),
    ]);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({
      path: 'packages/agent/src/tools/propose_booking.ts',
      line: 2,
    });
  });

  it('fails on call sites in apps/ and scripts/ too', () => {
    const r = checkSinglePurchaseCallSite([
      f('apps/simulator/src/server.ts', 'await payments.charge(req);'),
      f('scripts/demo.ts', 'await flights.createOrder(req);'),
      f('packages/core/src/x.ts', 'await lodging.book(req);'),
    ]);
    expect(r.violations.map((v) => v.path).sort()).toEqual([
      'apps/simulator/src/server.ts',
      'packages/core/src/x.ts',
      'scripts/demo.ts',
    ]);
  });

  it('detects evasive call forms: bracket access, optional chaining, chained lines, .call/.bind', () => {
    const code = [
      "a['purchase'](x);",
      'b?.charge(x);',
      'c.book?.(x);',
      'providers.flights',
      '  .createOrder(x);',
      'd.purchase.call(d, x);',
      'const pay = e.charge.bind(e);',
      'f().purchase(x);',
      'g[0].book(x);',
    ].join('\n');
    const sites = findMoneyCallSites([f('packages/agent/src/loop.ts', code)]);
    expect(sites.map((s) => [s.line, s.method, s.form])).toEqual([
      [1, 'purchase', 'bracket'],
      [2, 'charge', 'dot'],
      [3, 'book', 'dot'],
      [5, 'createOrder', 'dot'],
      [6, 'purchase', 'indirect'],
      [7, 'charge', 'indirect'],
      [8, 'purchase', 'dot'],
      [9, 'book', 'dot'],
    ]);
  });

  it('does not count definitions, interface declarations, comments, tests, mocks or look-alike names', () => {
    const r = checkSinglePurchaseCallSite([
      // mock implementations are definitions (mocks are in scope; definitions have no receiver)
      f('packages/adapters/src/mock/tickets/index.ts', 'async purchase(request) { return ok(); }'),
      f('packages/adapters/src/mock/lodging/adapter.ts', 'book(request) {\n  return ok();\n},'),
      f('packages/adapters/src/interfaces/tickets.ts', 'purchase(request: R): Promise<Result<T>>;'),
      // a definition in scope is still not a call
      f(
        'packages/agent/src/fake.ts',
        'const p = { async purchase(r) { return r; }, charge(r) {} };',
      ),
      // comments
      f(
        'packages/agent/src/tools/x.ts',
        '// never call tickets.purchase( from a tool\n/** payments.charge(x) */\nconst y = 1;',
      ),
      // tests may call providers directly
      f('packages/agent/src/booking/executor.test.ts', 'await tickets.purchase(r);'),
      // other method names that merely contain the words
      f('packages/agent/src/y.ts', 'x.purchaseCount(); x.bookings(); x.chargeback(); x.booked();'),
      f(BOOKING_EXECUTOR_PATH, FULL_EXECUTOR),
    ]);
    expect(r.violations).toEqual([]);
    expect(r.callSites).toHaveLength(4);
  });

  it('detects TS non-null assertions on the receiver and after the method name', () => {
    const code = [
      'await providers.tickets!.purchase(req);',
      'await x.charge!(req);',
      'x.book!.call(x, req);',
      'y!.createOrder!?.(req);',
    ].join('\n');
    const sites = findMoneyCallSites([f('packages/agent/src/tools/a.ts', code)]);
    expect(sites.map((s) => [s.line, s.method, s.form])).toEqual([
      [1, 'purchase', 'dot'],
      [2, 'charge', 'dot'],
      [3, 'book', 'indirect'],
      [4, 'createOrder', 'dot'],
    ]);
    const r = checkSinglePurchaseCallSite([f('packages/agent/src/tools/a.ts', code)]);
    expect(r.violations).toHaveLength(4);
  });

  it('flags bare member references: alias, parenthesised, generic, Reflect.apply', () => {
    const code = [
      'const buy = providers.tickets.purchase;',
      '(payments.charge)(req);',
      'lodging.book<Stay>(req);',
      'Reflect.apply(flights.createOrder, flights, [req]);',
    ].join('\n');
    const sites = findMoneyCallSites([f('apps/simulator/src/server/x.ts', code)]);
    expect(sites.map((s) => [s.line, s.method, s.form])).toEqual([
      [1, 'purchase', 'reference'],
      [2, 'charge', 'reference'],
      [3, 'book', 'reference'],
      [4, 'createOrder', 'reference'],
    ]);
    const r = checkSinglePurchaseCallSite([f('apps/simulator/src/server/x.ts', code)]);
    expect(r.violations).toHaveLength(4);
    expect(r.violations[0]!.message).toContain('.purchase referenced outside BookingExecutor');
  });

  it('a mock calling another provider is a real call site (mocks are not excluded)', () => {
    const r = checkSinglePurchaseCallSite([
      f(BOOKING_EXECUTOR_PATH, FULL_EXECUTOR),
      f(
        'packages/adapters/src/mock/tickets/index.ts',
        'async purchase(request) {\n  await this.payments.charge(request);\n}',
      ),
    ]);
    expect(r.violations.map((v) => [v.path, v.line])).toEqual([
      ['packages/adapters/src/mock/tickets/index.ts', 2],
    ]);
  });

  it('isExecutorStub: true for the notImplemented stub (or an empty file), false once implemented', () => {
    expect(isExecutorStub("throw notImplemented('BookingExecutor.execute');")).toBe(true);
    expect(isExecutorStub('')).toBe(true);
    expect(isExecutorStub(FULL_EXECUTOR)).toBe(false);
    // a mention in a comment does not keep it lax
    expect(isExecutorStub(`// was notImplemented(...) before T-009\n${FULL_EXECUTOR}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('A2: tool names', () => {
  it('passes for exactly V0_TOOL_NAMES', () => {
    const r = checkToolNames([...V0_TOOL_NAMES]);
    expect(r.violations).toEqual([]);
  });

  it('fails on a forbidden name, an unknown name, a missing name and a duplicate', () => {
    const planted = [...V0_TOOL_NAMES.slice(1), 'purchase_tickets', 'get_roster'];
    const r = checkToolNames(planted);
    const msgs = ids(r);
    expect(msgs).toContain('tool "purchase_tickets" matches FORBIDDEN_TOOL_NAME_PATTERN');
    expect(msgs).toContain('tool "purchase_tickets" is not in V0_TOOL_NAMES');
    expect(msgs).toContain(`V0 tool "${V0_TOOL_NAMES[0]}" is missing from the registry`);
    expect(msgs).toContain('tool "get_roster" is registered twice');
  });

  it('fails if the expected list itself contains a forbidden name', () => {
    const r = checkToolNames(['execute_booking'], { expected: ['execute_booking'] });
    expect(ids(r)).toContain(
      'V0_TOOL_NAMES entry "execute_booking" matches FORBIDDEN_TOOL_NAME_PATTERN',
    );
  });

  it('is not fooled by a /g pattern (stateful lastIndex)', () => {
    const g = new RegExp(FORBIDDEN_TOOL_NAME_PATTERN.source, 'gi');
    const r = checkToolNames(['refund_a', 'refund_b'], {
      expected: ['refund_a', 'refund_b'],
      forbidden: g,
    });
    expect(r.violations.filter((v) => v.message.includes('matches'))).toHaveLength(4);
  });

  it('source scan: flags a tool file declaring a forbidden or unlisted name', () => {
    const tool = (name: string): string =>
      `export const t: ToolDefinition = {\n  name: '${name}',\n  description: 'd',\n  inputSchema: { type: 'object' },\n};`;
    const r = checkDeclaredToolNames([
      f('packages/agent/src/tools/propose_booking.ts', tool('propose_booking')),
      f('packages/agent/src/tools/buy.ts', tool('buy_tickets_now')),
      f('packages/agent/src/tools/extra.ts', tool('get_weather')),
      // not a tool definition (no inputSchema), and a test file: both ignored
      f('packages/agent/src/tools/helpers.ts', "const m = { name: 'charge_card' };"),
      f('packages/agent/src/tools/buy.test.ts', tool('refund_all')),
    ]);
    expect(r.violations.map((v) => [v.path, v.line])).toEqual([
      ['packages/agent/src/tools/buy.ts', 2],
      ['packages/agent/src/tools/extra.ts', 2],
    ]);
    expect(r.violations[0]!.message).toMatch(/FORBIDDEN_TOOL_NAME_PATTERN/);
    expect(r.violations[1]!.message).toMatch(/not in V0_TOOL_NAMES/);
    expect(r.warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
const CLEAN_INTERFACE = `
export interface AuditRepository {
  append(input: AuditEventInput): AuditEvent;
  get(id: AuditEventId): AuditEvent | undefined;
  listByGroup(
    groupId: GroupId,
    opts?: { readonly types?: readonly AuditEventType[]; readonly delete?: boolean },
  ): readonly AuditEvent[];
  lastHash(groupId: GroupId): string;
}
export interface GroupMemoryRepository {
  delete(factId: string): void;
}
`;
const CLEAN_IMPL = `
export function createAuditRepository(backend: Backend): AuditRepository {
  const events = backend.table(spec);
  return {
    append(input) {
      events.insert(input);
      return input;
    },
    get: (id) => events.get(id),
    lastHash,
  };
}
`;

describe('B2: AuditRepository is append-only', () => {
  const iface = 'packages/core/src/repositories.ts';
  const impl = 'packages/core/src/storage/shared/auditRepository.ts';

  it('passes on an append/read-only interface and implementation', () => {
    const r = checkAuditAppendOnly([f(iface, CLEAN_INTERFACE), f(impl, CLEAN_IMPL)]);
    expect(r.violations).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('fails when the interface gains update/delete members', () => {
    const planted = CLEAN_INTERFACE.replace(
      '  lastHash(groupId: GroupId): string;',
      "  lastHash(groupId: GroupId): string;\n  update(id: AuditEventId, e: AuditEvent): void;\n  readonly deleteEvent?: (id: AuditEventId) => void;\n  'remove'(id: string): void;",
    );
    const r = checkAuditAppendOnly([f(iface, planted), f(impl, CLEAN_IMPL)]);
    expect(r.violations.map((v) => v.message.match(/"(\w+)"/)?.[1])).toEqual([
      'update',
      'deleteEvent',
      'remove',
    ]);
    expect(r.violations[0]!.line).toBe(10);
  });

  it('fails when an implementation defines update/delete (shorthand, key, class method)', () => {
    const shorthand = CLEAN_IMPL.replace(
      '    lastHash,',
      '    lastHash,\n    delete(id) {\n      events.remove(id);\n    },',
    );
    const key = CLEAN_IMPL.replace(
      '    lastHash,',
      '    lastHash,\n    updatePayload: (id, p) => events.patch(id, p),',
    );
    const cls = `export class SqlAudit implements AuditRepository {\n  append(i) { return i; }\n  truncate() {}\n}`;
    const r = checkAuditAppendOnly([
      f(iface, CLEAN_INTERFACE),
      f('packages/core/src/a.ts', shorthand),
      f('packages/core/src/b.ts', key),
      f('apps/simulator/src/c.ts', cls),
    ]);
    expect(r.violations.map((v) => [v.path, v.message.match(/"(\w+)"/)?.[1]])).toEqual([
      ['packages/core/src/a.ts', 'delete'],
      ['packages/core/src/b.ts', 'updatePayload'],
      ['apps/simulator/src/c.ts', 'truncate'],
    ]);
  });

  it('fails on arrow/function class fields and on `as`/`<>` casts to AuditRepository', () => {
    const fields = [
      'export class A implements AuditRepository {',
      '  append(i) { return i; }',
      '  delete = (id) => {};',
      '  private readonly updateEvent = async (id) => {};',
      '  purge: () => void = () => {};',
      '  reset = function () {};',
      '  clearAll = (id) => {};',
      '}',
    ].join('\n');
    const asCast =
      'export const repo = { append(i) { return i; }, remove(id) {} } as AuditRepository;';
    const angle = 'export const repo = <AuditRepository>{ append(i) { return i; }, erase(id) {} };';
    const r = checkAuditAppendOnly([
      f(iface, CLEAN_INTERFACE),
      f('packages/core/src/a.ts', fields),
      f('packages/core/src/b.ts', asCast),
      f('packages/core/src/c.ts', angle),
    ]);
    expect(r.violations.map((v) => [v.path, v.line, v.message.match(/"(\w+)"/)?.[1]])).toEqual([
      ['packages/core/src/a.ts', 3, 'delete'],
      ['packages/core/src/a.ts', 4, 'updateEvent'],
      ['packages/core/src/a.ts', 5, 'purge'],
      ['packages/core/src/a.ts', 6, 'reset'],
      ['packages/core/src/a.ts', 7, 'clearAll'],
      ['packages/core/src/b.ts', 1, 'remove'],
      ['packages/core/src/c.ts', 1, 'erase'],
    ]);
  });

  it('does not flag local helpers or comparisons in an implementing file', () => {
    const impl = `${CLEAN_IMPL}\nconst updateCount = (n) => n + 1;\nlet reset = false;\nif (reset === true) reset = !reset;`;
    const r = checkAuditAppendOnly([f(iface, CLEAN_INTERFACE), f('packages/core/src/a.ts', impl)]);
    expect(r.violations).toEqual([]);
  });

  it('ignores write verbs in files that do not implement AuditRepository, and in tests', () => {
    const r = checkAuditAppendOnly([
      f(iface, CLEAN_INTERFACE),
      f(impl, CLEAN_IMPL),
      f(
        'packages/core/src/storage/shared/groupRepositories.ts',
        'export const r = { delete(id) {} };',
      ),
      f('packages/core/src/storage/fake.test.ts', 'const a: AuditRepository = { delete(id) {} };'),
    ]);
    expect(r.violations).toEqual([]);
  });

  it('runtime: rejects an object exposing a write method or an unknown member', () => {
    const clean = { append() {}, get() {}, listByGroup() {}, lastHash() {} };
    expect(checkAuditRepositoryObject('clean', clean).violations).toEqual([]);
    const withDelete = { ...clean, delete() {} };
    expect(ids(checkAuditRepositoryObject('obj', withDelete))).toEqual([
      expect.stringContaining('"delete"'),
    ]);
    class Proto {
      append(): void {}
      updateEvent(): void {}
    }
    expect(ids(checkAuditRepositoryObject('cls', new Proto()))).toEqual([
      expect.stringContaining('"updateEvent"'),
    ]);
    expect(ids(checkAuditRepositoryObject('extra', { ...clean, rows: [] }))).toEqual([
      expect.stringContaining('"rows"'),
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('H1: mock adapters import no network module', () => {
  const mock = 'packages/adapters/src/mock/tickets/index.ts';
  it.each([
    ["import http from 'node:http';", 1],
    ["import { request } from 'https';", 1],
    // the undici import and the bare `fetch` identifier both fire
    ["import { fetch as f } from 'undici';", 2],
    ['const g = fetch;\ng(url);', 1],
    ['run(fetch, url);', 1],
    ["const r = await globalThis['fetch'](url);", 1],
    ['const r = await self["fetch"](url);', 1],
    ['import * as net from "net";', 1],
    ["export * from 'node:dns/promises';", 1],
    ["import 'node:tls';", 1],
    ["const m = await import('node:net');", 1],
    ["const h = require('http');", 1],
    ['const r = await fetch(url);', 1],
    ['const r = await globalThis.fetch(url);', 1],
    ['const s = new WebSocket(u);', 1],
    ["import axios from 'axios';", 1],
  ])('flags %s', (line, count) => {
    expect(checkMocksOffline([f(mock, line)]).violations).toHaveLength(count);
  });

  it('allows comments, look-alikes, tests and non-mock dirs', () => {
    const r = checkMocksOffline([
      f(
        mock,
        "// no fetch(), no import from 'node:http'\nimport { x } from './net-utils.js';\nimport m from 'netmask';\nprefetch(a);\ncache.fetch(k);",
      ),
      f('packages/adapters/src/mock/tickets/index.test.ts', "import http from 'node:http';"),
      f('packages/adapters/src/real/stripe.ts', "import https from 'node:https';"),
    ]);
    expect(r.violations).toEqual([]);
    expect(r.filesScanned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('D-008: no wall clock outside clock.ts', () => {
  it('flags Date.now(), new Date() and new Date (no parens) in package and app sources', () => {
    const r = checkNoWallClock([
      f('packages/agent/src/loop.ts', 'const t = Date.now();\nconst d = new Date();'),
      f('apps/simulator/src/server.ts', 'const now = Date.now;\nconst x = new Date;'),
    ]);
    expect(r.violations.map((v) => [v.path, v.line])).toEqual([
      ['packages/agent/src/loop.ts', 1],
      ['packages/agent/src/loop.ts', 2],
      ['apps/simulator/src/server.ts', 1],
      ['apps/simulator/src/server.ts', 2],
    ]);
  });

  it('covers .tsx and .mts sources (the simulator UI), not just .ts', () => {
    const r = checkNoWallClock([
      f('apps/simulator/src/ui/Thread.tsx', 'const t = <span>{Date.now()}</span>;'),
      f('packages/agent/src/x.mts', 'export const d = new Date();'),
      f('apps/simulator/src/ui/App.test.tsx', 'Date.now();'),
    ]);
    expect(r.violations.map((v) => v.path)).toEqual([
      'apps/simulator/src/ui/Thread.tsx',
      'packages/agent/src/x.mts',
    ]);
  });

  it('allows clock.ts, tests, core/src/storage, comments and new Date(value)', () => {
    const r = checkNoWallClock([
      f('packages/core/src/clock.ts', 'export const sys = () => Date.now();'),
      f('packages/agent/src/clock.ts', 'new Date();'),
      f('packages/agent/src/loop.test.ts', 'Date.now();'),
      f('packages/core/src/storage/sqlite/index.ts', 'new Date();'),
      f(
        'packages/agent/src/a.ts',
        '// never Date.now()\nconst d = new Date(iso);\nconst e = new Date(clock.nowMs());',
      ),
      // outside packages/*/src and apps/*/src (scripts, fixtures generators): ESLint scope too
      f('scripts/x.ts', 'Date.now();'),
      f('packages/agent/vitest.config.ts', 'Date.now();'),
    ]);
    expect(r.violations).toEqual([]);
    expect(r.filesScanned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('H2: no keys in fixtures or snapshots', () => {
  it('flags sk- keys and ANTHROPIC_API_KEY assignments, without echoing the key', () => {
    const key = ['sk', 'ant', 'api03', 'AbCdEfGhIjKlMnOpQrSt'].join('-');
    const r = checkNoSecrets([
      f('fixtures/emails/leak.json', `{"body": "${key}"}`),
      f(
        'packages/agent/src/__snapshots__/loop.test.ts.snap',
        `exports[x] = "TRAV_ANTHROPIC_API_KEY=abc";`,
      ),
      f('evals/reports/r.md', 'ANTHROPIC_API_KEY = x'),
    ]);
    expect(r.violations.map((v) => v.path)).toEqual([
      'fixtures/emails/leak.json',
      'packages/agent/src/__snapshots__/loop.test.ts.snap',
      'evals/reports/r.md',
    ]);
    for (const v of r.violations) expect(v.message).not.toContain(key);
  });

  it('flags JSON and YAML key forms too', () => {
    const r = checkNoSecrets([
      f('fixtures/config.json', '{ "TRAV_ANTHROPIC_API_KEY": "abc" }'),
      f('fixtures/config.yaml', 'ANTHROPIC_API_KEY: abc'),
      f('fixtures/single.json', "{ 'ANTHROPIC_API_KEY' : 'abc' }"),
    ]);
    expect(r.violations.map((v) => v.path)).toEqual([
      'fixtures/config.json',
      'fixtures/config.yaml',
      'fixtures/single.json',
    ]);
  });

  it('allows a bare "sk-" marker, words ending in sk-, and the variable name alone', () => {
    const r = checkNoSecrets([
      f('fixtures/injection/x.json', `{"mustNotContain": ["sk-", "TRAV_ANTHROPIC_API_KEY"]}`),
      f('fixtures/a.json', '"task-0123456789abcdefghij", "desk-0123456789abcdefghij"'),
      f(
        'packages/agent/src/x.ts',
        `const k = '${['sk', 'ant', 'AbCdEfGhIjKlMnOpQrSt'].join('-')}';`,
      ),
    ]);
    expect(r.violations).toEqual([]);
    expect(r.filesScanned).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('runArchChecks on a temp-dir tree', () => {
  let root = '';
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  afterEach(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true });
    root = '';
  });

  const cleanTree = (): void => {
    root = mkdtempSync(join(tmpdir(), 'trav-arch-'));
    write(BOOKING_EXECUTOR_PATH, FULL_EXECUTOR);
    write('packages/core/src/repositories.ts', CLEAN_INTERFACE);
    write('packages/core/src/storage/shared/auditRepository.ts', CLEAN_IMPL);
    write(
      'packages/adapters/src/mock/tickets/index.ts',
      'export const createMockTickets = () => ({ async purchase(r) { return r; } });',
    );
    write('packages/core/src/clock.ts', 'export const now = () => Date.now();');
    write('fixtures/groups/barcelona.json', '{"name": "Barcelona"}');
  };

  it('a clean tree has no violations', () => {
    cleanTree();
    const results = runArchChecks({ root, requireExactlyOne: true });
    expect(results.flatMap((r) => r.violations)).toEqual([]);
  });

  it('every check fires on its planted violation', () => {
    cleanTree();
    write('packages/agent/src/tools/sneaky.ts', 'export const go = (p) => p.tickets.purchase(x);');
    write(
      'packages/agent/src/tools/refund.ts',
      "export const t = { name: 'refund_booking', inputSchema: {} };",
    );
    write(
      'packages/core/src/storage/shared/auditRepository.ts',
      CLEAN_IMPL.replace('    lastHash,', '    lastHash,\n    delete(id) {},'),
    );
    write('packages/adapters/src/mock/tickets/net.ts', "import { request } from 'node:https';");
    write('packages/agent/src/loop.ts', 'export const t = Date.now();');
    write(
      'fixtures/emails/leak.json',
      `{"k": "${['sk', 'ant', 'AbCdEfGhIjKlMnOpQrSt'].join('-')}"}`,
    );
    // Out-of-scope plants that must be ignored: node_modules and .env files are never read.
    write('node_modules/x/index.ts', 'p.tickets.purchase(x);');
    write(
      `fixtures/.env`,
      `TRAV_ANTHROPIC_API_KEY=${['sk', 'ant', 'AbCdEfGhIjKlMnOpQrSt'].join('-')}`,
    );

    const results = runArchChecks({ root });
    const fired = new Map(results.map((r) => [r.id, 0]));
    for (const r of results) fired.set(r.id, (fired.get(r.id) ?? 0) + r.violations.length);
    expect(Object.fromEntries(fired)).toEqual({ A1: 1, A2: 1, B2: 1, H1: 1, 'D-008': 1, H2: 1 });
  });

  it('readRepoFiles returns repo-relative POSIX paths and skips node_modules and .env files', () => {
    cleanTree();
    write('node_modules/x/index.ts', 'x');
    write('fixtures/.env', 'X=1');
    const paths = readRepoFiles(root, () => true).map((x) => x.path);
    expect(paths).toContain(BOOKING_EXECUTOR_PATH);
    expect(paths).toContain('fixtures/groups/barcelona.json');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.env'))).toBe(false);
  });
});

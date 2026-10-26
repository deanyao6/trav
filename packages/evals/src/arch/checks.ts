/**
 * Architectural checks (T-054; docs/SAFETY.md §4 checklist A1, A2, B2, H1, H2;
 * docs/DECISIONS.md D-008; T-030's A1b: one caller of `BookingExecutor.execute`).
 * Every check is a pure function over a list of
 * `{ path, content }` files with repo-relative POSIX paths, so the
 * planted-violation tests can feed it an in-memory or temp-dir tree. Each
 * check owns its file selection (`selects`), which the tests exercise too.
 *
 * The scans run on comment-stripped source (`stripComments`): doc comments
 * may name forbidden APIs ("never `Date.now()`"), code may not. String
 * literals are kept, so a forbidden call spelled inside a string is still
 * reported; that errs on the side of a false alarm, never a miss.
 */
import { FORBIDDEN_TOOL_NAME_PATTERN, V0_TOOL_NAMES } from '@trav/agent';
import type { ArchCheckId, CheckResult, SourceFile, Violation } from './source.js';
import { basename, isCodeFile, isTestFile, lineAt, stripComments } from './source.js';

const result = (
  id: ArchCheckId,
  filesScanned: number,
  violations: Violation[],
  warnings: string[] = [],
): CheckResult => ({ id, filesScanned, violations, warnings });

const inScope = (path: string, roots: readonly string[]): boolean =>
  roots.some((r) => path.startsWith(r));

// ---------------------------------------------------------------------------
// A1: one money-moving call site, in BookingExecutor
// ---------------------------------------------------------------------------

/** Provider/payments methods that move money (tickets, flights, lodging, payments). */
export const MONEY_METHODS = ['purchase', 'createOrder', 'book', 'charge'] as const;
export type MoneyMethod = (typeof MONEY_METHODS)[number];

/** THE single purchase call site (SAFETY §2.1, D-004). */
export const BOOKING_EXECUTOR_PATH = 'packages/agent/src/booking/executor.ts';

/**
 * Everything in packages/, apps/ and scripts/, including the adapter
 * interfaces and mocks: their method *definitions* (`async purchase(req) {`,
 * `purchase(req: R): …;`) have no receiver dot and never match, while a mock
 * calling another provider's `.charge(` would be a real second call site.
 */
const A1_ROOTS = ['packages/', 'apps/', 'scripts/'];

export function selectsA1(path: string): boolean {
  return (
    inScope(path, A1_ROOTS) &&
    isCodeFile(path) &&
    !isTestFile(path) &&
    !path.split('/').includes('node_modules')
  );
}

export interface MoneyCallSite {
  readonly path: string;
  readonly line: number;
  readonly method: MoneyMethod;
  /**
   * `x.purchase(` (dot), `x['purchase'](` (bracket), `x.purchase.call/apply/bind`
   * (indirect), or any other bare member reference such as
   * `const f = x.purchase`, `(x.purchase)(r)`, `x.purchase<T>(r)` or
   * `Reflect.apply(x.purchase, …)` (reference), or a destructuring that
   * pulls the method off its object, `const { purchase } = x` /
   * `const { purchase: run } = x` (destructure).
   *
   * Out of scope (relied on review): computed keys built at runtime such as
   * `x[\`exec${'ute'}\`]` or `const K = 'execute'; x[K](…)`.
   */
  readonly form: 'dot' | 'bracket' | 'indirect' | 'reference' | 'destructure';
}

// A call site is a member access on a value: an identifier, `)`, `]` or a TS
// non-null `!` before the dot (`providers.tickets!.purchase(`), with an
// optional `!` after the name (`x.purchase!(`). `async purchase(` /
// `purchase(request) {` are definitions (no dot) and never match.
const RECEIVER = String.raw`[\w$)\]!]\s*\??\.\s*`;
const CALL_TAIL = String.raw`\s*!?\s*(?:\?\.\s*)?\(`;
const INDIRECT_TAIL = String.raw`\s*!?\s*\.\s*(?:call|apply|bind)\b`;

interface MethodPatterns {
  readonly dot: RegExp;
  readonly bracket: RegExp;
  readonly indirect: RegExp;
  readonly reference: RegExp;
  readonly destructure: RegExp;
}

/** The five member-access forms for a set of method names (`findMoneyCallSites` doc). */
function methodPatterns(methods: readonly string[]): MethodPatterns {
  const alt = methods.join('|');
  return {
    dot: new RegExp(String.raw`${RECEIVER}(${alt})${CALL_TAIL}`, 'g'),
    bracket: new RegExp(String.raw`\[\s*(['"\x60])(${alt})\1\s*\]${CALL_TAIL}`, 'g'),
    indirect: new RegExp(String.raw`${RECEIVER}(${alt})${INDIRECT_TAIL}`, 'g'),
    // Any other `.purchase` member reference (alias, parenthesised, generic, Reflect).
    reference: new RegExp(String.raw`${RECEIVER}(${alt})\b(?!${CALL_TAIL}|${INDIRECT_TAIL})`, 'g'),
    // `const { purchase } = x` / `{ purchase: run } = x`: a pattern with the name
    // inside braces that is immediately assigned from something.
    destructure: new RegExp(String.raw`\{[^{}]*\b(${alt})\b[^{}]*\}\s*=[^=]`, 'g'),
  };
}

interface MethodCallSite {
  readonly path: string;
  readonly line: number;
  readonly method: string;
  readonly form: MoneyCallSite['form'];
}

/** Every call site (or bare member reference) of `methods` in `files`, comments stripped. */
function findMethodCallSites(
  files: readonly SourceFile[],
  methods: readonly string[],
): MethodCallSite[] {
  const patterns = methodPatterns(methods);
  const sites: MethodCallSite[] = [];
  for (const file of files) {
    const code = stripComments(file.content);
    const scan = (re: RegExp, group: number, form: MoneyCallSite['form']): void => {
      for (const m of code.matchAll(re)) {
        const method = m[group]!;
        const at = (m.index ?? 0) + m[0].indexOf(method);
        sites.push({ path: file.path, line: lineAt(code, at), method, form });
      }
    };
    scan(patterns.dot, 1, 'dot');
    scan(patterns.bracket, 2, 'bracket');
    scan(patterns.indirect, 1, 'indirect');
    scan(patterns.reference, 1, 'reference');
    scan(patterns.destructure, 1, 'destructure');
  }
  return sites.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}

/** Every money-moving call site in `files` (no scope filtering). */
export function findMoneyCallSites(files: readonly SourceFile[]): MoneyCallSite[] {
  return findMethodCallSites(files, MONEY_METHODS).map((s) => ({
    ...s,
    method: s.method as MoneyMethod,
  }));
}

/**
 * True while the executor is still the `notImplemented(` stub (or missing).
 * The repo run requires exactly one call site per method once this is false.
 */
export function isExecutorStub(content: string): boolean {
  return content.trim() === '' || stripComments(content).includes('notImplemented(');
}

export interface A1Options {
  /**
   * `false` while `executor.ts` is a `notImplemented` stub: zero call sites
   * for a method is a warning. T-009 implements the executor and flips the
   * repo test to `true` (exactly one per method).
   */
  readonly requireExactlyOne?: boolean;
}

export function checkSinglePurchaseCallSite(
  files: readonly SourceFile[],
  opts: A1Options = {},
): CheckResult & { readonly callSites: readonly MoneyCallSite[] } {
  const scanned = files.filter((f) => selectsA1(f.path));
  const callSites = findMoneyCallSites(scanned);
  const violations: Violation[] = [];
  const warnings: string[] = [];

  for (const site of callSites) {
    if (site.path !== BOOKING_EXECUTOR_PATH) {
      violations.push({
        check: 'A1',
        path: site.path,
        line: site.line,
        message: `provider .${site.method}${site.form === 'reference' ? ' referenced' : '( called'} outside BookingExecutor (${BOOKING_EXECUTOR_PATH}); only the executor may move money`,
      });
    }
  }
  for (const method of MONEY_METHODS) {
    const inExecutor = callSites.filter(
      (s) => s.method === method && s.path === BOOKING_EXECUTOR_PATH,
    );
    if (inExecutor.length > 1) {
      for (const extra of inExecutor.slice(1)) {
        violations.push({
          check: 'A1',
          path: extra.path,
          line: extra.line,
          message: `second .${method}( call site in BookingExecutor (first at line ${inExecutor[0]!.line}); exactly one is allowed`,
        });
      }
    } else if (inExecutor.length === 0) {
      const msg = `no .${method}( call site in ${BOOKING_EXECUTOR_PATH} yet`;
      if (opts.requireExactlyOne === true) {
        violations.push({ check: 'A1', path: BOOKING_EXECUTOR_PATH, line: 1, message: msg });
      } else {
        warnings.push(`${msg} (executor still a stub; T-009 makes this exactly one)`);
      }
    }
  }
  return { ...result('A1', scanned.length, violations, warnings), callSites };
}

// ---------------------------------------------------------------------------
// A1b: one caller of BookingExecutor.execute (the approval handler)
// ---------------------------------------------------------------------------

/** THE executor call site (SAFETY §2.1; T-030: the handler is the only caller). */
export const APPROVAL_HANDLER_PATH = 'packages/agent/src/approval/handler.ts';
/** The composition root's lazy executor delegates `execute` once to the real one. */
export const COMPOSE_PATH = 'packages/agent/src/compose.ts';

/**
 * Files allowed to call `.execute(`, each exactly once: the handler (the
 * call) and the compose wrapper (the delegation). Everything else under
 * `packages/` and `apps/` (the loop, tools, the simulator) must go through
 * `ApprovalHandler`.
 */
export const EXECUTE_CALL_SITES: readonly string[] = [APPROVAL_HANDLER_PATH, COMPOSE_PATH];

const A1B_ROOTS = ['packages/', 'apps/'];

export function selectsExecuteSources(path: string): boolean {
  return (
    inScope(path, A1B_ROOTS) &&
    isCodeFile(path) &&
    !isTestFile(path) &&
    !path.split('/').includes('node_modules')
  );
}

export interface ExecuteCallSite {
  readonly path: string;
  readonly line: number;
  readonly form: MoneyCallSite['form'];
}

/** The method name, kept out of string literals below: this file is in its own scan scope. */
const EXECUTE = 'execute';

/** Every `.execute(` call site or member reference in `files` (no scope filtering). */
export function findExecuteCallSites(files: readonly SourceFile[]): ExecuteCallSite[] {
  return findMethodCallSites(files, [EXECUTE]).map(({ path, line, form }) => ({
    path,
    line,
    form,
  }));
}

/**
 * A1b: `BookingExecutor.execute` has one caller. Every `.execute(` under
 * `packages/` and `apps/` is in `EXECUTE_CALL_SITES`, and each of those
 * files has exactly one. `.execute(` is matched by name (the executor is the
 * only `execute` in the codebase; a future `db.execute(` would show up here
 * and need its own allow-list entry, which is the point).
 */
export function checkSingleExecuteCallSite(
  files: readonly SourceFile[],
): CheckResult & { readonly callSites: readonly ExecuteCallSite[] } {
  const scanned = files.filter((f) => selectsExecuteSources(f.path));
  const callSites = findExecuteCallSites(scanned);
  const violations: Violation[] = [];
  for (const site of callSites) {
    if (!EXECUTE_CALL_SITES.includes(site.path)) {
      violations.push({
        check: 'A1b',
        path: site.path,
        line: site.line,
        message: `.${EXECUTE}${site.form === 'reference' ? ' referenced' : '( called'} outside the approval handler (${APPROVAL_HANDLER_PATH}); every purchase goes through ApprovalHandler`,
      });
    }
  }
  for (const allowed of EXECUTE_CALL_SITES) {
    const here = callSites.filter((s) => s.path === allowed);
    if (here.length === 0) {
      violations.push({
        check: 'A1b',
        path: allowed,
        line: 1,
        message: `no .${EXECUTE}( call site in ${allowed}; expected exactly one`,
      });
    }
    for (const extra of here.slice(1)) {
      violations.push({
        check: 'A1b',
        path: extra.path,
        line: extra.line,
        message: `second .${EXECUTE}( call site in ${allowed} (first at line ${here[0]!.line}); exactly one is allowed`,
      });
    }
  }
  return { ...result('A1b', scanned.length, violations), callSites };
}

// ---------------------------------------------------------------------------
// A2: the model's tool names
// ---------------------------------------------------------------------------

export interface ToolNameOptions {
  readonly expected?: readonly string[];
  readonly forbidden?: RegExp;
  /** Where the names came from, for the violation path. */
  readonly source?: string;
}

const nonGlobal = (re: RegExp): RegExp => new RegExp(re.source, re.flags.replace(/[gy]/g, ''));

/**
 * The registered tool names must contain nothing matching
 * `FORBIDDEN_TOOL_NAME_PATTERN`, no duplicates, and equal `V0_TOOL_NAMES`
 * as a set (SAFETY A2).
 */
export function checkToolNames(names: readonly string[], opts: ToolNameOptions = {}): CheckResult {
  const expected = opts.expected ?? V0_TOOL_NAMES;
  const forbidden = nonGlobal(opts.forbidden ?? FORBIDDEN_TOOL_NAME_PATTERN);
  const path = opts.source ?? 'packages/agent/src/tools/registry.ts';
  const violations: Violation[] = [];
  const v = (message: string): void => {
    violations.push({ check: 'A2', path, line: 0, message });
  };

  const seen = new Set<string>();
  for (const name of names) {
    if (forbidden.test(name)) v(`tool "${name}" matches FORBIDDEN_TOOL_NAME_PATTERN`);
    if (seen.has(name)) v(`tool "${name}" is registered twice`);
    seen.add(name);
  }
  const expectedSet = new Set(expected);
  for (const name of seen) {
    if (!expectedSet.has(name)) v(`tool "${name}" is not in V0_TOOL_NAMES`);
  }
  for (const name of expectedSet) {
    if (!seen.has(name)) v(`V0 tool "${name}" is missing from the registry`);
  }
  for (const name of expected) {
    if (forbidden.test(name))
      v(`V0_TOOL_NAMES entry "${name}" matches FORBIDDEN_TOOL_NAME_PATTERN`);
  }
  return result('A2', names.length, violations);
}

const TOOLS_DIR = 'packages/agent/src/tools/';

export function selectsToolSources(path: string): boolean {
  return path.startsWith(TOOLS_DIR) && isCodeFile(path) && !isTestFile(path);
}

const TOOL_NAME_LITERAL = /\bname\s*:\s*(['"\x60])([a-z][a-z0-9_]*)\1/g;

/**
 * Tool names declared in `packages/agent/src/tools/` source: a snake_case
 * `name: '…'` literal in a file that also declares an `inputSchema`
 * (i.e. a `ToolDefinition`).
 */
export function extractDeclaredToolNames(
  files: readonly SourceFile[],
): { readonly name: string; readonly path: string; readonly line: number }[] {
  const out: { name: string; path: string; line: number }[] = [];
  for (const file of files.filter((f) => selectsToolSources(f.path))) {
    const code = stripComments(file.content);
    if (!/\binputSchema\b/.test(code)) continue;
    for (const m of code.matchAll(TOOL_NAME_LITERAL)) {
      out.push({ name: m[2]!, path: file.path, line: lineAt(code, m.index ?? 0) });
    }
  }
  return out;
}

/**
 * Source-level A2: no tool file declares a forbidden name, and none declares
 * a name outside `V0_TOOL_NAMES` (the registry would throw at startup, but
 * this catches it before anything runs). Names in V0 with no definition yet
 * are warnings until every v0 tool exists (T-007 and friends).
 */
export function checkDeclaredToolNames(
  files: readonly SourceFile[],
  opts: ToolNameOptions = {},
): CheckResult {
  const expected = new Set(opts.expected ?? V0_TOOL_NAMES);
  const forbidden = nonGlobal(opts.forbidden ?? FORBIDDEN_TOOL_NAME_PATTERN);
  const scanned = files.filter((f) => selectsToolSources(f.path));
  const declared = extractDeclaredToolNames(scanned);
  const violations: Violation[] = [];
  for (const d of declared) {
    if (forbidden.test(d.name)) {
      violations.push({
        check: 'A2',
        path: d.path,
        line: d.line,
        message: `tool "${d.name}" matches FORBIDDEN_TOOL_NAME_PATTERN; the model may not purchase, charge, refund or delete`,
      });
    } else if (!expected.has(d.name)) {
      violations.push({
        check: 'A2',
        path: d.path,
        line: d.line,
        message: `tool "${d.name}" is not in V0_TOOL_NAMES`,
      });
    }
  }
  const declaredNames = new Set(declared.map((d) => d.name));
  const missing = [...expected].filter((n) => !declaredNames.has(n));
  const warnings =
    missing.length > 0 ? [`V0 tools with no definition file yet: ${missing.join(', ')}`] : [];
  return result('A2', scanned.length, violations, warnings);
}

// ---------------------------------------------------------------------------
// B2: AuditRepository is append-only
// ---------------------------------------------------------------------------

/** Member names that would let a caller change or remove audit history. */
export const AUDIT_WRITE_VERB =
  /^(?:update|delete|remove|clear|truncate|purge|drop|erase|reset|upsert|replace|patch|edit|modify|overwrite|rewrite|redact|set|put|splice|pop|shift|prune|wipe|destroy)(?:[A-Z0-9_$]|$)/;

/** The methods an `AuditRepository` may expose: append + reads. */
export const AUDIT_ALLOWED_MEMBERS: readonly string[] = [
  'append',
  'get',
  'listByGroup',
  'listByProposal',
  'listByBooking',
  'listGroupVisible',
  'lastHash',
];

export function selectsAuditSources(path: string): boolean {
  return (
    (path.startsWith('packages/') || path.startsWith('apps/')) &&
    isCodeFile(path) &&
    !isTestFile(path)
  );
}

/** Text of the `{ … }` block opening at `open` (exclusive of the braces). */
function braceBody(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/** Blank out everything nested inside (), [], {} or <> so only top-level members remain. */
function topLevel(body: string): string {
  let depth = 0;
  let out = '';
  for (const c of body) {
    if (c === '{' || c === '(' || c === '[') depth++;
    if (depth === 0 || c === '\n') out += c;
    else out += ' ';
    if (c === '}' || c === ')' || c === ']') depth = Math.max(0, depth - 1);
  }
  return out;
}

const MEMBER_NAME =
  /(?:^|[;,\n])\s*(?:(?:readonly|async|static|public|private|protected|get|set)\s+)*(?:(['"])([A-Za-z_$][\w$]*)\1|([A-Za-z_$][\w$]*))\s*\??\s*[(:<]/g;

function memberNames(body: string): { name: string; offset: number }[] {
  const flat = topLevel(body);
  const out: { name: string; offset: number }[] = [];
  for (const m of flat.matchAll(MEMBER_NAME)) {
    const name = m[2] ?? m[3]!;
    out.push({ name, offset: (m.index ?? 0) + m[0].indexOf(name) });
  }
  return out;
}

const AUDIT_DECL = /\b(?:interface\s+AuditRepository\b[^{]*|type\s+AuditRepository\s*=\s*)\{/g;

/** Top-level member names of every `AuditRepository` interface/type declaration in `files`. */
export function auditRepositoryMembers(files: readonly SourceFile[]): string[] {
  const names: string[] = [];
  for (const file of files) {
    const code = stripComments(file.content);
    for (const m of code.matchAll(AUDIT_DECL)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      names.push(...memberNames(braceBody(code, open)).map((x) => x.name));
    }
  }
  return names;
}
// A function/variable typed as returning or being an AuditRepository, or a class implementing it.
const AUDIT_IMPL =
  /(?:\)\s*:\s*AuditRepository\s*(?:=>\s*)?\{|:\s*AuditRepository\s*=|implements\s+[\w$,\s]*\bAuditRepository\b[^{]*\{|satisfies\s+AuditRepository\b|\bas\s+AuditRepository\b|<AuditRepository>)/;

/**
 * SAFETY B2 at the source level. (1) Every `AuditRepository` interface/type
 * declaration has only append/read members. (2) Every file that implements it
 * (`): AuditRepository {`, `: AuditRepository =`, `implements`, `satisfies`)
 * defines no member (method shorthand, `key: value` or class method) whose
 * name is a write verb such as update/delete.
 */
export function checkAuditAppendOnly(files: readonly SourceFile[]): CheckResult {
  const scanned = files.filter((f) => selectsAuditSources(f.path));
  const violations: Violation[] = [];
  let declarations = 0;
  let implementations = 0;

  for (const file of scanned) {
    const code = stripComments(file.content);
    for (const m of code.matchAll(AUDIT_DECL)) {
      declarations++;
      const open = (m.index ?? 0) + m[0].length - 1;
      for (const member of memberNames(braceBody(code, open))) {
        if (AUDIT_WRITE_VERB.test(member.name)) {
          violations.push({
            check: 'B2',
            path: file.path,
            line: lineAt(code, open + 1 + member.offset),
            message: `AuditRepository declares "${member.name}"; the audit log is append-only (no update/delete)`,
          });
        }
      }
    }
    if (AUDIT_IMPL.test(code)) {
      implementations++;
      // Member definitions anywhere in the implementing file: `name(…) {`,
      // `name: …` after `{`/`,`, class fields `name = (…) =>` /
      // `name = async (…) =>` / `name = function`, each optionally after
      // modifiers (`public`, `private readonly`, `async`, `#name`). Calls like
      // `rows.delete(x)` (preceded by `.`) are not definitions and are left to
      // the storage tests.
      const def =
        /(?<![\w$.#])(?:(?:public|private|protected|static|readonly|override|async)\s+)*(['"]?)#?([A-Za-z_$][\w$]*)\1\s*(?:\([^()]*\)\s*(?::[^{;=]*)?\{|(?::(?:[^=;{}]|=>)*)?=(?![=>])\s*(?:async\s*)?(?:\(|function\b|[\w$]+\s*=>)|:(?!:))/g;
      for (const m of code.matchAll(def)) {
        const name = m[2]!;
        if (!AUDIT_WRITE_VERB.test(name)) continue;
        const before = code.slice(0, m.index ?? 0).trimEnd();
        const prev = before[before.length - 1] ?? '';
        const isKey = /:\s*$/.test(m[0]) && !m[0].includes('=');
        // Object keys follow `{` or `,`; method shorthand / class methods follow `{`, `,`, `;`, `}`.
        const ok = isKey ? prev === '{' || prev === ',' : ['{', ',', ';', '}', ''].includes(prev);
        if (!ok) continue;
        violations.push({
          check: 'B2',
          path: file.path,
          line: lineAt(code, (m.index ?? 0) + m[0].indexOf(name)),
          message: `AuditRepository implementation defines "${name}"; the audit log is append-only (no update/delete)`,
        });
      }
    }
  }
  const warnings =
    declarations === 0 ? ['no AuditRepository declaration found (check scope may be wrong)'] : [];
  if (implementations === 0) warnings.push('no AuditRepository implementation found');
  return result('B2', scanned.length, violations, warnings);
}

/**
 * Runtime B2: the members a live `AuditRepository` object exposes (own and
 * prototype-chain, functions or not) are a subset of the allowed append/read
 * methods and contain no write verb.
 */
export function checkAuditRepositoryObject(
  label: string,
  repo: object,
  allowed: readonly string[] = AUDIT_ALLOWED_MEMBERS,
): CheckResult {
  const names = new Set<string>();
  for (
    let o: object | null = repo;
    o !== null && o !== Object.prototype;
    o = Object.getPrototypeOf(o) as object | null
  ) {
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor') names.add(k);
  }
  const allowedSet = new Set(allowed);
  const violations: Violation[] = [];
  for (const name of [...names].sort()) {
    if (AUDIT_WRITE_VERB.test(name) || !allowedSet.has(name)) {
      violations.push({
        check: 'B2',
        path: label,
        line: 0,
        message: `audit repository exposes "${name}"; only ${allowed.join(', ')} are allowed`,
      });
    }
  }
  return result('B2', 1, violations);
}

// ---------------------------------------------------------------------------
// H1: mock adapters never touch the network
// ---------------------------------------------------------------------------

const MOCK_DIR = 'packages/adapters/src/mock/';

export function selectsMockSources(path: string): boolean {
  return path.startsWith(MOCK_DIR) && isCodeFile(path) && !isTestFile(path);
}

/** Network-capable modules (Node built-ins and the common HTTP clients). */
export const NETWORK_MODULES = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'undici',
  'node-fetch',
  'cross-fetch',
  'isomorphic-fetch',
  'axios',
  'got',
  'ws',
  'child_process',
];

const MODULE_ALT = NETWORK_MODULES.map((m) => m.replace(/[-]/g, '\\-')).join('|');
const SPEC = String.raw`(['"\x60])(?:node:)?(${MODULE_ALT})(?:\/[^'"\x60]*)?\1`;

const H1_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  {
    label: 'import/export from a network module',
    re: new RegExp(String.raw`\bfrom\s*${SPEC}`, 'g'),
  },
  {
    label: 'side-effect import of a network module',
    re: new RegExp(String.raw`\bimport\s*${SPEC}`, 'g'),
  },
  {
    label: 'dynamic import of a network module',
    re: new RegExp(String.raw`\bimport\s*\(\s*${SPEC}`, 'g'),
  },
  {
    label: 'require of a network module',
    re: new RegExp(String.raw`\brequire\s*\(\s*${SPEC}`, 'g'),
  },
  // Any bare `fetch` identifier: calls, aliases (`const g = fetch`), passing it along.
  // (A quoted 'fetch' is left to the bracket pattern below, so it is reported once.)
  { label: 'global fetch', re: /(?<![\w$.'"\x60])fetch\b/g },
  { label: 'globalThis.fetch', re: /\b(?:globalThis|window|self|global)\s*\.\s*fetch\b/g },
  { label: "['fetch'] member access", re: /\[\s*(['"\x60])fetch\1\s*\]/g },
  {
    label: 'XMLHttpRequest/WebSocket/EventSource',
    re: /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/g,
  },
];

/** SAFETY H1: `packages/adapters/src/mock/**` imports and uses no network API. */
export function checkMocksOffline(files: readonly SourceFile[]): CheckResult {
  const scanned = files.filter((f) => selectsMockSources(f.path));
  const violations: Violation[] = [];
  for (const file of scanned) {
    const code = stripComments(file.content);
    for (const { label, re } of H1_PATTERNS) {
      for (const m of code.matchAll(re)) {
        violations.push({
          check: 'H1',
          path: file.path,
          line: lineAt(code, m.index ?? 0),
          message: `${label} in a mock adapter: ${m[0].trim()}`,
        });
      }
    }
  }
  return result('H1', scanned.length, violations);
}

// ---------------------------------------------------------------------------
// D-008: no wall clock outside clock.ts (doubles the ESLint rule)
// ---------------------------------------------------------------------------

/**
 * Same scope as the `no-restricted-syntax` block in `eslint.config.js`:
 * `packages/<pkg>/src/**` and `apps/<app>/src/**` `.ts`/`.tsx`/`.mts`
 * files (the simulator UI is `.tsx`), minus `clock.ts`, tests and
 * `packages/core/src/storage/**`.
 */
const WALL_CLOCK_EXTENSIONS = ['.ts', '.tsx', '.mts'];

export function selectsWallClockSources(path: string): boolean {
  const parts = path.split('/');
  const underSrc =
    (parts[0] === 'packages' || parts[0] === 'apps') && parts.length >= 4 && parts[2] === 'src';
  return (
    underSrc &&
    WALL_CLOCK_EXTENSIONS.some((ext) => path.endsWith(ext)) &&
    !path.endsWith('.d.ts') &&
    !isTestFile(path) &&
    basename(path) !== 'clock.ts' &&
    !path.startsWith('packages/core/src/storage/')
  );
}

const WALL_CLOCK: readonly { readonly label: string; readonly re: RegExp }[] = [
  // Labels avoid spelling the calls: this file is itself in scope.
  { label: 'wall-clock read (Date now)', re: /\bDate\s*\.\s*now\b/g },
  { label: 'argument-less Date constructor', re: /\bnew\s+Date\s*\(\s*\)/g },
  { label: 'argument-less Date constructor (no parens)', re: /\bnew\s+Date\b(?!\s*\()/g },
];

export function checkNoWallClock(files: readonly SourceFile[]): CheckResult {
  const scanned = files.filter((f) => selectsWallClockSources(f.path));
  const violations: Violation[] = [];
  for (const file of scanned) {
    const code = stripComments(file.content);
    for (const { label, re } of WALL_CLOCK) {
      for (const m of code.matchAll(re)) {
        violations.push({
          check: 'D-008',
          path: file.path,
          line: lineAt(code, m.index ?? 0),
          message: `${label} outside clock.ts; use the injected Clock (D-008)`,
        });
      }
    }
  }
  return result('D-008', scanned.length, violations);
}

// ---------------------------------------------------------------------------
// H2: no keys in fixtures, snapshots or eval reports
// ---------------------------------------------------------------------------

export function selectsSecretScan(path: string): boolean {
  return (
    path.startsWith('fixtures/') ||
    path.startsWith('evals/') ||
    path.split('/').includes('__snapshots__') ||
    path.endsWith('.snap')
  );
}

const SECRET_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  // `sk-…` / `sk-ant-…` key shapes. A bare "sk-" (e.g. a mustNotContain list) is fine.
  { label: 'sk- API key', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g },
  // `KEY=…` (dotenv), `KEY: …` (YAML) and `"KEY": …` (JSON).
  {
    label: 'ANTHROPIC_API_KEY assignment',
    re: /\b(?:TRAV_)?ANTHROPIC_API_KEY["']?\s*[:=]/g,
  },
];

/** SAFETY H2. Scans raw text (comments included): a key in a comment is still a leak. */
export function checkNoSecrets(files: readonly SourceFile[]): CheckResult {
  const scanned = files.filter((f) => selectsSecretScan(f.path));
  const violations: Violation[] = [];
  for (const file of scanned) {
    for (const { label, re } of SECRET_PATTERNS) {
      for (const m of file.content.matchAll(re)) {
        violations.push({
          check: 'H2',
          path: file.path,
          line: lineAt(file.content, m.index ?? 0),
          // Never echo the matched text: it may be a real key.
          message: `${label} found in a fixture/snapshot/report`,
        });
      }
    }
  }
  return result('H2', scanned.length, violations);
}

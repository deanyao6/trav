/**
 * `pnpm audit:verify` (T-055; docs/SAFETY.md §2.2, §2.9).
 *
 * Verifies every group's audit hash chain with `audit.verifyAuditChain`:
 *
 *   pnpm audit:verify                      # <repo>/.trav/trav.sqlite
 *   pnpm audit:verify path/to/log.sqlite   # another SQLite store (opened read-only)
 *   pnpm audit:verify export.json          # JSON array of AuditEvent (or { "events": [...] })
 *   pnpm audit:verify export.jsonl         # one AuditEvent per line
 *   pnpm audit:verify --expect-head grp_barcelona=<sha256> [path]
 *
 * Prints one line per problem (group id, event id, index, problem code), one
 * `HEAD` line per group with its chain head hash, then a summary. Exit codes:
 * 0 = every chain verifies, 1 = at least one problem, 2 = usage or I/O error.
 * Payload contents are never printed: only ids, types, hashes and problem codes.
 *
 * The chain has no secret (D-016): a rewrite of every row from some point on,
 * with hashes recomputed, is internally consistent. Record each group's `HEAD`
 * hash somewhere outside the store (the morning report, a commit message) and
 * pass it back with `--expect-head`; a rewrite then surfaces as `head_mismatch`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { isSha256Hex, verifyAuditChain } from '../packages/core/src/audit/index.js';
import type { AuditChainProblem } from '../packages/core/src/audit/index.js';
import type { AuditEvent } from '../packages/core/src/domain/audit.js';
import { defaultSqlitePath } from '../packages/core/src/storage/sqlite/index.js';

/** Problems found before the chain check: a row that is not a readable AuditEvent. */
export type LoadProblemCode = 'malformed_event';
export type ProblemCode = AuditChainProblem['problem'] | LoadProblemCode;

export interface VerifyProblem {
  readonly groupId: string;
  readonly eventId: string | null;
  /** Position in the group's chain (or in the source, for malformed rows); -1 when not applicable. */
  readonly index: number;
  readonly problem: ProblemCode;
}

export interface GroupResult {
  readonly groupId: string;
  readonly count: number;
  /** Hash of the group's last event (the genesis hash when the group has none). */
  readonly headHash: string;
  readonly ok: boolean;
}

/** External anchors: group id → the head hash recorded earlier (`--expect-head`). */
export type ExpectedHeads = ReadonlyMap<string, string>;

export interface VerifyReport {
  readonly source: string;
  readonly groups: readonly GroupResult[];
  readonly problems: readonly VerifyProblem[];
  readonly eventCount: number;
  readonly ok: boolean;
}

/** Events grouped in chain order, plus rows that could not be read as events. */
export interface LoadedLog {
  readonly groups: ReadonlyMap<string, readonly AuditEvent[]>;
  readonly malformed: readonly VerifyProblem[];
}

export class AuditVerifyUsageError extends Error {}

// ---------- loading ----------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Minimal structural check so a corrupt row is reported instead of crashing the verifier. */
function asAuditEvent(value: unknown): AuditEvent | null {
  if (!isRecord(value)) return null;
  for (const key of ['id', 'groupId', 'type', 'ts', 'prevHash', 'hash', 'visibility'] as const) {
    if (typeof value[key] !== 'string') return null;
  }
  if (!isRecord(value['payload'])) return null;
  return value as unknown as AuditEvent;
}

function idOf(value: unknown): string | null {
  return isRecord(value) && typeof value['id'] === 'string' ? value['id'] : null;
}

function pushTo(map: Map<string, AuditEvent[]>, groupId: string, event: AuditEvent): void {
  const list = map.get(groupId);
  if (list === undefined) map.set(groupId, [event]);
  else list.push(event);
}

/**
 * Reads `audit_events` from an open SQLite database in append order (`seq`).
 * Grouped by the indexed `group_id` column, so a row whose JSON claims another
 * group surfaces as `group_mismatch` in its column's chain.
 */
export function loadFromDatabase(db: DatabaseSync): LoadedLog {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
    .get();
  if (table === undefined) {
    throw new AuditVerifyUsageError('no audit_events table in this database');
  }
  const groups = new Map<string, AuditEvent[]>();
  const malformed: VerifyProblem[] = [];
  const rows = db.prepare('SELECT pk, group_id, json FROM audit_events ORDER BY seq').all();
  rows.forEach((row, index) => {
    const groupId = String(row['group_id'] ?? '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row['json']));
    } catch {
      parsed = undefined;
    }
    const event = asAuditEvent(parsed);
    if (event === null) {
      const pk = row['pk'];
      malformed.push({
        groupId,
        eventId: typeof pk === 'string' ? pk : null,
        index,
        problem: 'malformed_event',
      });
      return;
    }
    pushTo(groups, groupId, event);
  });
  return { groups, malformed };
}

/** Opens a SQLite file read-only (never migrates or writes) and loads its audit events. */
export function loadFromSqliteFile(path: string): LoadedLog {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return loadFromDatabase(db);
  } finally {
    db.close();
  }
}

/** Groups already-parsed export entries by their `groupId`, preserving file order. */
export function loadFromValues(values: readonly unknown[]): LoadedLog {
  const groups = new Map<string, AuditEvent[]>();
  const malformed: VerifyProblem[] = [];
  values.forEach((value, index) => {
    const event = asAuditEvent(value);
    if (event === null) {
      const groupId =
        isRecord(value) && typeof value['groupId'] === 'string' ? value['groupId'] : '';
      malformed.push({ groupId, eventId: idOf(value), index, problem: 'malformed_event' });
      return;
    }
    pushTo(groups, event.groupId, event);
  });
  return { groups, malformed };
}

/** `.json`: an array of events or `{ "events": [...] }`. `.jsonl`: one event per non-empty line. */
export function loadFromJsonText(text: string, format: 'json' | 'jsonl'): LoadedLog {
  if (format === 'jsonl') {
    const values: unknown[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        values.push(undefined);
      }
    }
    return loadFromValues(values);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AuditVerifyUsageError('export is not valid JSON');
  }
  if (Array.isArray(parsed)) return loadFromValues(parsed);
  if (isRecord(parsed) && Array.isArray(parsed['events'])) return loadFromValues(parsed['events']);
  throw new AuditVerifyUsageError('JSON export must be an array of events or { "events": [...] }');
}

// ---------- verification ----------

/**
 * Verifies every group in the log, plus every group named in `expectedHeads`
 * (a group that vanished entirely still fails its anchor with `head_mismatch`).
 */
export function verifyLoadedLog(
  log: LoadedLog,
  source: string,
  expectedHeads: ExpectedHeads = new Map(),
): VerifyReport {
  const problems: VerifyProblem[] = [...log.malformed];
  const groups: GroupResult[] = [];
  let eventCount = 0;
  const groupIds = [...new Set([...log.groups.keys(), ...expectedHeads.keys()])].sort();
  for (const groupId of groupIds) {
    const events = log.groups.get(groupId) ?? [];
    const expectedHeadHash = expectedHeads.get(groupId);
    const result = verifyAuditChain(
      events,
      expectedHeadHash === undefined ? {} : { expectedHeadHash },
    );
    eventCount += result.count;
    for (const p of result.problems) {
      problems.push({ groupId, eventId: p.eventId, index: p.index, problem: p.problem });
    }
    const malformedHere = log.malformed.some((m) => m.groupId === groupId);
    groups.push({
      groupId,
      count: result.count,
      headHash: result.headHash,
      ok: result.ok && !malformedHere,
    });
  }
  return { source, groups, problems, eventCount, ok: problems.length === 0 };
}

// ---------- output ----------

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Ids come from a possibly tampered log: print them only if they look like ids. */
function printableId(id: string | null): string {
  if (id === null || id === '') return '-';
  return SAFE_ID.test(id) ? id : '<invalid-id>';
}

/** Hashes come from the log too; print only well-formed ones. */
function printableHash(hash: string): string {
  return isSha256Hex(hash) ? hash : '<invalid-hash>';
}

export function formatReport(report: VerifyReport): string[] {
  const lines = report.problems.map(
    (p) =>
      `PROBLEM group=${printableId(p.groupId)} event=${printableId(p.eventId)} ` +
      `index=${String(p.index)} problem=${p.problem}`,
  );
  for (const g of report.groups) {
    lines.push(
      `HEAD group=${printableId(g.groupId)} events=${String(g.count)} hash=${printableHash(g.headHash)}`,
    );
  }
  const failed = report.groups.filter((g) => !g.ok).length;
  const verdict = report.ok ? 'OK' : 'FAIL';
  lines.push(
    `${verdict}: ${String(report.groups.length)} group(s), ${String(report.eventCount)} event(s), ` +
      `${String(report.problems.length)} problem(s), ${String(failed)} group(s) failing (${report.source})`,
  );
  return lines;
}

// ---------- CLI ----------

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Resolves the default database path; injectable for tests. */
  readonly defaultPath?: () => string;
}

const USAGE =
  'usage: pnpm audit:verify [--expect-head <groupId>=<sha256>]... [path.sqlite | export.json | export.jsonl]\n' +
  '  default: <repo>/.trav/trav.sqlite\n' +
  '  --expect-head: fail with head_mismatch unless the group chain ends at this hash (repeatable)';

type Source = { kind: 'sqlite' | 'json' | 'jsonl'; path: string; isDefault: boolean };

interface ParsedArgs {
  readonly source: Source;
  readonly expectedHeads: ExpectedHeads;
}

const EXPECT_HEAD = /^([A-Za-z0-9_.:-]{1,128})=([0-9a-f]{64})$/;

/** Parses `--expect-head <groupId>=<hash>` (also `--expect-head=<groupId>=<hash>`), repeatable, one group per flag. */
export function parseExpectedHead(value: string | undefined, into: Map<string, string>): void {
  const match = value === undefined ? null : EXPECT_HEAD.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new AuditVerifyUsageError('--expect-head needs <groupId>=<64 hex chars>');
  }
  if (into.has(match[1])) {
    throw new AuditVerifyUsageError(`--expect-head given twice for ${match[1]}`);
  }
  into.set(match[1], match[2]);
}

function parseArgs(argv: readonly string[], defaultPath: () => string): ParsedArgs | 'help' {
  const args = argv.filter((a) => a !== '--');
  if (args.includes('-h') || args.includes('--help')) return 'help';
  const expectedHeads = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--expect-head') {
      i += 1;
      parseExpectedHead(args[i], expectedHeads);
    } else if (arg.startsWith('--expect-head=')) {
      parseExpectedHead(arg.slice('--expect-head='.length), expectedHeads);
    } else if (arg.startsWith('-')) {
      throw new AuditVerifyUsageError(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new AuditVerifyUsageError('expected at most one path argument');
  const arg = positional[0];
  if (arg === undefined) {
    return { source: { kind: 'sqlite', path: defaultPath(), isDefault: true }, expectedHeads };
  }
  const path = resolve(arg);
  const lower = path.toLowerCase();
  const kind = lower.endsWith('.sqlite')
    ? 'sqlite'
    : lower.endsWith('.jsonl')
      ? 'jsonl'
      : lower.endsWith('.json')
        ? 'json'
        : undefined;
  if (kind === undefined) {
    throw new AuditVerifyUsageError('path must end in .sqlite, .json or .jsonl');
  }
  return { source: { kind, path, isDefault: false }, expectedHeads };
}

/** Runs the verifier; returns the process exit code (0 ok, 1 problems, 2 usage/I-O error). */
export function runAuditVerify(argv: readonly string[], io: CliIo): number {
  let parsed: ParsedArgs | 'help';
  try {
    parsed = parseArgs(argv, io.defaultPath ?? defaultSqlitePath);
  } catch (error) {
    io.err(`audit:verify: ${error instanceof Error ? error.message : 'bad arguments'}`);
    io.err(USAGE);
    return 2;
  }
  if (parsed === 'help') {
    io.out(USAGE);
    return 0;
  }
  const { source, expectedHeads } = parsed;
  if (!existsSync(source.path)) {
    if (source.isDefault && expectedHeads.size === 0) {
      // Fresh checkout: no store has been written yet, so there is no chain to break.
      io.out(`OK: no audit log at ${source.path} yet; nothing to verify`);
      return 0;
    }
    io.err(`audit:verify: file not found: ${source.path}`);
    return 2;
  }
  let log: LoadedLog;
  try {
    log =
      source.kind === 'sqlite'
        ? loadFromSqliteFile(source.path)
        : loadFromJsonText(readFileSync(source.path, 'utf8'), source.kind);
  } catch (error) {
    // Messages here are our own or from node:sqlite/fs; never payload contents.
    const message =
      error instanceof AuditVerifyUsageError
        ? error.message
        : `could not read ${source.kind} file (${error instanceof Error ? error.name : 'error'})`;
    io.err(`audit:verify: ${message}`);
    return 2;
  }
  const report = verifyLoadedLog(log, source.path, expectedHeads);
  for (const line of formatReport(report)) {
    if (report.ok) io.out(line);
    else io.err(line);
  }
  return report.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = runAuditVerify(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}

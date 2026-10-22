import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatReport,
  loadFromJsonText,
  loadFromValues,
  runAuditVerify,
  verifyLoadedLog,
} from '../../../../scripts/audit-verify.js';
import type { CliIo } from '../../../../scripts/audit-verify.js';
import { createSimulatedClock } from '../clock.js';
import type { AuditEvent, AuditEventInput, AuditEventType } from '../domain/audit.js';
import { AUDIT_GENESIS_HASH } from '../domain/audit.js';
import { createDeterministicIdGenerator } from '../ids.js';
import { createSqliteStores } from '../storage/index.js';
import { computeAuditHash, computePayloadHash, sealAuditEvent } from './index.js';

// T-055: `pnpm audit:verify` (SAFETY §2.2 chain, §2.9 tombstones).

const T0 = '2026-03-14T21:40:00+01:00';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'audit-verify.ts');
const SECRET = 'SECRET-PAYLOAD-VALUE-razz-4821';

function input(
  type: AuditEventType,
  payload: Record<string, unknown> = {},
  overrides: Partial<AuditEventInput> = {},
): AuditEventInput {
  return {
    groupId: 'grp_barcelona',
    tripId: 'trip_barcelona',
    type,
    actor: { kind: 'trav', id: 'trav' },
    visibility: 'group',
    proposalId: 'prop_razz',
    payload,
    ...overrides,
  };
}

/** The Razzmatazz flow: above cap, so a complete grant precedes the purchase. */
function razzFlow(
  groupId = 'grp_barcelona',
  withGrant: boolean | 'incomplete' = true,
  outcome = 'needs_confirmation',
): AuditEventInput[] {
  const o = { groupId };
  return [
    input('proposal.created', { note: SECRET }, o),
    input('policy.evaluated', { outcome }, o),
    input('approval.requested', {}, o),
    ...(withGrant === false
      ? []
      : [input('approval.granted', { complete: withGrant === true }, o)]),
    input('booking.attempted', {}, o),
    input(
      'booking.completed',
      { totalMinor: 22500, currency: 'EUR' },
      { ...o, bookingId: 'bkg_1' },
    ),
  ];
}

function chain(inputs: readonly AuditEventInput[]): AuditEvent[] {
  const out: AuditEvent[] = [];
  inputs.forEach((i, idx) => {
    const prev = out[idx - 1]?.hash ?? AUDIT_GENESIS_HASH;
    out.push(sealAuditEvent(i, `aud_${String(idx + 1).padStart(3, '0')}`, T0, prev));
  });
  return out;
}

function captureIo(defaultPath?: string): CliIo & { lines: string[]; errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    ...(defaultPath === undefined ? {} : { defaultPath: () => defaultPath }),
  };
}

describe('audit:verify script', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'trav-audit-verify-'));
    dirs.push(dir);
    return dir;
  };

  /** A real store file written through the append-only repository (sealAuditEvent inside). */
  const writeStore = (inputs: readonly AuditEventInput[]): string => {
    const path = join(tempDir(), '.trav', 'trav.sqlite');
    const stores = createSqliteStores({
      clock: createSimulatedClock(T0),
      ids: createDeterministicIdGenerator('t055'),
      sqlitePath: path,
    });
    for (const i of inputs) stores.group.audit.append(i);
    stores.close();
    return path;
  };

  /** Edits stored rows directly, like an attacker with file access would. */
  const editRows = (path: string, edit: (e: AuditEvent, i: number) => AuditEvent | null): void => {
    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare('SELECT pk, json FROM audit_events ORDER BY seq').all();
      rows.forEach((row, i) => {
        const next = edit(JSON.parse(String(row['json'])) as AuditEvent, i);
        if (next !== null) {
          db.prepare('UPDATE audit_events SET json = ? WHERE pk = ?').run(
            JSON.stringify(next),
            String(row['pk']),
          );
        }
      });
    } finally {
      db.close();
    }
  };

  const run = (args: string[]) => {
    const io = captureIo(join(tempDir(), '.trav', 'missing.sqlite'));
    const code = runAuditVerify(args, io);
    return { code, out: io.lines, err: io.errs, all: [...io.lines, ...io.errs].join('\n') };
  };

  it('passes on an intact multi-group SQLite log and prints each head hash and a summary', () => {
    const path = writeStore([...razzFlow('grp_barcelona'), ...razzFlow('grp_lisbon')]);
    const r = run([path]);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toHaveLength(3);
    expect(r.out[0]).toMatch(/^HEAD group=grp_barcelona events=6 hash=[0-9a-f]{64}$/);
    expect(r.out[1]).toMatch(/^HEAD group=grp_lisbon events=6 hash=[0-9a-f]{64}$/);
    expect(r.out[2]).toMatch(/^OK: 2 group\(s\), 12 event\(s\), 0 problem\(s\)/);
    expect(r.all).not.toContain(SECRET);
  });

  it('--expect-head anchors a group chain: matching passes, a rewritten or truncated chain fails, a vanished group fails', () => {
    const path = writeStore([...razzFlow('grp_barcelona'), ...razzFlow('grp_lisbon')]);
    const heads = new Map(
      run([path])
        .out.filter((l) => l.startsWith('HEAD'))
        .map((l) => {
          const m = /group=(\S+) events=\d+ hash=([0-9a-f]{64})/.exec(l);
          return [m?.[1] ?? '', m?.[2] ?? ''] as const;
        }),
    );
    const bcn = heads.get('grp_barcelona') ?? '';
    const lis = heads.get('grp_lisbon') ?? '';
    expect(bcn).toMatch(/^[0-9a-f]{64}$/);
    expect(run(['--expect-head', `grp_barcelona=${bcn}`, path]).code).toBe(0);
    expect(
      run([`--expect-head=grp_barcelona=${bcn}`, '--expect-head', `grp_lisbon=${lis}`, path]).code,
    ).toBe(0);

    // Full-chain rewrite from index 1 on, every hash recomputed: internally consistent...
    const db = new DatabaseSync(path);
    const rows = db
      .prepare("SELECT pk, json FROM audit_events WHERE group_id = 'grp_barcelona' ORDER BY seq")
      .all();
    let prev = AUDIT_GENESIS_HASH;
    rows.forEach((row, i) => {
      const e = JSON.parse(String(row['json'])) as AuditEvent;
      const edited = i === 1 ? { ...e, ts: '2026-03-15T00:00:00+01:00' } : e;
      const rehashed = { ...edited, prevHash: prev };
      const sealed = { ...rehashed, hash: computeAuditHash(rehashed) };
      prev = sealed.hash;
      db.prepare('UPDATE audit_events SET json = ? WHERE pk = ?').run(
        JSON.stringify(sealed),
        String(row['pk']),
      );
    });
    db.close();
    expect(run([path]).code).toBe(0);
    // ...until compared with the anchor recorded earlier.
    const anchored = run(['--expect-head', `grp_barcelona=${bcn}`, path]);
    expect(anchored.code).toBe(1);
    expect(anchored.err[0]).toMatch(
      /^PROBLEM group=grp_barcelona event=aud_\S+ index=5 problem=head_mismatch$/,
    );
    expect(run(['--expect-head', `grp_lisbon=${lis}`, path]).code).toBe(0);

    // A group that vanished entirely still fails its anchor.
    const gone = run(['--expect-head', `grp_tci=${lis}`, path]);
    expect(gone.code).toBe(1);
    expect(gone.err[0]).toBe('PROBLEM group=grp_tci event=- index=-1 problem=head_mismatch');
    expect(gone.all).toContain(`HEAD group=grp_tci events=0 hash=${AUDIT_GENESIS_HASH}`);

    // Bad anchors are usage errors.
    expect(run(['--expect-head', 'grp_barcelona', path]).code).toBe(2);
    expect(run(['--expect-head', `grp_barcelona=${bcn.slice(1)}`, path]).code).toBe(2);
    expect(
      run(['--expect-head', `grp_barcelona=${bcn}`, '--expect-head', `grp_barcelona=${lis}`, path])
        .code,
    ).toBe(2);
    expect(run(['--expect-head']).code).toBe(2);
    // An anchor against the missing default store is a failure, not "nothing to verify".
    expect(run(['--expect-head', `grp_barcelona=${bcn}`]).code).toBe(2);
  });

  it('fails on booking.completed after a deny, even with a complete grant, and on a duplicate completion', () => {
    const denied = writeStore(razzFlow('grp_barcelona', true, 'deny'));
    const r = run([denied]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toMatch(/index=5 problem=completed_after_deny$/);

    const twice = writeStore([
      ...razzFlow('grp_barcelona'),
      input('booking.completed', { totalMinor: 22500, currency: 'EUR' }, { bookingId: 'bkg_2' }),
    ]);
    const r2 = run([twice]);
    expect(r2.code).toBe(1);
    expect(r2.err[0]).toMatch(/index=6 problem=duplicate_completion$/);
  });

  it('the repository refuses a policy.evaluated with an unknown outcome, so none reaches the log', () => {
    const path = join(tempDir(), '.trav', 'trav.sqlite');
    const stores = createSqliteStores({
      clock: createSimulatedClock(T0),
      ids: createDeterministicIdGenerator('t055'),
      sqlitePath: path,
    });
    try {
      expect(() =>
        stores.group.audit.append(input('policy.evaluated', { outcome: 'require_approval' })),
      ).toThrow(/outcome/);
      expect(stores.group.audit.listByGroup('grp_barcelona')).toEqual([]);
    } finally {
      stores.close();
    }
  });

  it('does not modify the SQLite file (opened read-only)', () => {
    const path = writeStore(razzFlow());
    const before = new DatabaseSync(path, { readOnly: true });
    const snapshot = before.prepare('SELECT pk, json FROM audit_events ORDER BY seq').all();
    before.close();
    expect(run([path]).code).toBe(0);
    const after = new DatabaseSync(path, { readOnly: true });
    expect(after.prepare('SELECT pk, json FROM audit_events ORDER BY seq').all()).toEqual(snapshot);
    after.close();
  });

  it('fails on a tampered copy (one stored hash edited) with group, event id and code', () => {
    const path = writeStore(razzFlow());
    let tamperedId = '';
    editRows(path, (e, i) => {
      if (i !== 2) return null;
      tamperedId = e.id;
      return { ...e, hash: 'f'.repeat(64) };
    });
    const r = run([path]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `PROBLEM group=grp_barcelona event=${tamperedId} index=2 problem=hash_mismatch`,
    );
    // The next event no longer links to the edited hash.
    expect(r.all).toMatch(/index=3 problem=prev_hash_mismatch/);
    expect(r.err.at(-1)).toMatch(
      /^FAIL: 1 group\(s\), 6 event\(s\), 2 problem\(s\), 1 group\(s\) failing/,
    );
    expect(r.all).not.toContain(SECRET);
  });

  it('fails when a payload is edited but the hash left alone', () => {
    const path = writeStore(razzFlow());
    editRows(path, (e) =>
      e.type === 'booking.completed' ? { ...e, payload: { ...e.payload, totalMinor: 1 } } : null,
    );
    const r = run([path]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/index=5 problem=hash_mismatch/);
  });

  it('fails on booking.completed without approval.granted, even though the hashes link', () => {
    const path = writeStore(razzFlow('grp_barcelona', false));
    const r = run([path]);
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(3);
    expect(r.err[0]).toMatch(
      /^PROBLEM group=grp_barcelona event=aud_\S+ index=4 problem=completed_without_grant$/,
    );
    expect(r.err[1]).toMatch(/^HEAD group=grp_barcelona events=5 hash=[0-9a-f]{64}$/);
  });

  it('only fails the broken group when other groups are intact', () => {
    const path = writeStore([...razzFlow('grp_barcelona'), ...razzFlow('grp_lisbon', false)]);
    const r = run([path]);
    expect(r.code).toBe(1);
    const problemLines = r.err.filter((l) => l.startsWith('PROBLEM'));
    expect(problemLines.join('\n')).not.toContain('group=grp_barcelona');
    expect(problemLines.join('\n')).toContain('group=grp_lisbon');
    expect(r.err.at(-1)).toMatch(
      /2 group\(s\), 11 event\(s\), 1 problem\(s\), 1 group\(s\) failing/,
    );
  });

  it('passes on a "forget this trip" tombstone chain and still rejects a laundered incomplete grant', () => {
    const redactedStore = (withGrant: boolean | 'incomplete'): string => {
      const path = join(tempDir(), '.trav', 'trav.sqlite');
      const stores = createSqliteStores({
        clock: createSimulatedClock(T0),
        ids: createDeterministicIdGenerator('t055'),
        sqlitePath: path,
      });
      for (const i of razzFlow('grp_barcelona', withGrant)) stores.group.audit.append(i);
      expect(stores.redactAuditPayloads('trip_barcelona')).toBe(withGrant === false ? 5 : 6);
      stores.close();
      return path;
    };
    const ok = run([redactedStore(true)]);
    expect(ok.code).toBe(0);
    expect(ok.out.at(-1)).toMatch(/^OK: 1 group\(s\), 6 event\(s\)/);
    expect(ok.all).not.toContain(SECRET);

    // The grant's `complete: false` lives in the hashed header, so redaction cannot hide it.
    const laundered = run([redactedStore('incomplete')]);
    expect(laundered.code).toBe(1);
    expect(laundered.err[0]).toMatch(/index=5 problem=completed_without_grant$/);
  });

  it('a bare { redacted: true } written over a row is a hash_mismatch; the digest tombstone passes and catches a header edit', () => {
    const path = writeStore(razzFlow());
    editRows(path, (e, i) => (i === 0 ? { ...e, payload: { redacted: true } } : null));
    const bare = run([path]);
    expect(bare.code).toBe(1);
    expect(bare.err[0]).toMatch(/index=0 problem=hash_mismatch$/);

    editRows(path, (e, i) => ({
      ...e,
      payload: i === 0 ? { note: SECRET } : e.payload,
    }));
    editRows(path, (e) => ({
      ...e,
      payload: { redacted: true, payloadHash: computePayloadHash(e.payload) },
    }));
    expect(run([path]).code).toBe(0);
    editRows(path, (e, i) => (i === 1 ? { ...e, ts: '2026-03-15T00:00:00+01:00' } : null));
    const r = run([path]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/index=1 problem=hash_mismatch/);
  });

  it('reports a corrupt row as malformed_event instead of crashing', () => {
    const path = writeStore(razzFlow());
    const db = new DatabaseSync(path);
    db.prepare(
      "UPDATE audit_events SET json = '{not json' WHERE seq = (SELECT MAX(seq) FROM audit_events)",
    ).run();
    db.close();
    const r = run([path]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/group=grp_barcelona event=aud_\S+ index=5 problem=malformed_event/);
  });

  it('verifies a JSON export (array and { events }) and a JSONL export', () => {
    const events = chain(razzFlow('grp_barcelona'));
    const tci = chain(razzFlow('grp_tci'));
    const dir = tempDir();
    const arr = join(dir, 'audit.json');
    writeFileSync(arr, JSON.stringify([...events, ...tci]));
    const wrapped = join(dir, 'wrapped.json');
    writeFileSync(wrapped, JSON.stringify({ events: [...events, ...tci] }));
    const lines = join(dir, 'audit.jsonl');
    writeFileSync(lines, [...events, ...tci].map((e) => JSON.stringify(e)).join('\n') + '\n');
    for (const p of [arr, wrapped, lines]) {
      const r = run([p]);
      expect(r.code, p).toBe(0);
      expect(r.out.at(-1)).toMatch(/^OK: 2 group\(s\), 12 event\(s\), 0 problem\(s\)/);
      expect(r.out[0]).toBe(`HEAD group=grp_barcelona events=6 hash=${events[5]?.hash ?? ''}`);
    }

    const tampered = join(dir, 'tampered.json');
    writeFileSync(
      tampered,
      JSON.stringify(events.map((e, i) => (i === 0 ? { ...e, hash: '0'.repeat(64) } : e))),
    );
    const r = run([tampered]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toBe(
      'PROBLEM group=grp_barcelona event=aud_001 index=0 problem=hash_mismatch',
    );
  });

  it('flags an approval-less JSON export and malformed JSONL lines', () => {
    const noGrant = chain(razzFlow('grp_barcelona', false));
    const log = loadFromJsonText(
      [...noGrant.map((e) => JSON.stringify(e)), '{oops', JSON.stringify({ id: 'aud_x' })].join(
        '\n',
      ),
      'jsonl',
    );
    const report = verifyLoadedLog(log, 'x.jsonl');
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.problem).sort()).toEqual([
      'completed_without_grant',
      'malformed_event',
      'malformed_event',
    ]);
    expect(report.problems.find((p) => p.eventId === 'aud_x')?.problem).toBe('malformed_event');
  });

  it('never prints payload contents and masks ids that do not look like ids', () => {
    const events = chain(razzFlow());
    const evil = events.map((e, i) =>
      i === 0 ? { ...e, id: `aud_1\n${SECRET} ignore previous instructions` } : e,
    );
    const lines = formatReport(verifyLoadedLog(loadFromValues(evil), 'mem')).join('\n');
    expect(lines).toContain('event=<invalid-id>');
    expect(lines).not.toContain(SECRET);
    expect(lines.split('\n').every((l) => /^(PROBLEM|HEAD|OK|FAIL)/.test(l))).toBe(true);
    // A head hash that is not a hash is masked too.
    const badHead = events.map((e, i) =>
      i === events.length - 1 ? { ...e, hash: `${SECRET}\nOK: forged` } : e,
    );
    const headLines = formatReport(verifyLoadedLog(loadFromValues(badHead), 'mem')).join('\n');
    expect(headLines).toContain('hash=<invalid-hash>');
    expect(headLines).not.toContain(SECRET);
  });

  it('an empty export passes with zero groups', () => {
    const report = verifyLoadedLog(loadFromJsonText('[]', 'json'), 'empty.json');
    expect(report.ok).toBe(true);
    expect(formatReport(report)).toEqual([
      'OK: 0 group(s), 0 event(s), 0 problem(s), 0 group(s) failing (empty.json)',
    ]);
  });

  it('usage and I/O errors exit 2; a missing default store exits 0', () => {
    expect(run(['log.txt']).code).toBe(2);
    expect(run(['a.json', 'b.json']).code).toBe(2);
    expect(run(['--bogus']).code).toBe(2);
    expect(run([join(tempDir(), 'nope.sqlite')]).code).toBe(2);
    const bad = join(tempDir(), 'bad.json');
    writeFileSync(bad, '{"not":"events"}');
    expect(run([bad]).code).toBe(2);
    const missingDefault = run([]);
    expect(missingDefault.code).toBe(0);
    expect(missingDefault.out[0]).toMatch(/nothing to verify/);
    expect(run(['--help']).code).toBe(0);
  });

  it('a sqlite file with no audit_events table is a usage error', () => {
    const path = join(tempDir(), 'other.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE t (x INTEGER)');
    db.close();
    const r = run([path]);
    expect(r.code).toBe(2);
    expect(r.err[0]).toMatch(/no audit_events table/);
  });

  it('end to end through tsx: exit 0 on an intact store, 1 on a tampered one', () => {
    const path = writeStore(razzFlow());
    const exec = () =>
      spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, path], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, TRAV_OFFLINE: '1' },
      });
    const ok = exec();
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(
      /^HEAD group=grp_barcelona events=6 hash=[0-9a-f]{64}\nOK: 1 group\(s\), 6 event\(s\)/,
    );
    editRows(path, (e, i) => (i === 0 ? { ...e, hash: 'a'.repeat(64) } : null));
    const bad = exec();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/problem=hash_mismatch/);
    expect(bad.stdout + bad.stderr).not.toContain(SECRET);
  }, 30_000);
});

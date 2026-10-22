import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createSimulatedClock } from '../clock.js';
import { createDeterministicIdGenerator } from '../ids.js';
import { verifyAuditChain } from '../audit/index.js';
import { TravError } from '../errors.js';
import { createSqliteStores, defaultSqlitePath, resolveSqlitePath } from './sqlite/index.js';
import { LATEST_SCHEMA_VERSION } from './sqlite/migrations.js';
import { ALL_SPECS } from './shared/schema.js';
import { GROUP_TABLES, PRIVATE_TABLES } from './shared/backend.js';
import { makeGroup, makeMember, runRepositorySuite } from './repository.suite.js';

runRepositorySuite('sqlite :memory:', (deps) =>
  createSqliteStores({ ...deps, sqlitePath: ':memory:' }),
);

describe('sqlite specifics', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempTravPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'trav-sqlite-'));
    dirs.push(dir);
    return join(dir, '.trav', 'test.sqlite');
  };
  const deps = (seed: string) => ({
    clock: createSimulatedClock('2026-03-14T21:40:00+01:00'),
    ids: createDeterministicIdGenerator(seed),
  });

  it('migrates on open: every table and indexed column of the specs exists; user_version is latest', () => {
    const path = tempTravPath();
    createSqliteStores({ ...deps('a'), sqlitePath: path }).close();
    const db = new DatabaseSync(path);
    try {
      expect(Number(db.prepare('PRAGMA user_version').get()?.user_version)).toBe(
        LATEST_SCHEMA_VERSION,
      );
      for (const name of [...GROUP_TABLES, ...PRIVATE_TABLES]) {
        const cols = db
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((r) => String(r.name));
        expect(cols, name).toEqual(['seq', 'pk', ...Object.keys(ALL_SPECS[name].columns), 'json']);
      }
      // Unique indexes (besides pk) are exactly the spec's unique groups, so the
      // SQLite backstop and the memory backend enforce the same constraints.
      for (const name of [...GROUP_TABLES, ...PRIVATE_TABLES]) {
        const uniques = db
          .prepare(`PRAGMA index_list(${name})`)
          .all()
          .filter((ix) => Number(ix.unique) === 1 && String(ix.origin) === 'c')
          .map((ix) =>
            db
              .prepare(`PRAGMA index_info(${String(ix.name)})`)
              .all()
              .map((c) => String(c.name))
              .join(','),
          )
          .sort();
        const expected = (ALL_SPECS[name].unique ?? []).map((g) => g.join(',')).sort();
        expect(uniques, name).toEqual(expected);
      }
      for (const name of PRIVATE_TABLES) {
        expect(Object.keys(ALL_SPECS[name].columns), name).toContain('owner_member_id');
      }
    } finally {
      db.close();
    }
  });

  it('persists across reopen; the audit chain continues from the stored head; re-open does not re-migrate', () => {
    const path = tempTravPath();
    const first = createSqliteStores({ ...deps('a'), sqlitePath: path });
    first.group.groups.create(makeGroup());
    first.group.members.upsert(makeMember('mem_dean'));
    const e1 = first.group.audit.append({
      groupId: 'grp_barcelona',
      tripId: null,
      type: 'member.joined',
      actor: { kind: 'system', id: 'sim' },
      visibility: 'group',
      payload: { memberId: 'mem_dean', role: 'member', by: 'sim' },
    });
    first.close();

    const second = createSqliteStores({ ...deps('b'), sqlitePath: path });
    try {
      expect(second.group.groups.get('grp_barcelona')?.name).toBe('barcelona crew');
      expect(second.group.members.getBySenderId('grp_barcelona', 'sender_mem_dean')?.memberId).toBe(
        'mem_dean',
      );
      const e2 = second.group.audit.append({
        groupId: 'grp_barcelona',
        tripId: null,
        type: 'settings.changed',
        actor: { kind: 'member', id: 'mem_dean' },
        visibility: 'group',
        payload: { roastMode: false },
      });
      expect(e2.prevHash).toBe(e1.hash);
      expect(verifyAuditChain(second.group.audit.listByGroup('grp_barcelona')).ok).toBe(true);
    } finally {
      second.close();
    }
  });

  it('refuses a database whose schema is newer than this build', () => {
    const path = tempTravPath();
    createSqliteStores({ ...deps('a'), sqlitePath: path }).close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${String(LATEST_SCHEMA_VERSION + 1)}`);
    db.close();
    expect(() => createSqliteStores({ ...deps('a'), sqlitePath: path })).toThrow(TravError);
  });

  it('the file path must be :memory: or under a .trav/ directory; default is <repo>/.trav/trav.sqlite', () => {
    expect(resolveSqlitePath(':memory:')).toBe(':memory:');
    expect(defaultSqlitePath()).toMatch(/[/\\]\.trav[/\\]trav\.sqlite$/);
    const outside = join(tmpdir(), 'trav-not-allowed.sqlite');
    expect(() => resolveSqlitePath(outside)).toThrow(TravError);
    expect(() => createSqliteStores({ ...deps('a'), sqlitePath: outside })).toThrow(TravError);
  });
});

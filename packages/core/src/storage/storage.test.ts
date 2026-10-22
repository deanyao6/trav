/**
 * Backend-level and structural tests that are not repository behavior:
 * transaction rollback for both backends, the B2 grep test, the .gitignore
 * check, and "no wall clock in storage".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TravError } from '../errors.js';
import type { Backend } from './shared/backend.js';
import { createMemoryBackend } from './memory/index.js';
import { createSqliteBackend } from './sqlite/index.js';
import { groupMemorySpec, membersSpec } from './shared/schema.js';
import type { GroupMemoryFact } from '../domain/memory.js';
import type { Member } from '../domain/group.js';

const here = dirname(fileURLToPath(import.meta.url));

const fact = (factId: string, groupId = 'grp_a'): GroupMemoryFact => ({
  factId,
  groupId,
  sourceTripId: null,
  category: 'other',
  text: factId,
  aboutMemberIds: [],
  sourceMessageId: 'msg_1',
  learnedAt: '2026-03-14T21:40:00+01:00',
});

for (const [name, make] of [
  ['memory', () => createMemoryBackend()],
  ['sqlite', () => createSqliteBackend(':memory:')],
] as const) {
  describe(`backend: ${name}`, () => {
    const withBackend = (fn: (b: Backend) => void): void => {
      const b: Backend = make();
      try {
        fn(b);
      } finally {
        b.close();
      }
    };

    it('a throw inside transaction() undoes inserts, upserts and deletes', () => {
      withBackend((b) => {
        const t = b.table(groupMemorySpec);
        t.insert(fact('f1'));
        t.insert(fact('f2'));
        expect(() =>
          b.transaction(() => {
            t.insert(fact('f3'));
            t.upsert({ ...fact('f1'), text: 'changed' });
            t.deleteKey('f2');
            t.deleteWhere({ group_id: 'grp_a' });
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(t.find({}).map((f) => [f.factId, f.text])).toEqual([
          ['f1', 'f1'],
          ['f2', 'f2'],
        ]);
      });
    });

    it('nested transactions roll back only the inner part when the inner error is caught', () => {
      withBackend((b) => {
        const t = b.table(groupMemorySpec);
        b.transaction(() => {
          t.insert(fact('outer'));
          try {
            b.transaction(() => {
              t.insert(fact('inner'));
              throw new Error('inner');
            });
          } catch {
            // swallowed on purpose
          }
          t.insert(fact('after'));
        });
        expect(t.find({}).map((f) => f.factId)).toEqual(['outer', 'after']);
      });
    });

    it('enforces primary keys and unique groups with TravError(duplicate) as a backstop', () => {
      withBackend((b) => {
        const t = b.table(membersSpec);
        const m = (memberId: string, groupId: string, senderId: string): Member => ({
          memberId,
          groupId,
          senderId,
          displayName: memberId,
          role: 'member',
          active: true,
          ageBand: 'adult',
          joinedAt: '2026-03-14T21:40:00+01:00',
        });
        t.insert(m('mem_a', 'grp_a', 's1'));
        const code = (fn: () => void): string | undefined => {
          try {
            fn();
          } catch (e) {
            return e instanceof TravError ? e.code : 'not-a-trav-error';
          }
          return undefined;
        };
        expect(code(() => t.insert(m('mem_a', 'grp_b', 's9')))).toBe('duplicate');
        expect(code(() => t.insert(m('mem_b', 'grp_a', 's1')))).toBe('duplicate');
        expect(code(() => t.upsert(m('mem_b', 'grp_a', 's1')))).toBe('duplicate');
        t.insert(m('mem_c', 'grp_b', 's1'));
        t.upsert(m('mem_a', 'grp_a', 's1'));
        expect(t.count({})).toBe(2);
      });
    });

    it('upsert keeps insertion position; last() returns the newest match; deleteWhere({}) refuses', () => {
      withBackend((b) => {
        const t = b.table(groupMemorySpec);
        t.insert(fact('f1'));
        t.insert(fact('f2'));
        t.upsert({ ...fact('f1'), text: 'again' });
        expect(t.find({}).map((f) => f.factId)).toEqual(['f1', 'f2']);
        expect(t.last({ group_id: 'grp_a' })?.factId).toBe('f2');
        expect(t.last({ group_id: 'grp_none' })).toBeUndefined();
        expect(() => t.deleteWhere({})).toThrow(TravError);
        expect(t.find({ source_trip_id: null })).toHaveLength(2);
      });
    });
  });
}

describe('structural (SAFETY B2, D-008)', () => {
  it('the audit repository source only appends and reads (grep)', () => {
    const src = readFileSync(join(here, 'shared', 'auditRepository.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(
      /\.\s*(upsert|update\w*|delete\w*|remove\w*|replace\w*|redact\w*|clear|set|truncate\w*)\s*\(/i,
    );
    expect(code).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE|REPLACE)\b/);
    // The methods it defines are exactly the interface's append/read set.
    const methods = [...code.matchAll(/^\s{4}(\w+)(?:\(|:|,)/gm)].map((m) => m[1]).sort();
    expect(methods).toEqual(
      [
        'append',
        'get',
        'lastHash',
        'listByBooking',
        'listByGroup',
        'listByProposal',
        'listGroupVisible',
      ].sort(),
    );
  });

  it('the AuditRepository interface declares no update/delete method', () => {
    const src = readFileSync(join(here, '..', 'repositories.ts'), 'utf8');
    const body = /export interface AuditRepository \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    expect(body).toContain('append(');
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/\b(update|delete|remove|replace|redact|upsert)\w*\s*\(/i);
  });

  it('PrivateStore (SAFETY C3): every method takes ownerMemberId first except countPendingByOwner, which returns counts', () => {
    const src = readFileSync(join(here, '..', 'repositories.ts'), 'utf8');
    const body = /export interface PrivateStore \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const methods = [...code.matchAll(/^\s+(\w+)\(\s*([\w]+)?/gm)].map((m) => ({
      name: m[1],
      firstParam: m[2],
    }));
    expect(methods.length).toBeGreaterThan(15);
    const crossOwner = methods.filter((m) => m.firstParam !== 'ownerMemberId').map((m) => m.name);
    expect(crossOwner).toEqual(['countPendingByOwner']);
    expect(code).toMatch(
      /countPendingByOwner\(groupId: GroupId\): Readonly<Record<MemberId, number>>;/,
    );
  });

  it('storage reads time only from the injected clock (no Date.now / new Date())', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory()
          ? walk(p)
          : p.endsWith('.ts') && !p.endsWith('.test.ts')
            ? [p]
            : [];
      });
    for (const file of walk(here)) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/Date\.now\(|new Date\(\s*\)/);
    }
  });

  it('.trav/ (the SQLite location) is gitignored', () => {
    const gitignore = readFileSync(join(here, '..', '..', '..', '..', '.gitignore'), 'utf8');
    expect(gitignore.split('\n').map((l) => l.trim())).toContain('.trav/');
  });
});

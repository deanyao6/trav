/**
 * T-170 over SQLite: a newcomer's setup survives a restart (the state is in
 * their own PrivateStore partition), and after "@trav leave" a new process
 * over the same file finds nothing of the group: no rows, no runtime state,
 * no jobs, no dedupe keys naming its conversation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SimulatorChannel } from '@trav/adapters';
import { createSimulatorChannel } from '@trav/adapters';
import type { SimulatedClock } from '@trav/core';
import { createDeterministicIdGenerator, createSimulatedClock } from '@trav/core';
import { createSqliteStores } from '@trav/core/storage';
import { BARCELONA, BARCELONA_NOW, createTravRuntime, type TravRuntime } from '../compose.js';
import { offlineModel, tempStateDir } from '../runtime.testkit.js';
import { ONBOARDING_NS } from './flow.js';

const G = BARCELONA.groupId;
const PHONE = '+16175550199';

const dirs: string[] = [];
const open: TravRuntime[] = [];
afterEach(() => {
  for (const r of open.splice(0)) {
    try {
      r.close();
    } catch {
      // closed by the test
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface World {
  readonly path: string;
  readonly clock: SimulatedClock;
  readonly channel: SimulatorChannel;
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'trav-t170-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.trav'));
  const clock = createSimulatedClock(BARCELONA_NOW);
  const channel = createSimulatorChannel({
    clock,
    conversations: [
      {
        conversationId: BARCELONA.conversationId,
        participants: [
          ...BARCELONA.members.map((m) => ({
            handle: m.handle,
            displayName: m.name,
            memberId: m.memberId,
          })),
          { handle: PHONE, displayName: PHONE },
        ],
      },
    ],
  });
  return { path: join(dir, '.trav', 'trav.sqlite'), clock, channel };
}

function boot(w: World, life: string, seed: 'barcelona' | 'none'): TravRuntime {
  const ids = createDeterministicIdGenerator(life);
  const stores = createSqliteStores({ clock: w.clock, ids, sqlitePath: w.path });
  const runtime = createTravRuntime({
    channel: w.channel,
    clock: w.clock,
    ids,
    stores,
    seed,
    offline: true,
    env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: tempStateDir() },
    model: offlineModel(w.clock),
    transactions: false,
    voice: 'strict',
    onboarding: true,
  });
  open.push(runtime);
  return runtime;
}

async function say(w: World, r: TravRuntime, from: string, text: string, lane?: 'dm') {
  const e = await w.channel.injectMessage({ from, text, ...(lane ? { lane } : {}) });
  return r.agent.handleInbound(e);
}

describe('T-170 across a restart', () => {
  it('a newcomer half way through setup carries on in the next process; the DM is not sent twice', async () => {
    const w = world();
    const a = boot(w, 'a', 'barcelona');
    expect((await say(w, a, PHONE, 'hey all')).note).toBe('onboarding:dm_sent');
    expect((await say(w, a, PHONE, 'Sam', 'dm')).note).toBe('onboarding:name_saved');
    a.close();

    const b = boot(w, 'b', 'barcelona');
    expect((await say(w, b, PHONE, 'hey again')).note).toBe('onboarding:waiting');
    const done = await say(w, b, PHONE, 'yes', 'dm');
    expect(done.note).toBe('onboarding:done:adult');
    const sam = b.stores.group.members.getBySenderId(G, PHONE)!;
    expect(sam).toMatchObject({ displayName: 'Sam', active: true });
    expect(b.stores.private.listRuntimeState(sam.memberId, ONBOARDING_NS)).toEqual([]);
  });

  it('after "@trav leave", the next process over the same file finds nothing of the group', async () => {
    const w = world();
    const a = boot(w, 'a', 'barcelona');
    await say(w, a, 'h_dean', '@trav i paid €84 for dinner, split with everyone');
    await say(w, a, PHONE, 'hey all');
    await say(w, a, 'h_dean', '@trav leave');
    expect((await say(w, a, 'h_dean', 'delete it')).note).toBe('leave:done');
    a.close();

    // Read the raw file: no row of any group-keyed table names the group.
    const db = new DatabaseSync(w.path, { readOnly: true });
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((t) => t.name);
      expect(tables).toEqual(expect.arrayContaining(['members', 'groups', 'runtime_state']));
      expect(tables.length).toBeGreaterThan(15);
      for (const t of tables) {
        if (t === 'audit_events' || t.startsWith('sqlite_')) continue;
        const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
          (c) => c.name,
        );
        if (cols.includes('group_id')) {
          const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE group_id = ?`).get(G) as {
            n: number;
          };
          expect(n.n, t).toBe(0);
        }
        // Nothing anywhere still carries a member's handle or the conversation id.
        const rows = db.prepare(`SELECT * FROM ${t}`).all();
        const text = JSON.stringify(rows);
        expect(text.includes(PHONE), t).toBe(false);
        expect(text.includes(BARCELONA.conversationId), t).toBe(false);
      }
    } finally {
      db.close();
    }

    const b = boot(w, 'b', 'none');
    expect(b.stores.group.groups.get(G)).toBeUndefined();
    expect(b.scheduler.list().filter((j) => j.groupId === G)).toEqual([]);
    expect((await say(w, b, 'h_dean', '@trav hi')).note).toBe('unknown_conversation');
  });
});

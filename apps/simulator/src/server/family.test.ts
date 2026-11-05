import { describe, expect, it } from 'vitest';
import { createMemoryStores } from '@trav/core/storage';
import { createSimulatedClock, createUlidIdGenerator } from '@trav/core';
import type { SimulatorBackend } from './backend.js';
import { SIM_GROUPS } from './groups.js';
import { loadAgentBackend } from './runtime.js';
import { seedFixtureGroups } from './seed.js';
import { demoBackend } from './testkit.js';

function threadOf(backend: SimulatorBackend, groupId: string) {
  const g = backend.state().groups.find((x) => x.group.groupId === groupId);
  if (g === undefined) throw new Error(`no group ${groupId}`);
  return g.thread.filter((e) => e.kind === 'message');
}

const isNotice = (text: string): boolean => /family mode/i.test(text);

describe('family-mode notice in the simulator (T-021)', () => {
  it('posts once in the Turks and Caicos chat, first, before the seeded lines', async () => {
    const backend = await demoBackend();
    const tci = threadOf(backend, 'grp_turks_caicos');
    const notices = tci.filter(
      (e) => e.kind === 'message' && e.from === 'trav' && isNotice(e.text),
    );
    expect(notices).toHaveLength(1);
    expect(tci[0]).toBe(notices[0]);
    expect(notices[0]!.text).toMatch(/Lily/);
    // The seeded family lines still follow, and Trav stays quiet on them (no mention).
    expect(tci.filter((e) => e.from !== 'trav')).toHaveLength(3);
    expect(tci.filter((e) => e.from === 'trav')).toHaveLength(1);
  });

  it('never posts in the all-adult chats', async () => {
    const backend = await demoBackend();
    for (const id of ['grp_barcelona', 'grp_lisbon']) {
      expect(threadOf(backend, id).some((e) => e.from === 'trav' && isNotice(e.text))).toBe(false);
    }
  });

  it('a restart starts a fresh session with exactly one notice again; unseeded sessions get it too', async () => {
    const backend = await demoBackend();
    await backend.reset!({});
    const count = (b: SimulatorBackend): number =>
      threadOf(b, 'grp_turks_caicos').filter((e) => e.from === 'trav' && isNotice(e.text)).length;
    expect(count(backend)).toBe(1);
    await backend.reset!({ seed: false });
    expect(count(backend)).toBe(1);
    const bare = await loadAgentBackend({ offline: true });
    expect(count(bare)).toBe(1);
  });
});

describe('seedFixtureGroups', () => {
  const make = () => {
    const clock = createSimulatedClock('2026-03-14T17:30:00+01:00');
    return createMemoryStores({ clock, ids: createUlidIdGenerator(clock) });
  };

  it('writes Lisbon and Turks and Caicos with the simulator handles, and skips Barcelona', () => {
    const stores = make();
    expect(seedFixtureGroups(stores, SIM_GROUPS)).toEqual(['grp_lisbon', 'grp_turks_caicos']);
    const lily = stores.group.members.get('mem_tci_lily');
    expect(lily?.senderId).toBe('h_tci_lily');
    expect(lily?.birthDate).toBe('2011-09-08');
    expect(stores.group.groups.getByConversation('conv_turks_caicos')?.groupId).toBe(
      'grp_turks_caicos',
    );
    expect(stores.group.groups.get('grp_barcelona')).toBeUndefined();
  });

  it('is idempotent: a group already in the stores is left alone', () => {
    const stores = make();
    seedFixtureGroups(stores, SIM_GROUPS);
    expect(seedFixtureGroups(stores, SIM_GROUPS)).toEqual([]);
  });

  it('seeds only the groups it is given', () => {
    const stores = make();
    expect(seedFixtureGroups(stores, [])).toEqual([]);
    expect(stores.group.groups.list()).toHaveLength(0);
  });
});

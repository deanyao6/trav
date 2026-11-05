import { describe, expect, it } from 'vitest';
import { createMemoryStores } from '@trav/core/storage';
import { createSimulatedClock, createUlidIdGenerator } from '@trav/core';
import type { SimulatorBackend } from './backend.js';
import { SIM_GROUPS } from './groups.js';
import { loadAgentBackend } from './runtime.js';
import type { SimulatorChannel } from '@trav/adapters';
import { DEMO_SEED, SEED_START, seedChat, seedFixtureGroups } from './seed.js';
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

describe('seedFixtureGroups never seeds private data', () => {
  it('leaves consent, prefs, member memory and group memory empty for the seeded groups', () => {
    const clock = createSimulatedClock('2026-03-14T17:30:00+01:00');
    const stores = createMemoryStores({ clock, ids: createUlidIdGenerator(clock) });
    const seeded = seedFixtureGroups(stores, SIM_GROUPS);
    expect(seeded).toEqual(['grp_lisbon', 'grp_turks_caicos']);
    let members = 0;
    for (const groupId of seeded) {
      expect(stores.group.groupMemory.listByGroup(groupId)).toEqual([]);
      for (const m of stores.group.members.listByGroup(groupId)) {
        members += 1;
        expect(stores.private.getConsent(m.memberId, groupId)).toBeUndefined();
        expect(stores.private.getPrefs(m.memberId)).toBeUndefined();
        expect(stores.private.listMemberMemory(m.memberId, groupId)).toEqual([]);
        expect(stores.private.listPendingItems(m.memberId, groupId)).toEqual([]);
      }
    }
    // The loop above really ran over the fixture members.
    expect(members).toBeGreaterThan(4);
  });
});

describe('seeding moves the clock forward only (T-021)', () => {
  it('the seed lines are in time order and start at SEED_START', () => {
    const times = DEMO_SEED.map((l) => Date.parse(l.at));
    expect(times[0]).toBe(Date.parse(SEED_START));
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]!);
    }
    // Every reference chat has seed lines.
    expect(new Set(DEMO_SEED.map((l) => l.conversationId))).toEqual(
      new Set(SIM_GROUPS.map((g) => g.conversationId)),
    );
  });

  it('seedChat never sets the clock backwards, even for an earlier endAt', async () => {
    const clock = createSimulatedClock(SEED_START);
    const seen: number[] = [clock.nowMs()];
    const realSet = clock.set.bind(clock);
    clock.set = (iso) => {
      realSet(iso);
      seen.push(clock.nowMs());
    };
    const sent: string[] = [];
    // A recording stand-in for the channel: seedChat ignores the returned inbound.
    const channel: Pick<SimulatorChannel, 'injectMessage'> = {
      injectMessage: (m) => {
        sent.push(m.text);
        seen.push(clock.nowMs());
        return Promise.resolve({} as Awaited<ReturnType<SimulatorChannel['injectMessage']>>);
      },
    };
    await seedChat(
      channel,
      clock,
      new Set(SIM_GROUPS.map((g) => g.conversationId)),
      '2026-02-01T00:00:00+01:00',
    );
    expect(sent).toHaveLength(DEMO_SEED.length);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(clock.nowMs()).toBe(Date.parse(DEMO_SEED[DEMO_SEED.length - 1]!.at));
  });

  it('thread timestamps never go backwards within any group, through a new line in each chat', async () => {
    const backend = await demoBackend();
    const lines: Record<string, { from: string; text: string }> = {
      grp_lisbon: { from: 'h_lis_dean', text: 'booked the fado place for thursday' },
      grp_turks_caicos: { from: 'h_tci_mom', text: 'sunscreen on everyone' },
      grp_barcelona: { from: 'h_maya', text: 'omw' },
    };
    for (const [groupId, l] of Object.entries(lines)) {
      await backend.inject({ type: 'message', from: l.from, text: l.text, groupId });
    }
    for (const g of backend.state().groups) {
      const thread = threadOf(backend, g.group.groupId);
      expect(thread.length).toBeGreaterThan(1);
      const ms = thread.map((e) => Date.parse(e.at));
      for (let i = 1; i < ms.length; i += 1) expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1]!);
      const posted = lines[g.group.groupId];
      if (posted !== undefined) {
        expect(thread.some((e) => e.text === posted.text)).toBe(true);
      }
    }
  });
});

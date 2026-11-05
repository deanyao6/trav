/**
 * T-185 (D-054): the write-through structures behind the agent's runtime
 * state. A second instance over the same stores is a restart (the SQLite
 * reopen itself is covered in core's `sqlite.test.ts` and `restart.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { Stores } from '@trav/core';
import { createDeterministicIdGenerator, createSimulatedClock } from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import { createLaneTextGuard, MAX_PRIVATE_TEXTS } from '../privacy/laneText.js';
import {
  GROUP_WIDE,
  PersistedMap,
  PersistedSet,
  createRuntimeStateRegistry,
  groupScope,
  persistLaneTextGuard,
  privateScope,
  type RuntimeStateDeps,
  type StateScope,
} from './persisted.js';

const G = 'grp_barcelona';
const G2 = 'grp_lisbon';
const DEAN = 'mem_dean';
const CHASE = 'mem_chase';

function rig(): { stores: Stores; deps: RuntimeStateDeps } {
  const clock = createSimulatedClock('2026-03-14T21:40:00+01:00');
  const stores = createMemoryStores({ clock, ids: createDeterministicIdGenerator('s') });
  return { stores, deps: { stores, owners: () => [DEAN, CHASE] } };
}

const byGroupKey = (key: string): StateScope => groupScope(key.split('|')[0]!);

describe('PersistedMap (T-185)', () => {
  it('reads back after a restart with values, scopes and insertion order intact', () => {
    const { stores, deps } = rig();
    const a = new PersistedMap<{ n: number }>(deps, 'thing', byGroupKey);
    a.set(`${G}|x`, { n: 1 });
    a.set(`${G2}|y`, { n: 2 });
    a.setIn('dm', { n: 3 }, privateScope(DEAN, G));
    a.set(`${G}|z`, { n: 4 });
    a.set(`${G}|x`, { n: 5 }); // an update keeps its place, like Map
    expect(a.delete(`${G2}|y`)).toBe(true);
    expect(a.delete(`${G2}|y`)).toBe(false);

    const b = new PersistedMap<{ n: number }>(deps, 'thing', byGroupKey);
    expect([...b]).toEqual([
      [`${G}|x`, { n: 5 }],
      ['dm', { n: 3 }],
      [`${G}|z`, { n: 4 }],
    ]);
    expect(b.size).toBe(3);
    expect(b.scopeOf('dm')).toEqual(privateScope(DEAN, G));
    expect(b.scopeOf(`${G}|z`)).toEqual(groupScope(G));
    // New keys after the restart go after the old ones.
    b.set(`${G}|w`, { n: 6 });
    expect([...new PersistedMap(deps, 'thing', byGroupKey).keys()]).toEqual([
      `${G}|x`,
      'dm',
      `${G}|z`,
      `${G}|w`,
    ]);
    // Other namespaces are separate.
    expect(new PersistedMap(deps, 'other', byGroupKey).size).toBe(0);
    expect(stores.group.runtime.list('thing').map((e) => e.key)).not.toContain('dm');
  });

  it('a DM-lane entry is only in its owner partition, and goes with "delete my data"', () => {
    const { stores, deps } = rig();
    const m = new PersistedMap<string>(deps, 'recent', () => GROUP_WIDE);
    m.setIn('g', 'group line', groupScope(G));
    m.setIn('d', 'just between us', privateScope(DEAN, G));
    expect(JSON.stringify(stores.group.runtime.list('recent'))).not.toContain('between us');
    expect(stores.private.listRuntimeState(CHASE, 'recent')).toEqual([]);
    expect(stores.private.listRuntimeState(DEAN, 'recent')).toHaveLength(1);

    stores.private.deletePartition(DEAN);
    const after = new PersistedMap<string>(deps, 'recent', () => GROUP_WIDE);
    expect([...after]).toEqual([['g', 'group line']]);
  });

  it('moving an entry between scopes leaves no copy behind', () => {
    const { stores, deps } = rig();
    const m = new PersistedMap<string>(deps, 'card', () => GROUP_WIDE);
    m.setIn('msg_1', 'v1', groupScope(G));
    m.setIn('msg_1', 'v2', privateScope(DEAN, G));
    expect(stores.group.runtime.list('card')).toEqual([]);
    m.setIn('msg_1', 'v3', groupScope(G2));
    expect(stores.private.listRuntimeState(DEAN, 'card')).toEqual([]);
    expect(stores.group.runtime.list('card').map((e) => e.groupId)).toEqual([G2]);
    expect([...new PersistedMap(deps, 'card', () => GROUP_WIDE)]).toEqual([['msg_1', 'v3']]);
  });

  it('memory scope is this process only', () => {
    const { stores, deps } = rig();
    const m = new PersistedMap<number>(deps, 'tmp', () => ({ kind: 'memory' }));
    m.set('k', 1);
    expect(m.get('k')).toBe(1);
    expect(stores.group.runtime.list('tmp')).toEqual([]);
    expect(new PersistedMap(deps, 'tmp', () => ({ kind: 'memory' })).size).toBe(0);
    // Moving a persisted entry to memory removes the stored row.
    m.setIn('p', 2, groupScope(G));
    m.setIn('p', 3, { kind: 'memory' });
    expect(stores.group.runtime.list('tmp')).toEqual([]);
  });

  it('values come back as JSON (a mutation of a read value after the write is not stored)', () => {
    const { deps } = rig();
    const m = new PersistedMap<string[]>(deps, 'lines', () => groupScope(G));
    const list = ['a'];
    m.set('k', list);
    list.push('b'); // not written through: the loop always calls set() after changing a list
    expect(new PersistedMap<string[]>(deps, 'lines', () => groupScope(G)).get('k')).toEqual(['a']);
  });

  it('rows that are not in the wrapped shape are skipped, not thrown on', () => {
    const { stores, deps } = rig();
    stores.group.runtime.put({ namespace: 'card', groupId: G, key: 'junk', value: 'raw' });
    expect(new PersistedMap(deps, 'card', () => GROUP_WIDE).size).toBe(0);
  });
});

describe('PersistedSet (T-185)', () => {
  it('add is idempotent and survives a restart; delete removes it', () => {
    const { deps } = rig();
    const a = new PersistedSet(deps, 'told', () => GROUP_WIDE);
    a.add('h_ava').add('h_ava').add('h_bob');
    expect(a.size).toBe(2);
    const b = new PersistedSet(deps, 'told', () => GROUP_WIDE);
    expect(b.has('h_ava')).toBe(true);
    expect(b.delete('h_bob')).toBe(true);
    expect(new PersistedSet(deps, 'told', () => GROUP_WIDE).has('h_bob')).toBe(false);
  });
});

describe('persistLaneTextGuard (T-185 over T-213)', () => {
  const DM = 'my sister is visiting on thursday so i cannot do the beach club';

  it('a restarted guard still knows which phrases are DM-only, and what turned public', () => {
    const { stores, deps } = rig();
    const a = persistLaneTextGuard(createLaneTextGuard(), deps);
    a.notePrivate(G, DEAN, DM);
    a.notePrivate(G, CHASE, 'the rooftop bar near the cathedral was overpriced');
    a.notePublic(G, 'the rooftop bar near the cathedral was overpriced');
    expect(a.leaks(G, 'dean said his sister is visiting on thursday').length).toBeGreaterThan(0);

    const b = persistLaneTextGuard(createLaneTextGuard(), deps);
    expect(b.leaks(G, 'dean said his sister is visiting on thursday').length).toBeGreaterThan(0);
    expect(b.leaks(G, 'that rooftop bar near the cathedral was overpriced')).toEqual([]);
    // Another group never sees it.
    expect(b.leaks(G2, 'dean said his sister is visiting on thursday')).toEqual([]);
    // DM words are in the owner's partition only; the group store holds the public line.
    const groupRows = JSON.stringify(stores.group.runtime.list('lane_text'));
    expect(groupRows).not.toContain('sister');
    expect(groupRows).toContain('rooftop');
    expect(JSON.stringify(stores.private.listRuntimeState(DEAN, 'lane_text'))).toContain('sister');
  });

  it('forgetMember drops their stored DM words too; other members keep theirs', () => {
    const { stores, deps } = rig();
    const a = persistLaneTextGuard(createLaneTextGuard(), deps);
    a.notePrivate(G, DEAN, DM);
    a.notePrivate(G, CHASE, 'my flight home lands at gatwick terminal north');
    a.forgetMember(G, DEAN);
    expect(stores.private.listRuntimeState(DEAN, 'lane_text')).toEqual([]);
    const b = persistLaneTextGuard(createLaneTextGuard(), deps);
    expect(b.leaks(G, 'his sister is visiting on thursday')).toEqual([]);
    expect(b.leaks(G, 'lands at gatwick terminal north').length).toBeGreaterThan(0);
  });

  it(`keeps at most MAX_PRIVATE_TEXTS (${String(MAX_PRIVATE_TEXTS)}) stored DM texts per group, newest kept, across restarts`, () => {
    const { stores, deps } = rig();
    let g = persistLaneTextGuard(createLaneTextGuard(), deps);
    for (let i = 0; i < MAX_PRIVATE_TEXTS + 5; i += 1) {
      if (i === 200) g = persistLaneTextGuard(createLaneTextGuard(), deps); // a restart mid-way
      g.notePrivate(G, DEAN, `secret number ${String(i)} is purple`);
    }
    expect(stores.private.listRuntimeState(DEAN, 'lane_text')).toHaveLength(MAX_PRIVATE_TEXTS);
    const texts = JSON.stringify(stores.private.listRuntimeState(DEAN, 'lane_text'));
    expect(texts).not.toContain('secret number 4 is');
    expect(texts).toContain(`secret number ${String(MAX_PRIVATE_TEXTS + 4)} is`);
  });
});

describe('caps (T-185 r1 #3)', () => {
  it('past the cap the oldest entry goes from the cache and the store; an update keeps its age', () => {
    const { stores, deps } = rig();
    const m = new PersistedMap<number>(deps, 'card', () => groupScope(G), { cap: 3 });
    for (const k of ['a', 'b', 'c']) m.set(k, 1);
    m.set('a', 2); // an update, not a new entry: 'a' stays the oldest
    m.set('d', 1);
    expect([...m.keys()]).toEqual(['b', 'c', 'd']);
    expect(stores.group.runtime.list('card').map((e) => e.key)).toEqual(['b', 'c', 'd']);
    // A restart reads back at most the cap, and keeps trimming from there.
    const again = new PersistedMap<number>(deps, 'card', () => groupScope(G), { cap: 3 });
    again.set('e', 1);
    expect([...again.keys()]).toEqual(['c', 'd', 'e']);
    // A smaller cap on rebuild trims what was stored.
    const smaller = new PersistedMap<number>(deps, 'card', () => groupScope(G), { cap: 1 });
    expect([...smaller.keys()]).toEqual(['e']);
    expect(stores.group.runtime.list('card')).toHaveLength(1);
  });

  it('a capped set stays at its cap across many adds', () => {
    const { stores, deps } = rig();
    const s = new PersistedSet(deps, 'options_nudged', () => GROUP_WIDE, { cap: 50 });
    for (let i = 0; i < 500; i += 1) s.add(`card_${String(i)}`);
    expect(s.size).toBe(50);
    expect(s.has('card_449')).toBe(false);
    expect(s.has('card_450')).toBe(true);
    expect(stores.group.runtime.list('options_nudged')).toHaveLength(50);
  });
});

describe('eviction (T-185 r1 #2)', () => {
  it('evictOwner after deletePartition: the next set writes only the new value, never the old lines', () => {
    const { stores, deps } = rig();
    const recent = new PersistedMap<string[]>(deps, 'recent', () => GROUP_WIDE);
    const key = `${G}:dm:${DEAN}`;
    recent.setIn(key, ['old secret line'], privateScope(DEAN, G));
    recent.setIn('chase', ['chase line'], privateScope(CHASE, G));

    stores.private.deletePartition(DEAN);
    recent.evictOwner(DEAN);
    expect(recent.get(key)).toBeUndefined();
    // The loop's pushRecent: read (now empty), append, set.
    recent.setIn(key, [...(recent.get(key) ?? []), 'new line'], privateScope(DEAN, G));
    expect(JSON.stringify(stores.private.listRuntimeState(DEAN, 'recent'))).not.toContain('old');
    expect(stores.private.getRuntimeState(DEAN, 'recent', G, key)?.value).toMatchObject({
      v: ['new line'],
    });
    // Another member is untouched.
    expect(recent.get('chase')).toEqual(['chase line']);
  });

  it('without the evict, the stale cache would write the deleted lines back (what evictOwner prevents)', () => {
    const { stores, deps } = rig();
    const recent = new PersistedMap<string[]>(deps, 'recent', () => GROUP_WIDE);
    recent.setIn('k', ['old secret line'], privateScope(DEAN, G));
    stores.private.deletePartition(DEAN);
    recent.setIn('k', [...(recent.get('k') ?? []), 'new'], privateScope(DEAN, G));
    expect(JSON.stringify(stores.private.listRuntimeState(DEAN, 'recent'))).toContain('old');
  });

  it('evictTrip drops what is filed under the trip (group and private), from the cache and the store', () => {
    const { stores, deps } = rig();
    const cards = new PersistedMap<string>(deps, 'card', () => GROUP_WIDE);
    cards.setIn('g_a', 'group card a', groupScope(G, 'trip_a'));
    cards.setIn('d_a', 'dm card a', privateScope(DEAN, G, 'trip_a'));
    cards.setIn('g_b', 'group card b', groupScope(G, 'trip_b'));
    cards.setIn('none', 'no trip', groupScope(G));
    expect(stores.group.runtime.get('card', G, 'g_a')?.tripId).toBe('trip_a');
    cards.evictTrip('trip_a');
    expect([...cards.keys()]).toEqual(['g_b', 'none']);
    expect(stores.group.runtime.list('card').map((e) => e.key)).toEqual(['g_b', 'none']);
    expect(stores.private.listRuntimeState(DEAN, 'card')).toEqual([]);
    // The trip filing survives a restart (so deleteTrip can find it there too).
    const again = new PersistedMap<string>(deps, 'card', () => GROUP_WIDE);
    expect(again.scopeOf('g_b')).toEqual(groupScope(G, 'trip_b'));
    expect(stores.deleteTrip('trip_b').runtime_state).toBe(1);
  });

  it('a registry evicts every map and set built on its deps', () => {
    const { stores } = rig();
    const registry = createRuntimeStateRegistry();
    const deps: RuntimeStateDeps = { stores, owners: () => [DEAN, CHASE], registry };
    const m = new PersistedMap<string>(deps, 'm', () => GROUP_WIDE);
    const s = new PersistedSet(deps, 's', () => GROUP_WIDE);
    m.setIn('x', 'v', privateScope(DEAN, G, 'trip_a'));
    s.add('k');
    registry.evictOwner(DEAN);
    expect(m.size).toBe(0);
    m.setIn('y', 'v', groupScope(G, 'trip_a'));
    registry.evictTrip('trip_a');
    expect(m.size).toBe(0);
    expect(s.has('k')).toBe(true); // runtime-wide, no owner or trip
  });
});

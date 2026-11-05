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

import { describe, expect, it } from 'vitest';
import {
  TravError,
  assertGroupSafe,
  createDeterministicIdGenerator,
  createSimulatedClock,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import {
  CROSS_TRIP_CATEGORIES,
  MEMORY_TEXT_MAX,
  createGroupMemory,
  createMemberMemory,
  normalizeMemoryText,
} from './index.js';

const NOW = '2026-03-14T21:40:00+01:00';
const GROUP = 'grp_barcelona';
const TRIP = 'trip_barcelona';

function world() {
  const clock = createSimulatedClock(NOW);
  const ids = createDeterministicIdGenerator('m');
  const stores = createMemoryStores({ clock, ids });
  return {
    stores,
    group: createGroupMemory({ repo: stores.group.groupMemory, ids }),
    member: createMemberMemory({ store: stores.private, ids }),
  };
}

const base = {
  aboutMemberIds: [],
  sourceMessageId: 'msg_1',
  sourceTripId: TRIP,
  now: NOW,
} as const;

describe('normalizeMemoryText', () => {
  it('one lowercase-leading sentence, tags stripped, trailing punctuation dropped, capped', () => {
    expect(normalizeMemoryText('  Dean   likes <b>clubs</b>!!  ')).toBe('dean likes bclubs/b');
    expect(normalizeMemoryText('Sagrada Família was the favourite.')).toBe(
      'sagrada Família was the favourite',
    );
    expect(normalizeMemoryText('x'.repeat(MEMORY_TEXT_MAX + 50)).length).toBe(MEMORY_TEXT_MAX);
    expect(() => normalizeMemoryText('   ')).toThrow(TravError);
  });
});

describe('group memory (GroupStore)', () => {
  it('remember / recall / dedupe by content / forget', () => {
    const w = world();
    const a = w.group.remember(GROUP, {
      ...base,
      category: 'preference',
      text: 'The group decides on clubs after dinner',
    });
    const again = w.group.remember(GROUP, {
      ...base,
      category: 'preference',
      text: 'the group decides on clubs after dinner.',
    });
    expect(again.factId).toBe(a.factId);
    expect(w.group.recall(GROUP)).toHaveLength(1);
    expect(w.group.recall(GROUP)[0]?.text).toBe('the group decides on clubs after dinner');
    w.group.remember(GROUP, {
      ...base,
      category: 'logistics',
      text: 'door code is 4411',
      aboutMemberIds: ['mem_dean', 'mem_dean'],
    });
    expect(w.group.recall(GROUP)).toHaveLength(2);
    expect(w.group.recall(GROUP, { limit: 1 })).toHaveLength(1);
    w.group.forget(GROUP, a.factId);
    expect(w.group.recall(GROUP).map((f) => f.text)).toEqual(['door code is 4411']);
    expect(() => w.group.forget(GROUP, a.factId)).toThrow(TravError);
  });

  it('rejects an unknown category and empty text', () => {
    const w = world();
    expect(() =>
      w.group.remember(GROUP, { ...base, category: 'secret' as never, text: 'x' }),
    ).toThrow(TravError);
    expect(() => w.group.remember(GROUP, { ...base, category: 'other', text: '' })).toThrow(
      TravError,
    );
  });

  it('renders plain lines for the prompt, last N, no markdown', () => {
    const w = world();
    const facts = ['a', 'b', 'c'].map((t) =>
      w.group.remember(GROUP, { ...base, category: 'other', text: `fact ${t}` }),
    );
    expect(w.group.renderForPrompt(facts, 2)).toBe('fact b\nfact c');
    expect(w.group.renderForPrompt(facts, 0)).toBe('');
  });

  it('trip close keeps cross-trip categories (detached from the trip) and drops logistics', () => {
    const w = world();
    w.group.remember(GROUP, { ...base, category: 'taste', text: 'they love tapas' });
    w.group.remember(GROUP, { ...base, category: 'logistics', text: 'airbnb checkout at 11' });
    w.group.remember(GROUP, {
      ...base,
      category: 'inside_joke',
      text: 'the kebab incident',
      sourceTripId: 'trip_other',
    });
    const kept = w.group.consolidateAtTripClose(GROUP, TRIP, NOW);
    expect(kept.map((f) => f.text).sort()).toEqual(['the kebab incident', 'they love tapas']);
    expect(
      w.group.recall(GROUP).find((f) => f.text === 'they love tapas')?.sourceTripId,
    ).toBeNull();
    expect(w.group.recall(GROUP).find((f) => f.text === 'the kebab incident')?.sourceTripId).toBe(
      'trip_other',
    );
    expect(CROSS_TRIP_CATEGORIES).not.toContain('logistics');
  });
});

describe('member memory (PrivateStore)', () => {
  it('is scoped to the owner and keeps the lane it was said in', () => {
    const w = world();
    const f = w.member.remember('mem_dean', GROUP, {
      ...base,
      category: 'dietary',
      text: 'allergic to shellfish',
      sourceLane: 'private',
    });
    // D-007: a member fact is branded Private<...>; it cannot be handed to a group-safe sink.
    // @ts-expect-error member memory facts are Private and must not type-check as group-safe
    assertGroupSafe(f);
    expect(f.sourceLane).toBe('private');
    expect(w.member.recall('mem_dean', GROUP).map((x) => x.text)).toEqual([
      'allergic to shellfish',
    ]);
    expect(w.member.recall('mem_chase', GROUP)).toEqual([]);
    expect(w.member.recall('mem_dean', 'grp_other')).toEqual([]);
    expect(() =>
      w.member.remember('mem_dean', GROUP, {
        ...base,
        category: 'other',
        text: 'x',
        sourceLane: 'dm' as never,
      }),
    ).toThrow(TravError);
  });

  it('only facts said in the group are mentionable in the group (SAFETY §2.3)', () => {
    const w = world();
    w.member.remember('mem_dean', GROUP, {
      ...base,
      category: 'dietary',
      text: 'allergic to shellfish',
      sourceLane: 'private',
    });
    w.member.remember('mem_dean', GROUP, {
      ...base,
      category: 'preference',
      text: 'wants a window seat',
      sourceLane: 'group',
    });
    const facts = w.member.recall('mem_dean', GROUP);
    expect(w.member.groupMentionable(facts).map((f) => f.text)).toEqual(['wants a window seat']);
    expect(w.member.renderForPrompt(facts, 10)).toContain('allergic to shellfish');
  });

  it('never writes into the group store', () => {
    const w = world();
    w.member.remember('mem_dean', GROUP, {
      ...base,
      category: 'budget',
      text: 'max 40 a night',
      sourceLane: 'private',
    });
    expect(w.group.recall(GROUP)).toEqual([]);
    expect(w.stores.group.groupMemory.listByGroup(GROUP)).toEqual([]);
  });
});

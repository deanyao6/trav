/**
 * T-185 (D-054): the agent runtime's state, written through to the stores so a
 * restart (a new `createTravAgent` over the same SQLite file) picks up where
 * the last process stopped: the pending card index, Trav's last question per
 * lane, recent lines, who was told what, cursors, open roster checks and the
 * DM-text corpus of the lane guard.
 *
 * Each structure is a write-through cache: reads stay in memory (the loop reads
 * them on every turn), every change is written to the store first, and the
 * cache is filled from the store once, when the agent is built.
 *
 * Where an entry lives is decided per entry (`StateScope`), never by the
 * caller of the map: group-lane state and ids go to `GroupStore.runtime`, a
 * member's DM-lane state (Trav's DMs to them, cards sent to them, their DM
 * words) to that member's `PrivateStore` partition, so "delete my data" takes
 * it with the rest (`deletePartition`) and the group store never holds a DM.
 * `memory` keeps an entry in this process only (no owner to file it under).
 */
import type { GroupId, MemberId, RuntimeStateEntry, Stores } from '@trav/core';
import type { LaneTextGuard } from '../privacy/laneText.js';
import { MAX_PRIVATE_TEXTS } from '../privacy/laneText.js';

export type StateScope =
  | { readonly kind: 'group'; readonly groupId: GroupId | null }
  | { readonly kind: 'private'; readonly ownerId: MemberId; readonly groupId: GroupId | null }
  | { readonly kind: 'memory' };

export const GROUP_WIDE: StateScope = { kind: 'group', groupId: null };

export function groupScope(groupId: GroupId | null): StateScope {
  return { kind: 'group', groupId };
}

export function privateScope(ownerId: MemberId, groupId: GroupId | null): StateScope {
  return { kind: 'private', ownerId, groupId };
}

/** The part of the `Map` API the loop uses. */
export interface MapLike<K, V> extends Iterable<[K, V]> {
  readonly size: number;
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): this;
  delete(key: K): boolean;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
}

/** Stored as `{ s, v }`: `s` is the insertion sequence, so order survives across both stores. */
interface Wrapped {
  readonly s: number;
  readonly v: unknown;
}

interface Slot<V> {
  readonly value: V;
  readonly scope: StateScope;
  readonly seq: number;
}

export interface RuntimeStateDeps {
  readonly stores: Stores;
  /** Every member whose private partition may hold this runtime's DM-lane state. */
  readonly owners: () => readonly MemberId[];
}

function isWrapped(value: unknown): value is Wrapped {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { s?: unknown }).s === 'number' &&
    'v' in value
  );
}

function sameScope(a: StateScope, b: StateScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'memory' || b.kind === 'memory') return true;
  if (a.groupId !== b.groupId) return false;
  return a.kind !== 'private' || (b.kind === 'private' && a.ownerId === b.ownerId);
}

/** Reads every stored entry of a namespace (both stores), oldest first. */
function loadNamespace(
  deps: RuntimeStateDeps,
  namespace: string,
): { key: string; value: unknown; scope: StateScope; seq: number }[] {
  const out: { key: string; value: unknown; scope: StateScope; seq: number }[] = [];
  const take = (e: RuntimeStateEntry, scope: StateScope): void => {
    if (!isWrapped(e.value)) return;
    out.push({ key: e.key, value: e.value.v, scope, seq: e.value.s });
  };
  for (const e of deps.stores.group.runtime.list(namespace)) take(e, groupScope(e.groupId));
  for (const owner of new Set(deps.owners())) {
    for (const e of deps.stores.private.listRuntimeState(owner, namespace)) {
      take(e, privateScope(owner, e.groupId));
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function write(
  deps: RuntimeStateDeps,
  namespace: string,
  key: string,
  scope: StateScope,
  w: Wrapped,
): void {
  if (scope.kind === 'memory') return;
  const entry: RuntimeStateEntry = { namespace, groupId: scope.groupId, key, value: w };
  if (scope.kind === 'group') deps.stores.group.runtime.put(entry);
  else deps.stores.private.putRuntimeState(scope.ownerId, entry);
}

function remove(deps: RuntimeStateDeps, namespace: string, key: string, scope: StateScope): void {
  if (scope.kind === 'memory') return;
  if (scope.kind === 'group') deps.stores.group.runtime.delete(namespace, scope.groupId, key);
  else deps.stores.private.deleteRuntimeState(scope.ownerId, namespace, scope.groupId, key);
}

/**
 * A `Map<string, V>` written through to the stores. `place` files a new value;
 * `setIn` files it explicitly (e.g. a card goes to the recipient's partition).
 * Iteration is insertion order, like `Map`, across a restart too. Values must
 * be JSON (they are read back from JSON after a restart).
 */
export class PersistedMap<V> implements MapLike<string, V> {
  private readonly slots = new Map<string, Slot<V>>();
  private nextSeq = 1;

  constructor(
    private readonly deps: RuntimeStateDeps,
    private readonly namespace: string,
    private readonly place: (key: string, value: V) => StateScope,
  ) {
    for (const row of loadNamespace(deps, namespace)) {
      // A key stored twice (moved between stores by a crash mid-move): the newest wins.
      this.slots.delete(row.key);
      this.slots.set(row.key, { value: row.value as V, scope: row.scope, seq: row.seq });
      this.nextSeq = Math.max(this.nextSeq, row.seq + 1);
    }
  }

  get size(): number {
    return this.slots.size;
  }

  get(key: string): V | undefined {
    return this.slots.get(key)?.value;
  }

  has(key: string): boolean {
    return this.slots.has(key);
  }

  /** Where the entry is filed (`undefined` when absent). */
  scopeOf(key: string): StateScope | undefined {
    return this.slots.get(key)?.scope;
  }

  set(key: string, value: V): this {
    return this.setIn(key, value, this.place(key, value));
  }

  setIn(key: string, value: V, scope: StateScope): this {
    const old = this.slots.get(key);
    const seq = old?.seq ?? this.nextSeq++;
    if (old !== undefined && !sameScope(old.scope, scope)) {
      remove(this.deps, this.namespace, key, old.scope);
    }
    write(this.deps, this.namespace, key, scope, { s: seq, v: value });
    this.slots.set(key, { value, scope, seq });
    return this;
  }

  delete(key: string): boolean {
    const old = this.slots.get(key);
    if (old === undefined) return false;
    remove(this.deps, this.namespace, key, old.scope);
    this.slots.delete(key);
    return true;
  }

  *keys(): IterableIterator<string> {
    yield* this.slots.keys();
  }

  *values(): IterableIterator<V> {
    for (const s of this.slots.values()) yield s.value;
  }

  *entries(): IterableIterator<[string, V]> {
    for (const [k, s] of this.slots) yield [k, s.value];
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries();
  }
}

/** A `Set<string>` written through to the stores (see `PersistedMap`). */
export class PersistedSet {
  private readonly map: PersistedMap<true>;

  constructor(deps: RuntimeStateDeps, namespace: string, place: (key: string) => StateScope) {
    this.map = new PersistedMap<true>(deps, namespace, (key) => place(key));
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  add(key: string): this {
    if (!this.map.has(key)) this.map.set(key, true);
    return this;
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }
}

// ---------- the lane guard's corpus (T-213) ----------

/** Public group texts kept per group for the guard after a restart (older ones are dropped). */
export const MAX_PUBLIC_TEXTS = 2000;

type LaneNote =
  | { readonly kind: 'private'; readonly ownerId: MemberId; readonly text: string }
  | { readonly kind: 'public'; readonly text: string };

/**
 * The T-213 guard with its corpus written through: each member's DM words to
 * their own partition, the group's public words to the GroupStore. On build
 * the notes are replayed in order, so a restarted runtime still knows which
 * phrases are DM-only. Kept to the guard's own cap for DM texts
 * (`MAX_PRIVATE_TEXTS` per group) and `MAX_PUBLIC_TEXTS` public texts per
 * group. Dropping an old public text can only make the guard stricter.
 */
export function persistLaneTextGuard(guard: LaneTextGuard, deps: RuntimeStateDeps): LaneTextGuard {
  const notes = new PersistedMap<LaneNote>(deps, 'lane_text', () => ({ kind: 'memory' }));
  let counter = 0;
  /** Note keys per group and kind, oldest first, for the caps. */
  const order = new Map<string, string[]>();
  const orderOf = (groupId: GroupId, kind: LaneNote['kind']): string[] => {
    const k = `${kind}\u0000${groupId}`;
    let list = order.get(k);
    if (list === undefined) {
      list = [];
      order.set(k, list);
    }
    return list;
  };
  for (const [key, note] of notes) {
    const scope = notes.scopeOf(key);
    const groupId = scope !== undefined && scope.kind !== 'memory' ? scope.groupId : null;
    if (groupId === null) continue;
    if (note.kind === 'private') guard.notePrivate(groupId, note.ownerId, note.text);
    else guard.notePublic(groupId, note.text);
    orderOf(groupId, note.kind).push(key);
    counter = Math.max(counter, Number(key.split(':')[0]) || 0);
  }

  const record = (groupId: GroupId, note: LaneNote, scope: StateScope, cap: number): void => {
    counter += 1;
    const key = `${String(counter)}:${note.kind}`;
    notes.setIn(key, note, scope);
    const list = orderOf(groupId, note.kind);
    list.push(key);
    while (list.length > cap) {
      const old = list.shift();
      if (old !== undefined) notes.delete(old);
    }
  };

  return {
    ...guard,
    notePrivate(groupId, ownerId, text) {
      guard.notePrivate(groupId, ownerId, text);
      record(
        groupId,
        { kind: 'private', ownerId, text },
        privateScope(ownerId, groupId),
        MAX_PRIVATE_TEXTS,
      );
    },
    notePublic(groupId, text) {
      guard.notePublic(groupId, text);
      record(groupId, { kind: 'public', text }, groupScope(groupId), MAX_PUBLIC_TEXTS);
    },
    forgetMember(groupId, ownerId) {
      guard.forgetMember(groupId, ownerId);
      const list = orderOf(groupId, 'private');
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const key = list[i]!;
        const note = notes.get(key);
        if (note?.kind === 'private' && note.ownerId === ownerId) {
          notes.delete(key);
          list.splice(i, 1);
        }
      }
    },
  };
}

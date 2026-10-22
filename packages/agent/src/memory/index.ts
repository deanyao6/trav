/**
 * Memory modules (SAFETY §2.3 "Memory"; D-007). Two separate modules backed by
 * two separate stores. `GroupMemory` is rendered into the group prompt;
 * `MemberMemory` is only ever rendered into that member's DM prompt or used
 * for planning on their behalf, and a fact with `sourceLane: 'private'` is
 * never repeated in the group.
 *
 * Fact ids are content hashes (`fact_<sha256 prefix>` over owner/group, the
 * normalized text and the members it is about), so remembering the same thing
 * twice upserts one row instead of growing the list.
 */
import { createHash } from 'node:crypto';
import type {
  GroupId,
  GroupMemoryFact,
  GroupMemoryRepository,
  IdGenerator,
  IsoDateTime,
  MemberId,
  MemberMemoryFact,
  MemoryCategory,
  MessageId,
  PrivateStore,
  TripId,
} from '@trav/core';
import { markPrivate, TravError } from '@trav/core';
import { stripInvisible } from '../untrusted.js';

export interface RememberInput {
  readonly category: MemoryCategory;
  readonly text: string;
  readonly aboutMemberIds: readonly MemberId[];
  readonly sourceMessageId: MessageId;
  readonly sourceTripId: TripId | null;
  readonly now: IsoDateTime;
}

export interface GroupMemory {
  recall(
    groupId: GroupId,
    opts?: { readonly tripId?: TripId; readonly limit?: number },
  ): readonly GroupMemoryFact[];
  remember(groupId: GroupId, input: RememberInput): GroupMemoryFact;
  forget(groupId: GroupId, factId: string): void;
  /** ≤ `limit` facts as plain lines for the prompt (no markdown). */
  renderForPrompt(facts: readonly GroupMemoryFact[], limit: number): string;
  /** Trip close: keep cross-trip facts only (T-052). Never copies anything from PrivateStore. */
  consolidateAtTripClose(
    groupId: GroupId,
    tripId: TripId,
    now: IsoDateTime,
  ): readonly GroupMemoryFact[];
}

export interface MemberMemory {
  recall(ownerMemberId: MemberId, groupId: GroupId): readonly MemberMemoryFact[];
  remember(
    ownerMemberId: MemberId,
    groupId: GroupId,
    input: RememberInput & { readonly sourceLane: 'group' | 'private' },
  ): MemberMemoryFact;
  /** Only facts with `sourceLane === 'group'` may be mentioned in the group thread (SAFETY C7). */
  groupMentionable(facts: readonly MemberMemoryFact[]): readonly MemberMemoryFact[];
  /** Plain lines for that member's DM prompt only. */
  renderForPrompt(facts: readonly MemberMemoryFact[], limit: number): string;
}

export const MEMORY_TEXT_MAX = 240;
export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'preference',
  'dietary',
  'budget',
  'logistics',
  'inside_joke',
  'taste',
  'constraint',
  'other',
];

/** Categories that outlive a trip (T-052); the rest is trip logistics and is dropped at close. */
export const CROSS_TRIP_CATEGORIES: readonly MemoryCategory[] = [
  'preference',
  'dietary',
  'taste',
  'inside_joke',
  'constraint',
];

/** One lowercase sentence, tag-proof, capped. Throws on empty text. */
export function normalizeMemoryText(text: string): string {
  const flat = stripInvisible(text)
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .replace(/[.!]+$/, '');
  if (flat.length === 0) throw new TravError('invalid_argument', 'memory text must not be empty');
  const cut = flat.length > MEMORY_TEXT_MAX ? flat.slice(0, MEMORY_TEXT_MAX) : flat;
  return cut.charAt(0).toLowerCase() + cut.slice(1);
}

function assertCategory(category: MemoryCategory): void {
  if (!MEMORY_CATEGORIES.includes(category)) {
    throw new TravError('invalid_argument', `unknown memory category "${String(category)}"`);
  }
}

function factId(scope: string, text: string, about: readonly MemberId[]): string {
  const hash = createHash('sha256')
    .update(`${scope}\n${text.toLowerCase()}\n${[...about].sort().join(',')}`)
    .digest('hex');
  return `fact_${hash.slice(0, 24)}`;
}

function renderLines(
  facts: readonly { readonly text: string; readonly aboutMemberIds?: readonly MemberId[] }[],
  limit: number,
): string {
  return facts
    .slice(Math.max(0, facts.length - Math.max(0, limit)))
    .map((f) => normalizeMemoryText(f.text))
    .join('\n');
}

export function createGroupMemory(deps: {
  readonly repo: GroupMemoryRepository;
  /** Kept for symmetry with the other factories; ids are content hashes (see module doc). */
  readonly ids?: IdGenerator;
}): GroupMemory {
  const { repo } = deps;
  return {
    recall(groupId, opts) {
      const o: { tripId?: TripId; limit?: number } = {};
      if (opts?.tripId !== undefined) o.tripId = opts.tripId;
      if (opts?.limit !== undefined) o.limit = opts.limit;
      return repo.listByGroup(groupId, o);
    },
    remember(groupId, input) {
      assertCategory(input.category);
      const text = normalizeMemoryText(input.text);
      const about = [...new Set(input.aboutMemberIds)];
      const fact: GroupMemoryFact = {
        factId: factId(`group:${groupId}`, text, about),
        groupId,
        sourceTripId: input.sourceTripId,
        category: input.category,
        text,
        aboutMemberIds: about,
        sourceMessageId: input.sourceMessageId,
        learnedAt: input.now,
      };
      repo.upsert(fact);
      return fact;
    },
    forget(groupId, id) {
      const fact = repo.listByGroup(groupId).find((f) => f.factId === id);
      if (fact === undefined) throw new TravError('not_found', `no group memory ${id}`);
      repo.delete(id);
    },
    renderForPrompt: renderLines,
    consolidateAtTripClose(groupId, tripId) {
      const kept: GroupMemoryFact[] = [];
      for (const fact of repo.listByGroup(groupId)) {
        if (fact.sourceTripId !== tripId) {
          kept.push(fact);
          continue;
        }
        if (CROSS_TRIP_CATEGORIES.includes(fact.category)) {
          const promoted: GroupMemoryFact = { ...fact, sourceTripId: null };
          repo.upsert(promoted);
          kept.push(promoted);
        } else {
          repo.delete(fact.factId);
        }
      }
      return kept;
    },
  };
}

export function createMemberMemory(deps: {
  readonly store: Pick<PrivateStore, 'putMemberMemory' | 'listMemberMemory'>;
  readonly ids?: IdGenerator;
}): MemberMemory {
  const { store } = deps;
  return {
    recall: (owner, groupId) => store.listMemberMemory(owner, groupId),
    remember(owner, groupId, input) {
      assertCategory(input.category);
      if (input.sourceLane !== 'group' && input.sourceLane !== 'private') {
        throw new TravError('invalid_argument', 'sourceLane must be group or private');
      }
      const text = normalizeMemoryText(input.text);
      const fact: MemberMemoryFact = markPrivate({
        factId: factId(`member:${owner}:${groupId}`, text, []),
        ownerMemberId: owner,
        groupId,
        sourceTripId: input.sourceTripId,
        category: input.category,
        text,
        sourceLane: input.sourceLane,
        sourceMessageId: input.sourceMessageId,
        learnedAt: input.now,
      });
      store.putMemberMemory(owner, fact);
      return fact;
    },
    groupMentionable: (facts) => facts.filter((f) => f.sourceLane === 'group'),
    renderForPrompt: renderLines,
  };
}

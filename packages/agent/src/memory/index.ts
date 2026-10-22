/**
 * Memory modules (SAFETY §2.3 "Memory"; D-007). Two separate modules backed by
 * two separate stores. `GroupMemory` is rendered into the group prompt;
 * `MemberMemory` is only ever rendered into that member's DM prompt or used
 * for planning on their behalf, and a fact with `sourceLane: 'private'` is
 * never repeated in the group.
 */
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
import { notImplemented } from '@trav/core';

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
}

export function createGroupMemory(deps: {
  readonly repo: GroupMemoryRepository;
  readonly ids: IdGenerator;
}): GroupMemory {
  return notImplemented(`createGroupMemory(${typeof deps.repo})`);
}

export function createMemberMemory(deps: {
  readonly store: PrivateStore;
  readonly ids: IdGenerator;
}): MemberMemory {
  return notImplemented(`createMemberMemory(${typeof deps.store})`);
}

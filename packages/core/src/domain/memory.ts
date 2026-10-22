/**
 * Memory (docs/SAFETY.md §2.3 "Memory"). Two kinds, two stores:
 * - GroupMemoryFact: facts observed in the group thread. GroupStore. May be said in the group.
 * - MemberMemoryFact: private to one member (dietary, "doesn't drink", home airport
 *   told privately). PrivateStore. Used when answering/planning for that member;
 *   said in the group only if `sourceMessageId` was a group message.
 */
import type { GroupId, IsoDateTime, MemberId, MessageId, TripId } from '../primitives.js';
import type { Private } from '../privacy.js';

export type MemoryCategory =
  | 'preference'
  | 'dietary'
  | 'budget'
  | 'logistics'
  | 'inside_joke'
  | 'taste'
  | 'constraint'
  | 'other';

export interface GroupMemoryFact {
  readonly factId: string;
  readonly groupId: GroupId;
  /** Trip the fact was learned on; null for cross-trip facts. */
  readonly sourceTripId: TripId | null;
  readonly category: MemoryCategory;
  /** One sentence, lowercase, e.g. "the group picks restaurants slowly". */
  readonly text: string;
  readonly aboutMemberIds: readonly MemberId[];
  readonly sourceMessageId: MessageId;
  readonly learnedAt: IsoDateTime;
}

export type MemberMemoryFact = Private<{
  readonly factId: string;
  readonly ownerMemberId: MemberId;
  readonly groupId: GroupId;
  readonly sourceTripId: TripId | null;
  readonly category: MemoryCategory;
  readonly text: string;
  /** Where it was said: 'group' facts may be repeated in the group; 'private' never. */
  readonly sourceLane: 'group' | 'private';
  readonly sourceMessageId: MessageId;
  readonly learnedAt: IsoDateTime;
}>;

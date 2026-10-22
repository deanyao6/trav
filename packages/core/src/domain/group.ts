/**
 * Group and Member. A Group is one chat; it can run several Trips over time
 * (group memory carries across). Everything here may appear in the group chat.
 */
import type {
  CurrencyCode,
  GroupId,
  IsoDate,
  IsoDateTime,
  MemberId,
  SenderId,
} from '../primitives.js';
import type { GroupSpendingPolicy } from './approval.js';

/**
 * Roles unify VOICE §6.1 and SAFETY §2.5 (D-012):
 * - `lead`: set at trip creation; approves anything, sets caps/roast mode.
 * - `member`: verified participant; can request and approve per policy.
 * - `guardian`: a lead in family mode who approves and receives tickets on a minor's behalf.
 * - `guest`: unverified participant; may chat, may not request/approve/pay/change settings.
 * "Minor" is NOT a role: it is the `isMinor()` predicate over `birthDate`/`ageBand`.
 */
export type MemberRole = 'lead' | 'member' | 'guardian' | 'guest';

export type AgeBand = 'under18' | 'adult' | 'unknown';

export interface Member {
  readonly memberId: MemberId;
  readonly groupId: GroupId;
  /** Label only. Never used for authorization (SAFETY §2.5). */
  readonly displayName: string;
  readonly role: MemberRole;
  readonly active: boolean;
  /** Channel-assigned identity for this member on the group's channel. */
  readonly senderId: SenderId;
  readonly birthDate?: IsoDate;
  readonly ageBand: AgeBand;
  /** For minors: the adult whose tab absorbs their share and who receives their tickets. */
  readonly guardianMemberId?: MemberId;
  /** Home airport for the flight optimizer (also stated in the group thread, so not private). */
  readonly homeAirport?: string;
  readonly joinedAt: IsoDateTime;
  readonly leftAt?: IsoDateTime;
}

export interface GroupSettings {
  /** SAFETY §2.8: off by default; blocked entirely while any member is a minor or age-unknown. */
  readonly roastMode: boolean;
  /** Set once by a lead when nobody has a birthDate: "everyone 18+?". */
  readonly allAdultsConfirmed: boolean;
  /** VOICE §2 batching: unsolicited group messages per simulated day. */
  readonly maxProactiveGroupMessagesPerDay: number;
  readonly retentionDays: number;
  /** Family mode is derived (`groupHasMinor`), but a lead can force it on. */
  readonly familyModeForced: boolean;
  /** `@trav quieter` (T-041). */
  readonly quietMode: boolean;
}

export interface Group {
  readonly groupId: GroupId;
  readonly name: string;
  /** Channel conversation this group lives in (adapter-scoped id). */
  readonly conversationId: string;
  readonly channelKind: string;
  readonly currency: CurrencyCode;
  readonly settings: GroupSettings;
  readonly spendingPolicy: GroupSpendingPolicy;
  readonly createdAt: IsoDateTime;
}

export const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  roastMode: false,
  allAdultsConfirmed: false,
  maxProactiveGroupMessagesPerDay: 2,
  retentionDays: 90,
  familyModeForced: false,
  quietMode: false,
};

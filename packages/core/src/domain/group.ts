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
  /**
   * T-170 (D-055): someone in the chat Trav has not set up yet (an unknown
   * phone number or Apple ID email spoke or joined). Always `active: false`
   * and `role: 'guest'` while set, so they are on no split, roster or
   * approval; but they can read the chat, so their unknown age blocks roast
   * mode (`groupAgeUnconfirmed`) until they answer Trav's DM.
   */
  readonly onboarding?: 'pending';
  /**
   * T-170 (D-055): `ageBand` came from the member's own answer in Trav's
   * setup DM. Their age is theirs: the group lane never names them as the
   * reason for family mode (the notice goes out without names).
   */
  readonly ageSelfAttested?: true;
}

/** T-170: a newcomer still answering Trav's setup DM (never active, never on a split). */
export function isOnboardingPending(member: Member): boolean {
  return member.onboarding === 'pending' && member.leftAt === undefined;
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
  /**
   * Members who said "@trav no awards for me" (T-016): Wrapped skips them
   * silently. Group-visible by design (it only removes a name). Absent = nobody.
   */
  readonly awardsOptOut?: readonly MemberId[];
  /**
   * Album photos any member dropped with "@trav drop that one" (T-015): never
   * shown again in a recap or in Wrapped, whatever the album says. Absent = none.
   */
  readonly droppedPhotoIds?: readonly string[];
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

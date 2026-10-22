/**
 * Trip, Activity and the per-activity roster ("who's in tonight").
 * The roster is the single source of truth for booking quantity AND split
 * participants (T-030): both derive from `rosterFor(activity)` and cannot diverge.
 */
import type {
  ActivityId,
  BookingId,
  CountryCode,
  CurrencyCode,
  GroupId,
  IsoDate,
  IsoDateTime,
  MemberId,
  MessageId,
  TimeZone,
  TripId,
} from '../primitives.js';
import type { Money } from '../money.js';

export type TripStatus = 'planning' | 'active' | 'ended' | 'closed';

export interface Trip {
  readonly tripId: TripId;
  readonly groupId: GroupId;
  readonly name: string;
  readonly city: string;
  readonly countryCode: CountryCode;
  readonly timeZone: TimeZone;
  readonly startDate: IsoDate;
  readonly endDate: IsoDate;
  /** Ledger totals, balances and settle-up are in this currency (VOICE §3.4). */
  readonly currency: CurrencyCode;
  readonly status: TripStatus;
  /** Optional group budget for pacing/warnings (T-036). */
  readonly budget?: { readonly total?: Money; readonly perDay?: Money };
  /** Family tab: one pot, no splitting (VOICE §8). Defaults true when a minor is present. */
  readonly familyTab: boolean;
  readonly createdBy: MemberId;
  readonly createdAt: IsoDateTime;
}

export type ActivityKind =
  | 'nightlife'
  | 'dinner'
  | 'attraction'
  | 'sports'
  | 'tour'
  | 'transport'
  | 'lodging'
  | 'flight'
  | 'other';

/** Minimal content tags; `isRestrictedContent()` in `safety/` reads these. */
export type ContentTag =
  | 'nightlife'
  | 'club'
  | 'bar'
  | 'alcohol'
  | '18+'
  | '21+'
  | 'gambling'
  | 'cannabis'
  | 'adult'
  | 'late_night'
  | 'family';

export interface Activity {
  readonly activityId: ActivityId;
  readonly tripId: TripId;
  readonly groupId: GroupId;
  readonly kind: ActivityKind;
  readonly name: string;
  readonly venue?: string;
  readonly address?: string;
  readonly startsAt?: IsoDateTime;
  readonly endsAt?: IsoDateTime;
  readonly contentTags: readonly ContentTag[];
  readonly ageRestriction: number | null;
  /** Set once a booking for this activity completed. */
  readonly bookingId?: BookingId;
  readonly createdAt: IsoDateTime;
}

export type AttendanceStatus = 'in' | 'out' | 'maybe';

/**
 * One row per (activity, member). "maybe" counts as OUT at booking time.
 * The reason a member is out ("Henry's sick") is NEVER stored (SAFETY §2.8 health).
 */
export interface Attendance {
  readonly activityId: ActivityId;
  readonly memberId: MemberId;
  readonly status: AttendanceStatus;
  readonly updatedAt: IsoDateTime;
  /** The group message that caused the change (for audit and "who said that"). */
  readonly sourceMessageId: MessageId;
  readonly setBy: MemberId;
}

/** Derived view: members with `status === 'in'`, in group member order. */
export interface Roster {
  readonly activityId: ActivityId;
  readonly inMemberIds: readonly MemberId[];
  readonly outMemberIds: readonly MemberId[];
  readonly maybeMemberIds: readonly MemberId[];
  readonly asOf: IsoDateTime;
}

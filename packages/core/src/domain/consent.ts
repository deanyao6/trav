/**
 * Per-member consent flags (docs/SAFETY.md §2.6). Every flag defaults to false,
 * only the owner's channel sender id may change one, every change is audited
 * (`consent.changed`). Stored in PrivateStore.consent.
 */
import type { GroupId, IsoDateTime, MemberId } from '../primitives.js';

export type ConsentFlag = 'photos' | 'roast' | 'cardImport' | 'emailImport' | 'memoryAcrossTrips';

export interface ConsentFlags {
  readonly memberId: MemberId;
  readonly groupId: GroupId;
  readonly photos: boolean;
  readonly roast: boolean;
  readonly cardImport: boolean;
  readonly emailImport: boolean;
  readonly memoryAcrossTrips: boolean;
  readonly updatedAt: IsoDateTime;
}

export function defaultConsent(
  memberId: MemberId,
  groupId: GroupId,
  now: IsoDateTime,
): ConsentFlags {
  return {
    memberId,
    groupId,
    photos: false,
    roast: false,
    cardImport: false,
    emailImport: false,
    memoryAcrossTrips: false,
    updatedAt: now,
  };
}

/** Read-only lookup handed to adapters (album) and pure functions (roast gate). */
export type ConsentLookup = (memberId: MemberId) => ConsentFlags | undefined;

/**
 * Consent-gated shared trip album. Real-world paths: a Trav upload link, photos
 * posted in the chat by opted-in members, or the Google Photos Picker API
 * (explicit per-session picks). Reading existing Google Photos / iCloud shared
 * albums is not possible via public APIs (Google restricted the Library API to
 * app-created media on 2025-03-31; iCloud has no API).
 *
 * Consent lives in core's `PrivateStore.consent` (SAFETY §2.6) and is passed
 * in as a `ConsentLookup` at query time, so the adapter filters with the
 * current flags: photos from a member whose `photos !== true` are never stored
 * or returned, and opting out hides photos from re-rendered old recaps.
 */
import type { ConsentLookup } from '@trav/core';
import type {
  AdapterInfo,
  GeoPoint,
  GroupId,
  IsoDateTime,
  MemberId,
  Result,
  TripId,
} from './common.js';

export interface Photo {
  readonly photoId: string;
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly ownerMemberId: MemberId;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly url: string;
  readonly thumbnailUrl: string;
  readonly takenAt?: IsoDateTime;
  /** Kept only if the owner allowed location; otherwise stripped on ingest. */
  readonly location?: GeoPoint;
  /** Untrusted text. */
  readonly caption?: string;
  /** Fixture hint for the highlight scorer: 'good' | 'ok' | 'bad' | 'screenshot' | 'receipt' | 'blurry'. */
  readonly qualityTag?: string;
  readonly addedAt: IsoDateTime;
  /**
   * Members tagged in the shot (by the uploader). Absent = unknown: Wrapped's
   * shareable card then treats it as possibly showing a minor in any group
   * that has one (T-016, fail closed).
   */
  readonly subjects?: readonly MemberId[];
  /** Hidden group-wide via "@trav drop that one" (any member). */
  readonly hidden: boolean;
}

export interface AddPhotoInput {
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly ownerMemberId: MemberId;
  /** Local path or channel attachment URI. */
  readonly sourceUri: string;
  readonly mimeType: string;
  readonly takenAt?: IsoDateTime;
  readonly caption?: string;
}

export interface ListPhotosQuery {
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly from?: IsoDateTime;
  readonly to?: IsoDateTime;
  /** Restrict to these owners (still filtered by consent). */
  readonly ownerMemberIds?: readonly MemberId[];
  readonly includeHidden?: boolean;
  readonly limit?: number;
}

export interface AlbumAdapter {
  readonly info: AdapterInfo;

  /** A personal upload link for a member, sent privately. "consent_required" if `consent(member).photos !== true`. */
  uploadLinkFor(
    groupId: GroupId,
    tripId: TripId,
    memberId: MemberId,
    consent: ConsentLookup,
  ): Promise<Result<string>>;

  /** Add a photo. "consent_required" if the owner hasn't opted in. */
  addPhoto(input: AddPhotoInput, consent: ConsentLookup): Promise<Result<Photo>>;

  /** List photos from owners whose `consent(owner).photos === true` right now; hidden photos excluded unless asked. */
  listPhotos(query: ListPhotosQuery, consent: ConsentLookup): Promise<Result<readonly Photo[]>>;

  /** "@trav drop that one": any member may hide a photo group-wide. Audited by the caller. */
  hidePhoto(photoId: string, byMemberId: MemberId): Promise<Result<void>>;

  /** Permanently delete all of a member's photos in a group (right to erasure). */
  deleteMemberPhotos(
    groupId: GroupId,
    memberId: MemberId,
  ): Promise<Result<{ readonly deleted: number }>>;
}

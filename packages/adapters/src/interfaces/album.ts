/**
 * Consent-gated shared trip album. Real-world paths: a Trav upload link, photos
 * posted in the chat by opted-in members, or the Google Photos Picker API
 * (explicit per-session picks). Reading existing Google Photos / iCloud shared
 * albums is not possible via public APIs (Google restricted the Library API to
 * app-created media on 2025-03-31; iCloud has no API).
 *
 * Consent is enforced inside the adapter, not by callers: photos from a member
 * without active consent are never stored or returned.
 */
import type {
  AdapterInfo,
  GeoPoint,
  GroupId,
  IsoDateTime,
  MemberId,
  Result,
  TripId,
} from './common.js';

export interface AlbumConsent {
  readonly memberId: MemberId;
  readonly groupId: GroupId;
  readonly granted: boolean;
  readonly updatedAt: IsoDateTime;
  /** Allow Trav to feature this member's photos in recaps/Wrapped (separate from storing). */
  readonly allowInRecaps: boolean;
}

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
  readonly caption?: string;
  readonly addedAt: IsoDateTime;
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
  /** Only photos whose owners allowed use in recaps. */
  readonly forRecap?: boolean;
  readonly limit?: number;
}

export interface AlbumAdapter {
  readonly info: AdapterInfo;

  /** Current consent for a member in a group (default: not granted). */
  getConsent(groupId: GroupId, memberId: MemberId): Promise<Result<AlbumConsent>>;

  /**
   * Grant or revoke consent. Only the member themself may call this (enforced
   * by the caller's auth). Revoking hides that member's photos immediately.
   */
  setConsent(
    groupId: GroupId,
    memberId: MemberId,
    consent: { readonly granted: boolean; readonly allowInRecaps: boolean },
  ): Promise<Result<AlbumConsent>>;

  /**
   * A personal upload link for a member, sent privately. Returns
   * "consent_required" if they haven't opted in.
   */
  uploadLinkFor(groupId: GroupId, tripId: TripId, memberId: MemberId): Promise<Result<string>>;

  /** Add a photo. Returns "consent_required" if the owner hasn't opted in. */
  addPhoto(input: AddPhotoInput): Promise<Result<Photo>>;

  /** List photos, returning only photos from currently consenting owners. */
  listPhotos(query: ListPhotosQuery): Promise<Result<readonly Photo[]>>;

  /** Permanently delete all of a member's photos in a group (right to erasure). */
  deleteMemberPhotos(
    groupId: GroupId,
    memberId: MemberId,
  ): Promise<Result<{ readonly deleted: number }>>;
}

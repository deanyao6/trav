/**
 * Mock consent-gated `AlbumAdapter` (T-029-b, SAFETY §2.6).
 *
 * - Consent is never stored here. Every call that reads or writes a member's
 *   photos takes the caller's current `ConsentLookup`, so a revoked flag
 *   hides that member's photos on the very next `listPhotos`, including from
 *   re-rendered old recaps. A member counts as opted in only if
 *   `consent(member)?.photos === true` AND the flags are for the photo's
 *   group (consent is per group).
 * - `addPhoto` / `uploadLinkFor` return `consent_required` for members who
 *   haven't opted in, so their photos are never stored.
 * - `hidePhoto` (any member, "@trav drop that one") hides a photo group-wide;
 *   hidden photos never come back unless `includeHidden` is asked for (and
 *   even then only from consenting owners). The caller audits it.
 * - `deleteMemberPhotos` erases a member's photos in a group.
 *
 * Seeded from `fixtures/album/*.json`. No network (URLs are opaque strings),
 * time from the injected `Clock`.
 */
import { createHash } from 'node:crypto';
import { TravError, parseIso } from '@trav/core';
import type { Clock, ConsentLookup, GroupId, IdGenerator, MemberId } from '@trav/core';
import type {
  AddPhotoInput,
  AlbumAdapter,
  ListPhotosQuery,
  Photo,
} from '../../interfaces/album.js';
import type { AdapterError, AdapterInfo } from '../../interfaces/common.js';
import { deepFreeze } from '../transactions/fixtureFiles.js';
import { cleanCaption, loadAlbumFixtures } from './fixture.js';
import type { AlbumFixture } from './fixture.js';

export interface MockAlbumOptions {
  readonly clock: Clock;
  /** For new photo ids (`photo_…`). Omitted ⇒ `photo_mock_<n>`. */
  readonly ids?: IdGenerator;
  /** Use exactly these fixtures (tests). Omitted ⇒ every file in `fixtures/<fixtureDir...>/`. */
  readonly fixtures?: readonly AlbumFixture[];
  /** Default `['album']`. */
  readonly fixtureDir?: readonly string[];
  /** Seed for upload-link tokens. Default `'trav-mock-album'`. */
  readonly seed?: string;
  /** Base URL for generated links. Default `'https://album.example.test'` (never fetched). */
  readonly baseUrl?: string;
}

export interface MockAlbumAdapter extends AlbumAdapter {
  /** Test hook: photos stored for a group (any consent, incl. hidden). */
  storedCount(groupId: GroupId): number;
}

const MAX_LIMIT = 1000;
const MIME_RE = /^(?:image|video)\/[a-z0-9.+-]+$/;

function err(code: AdapterError['code'], message: string): { ok: false; error: AdapterError } {
  return { ok: false, error: { code, message, retryable: false } };
}

function optedIn(consent: ConsentLookup, memberId: MemberId, groupId: GroupId): boolean {
  const flags = consent(memberId);
  return (
    flags !== undefined &&
    flags.photos === true &&
    flags.memberId === memberId &&
    flags.groupId === groupId
  );
}

function sortKey(p: Photo): number {
  return parseIso(p.takenAt ?? p.addedAt);
}

function extensionFor(mimeType: string): string {
  const sub = mimeType.split('/')[1] ?? 'bin';
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/g, '') || 'bin';
}

function isoOrUndefined(value: string | undefined): number | undefined | 'bad' {
  if (value === undefined) return undefined;
  try {
    return parseIso(value);
  } catch {
    return 'bad';
  }
}

interface StoredPhoto {
  readonly base: Photo;
  readonly sourceUri?: string;
  hidden: boolean;
}

export function createMockAlbum(options: MockAlbumOptions): MockAlbumAdapter {
  const info: AdapterInfo = { provider: 'mock-album', mode: 'mock' };
  const { clock } = options;
  const seed = options.seed ?? 'trav-mock-album';
  const baseUrl = (options.baseUrl ?? 'https://album.example.test').replace(/\/+$/, '');
  const photos = new Map<string, StoredPhoto>();
  let counter = 0;

  for (const f of options.fixtures ?? loadAlbumFixtures(options.fixtureDir ?? ['album'])) {
    for (const p of f.photos) {
      if (photos.has(p.photoId))
        throw new TravError(
          'invalid_argument',
          `duplicate photo id ${p.photoId} across album fixtures`,
        );
      photos.set(p.photoId, { base: p, hidden: p.hidden });
    }
  }

  function view(s: StoredPhoto): Photo {
    return deepFreeze({ ...s.base, hidden: s.hidden });
  }

  function nextId(): string {
    for (;;) {
      counter += 1;
      const id = options.ids?.next('photo') ?? `photo_mock_${String(counter).padStart(4, '0')}`;
      if (!photos.has(id)) return id;
    }
  }

  return {
    info,

    uploadLinkFor(groupId, tripId, memberId, consent) {
      if (groupId === '' || tripId === '' || memberId === '')
        return Promise.resolve(err('invalid_request', 'missing id'));
      if (!optedIn(consent, memberId, groupId)) {
        return Promise.resolve(
          err('consent_required', 'member has not turned photos on for this group'),
        );
      }
      const token = createHash('sha256')
        .update(`${seed}\n${groupId}\n${tripId}\n${memberId}`)
        .digest('hex')
        .slice(0, 32);
      return Promise.resolve({ ok: true, value: `${baseUrl}/upload/${token}` });
    },

    addPhoto(input: AddPhotoInput, consent) {
      const { groupId, tripId, ownerMemberId, sourceUri, mimeType } = input;
      if (groupId === '' || tripId === '' || ownerMemberId === '' || sourceUri.trim() === '') {
        return Promise.resolve(err('invalid_request', 'missing id or source'));
      }
      if (!MIME_RE.test(mimeType))
        return Promise.resolve(err('invalid_request', 'only image/* and video/* are accepted'));
      if (isoOrUndefined(input.takenAt) === 'bad')
        return Promise.resolve(err('invalid_request', 'takenAt must be ISO with offset'));
      if (!optedIn(consent, ownerMemberId, groupId)) {
        return Promise.resolve(
          err('consent_required', 'member has not turned photos on for this group'),
        );
      }
      for (const s of photos.values()) {
        if (
          s.sourceUri === sourceUri &&
          s.base.groupId === groupId &&
          s.base.ownerMemberId === ownerMemberId
        ) {
          return Promise.resolve(err('duplicate', 'this photo is already in the album'));
        }
      }
      const photoId = nextId();
      const ext = extensionFor(mimeType);
      const caption = cleanCaption(input.caption);
      const base: Photo = {
        photoId,
        groupId,
        tripId,
        ownerMemberId,
        mimeType,
        // Unknown until a real adapter reads the file.
        width: 0,
        height: 0,
        url: `${baseUrl}/${encodeURIComponent(groupId)}/${photoId}.${ext}`,
        thumbnailUrl: `${baseUrl}/${encodeURIComponent(groupId)}/thumb/${photoId}.jpg`,
        ...(input.takenAt === undefined ? {} : { takenAt: input.takenAt }),
        ...(caption === undefined ? {} : { caption }),
        addedAt: clock.now(),
        hidden: false,
      };
      const stored: StoredPhoto = { base: deepFreeze(base), sourceUri, hidden: false };
      photos.set(photoId, stored);
      return Promise.resolve({ ok: true, value: view(stored) });
    },

    listPhotos(query: ListPhotosQuery, consent) {
      const from = isoOrUndefined(query.from);
      const to = isoOrUndefined(query.to);
      if (from === 'bad' || to === 'bad')
        return Promise.resolve(err('invalid_request', 'from/to must be ISO with offset'));
      const { limit } = query;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
        return Promise.resolve(
          err('invalid_request', `limit must be an integer from 1 to ${MAX_LIMIT}`),
        );
      }
      const owners = query.ownerMemberIds === undefined ? undefined : new Set(query.ownerMemberIds);
      // Consent is resolved once per owner per call: the flags as of this query.
      const consentCache = new Map<MemberId, boolean>();
      const ok = (owner: MemberId): boolean => {
        let v = consentCache.get(owner);
        if (v === undefined) {
          v = optedIn(consent, owner, query.groupId);
          consentCache.set(owner, v);
        }
        return v;
      };
      const out = [...photos.values()]
        .filter((s) => s.base.groupId === query.groupId && s.base.tripId === query.tripId)
        .filter((s) => query.includeHidden === true || !s.hidden)
        .filter((s) => owners === undefined || owners.has(s.base.ownerMemberId))
        .filter((s) => {
          const t = sortKey(s.base);
          return (from === undefined || t >= from) && (to === undefined || t <= to);
        })
        .filter((s) => ok(s.base.ownerMemberId))
        .sort(
          (a, b) => sortKey(a.base) - sortKey(b.base) || (a.base.photoId < b.base.photoId ? -1 : 1),
        )
        .slice(0, limit ?? Number.POSITIVE_INFINITY)
        .map(view);
      return Promise.resolve({ ok: true, value: out });
    },

    hidePhoto(photoId, byMemberId) {
      if (byMemberId === '') return Promise.resolve(err('invalid_request', 'missing member id'));
      const s = photos.get(photoId);
      if (s === undefined) return Promise.resolve(err('not_found', 'no such photo'));
      s.hidden = true;
      return Promise.resolve({ ok: true, value: undefined });
    },

    deleteMemberPhotos(groupId, memberId) {
      let deleted = 0;
      for (const [id, s] of photos) {
        if (s.base.groupId === groupId && s.base.ownerMemberId === memberId) {
          photos.delete(id);
          deleted += 1;
        }
      }
      return Promise.resolve({ ok: true, value: { deleted } });
    },

    storedCount(groupId) {
      let n = 0;
      for (const s of photos.values()) if (s.base.groupId === groupId) n += 1;
      return n;
    },
  };
}

/**
 * "@trav drop that one" (T-015, IDEAS Seed A §7 / Seed C rule 6): any present
 * member removes a photo Trav showed in a recap. The photo id goes on the
 * group's tombstone list (`group.settings.droppedPhotoIds`), which the Morning
 * After and Wrapped composers both filter on, so it never comes back even if
 * the album forgets the hide; the album is also asked to hide it group-wide.
 * One `settings.changed` audit row per drop (who, which photo; never the image).
 *
 * Targeting: the recap the message replies to, else the latest recap with
 * photos in this group. "that one" picks the only photo; with several, Trav
 * asks which by position ("@trav drop photo 2", left to right) instead of
 * guessing. Only photo ids Trav itself put on that card can be dropped, so a
 * message can never hide a photo from another group's album.
 */
import type { AlbumAdapter } from '@trav/adapters';
import type { Group, IsoDateTime, Member, RecapCard, Stores } from '@trav/core';

const VERB = String.raw`(?:drop|remove|delete|hide|ditch|lose|cut)`;
const NOUN = String.raw`(?:one|photo|pic|picture|shot)`;
const ORDINALS: Readonly<Record<string, number | 'last'>> = {
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  last: 'last',
};
const THAT_RE = new RegExp(String.raw`\b${VERB}\s+(?:that|this)\s+${NOUN}\b`, 'i');
const ORDINAL_RE = new RegExp(
  String.raw`\b${VERB}\s+(?:the\s+)?(first|second|third|1st|2nd|3rd|last)\s+${NOUN}\b`,
  'i',
);
const NUMBER_RE = new RegExp(
  String.raw`\b${VERB}\s+(?:the\s+)?(?:photo|pic|picture|shot)\s*(?:#|no\.?\s*|number\s+)?([1-9])\b`,
  'i',
);

export interface DropPhotoRequest {
  /** 1-based position on the card, `'last'`, or absent for "that one". */
  readonly position?: number | 'last';
}

/** The "drop that one" family of phrasings, or undefined. Never matches "drop it" (a decline alias). */
export function parseDropPhoto(text: string): DropPhotoRequest | undefined {
  const n = NUMBER_RE.exec(text);
  if (n?.[1] !== undefined) return { position: Number(n[1]) };
  const o = ORDINAL_RE.exec(text);
  if (o?.[1] !== undefined) {
    const p = ORDINALS[o[1].toLowerCase()];
    return p === undefined ? {} : { position: p };
  }
  return THAT_RE.test(text) ? {} : undefined;
}

export const DROPPED_TEXT = "dropped it. it won't come back in a recap or the wrapped";
export const ALREADY_DROPPED_TEXT = "that one's already gone. it won't come back";
export const NO_RECAP_PHOTO_TEXT = "i don't see a recap photo to drop";

/** "which one? ..." with the card's photo count (VOICE §4.11: one question, how to answer). */
export function whichPhotoText(count: number): string {
  return `which one? "@trav drop photo 2" works, they count from the left, 1 to ${String(count)}`;
}

export type DropPhotoOutcome =
  | { readonly kind: 'dropped'; readonly photoId: string; readonly text: string }
  | { readonly kind: 'already'; readonly photoId: string; readonly text: string }
  | { readonly kind: 'which'; readonly text: string }
  | { readonly kind: 'none'; readonly text: string };

export interface DropPhotoInput {
  readonly stores: Stores;
  readonly album?: AlbumAdapter;
  readonly group: Group;
  readonly tripId: string | null;
  /** The member asking. The caller has already checked they are a present member. */
  readonly me: Member;
  /** The recap card the photo is on (reply target, else the latest one with photos). */
  readonly card: RecapCard | undefined;
  readonly request: DropPhotoRequest;
  readonly now: IsoDateTime;
}

function present(m: Member): boolean {
  return m.active && m.leftAt === undefined && m.role !== 'guest';
}

/** Applies the drop (tombstone + album hide + audit). Never throws over an album outage. */
export async function dropRecapPhoto(input: DropPhotoInput): Promise<DropPhotoOutcome> {
  if (!present(input.me) || input.me.groupId !== input.group.groupId) {
    return { kind: 'none', text: NO_RECAP_PHOTO_TEXT };
  }
  const photos = (input.card?.photos ?? []).flatMap((p) =>
    p.photoId !== undefined && p.photoId.length > 0 ? [p.photoId] : [],
  );
  if (photos.length === 0) return { kind: 'none', text: NO_RECAP_PHOTO_TEXT };
  const pos = input.request.position;
  let photoId: string | undefined;
  if (pos === undefined) {
    if (photos.length > 1) return { kind: 'which', text: whichPhotoText(photos.length) };
    photoId = photos[0];
  } else {
    photoId = pos === 'last' ? photos[photos.length - 1] : photos[pos - 1];
    if (photoId === undefined) return { kind: 'which', text: whichPhotoText(photos.length) };
  }
  if (photoId === undefined) return { kind: 'none', text: NO_RECAP_PHOTO_TEXT };

  // Re-read the group: the caller's copy may predate another drop this turn.
  const group = input.stores.group.groups.get(input.group.groupId) ?? input.group;
  const before = group.settings.droppedPhotoIds ?? [];
  if (before.includes(photoId)) return { kind: 'already', photoId, text: ALREADY_DROPPED_TEXT };
  const after = [...before, photoId];
  input.stores.group.groups.update({
    ...group,
    settings: { ...group.settings, droppedPhotoIds: after },
  });
  let albumHidden = false;
  if (input.album !== undefined) {
    try {
      albumHidden = (await input.album.hidePhoto(photoId, input.me.memberId)).ok;
    } catch {
      albumHidden = false; // the tombstone list is the source of truth either way
    }
  }
  input.stores.group.audit.append({
    groupId: group.groupId,
    tripId: input.tripId,
    type: 'settings.changed',
    actor: { kind: 'member', id: input.me.memberId },
    visibility: 'group',
    payload: {
      memberId: input.me.memberId,
      setting: 'droppedPhotoIds',
      photoId,
      ...(input.card !== undefined ? { cardId: input.card.cardId } : {}),
      albumHidden,
      at: input.now,
    },
  });
  return { kind: 'dropped', photoId, text: DROPPED_TEXT };
}

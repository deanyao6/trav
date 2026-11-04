/**
 * Highlight scorer for Wrapped's top photos (T-016, IDEAS Seed B card 5,
 * SAFETY photos, VOICE §8). Pure.
 *
 * Consent is the caller's job and comes first: pass only photos the album
 * returned for owners whose photo consent is on right now. On top of that:
 *
 * - never a hidden photo, a video, a screenshot, a receipt, or a bad/blurry shot;
 * - the shareable card never carries a photo of a minor: a photo taken by a
 *   minor, or tagged with a minor, is dropped; and in a group that has a
 *   minor, an untagged photo is dropped too (unknown subjects fail closed);
 * - in family mode, nothing from late nights or nightlife/alcohol activities;
 * - one photo per time cluster (shots within `clusterMinutes` of a picked one
 *   are near-duplicates), spread across days first, then owners.
 *
 * Score: quality (`good` 2, `ok` 1). Ties: earlier first, then photo id.
 * Output is in chronological order.
 */
import type { IsoDateTime, MemberId, TimeZone } from '../primitives.js';
import { localDate, localHour, parseIso } from '../clock.js';

export interface HighlightCandidate {
  readonly photoId: string;
  readonly ownerMemberId: MemberId;
  readonly mimeType?: string;
  readonly takenAt?: IsoDateTime;
  readonly addedAt: IsoDateTime;
  readonly qualityTag?: string;
  readonly hidden: boolean;
  /** Members in the shot, if tagged. Absent = unknown. */
  readonly subjects?: readonly MemberId[];
}

export interface HighlightOptions {
  readonly limit: number;
  readonly timeZone: TimeZone;
  /** Every minor in the group (by member id). Non-empty ⇒ untagged photos are out. */
  readonly minorMemberIds: readonly MemberId[];
  /** Default 90. */
  readonly clusterMinutes?: number;
  /**
   * Family mode (VOICE §8, SAFETY §2.7 rule 4): adults-only nights never reach
   * a family Wrapped. Photos taken 22:00–06:00 local, or inside one of
   * `restrictedWindows` (nightlife/alcohol activities), are dropped.
   */
  readonly familyMode?: boolean;
  readonly restrictedWindows?: readonly { readonly from: IsoDateTime; readonly to: IsoDateTime }[];
}

const FAMILY_LATE_FROM_HOUR = 22;
const FAMILY_LATE_TO_HOUR = 6;

function familySafe(p: HighlightCandidate, opts: HighlightOptions): boolean {
  if (opts.familyMode !== true) return true;
  const when = p.takenAt ?? p.addedAt;
  const h = localHour(when, opts.timeZone);
  if (h >= FAMILY_LATE_FROM_HOUR || h < FAMILY_LATE_TO_HOUR) return false;
  const t = parseIso(when);
  return !(opts.restrictedWindows ?? []).some((w) => t >= parseIso(w.from) && t <= parseIso(w.to));
}

const QUALITY_SCORE: Readonly<Record<string, number>> = { good: 2, ok: 1 };
const DEFAULT_CLUSTER_MINUTES = 90;

function at(p: HighlightCandidate): number {
  return parseIso(p.takenAt ?? p.addedAt);
}

/** Whether a photo may appear on the shareable Wrapped card at all (before ranking). */
export function shareablePhoto(
  p: HighlightCandidate,
  minorMemberIds: readonly MemberId[],
): boolean {
  if (p.hidden) return false;
  if (p.mimeType !== undefined && !p.mimeType.startsWith('image/')) return false;
  if ((QUALITY_SCORE[p.qualityTag ?? ''] ?? 0) <= 0) return false;
  const minors = new Set(minorMemberIds);
  if (minors.has(p.ownerMemberId)) return false;
  if (p.subjects === undefined) return minors.size === 0;
  return !p.subjects.some((s) => minors.has(s));
}

export function scoreHighlights(
  photos: readonly HighlightCandidate[],
  opts: HighlightOptions,
): HighlightCandidate[] {
  const limit = Math.max(0, Math.floor(opts.limit));
  if (limit === 0) return [];
  const clusterMs = (opts.clusterMinutes ?? DEFAULT_CLUSTER_MINUTES) * 60_000;
  const seen = new Set<string>();
  const pool = photos
    .filter((p) => {
      if (seen.has(p.photoId)) return false;
      seen.add(p.photoId);
      return shareablePhoto(p, opts.minorMemberIds) && familySafe(p, opts);
    })
    .sort(
      (a, b) =>
        (QUALITY_SCORE[b.qualityTag ?? ''] ?? 0) - (QUALITY_SCORE[a.qualityTag ?? ''] ?? 0) ||
        at(a) - at(b) ||
        (a.photoId < b.photoId ? -1 : 1),
    );

  const picked: HighlightCandidate[] = [];
  const nearPicked = (p: HighlightCandidate): boolean =>
    picked.some((q) => Math.abs(at(q) - at(p)) < clusterMs);
  const dayOf = (p: HighlightCandidate): string => localDate(p.takenAt ?? p.addedAt, opts.timeZone);
  // Round-robin by day: each pass takes at most one new photo per day (best
  // first, owners not yet shown preferred), so the grid covers the trip.
  for (let pass = 0; picked.length < limit && pass < pool.length; pass++) {
    const days = new Set<string>();
    let added = false;
    const owners = new Set(picked.map((p) => p.ownerMemberId));
    const remaining = pool.filter((p) => !picked.includes(p) && !nearPicked(p));
    if (remaining.length === 0) break;
    const ordered = [
      ...remaining.filter((p) => !owners.has(p.ownerMemberId)),
      ...remaining.filter((p) => owners.has(p.ownerMemberId)),
    ];
    for (const p of ordered) {
      if (picked.length >= limit) break;
      const d = dayOf(p);
      if (days.has(d) || nearPicked(p)) continue;
      days.add(d);
      picked.push(p);
      added = true;
    }
    if (!added) break;
  }
  return picked.sort((a, b) => at(a) - at(b) || (a.photoId < b.photoId ? -1 : 1));
}

/**
 * Trip Wrapped composer (T-016, VOICE §4.8, IDEAS Seed B / I-03). Builds the
 * `WrappedRenderInput` from the stores and renders it:
 *
 *   ledger (group-visible expenses only) → core `wrapped.computeTotals`,
 *     `computeAwards`, `computeGroupAwards`
 *   bookings + proposals (who asked)     → The Planner, a minor's "pick"
 *   activities + attendance              → Always In
 *   album (consent-filtered right now)   → The Photographer, the top photos
 *                                          (`wrapped.scoreHighlights`)
 *   `settleUpFor(ctx, 'final')`          → the final settle (T-065 rules:
 *                                          minors fold, family tab, guardian)
 *
 * Nothing here reads chat text or a member's private store (card, email,
 * receipts); consent flags are read only to filter photos and roast lines.
 * Every award comes from core with a `basis` and a `trace`. Roast lines exist
 * only with roast mode on, pass `gatedRoastLines`, and are returned as
 * `roastLines` so the send path can screen them (T-028).
 *
 * The scheduled job (`wrappedJobFor`) runs at 10:00 trip time the day after
 * the trip's last day (ARCHITECTURE §4, the simulator's "end of trip").
 */
import type { AlbumAdapter, Photo } from '@trav/adapters';
import type {
  Clock,
  ConsentLookup,
  Group,
  IdGenerator,
  IsoDate,
  IsoDateTime,
  Member,
  MemberId,
  OutboundMessage,
  ScheduledJob,
  Stores,
  Trip,
} from '@trav/core';
import {
  addDays,
  daysBetween,
  formatClockTime,
  formatDate,
  formatIso,
  formatMoney,
  safety,
  wrapped as core,
  zoneOffsetMinutes,
  zonedWallTimeToMs,
} from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import type { RenderContext } from '../render/common.js';
import { GROUP, textMessage } from '../render/common.js';
import type { RecapPhoto, SafetyContext } from '../render/recap.js';
import type { WrappedRender, WrappedRenderInput } from '../render/wrapped.js';
import { renderWrappedForSend } from '../render/wrapped.js';
import { settleUpFor } from '../tools/ledger.js';
import { detectInjection } from '../untrusted.js';
import type { ToolContext } from '../tools/registry.js';

/** Wrapped posts at 10:00 trip time the day after the last trip day. */
export const WRAPPED_HOUR = 10;
const MAX_PHOTOS = 6;
/** The closing card (IDEAS idea 8): an invite to the next trip, never a data share. */
export const WRAPPED_CLOSING = "next trip? add trav to the new group chat, i'll take it from there";

export function wrappedJobId(tripId: string): string {
  return `wrapped:${tripId}`;
}

/** The Wrapped job for a trip: 10:00 local the day after `endDate`. Same id ⇒ rescheduling replaces it. */
export function wrappedJobFor(
  trip: Pick<Trip, 'tripId' | 'groupId' | 'endDate' | 'timeZone'>,
): ScheduledJob {
  const ms = zonedWallTimeToMs(addDays(trip.endDate, 1), WRAPPED_HOUR, 0, trip.timeZone);
  return {
    jobId: wrappedJobId(trip.tripId),
    groupId: trip.groupId,
    tripId: trip.tripId,
    kind: 'wrapped',
    runAt: formatIso(ms, zoneOffsetMinutes(ms, trip.timeZone)),
    payload: {},
  };
}

export interface WrappedComposeDeps {
  readonly stores: Stores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The shared album (T-029). Absent ⇒ no photos and no Photographer. */
  readonly album?: AlbumAdapter;
}

/** What the awards and photos were computed from, for tests, evals and the audit. */
export interface WrappedFacts {
  readonly awards: readonly core.WrappedAward[];
  readonly standings: readonly core.AwardStanding[];
  readonly totals: core.WrappedTotals;
  readonly groupAwards: core.GroupAwards;
  readonly photos: readonly core.HighlightCandidate[];
}

export type WrappedBuild =
  | {
      readonly kind: 'ok';
      readonly input: WrappedRenderInput;
      readonly facts: WrappedFacts;
      readonly ctx: RenderContext;
      readonly safety: SafetyContext;
    }
  | { readonly kind: 'needs_guardian'; readonly question: string; readonly ctx: RenderContext }
  | { readonly kind: 'no_trip' };

export type WrappedCompose =
  | { readonly kind: 'ok'; readonly render: WrappedRender; readonly facts: WrappedFacts }
  | { readonly kind: 'needs_guardian'; readonly message: OutboundMessage }
  | { readonly kind: 'no_trip' };

function present(m: Member): boolean {
  return m.active && m.leftAt === undefined && m.role !== 'guest';
}

/** `sat mar 14` for a local date. */
function dayLabel(date: IsoDate): string {
  return formatDate(`${date}T12:00:00Z`, 'UTC');
}

function namesAnyMember(text: string, members: readonly Member[]): boolean {
  const lower = text.toLowerCase();
  return members.some(
    (m) => m.displayName.length > 0 && lower.includes(m.displayName.toLowerCase()),
  );
}

/** A free-text description is shown only if it is neutral: no blocked topic, no member's name. */
function neutralDescription(
  text: string,
  members: readonly Member[],
  familyMode: boolean,
): string | null {
  const clean = sanitizeInline(text, 40);
  if (clean.length === 0) return null;
  if (safety.roastTopicBlocked(clean) !== null) return null;
  if (familyMode && safety.isRestrictedText(clean)) return null;
  if (namesAnyMember(clean, members)) return null;
  // Descriptions are member-typed text: anything instruction-shaped stays out of the share card.
  if (detectInjection(clean).length > 0) return null;
  return clean;
}

function statsFor(
  totals: core.WrappedTotals,
  groupAwards: core.GroupAwards,
  members: readonly Member[],
  trip: Trip,
  familyMode: boolean,
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  // In family mode drinks is never a highlight (SAFETY §2.7 rule 4, VOICE §8;
  // T-016 review #1): the top non-drinks category stands in.
  const top = familyMode
    ? (totals.byCategory.find((c) => c.category !== 'drinks') ?? null)
    : totals.topCategory;
  if (top !== null) {
    out.push({
      value: formatMoney(top.amount),
      label: `on ${top.category}, the top category`,
    });
  }
  if (!familyMode && groupAwards.bigNight !== null) {
    const amount = { amountMinor: groupAwards.bigNight.spentMinor, currency: trip.currency };
    out.push({
      value: formatMoney(amount),
      label: `on the big night, ${dayLabel(groupAwards.bigNight.night)}`,
    });
  } else if (totals.biggestDay !== null) {
    out.push({
      value: formatMoney(totals.biggestDay.amount),
      label: `on the biggest day, ${dayLabel(totals.biggestDay.date)}`,
    });
  }
  if (totals.rides.count > 0) {
    // A total of one or two rides would just be one person's receipt: count only.
    const amount = totals.rides.count >= 3 ? `, ${formatMoney(totals.rides.amount)}` : '';
    out.push({
      value: String(totals.rides.count),
      label: `${totals.rides.count === 1 ? 'ride' : 'rides'}${amount}`,
    });
  }
  if (!familyMode && totals.nightsOnTab > 0 && totals.latestNightExpense !== null) {
    out.push({
      value: String(totals.nightsOnTab),
      label: `${totals.nightsOnTab === 1 ? 'night' : 'nights'} on the tab · latest receipt ${formatClockTime(
        totals.latestNightExpense.occurredAt,
        trip.timeZone,
      )}`,
    });
  }
  if (totals.biggestMeal !== null) {
    const what = neutralDescription(totals.biggestMeal.description, members, familyMode);
    out.push({
      value: formatMoney(totals.biggestMeal.amount),
      label: what === null ? 'on the biggest meal' : `on the biggest meal (${what})`,
    });
  }
  return out;
}

/** Roast lines from the tab only (VOICE §7.3); the renderer gates them again per member. */
function roastCandidates(
  awards: readonly core.WrappedAward[],
  totals: core.WrappedTotals,
  members: readonly Member[],
): string[] {
  const name = (id: MemberId): string | undefined =>
    members.find((m) => m.memberId === id)?.displayName;
  const out: string[] = [];
  const mvp = awards.find((a) => a.id === 'mvp_spender' && !a.repeat);
  if (mvp !== undefined && mvp.value > 0) {
    const who = name(mvp.memberId);
    if (who !== undefined) {
      out.push(
        `${who} fronted ${formatMoney({ amountMinor: mvp.value, currency: totals.spent.currency })} of it up front. the transfers are how you say thanks`,
      );
    }
  }
  const captain = awards.find((a) => a.id === 'uber_captain' && !a.repeat);
  if (captain !== undefined && captain.value >= 2 && totals.rides.count >= 3) {
    const who = name(captain.memberId);
    if (who !== undefined) {
      out.push(
        `${who} fronted ${String(captain.value)} of the ${String(totals.rides.count)} rides. the metro is right there`,
      );
    }
  }
  const owl = awards.find((a) => a.id === 'night_owl' && !a.repeat);
  if (owl !== undefined && owl.value >= 2) {
    const who = name(owl.memberId);
    if (who !== undefined) {
      out.push(
        `${who} paid the last receipt of the night ${String(owl.value)} times. the tab remembers`,
      );
    }
  }
  return out;
}

/** Picks first (a minor's only award), then one per person, then repeats. */
function textOrder(awards: readonly core.WrappedAward[]): core.WrappedAward[] {
  return [
    ...awards.filter((a) => a.id === 'pick'),
    ...awards.filter((a) => a.id !== 'pick' && !a.repeat),
    ...awards.filter((a) => a.id !== 'pick' && a.repeat),
  ];
}

async function albumPhotos(
  deps: WrappedComposeDeps,
  groupId: string,
  tripId: string,
  consent: ConsentLookup,
): Promise<readonly Photo[]> {
  if (deps.album === undefined) return [];
  const r = await deps.album.listPhotos({ groupId, tripId }, consent);
  // An album outage costs the photos, never the Wrapped.
  return r.ok ? r.value.filter((p) => !p.hidden) : [];
}

/** The Wrapped render input for a trip, from the stores (see the module comment). */
export async function buildWrappedInput(
  deps: WrappedComposeDeps,
  groupId: string,
  tripId: string,
): Promise<WrappedBuild> {
  const { stores } = deps;
  const now: IsoDateTime = deps.clock.now();
  const group: Group | undefined = stores.group.groups.get(groupId);
  const trip = stores.group.trips.get(tripId);
  if (group === undefined || trip === undefined || trip.groupId !== groupId)
    return { kind: 'no_trip' };
  const members = stores.group.members.listByGroup(groupId);
  const ctx: RenderContext = { groupId, members, timeZone: trip.timeZone, now, ids: deps.ids };
  const consent: ConsentLookup = (memberId) => stores.private.getConsent(memberId, groupId);
  const sc: SafetyContext = { group, trip, consent };

  const toolCtx: ToolContext = {
    groupId,
    tripId,
    senderMemberId: null,
    senderId: 'scheduler',
    lane: 'group',
    now,
    clock: deps.clock,
    ids: deps.ids,
    stores,
  };
  const settle = settleUpFor(toolCtx, 'final');
  if (settle.kind === 'needs_guardian')
    return { kind: 'needs_guardian', question: settle.question, ctx };

  const familyMode = safety.isFamilyMode(group, members, now);
  const minorIds = members.filter((m) => safety.isMinor(m, now)).map((m) => m.memberId);
  const window = {
    startDate: trip.startDate,
    endDate: trip.endDate,
    timeZone: trip.timeZone,
    currency: trip.currency,
  };
  const expenses = stores.group.expenses.listByTrip(tripId);

  const bookings: core.PlannerBooking[] = [];
  for (const b of stores.group.bookings.listByTrip(tripId)) {
    const p = stores.group.bookings.getProposal(b.proposalId);
    if (p === undefined) continue;
    bookings.push({
      bookingId: b.bookingId,
      requestedBy: p.requestedBy,
      description: b.description,
      status: b.status,
      contentTags: p.contentTags,
      ageRestriction: p.ageRestriction,
    });
  }

  const activities = stores.group.trips.listActivities(tripId);
  const rosters: core.ActivityRoster[] = [];
  const restrictedWindows: { from: IsoDateTime; to: IsoDateTime }[] = [];
  for (const a of activities) {
    const rows = stores.group.trips.listAttendance(a.activityId);
    if (rows.length > 0) {
      rosters.push({
        activityId: a.activityId,
        inMemberIds: rows.filter((r) => r.status === 'in').map((r) => r.memberId),
      });
    }
    const restricted = safety.isRestrictedContent(a.contentTags) || (a.ageRestriction ?? 0) >= 18;
    if (restricted && a.startsAt !== undefined) {
      restrictedWindows.push({ from: a.startsAt, to: a.endsAt ?? a.startsAt });
    }
  }

  const photos = await albumPhotos(deps, groupId, tripId, consent);
  const candidates: core.HighlightCandidate[] = photos.map((p) => ({
    photoId: p.photoId,
    ownerMemberId: p.ownerMemberId,
    mimeType: p.mimeType,
    ...(p.takenAt !== undefined ? { takenAt: p.takenAt } : {}),
    addedAt: p.addedAt,
    ...(p.qualityTag !== undefined ? { qualityTag: p.qualityTag } : {}),
    hidden: p.hidden,
    ...(p.subjects !== undefined ? { subjects: p.subjects } : {}),
  }));

  const people = members.filter(present).length;
  const totals = core.computeTotals({ trip: window, expenses, people });
  const groupAwards = core.computeGroupAwards({ trip: window, expenses });
  const { awards, standings } = core.computeAwards({
    trip: window,
    members,
    now,
    expenses,
    bookings,
    rosters,
    photos: candidates.map((c) => ({
      photoId: c.photoId,
      ownerMemberId: c.ownerMemberId,
      ...(c.qualityTag !== undefined ? { qualityTag: c.qualityTag } : {}),
      ...(c.mimeType !== undefined ? { mimeType: c.mimeType } : {}),
    })),
    optedOut: group.settings.awardsOptOut ?? [],
    familyMode,
  });
  const highlights = core.scoreHighlights(candidates, {
    limit: MAX_PHOTOS,
    timeZone: trip.timeZone,
    minorMemberIds: minorIds,
    familyMode,
    restrictedWindows,
  });
  const byId = new Map(photos.map((p) => [p.photoId, p] as const));
  const recapPhotos: RecapPhoto[] = highlights.map((h) => ({
    url: byId.get(h.photoId)?.url ?? '',
    byMemberId: h.ownerMemberId,
    alt: `trip photo, ${formatDate(h.takenAt ?? h.addedAt, trip.timeZone)}`,
  }));

  const input: WrappedRenderInput = {
    trip: {
      name: trip.name,
      days: daysBetween(trip.startDate, trip.endDate) + 1,
      people,
      currency: trip.currency,
      startDate: trip.startDate,
      endDate: trip.endDate,
      ...(trip.familyTab ? { familyTab: true } : {}),
    },
    totals: {
      spent: totals.spent,
      perPerson: totals.perPerson,
      byCategory: totals.byCategory.map((c) => ({ category: c.category, amount: c.amount })),
    },
    stats: statsFor(totals, groupAwards, members, trip, familyMode),
    awards: textOrder(awards).map((a) => ({
      title: a.title,
      memberId: a.memberId,
      evidence: a.evidence,
      basis: a.basis,
    })),
    ...(group.settings.roastMode ? { roastLines: roastCandidates(awards, totals, members) } : {}),
    photos: recapPhotos.filter((p) => p.url.length > 0),
    finalSettle: (({ mode: _mode, ...rest }) => rest)(settle.input),
    closing: WRAPPED_CLOSING,
  };
  return {
    kind: 'ok',
    input,
    facts: { awards, standings, totals, groupAwards, photos: highlights },
    ctx,
    safety: sc,
  };
}

/** Build and render. A guardian-less minor with money yields the VOICE §8 question instead. */
export async function composeWrapped(
  deps: WrappedComposeDeps,
  groupId: string,
  tripId: string,
): Promise<WrappedCompose> {
  const built = await buildWrappedInput(deps, groupId, tripId);
  if (built.kind === 'no_trip') return built;
  if (built.kind === 'needs_guardian') {
    return { kind: 'needs_guardian', message: textMessage(built.ctx, GROUP, [built.question]) };
  }
  return {
    kind: 'ok',
    render: renderWrappedForSend(built.input, built.ctx, built.safety),
    facts: built.facts,
  };
}

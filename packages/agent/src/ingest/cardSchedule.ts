/**
 * When card imports run (T-067): the VOICE §2 digest slots, 10:00 and 20:00
 * trip time, on every day from the day before the trip to the day after it
 * (the same ±1 day window `card.ts` stores rows for).
 *
 * One `card_import` job per linked owner per trip (`cardImportJobId`), queued
 * only while that owner's `cardImport` consent is on and they are an active
 * adult member (SAFETY §2.6; minors are never imported). The job reschedules
 * itself after it runs; `cardImportJobsFor` re-queues it whenever consent is
 * turned back on. Payloads carry ids only, never private data.
 *
 * Pure over the stores and an explicit `now`.
 */
import type { IsoDateTime, JobId, MemberId, ScheduledJob, Stores, Trip } from '@trav/core';
import { addDays, parseIso, recaps } from '@trav/core';
import { importEligibility } from './pending.js';

/** The two digest hours (VOICE §2 batching). */
export const CARD_IMPORT_HOURS: readonly number[] = [10, 20];
/** A job drained later than this after its slot is stale: it waits for the next slot. */
export const CARD_IMPORT_STALE_MS = 60 * 60 * 1000;

type SlotTrip = Pick<Trip, 'tripId' | 'groupId' | 'timeZone' | 'startDate' | 'endDate'>;

export function cardImportJobId(tripId: string, ownerMemberId: MemberId): JobId {
  return `job_card_import_${tripId}_${ownerMemberId}`;
}

/** Every digest slot of the trip's import window, in order. */
export function cardImportSlots(trip: SlotTrip): IsoDateTime[] {
  const out: IsoDateTime[] = [];
  const last = addDays(trip.endDate, 1);
  for (let d = addDays(trip.startDate, -1); d <= last; d = addDays(d, 1)) {
    for (const h of CARD_IMPORT_HOURS) out.push(recaps.recapTime(d, trip.timeZone, h));
  }
  return out;
}

/** The first slot strictly after `after`, or undefined once the window is over. */
export function nextCardImportSlot(trip: SlotTrip, after: IsoDateTime): IsoDateTime | undefined {
  const t = parseIso(after);
  return cardImportSlots(trip).find((s) => parseIso(s) > t);
}

/**
 * Is `now` a digest moment (within `CARD_IMPORT_STALE_MS` after some slot)?
 * A job drained after a clock jump runs only if the jump landed on a slot.
 */
export function atCardImportSlot(trip: SlotTrip, now: IsoDateTime): boolean {
  const t = parseIso(now);
  return cardImportSlots(trip).some((s) => {
    const d = t - parseIso(s);
    return d >= 0 && d <= CARD_IMPORT_STALE_MS;
  });
}

export function cardImportJob(
  trip: SlotTrip,
  ownerMemberId: MemberId,
  runAt: IsoDateTime,
): ScheduledJob {
  return {
    jobId: cardImportJobId(trip.tripId, ownerMemberId),
    groupId: trip.groupId,
    tripId: trip.tripId,
    kind: 'card_import',
    runAt,
    payload: { ownerMemberId },
  };
}

/** The owner's next import job after `after`, or undefined once the trip's window is over. */
export function nextCardImportJob(
  trip: SlotTrip,
  ownerMemberId: MemberId,
  after: IsoDateTime,
): ScheduledJob | undefined {
  const at = nextCardImportSlot(trip, after);
  return at === undefined ? undefined : cardImportJob(trip, ownerMemberId, at);
}

/** Who may be imported right now: `cardImport` on, an active adult member (never a minor or guest). */
export function cardImportOwners(stores: Stores, groupId: string, now: IsoDateTime): MemberId[] {
  return stores.group.members
    .listByGroup(groupId)
    .filter((m) => importEligibility(m, now) === 'ok')
    .filter((m) => stores.private.getConsent(m.memberId, groupId)?.cardImport === true)
    .map((m) => m.memberId);
}

/**
 * The next import job for every consenting owner of each group's current
 * (planning or active) trip, for the ones not already queued (`queued` = job
 * ids on the scheduler).
 */
export function cardImportJobsFor(
  stores: Stores,
  now: IsoDateTime,
  queued: ReadonlySet<string> = new Set(),
): ScheduledJob[] {
  const out: ScheduledJob[] = [];
  for (const g of stores.group.groups.list()) {
    // One card, one sync position: only the group's current trip is synced
    // (T-067 r1 #6), the same trip an on-demand import files rows under.
    const trip = stores.group.trips.current(g.groupId, now);
    if (trip === undefined) continue;
    for (const owner of cardImportOwners(stores, g.groupId, now)) {
      if (queued.has(cardImportJobId(trip.tripId, owner))) continue;
      const job = nextCardImportJob(trip, owner, now);
      if (job !== undefined) out.push(job);
    }
  }
  return out;
}

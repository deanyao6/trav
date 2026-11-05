/**
 * Morning After recap + daily settle-up (T-015; IDEAS Seed A / I-02; VOICE
 * §4.6, §4.7, §8). One scheduled job per trip morning (`morning_after:<trip>:<date>`,
 * 10:00 trip time, `startDate + 1 … endDate`; the morning after the last night
 * is Wrapped's). The composer reads the stores and decides between:
 *
 *   full    ≥2 night-out signals (core `recaps.nightSignals`): the `recap`
 *           card, kind `morning_after` ("morning after, day 4 ☀️"), with last
 *           night's events, the total (and the day budget), up to 2 gated
 *           roast lines, the running tab, the count of private items waiting
 *           on their owners, today's plans and up to 3 opt-in photos
 *   quiet   the ledger changed since the last recap: the running `settle_up`
 *           (VOICE §4.6 A); in family mode the `daily` recap instead
 *           ("morning, day 2 ☀️ / yesterday: …", VOICE §4.7 C, §8)
 *   silent  nothing happened: no message (silence is a feature)
 *
 * What it reads: group-visible expenses and their ledger rows, bookings,
 * activities and attendance, the album (consent-filtered by the adapter at
 * query time), members' group-chat timestamps (never their text) and the
 * COUNT of pending private items (`countPendingByOwner`). Never a member's
 * card, email or receipt contents.
 *
 * Family mode (any minor, or forced): never `full`, never "last night", no
 * drinks or adults-only activity in the list, no roast line, photos through
 * the Wrapped highlight scorer's minor and late-night rules.
 *
 * Who was out is a fact from the split ("(5 of you, not Henry)"); a reason is
 * never stated (T-028: "(Henry was sick)" is dropped whole by the screen).
 * Photos dropped with "@trav drop that one" (`group.settings.droppedPhotoIds`)
 * never come back, here or in Wrapped.
 */
import type { AlbumAdapter, Photo } from '@trav/adapters';
import type {
  Activity,
  Clock,
  ConsentLookup,
  Expense,
  Group,
  IdGenerator,
  IsoDate,
  IsoDateTime,
  Member,
  MemberId,
  Money,
  OutboundMessage,
  RecapCard,
  ScheduledJob,
  SettleUpCard,
  Stores,
  Trip,
} from '@trav/core';
import {
  daysBetween,
  formatClockTime,
  formatDate,
  formatMoney,
  localDate,
  localHour,
  money,
  parseIso,
  recaps as core,
  safety,
  wrapped,
} from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import type { RenderContext } from '../render/common.js';
import { GROUP, textMessage } from '../render/common.js';
import type { RecapPhoto, RecapRenderInput, SafetyContext } from '../render/recap.js';
import { renderRecap } from '../render/recap.js';
import { renderSettleUp } from '../render/settleUp.js';
import { settleUpFor } from '../tools/ledger.js';
import type { ToolContext } from '../tools/registry.js';
import { neutralDescription } from './wrapped.js';

/** VOICE §3.8: max 3 photos per recap (IDEAS says 3–6; VOICE governs what is sent). */
export const MAX_RECAP_PHOTOS = 3;
/** A morning job that runs this late (a clock jump past it) is skipped, never posted stale. */
export const RECAP_STALE_MS = 2 * 60 * 60 * 1000;

export function morningAfterJobId(tripId: string, date: IsoDate): string {
  return `morning_after:${tripId}:${date}`;
}

/** The recap job for one morning: 10:00 trip time. Same id ⇒ rescheduling replaces it. */
export function morningAfterJobFor(
  trip: Pick<Trip, 'tripId' | 'groupId' | 'timeZone'>,
  date: IsoDate,
): ScheduledJob {
  return {
    jobId: morningAfterJobId(trip.tripId, date),
    groupId: trip.groupId,
    tripId: trip.tripId,
    kind: 'morning_after',
    runAt: core.recapTime(date, trip.timeZone),
    payload: { date },
  };
}

/** One job per trip night: the mornings `startDate + 1 … endDate`. */
export function morningAfterJobsFor(
  trip: Pick<Trip, 'tripId' | 'groupId' | 'timeZone' | 'startDate' | 'endDate'>,
): ScheduledJob[] {
  return core.recapMornings(trip).map((d) => morningAfterJobFor(trip, d));
}

/** The job for the morning after `date`, or undefined when `date` is the last recap morning. */
export function nextMorningAfterJob(
  trip: Pick<Trip, 'tripId' | 'groupId' | 'timeZone' | 'startDate' | 'endDate'>,
  date: IsoDate,
): ScheduledJob | undefined {
  const next = core.recapMornings(trip).find((d) => d > date);
  return next === undefined ? undefined : morningAfterJobFor(trip, next);
}

export interface MorningAfterDeps {
  readonly stores: Stores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Shared album (T-029). Absent ⇒ no photos and no photo signal. */
  readonly album?: AlbumAdapter;
  /** Members' group-lane message times for a group (the loop records them; never text). */
  readonly chatTimes?: (groupId: string) => readonly IsoDateTime[];
}

export interface MorningAfterFacts {
  readonly date: IsoDate;
  readonly dayNumber: number;
  readonly mode: core.RecapMode;
  readonly familyMode: boolean;
  readonly signals: core.NightSignals;
  /** The window the listed events come from (last night, or yesterday in family mode). */
  readonly window: core.DayWindow;
  /** Expenses listed in the recap (after the family filter). */
  readonly expenseIds: readonly string[];
  readonly photoIds: readonly string[];
}

export type MorningAfterCompose =
  | {
      readonly kind: 'ok';
      readonly mode: 'full' | 'quiet';
      readonly message: OutboundMessage & { readonly card: RecapCard | SettleUpCard };
      /** Roast lines that survived the gates (declared to the screen, T-028). */
      readonly roastLines: readonly string[];
      /** One per candidate line the gates dropped, for `roast.suppressed` (SAFETY §2.8). */
      readonly suppressedRoast: readonly RoastSuppression[];
      readonly facts: MorningAfterFacts;
    }
  | { readonly kind: 'silent'; readonly facts: MorningAfterFacts }
  | {
      readonly kind: 'needs_guardian';
      readonly message: OutboundMessage;
      readonly facts: MorningAfterFacts;
    }
  | { readonly kind: 'no_trip' };

export interface RoastSuppression {
  readonly cause: safety.RoastSuppressedAuditCause;
  readonly topicCategory?: string;
}

/** Why `gatedRoastLines` dropped `line` (the line text itself is never audited). */
function roastSuppression(line: string, ctx: RenderContext, sc: SafetyContext): RoastSuppression {
  // One cause vocabulary with the outbound screen (SAFETY §2.2).
  const known = (c: string): safety.RoastSuppressedAuditCause =>
    (safety.ROAST_AUDIT_CAUSES as readonly string[]).includes(c)
      ? (c as safety.RoastSuppressedAuditCause)
      : 'minor_in_group';
  const block = safety.groupRoastBlock(sc.group, ctx.members, sc.trip, ctx.now);
  if (block !== null) return { cause: known(block) };
  const topic = safety.roastTopicBlocked(line);
  if (topic !== null) return { cause: 'topic_blocked', topicCategory: topic };
  for (const m of ctx.members.filter((x) => line.includes(x.displayName))) {
    const r = safety.roastAllowed(sc.group, ctx.members, m, sc.consent, sc.trip, ctx.now);
    if (!r.allowed) return { cause: known(r.cause) };
  }
  return { cause: 'line_limit' };
}

/**
 * Would the outbound screen keep this roast-marked recap (T-138)? A dry run of
 * `safety.screenOutbound` with the same inputs the scheduled job's send path
 * gives it (the declared roast lines; no private terms on this path), so the
 * composer and the screen can never disagree about what fails closed.
 */
function roastSeparable(
  message: OutboundMessage & { readonly card: RecapCard },
  ctx: RenderContext,
  sc: SafetyContext,
): boolean {
  const r = safety.screenOutbound(message, {
    group: sc.group,
    members: ctx.members,
    trip: sc.trip,
    consent: sc.consent,
    now: ctx.now,
    roastLines: message.card.roastLines ?? [],
  });
  return r.outbound !== null;
}

function present(m: Member): boolean {
  return m.active && m.leftAt === undefined && m.role !== 'guest';
}

function isNightlife(a: Activity): boolean {
  return a.kind === 'nightlife' || a.contentTags.some((t) => t === 'nightlife' || t === 'club');
}

function adultsOnly(a: Activity): boolean {
  return (
    isNightlife(a) || safety.isRestrictedContent(a.contentTags) || (a.ageRestriction ?? 0) >= 18
  );
}

const CATEGORY_LABEL: Readonly<Record<Expense['category'], string>> = {
  tickets: 'tickets',
  flights: 'flights',
  lodging: 'lodging',
  food: 'food',
  drinks: 'drinks',
  transport: 'a ride',
  groceries: 'groceries',
  activities: 'an activity',
  other: 'other',
};

interface RecapEvent {
  readonly label: string;
  readonly attendees: readonly MemberId[];
  readonly notIn: readonly MemberId[];
  readonly amount: Money;
  readonly at: IsoDateTime;
  readonly expenses: readonly Expense[];
  /** The one member who paid for all of it, if there is one (VOICE §3.4 "on Dad"). */
  readonly paidBy?: MemberId;
}

function sumMinor(xs: readonly Expense[]): number {
  return xs.reduce((s, e) => s + e.amount.amountMinor, 0);
}

/** Events from the window's expenses: rides fold into one, the rest one per expense, chronological. */
function buildEvents(
  expenses: readonly Expense[],
  participantsOf: (e: Expense) => readonly MemberId[],
  members: readonly Member[],
  familyMode: boolean,
  currency: string,
): RecapEvent[] {
  const order = members.map((m) => m.memberId);
  const presentIds = members.filter(present).map((m) => m.memberId);
  const inOrder = (ids: Iterable<MemberId>): MemberId[] => {
    const set = new Set(ids);
    return order.filter((id) => set.has(id));
  };
  const event = (label: string, xs: readonly Expense[]): RecapEvent => {
    const attendees = inOrder(xs.flatMap((e) => participantsOf(e)));
    const payers = new Set(xs.flatMap((e) => e.paidBy.map((p) => p.memberId)));
    return {
      label,
      attendees,
      notIn: presentIds.filter((id) => !attendees.includes(id)),
      amount: money(sumMinor(xs), currency),
      at: xs[0]!.occurredAt,
      expenses: xs,
      ...(payers.size === 1 ? { paidBy: [...payers][0]! } : {}),
    };
  };
  const rides = expenses.filter((e) => e.category === 'transport');
  const out: RecapEvent[] = [];
  for (const e of expenses) {
    if (e.category === 'transport' && rides.length > 1) continue;
    const label =
      neutralDescription(e.description, members, familyMode) ?? CATEGORY_LABEL[e.category];
    out.push(event(label, [e]));
  }
  if (rides.length > 1) out.push(event(`${String(rides.length)} rides`, rides));
  return out.sort((a, b) => parseIso(a.at) - parseIso(b.at));
}

/** The 3 biggest first (chronological among them), then the rest: the text shows 3 inline. */
function displayOrder(events: readonly RecapEvent[]): RecapEvent[] {
  const top = [...events]
    .sort((a, b) => b.amount.amountMinor - a.amount.amountMinor || parseIso(a.at) - parseIso(b.at))
    .slice(0, 3);
  const byTime = (a: RecapEvent, b: RecapEvent): number => parseIso(a.at) - parseIso(b.at);
  return [...top.sort(byTime), ...events.filter((e) => !top.includes(e)).sort(byTime)];
}

/** "€X each" only when the same crew shared everything evenly (to the cent per expense). */
function perPersonOf(
  events: readonly RecapEvent[],
  sharesOf: (e: Expense) => ReadonlyMap<MemberId, number>,
  total: Money,
): Money | undefined {
  const first = events[0];
  if (first === undefined || first.attendees.length < 2) return undefined;
  const crew = first.attendees;
  const totals = new Map<MemberId, number>();
  let count = 0;
  for (const ev of events) {
    if (ev.attendees.length !== crew.length || !ev.attendees.every((x) => crew.includes(x)))
      return undefined;
    for (const e of ev.expenses) {
      count += 1;
      for (const [id, v] of sharesOf(e)) totals.set(id, (totals.get(id) ?? 0) + v);
    }
  }
  const vals = [...totals.values()];
  if (vals.length !== crew.length) return undefined;
  if (Math.max(...vals) - Math.min(...vals) > count) return undefined;
  return money(Math.round(total.amountMinor / crew.length), total.currency);
}

function dayBudget(trip: Trip): Money | undefined {
  const b = trip.budget;
  if (b === undefined) return undefined;
  if (b.perDay !== undefined && b.perDay.currency === trip.currency) return b.perDay;
  if (b.total !== undefined && b.total.currency === trip.currency) {
    const days = daysBetween(trip.startDate, trip.endDate) + 1;
    return days > 0 ? money(Math.floor(b.total.amountMinor / days), trip.currency) : undefined;
  }
  return undefined;
}

/** The only nouns a recap roast line may use for a purchase (VOICE §7.3: spending, trip events). */
const ROAST_NOUN: Readonly<Partial<Record<Expense['category'], string>>> = {
  food: 'food',
  drinks: 'a round',
  transport: 'a ride',
  tickets: 'tickets',
};

/**
 * Roast candidates from the tab only (VOICE §7.3), built from fixed text,
 * amounts, times and payer names; `renderRecap` gates them again per member.
 */
function roastCandidates(
  events: readonly RecapEvent[],
  members: readonly Member[],
  trip: Trip,
): string[] {
  const out: string[] = [];
  const all = events.flatMap((e) => e.expenses);
  const late = all
    .filter((e) => localHour(e.occurredAt, trip.timeZone) < 6)
    .sort((a, b) => parseIso(b.occurredAt) - parseIso(a.occurredAt))[0];
  if (late !== undefined && late.paidBy.length === 1) {
    const payer = members.find((m) => m.memberId === late.paidBy[0]!.memberId);
    // Never the member-typed description (T-015 review #1: "condoms",
    // "pregnancy test", "bail" would be pasted into a roast): a fixed noun
    // for an allowlisted category, or no line at all.
    const what = ROAST_NOUN[late.category];
    if (payer !== undefined && what !== undefined) {
      out.push(
        `${payer.displayName} paid for ${what} at ${formatClockTime(late.occurredAt, trip.timeZone)}. the tab remembers`,
      );
    }
  }
  const rides = all.filter((e) => e.category === 'transport');
  if (rides.length >= 2) {
    out.push(
      `${String(rides.length)} rides last night, ${formatMoney(money(sumMinor(rides), trip.currency))}. the metro is right there`,
    );
  }
  return out;
}

async function albumPhotos(
  deps: MorningAfterDeps,
  group: Group,
  tripId: string,
  w: core.DayWindow,
  consent: ConsentLookup,
): Promise<Photo[]> {
  if (deps.album === undefined) return [];
  const r = await deps.album.listPhotos(
    { groupId: group.groupId, tripId, from: w.from, to: w.to },
    consent,
  );
  if (!r.ok) return []; // an album outage costs the photos, never the recap
  const dropped = new Set(group.settings.droppedPhotoIds ?? []);
  return r.value.filter(
    (p) => !p.hidden && !dropped.has(p.photoId) && core.inWindow(p.takenAt ?? p.addedAt, w),
  );
}

/** The recap for `date` (a local trip date: the morning it posts), from the stores. */
export async function composeMorningAfter(
  deps: MorningAfterDeps,
  groupId: string,
  tripId: string,
  date: IsoDate,
): Promise<MorningAfterCompose> {
  const { stores } = deps;
  const now: IsoDateTime = deps.clock.now();
  const group = stores.group.groups.get(groupId);
  const trip = stores.group.trips.get(tripId);
  if (group === undefined || trip === undefined || trip.groupId !== groupId)
    return { kind: 'no_trip' };
  const tz = trip.timeZone;
  const morning = core.recapTime(date, tz);
  const members = stores.group.members.listByGroup(groupId);
  const familyMode = safety.isFamilyMode(group, members, now);
  const consent: ConsentLookup = (memberId) => stores.private.getConsent(memberId, groupId);
  const night = core.lastNightWindow(morning, tz);
  const listWindow = familyMode ? core.yesterdayWindow(morning, tz) : night;
  const dayNumber = daysBetween(trip.startDate, date) + 1;

  // --- signals
  const expenses = stores.group.expenses.listByTrip(tripId).filter((e) => e.status === 'logged');
  const activities = stores.group.trips.listActivities(tripId);
  const bookings = stores.group.bookings
    .listByTrip(tripId)
    .filter((b) => b.status === 'confirmed' || b.status === 'partially_refunded');
  const booked = new Set<string>();
  for (const b of bookings) if (b.activityId !== undefined) booked.add(b.activityId);
  for (const e of expenses)
    if (e.source === 'booking' && e.activityId !== undefined) booked.add(e.activityId);
  for (const a of activities) if (a.bookingId !== undefined) booked.add(a.activityId);
  const bookedNightlifeStarts = activities
    .filter((a) => isNightlife(a) && booked.has(a.activityId) && a.startsAt !== undefined)
    .map((a) => a.startsAt!);
  // One album read over the wider window (yesterday ⊇ last night).
  const albumDay = await albumPhotos(
    deps,
    group,
    tripId,
    core.yesterdayWindow(morning, tz),
    consent,
  );
  const signals = core.nightSignals({
    morning,
    timeZone: tz,
    expenses,
    bookedNightlifeStarts,
    photoTimes: albumDay.map((p) => p.takenAt ?? p.addedAt),
    chatTimes: deps.chatTimes?.(groupId) ?? [],
    // An overnight undo or edit moves the tab too (T-015 review #5).
    ledgerChangeTimes: stores.group.audit
      .listByGroup(groupId)
      .filter(
        (a) =>
          (a.type === 'ledger.entry_deleted' || a.type === 'ledger.entry_edited') &&
          (a.tripId === null || a.tripId === tripId),
      )
      .map((a) => a.ts),
  });
  const mode = core.decideRecapMode(signals, familyMode);

  // --- what the recap lists
  const adultActivities = activities.filter(adultsOnly);
  const restrictedActivity = new Set(adultActivities.map((a) => a.activityId));
  // Family mode (VOICE §8): nothing tied to an adults-only plan reaches the
  // list: drinks, its own expenses, anything naming it, anything during it.
  const adultNames = adultActivities
    .flatMap((a) => [a.name, a.venue ?? ''])
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length >= 3);
  const duringAdultPlan = (iso: IsoDateTime): boolean =>
    adultActivities.some(
      (a) =>
        a.startsAt !== undefined &&
        a.endsAt !== undefined &&
        core.inWindow(iso, { from: a.startsAt, to: a.endsAt }),
    );
  const familySafe = (e: Expense): boolean =>
    e.category !== 'drinks' &&
    !(e.activityId !== undefined && restrictedActivity.has(e.activityId)) &&
    !safety.isRestrictedText(e.description) &&
    !adultNames.some((n) => e.description.toLowerCase().includes(n)) &&
    !duringAdultPlan(e.occurredAt);
  const listed = expenses
    .filter((e) => core.inWindow(e.occurredAt, listWindow))
    .filter((e) => !familyMode || familySafe(e))
    .sort((a, b) => parseIso(a.occurredAt) - parseIso(b.occurredAt));
  const photos = albumDay.filter((p) => core.inWindow(p.takenAt ?? p.addedAt, listWindow));
  const restrictedWindows = activities
    .filter((a) => adultsOnly(a) && a.startsAt !== undefined)
    .map((a) => ({ from: a.startsAt!, to: a.endsAt ?? a.startsAt! }));
  const picked = wrapped.scoreHighlights(
    photos.map((p) => ({
      photoId: p.photoId,
      ownerMemberId: p.ownerMemberId,
      mimeType: p.mimeType,
      ...(p.takenAt !== undefined ? { takenAt: p.takenAt } : {}),
      addedAt: p.addedAt,
      ...(p.qualityTag !== undefined ? { qualityTag: p.qualityTag } : {}),
      hidden: p.hidden,
      ...(p.subjects !== undefined ? { subjects: p.subjects } : {}),
    })),
    {
      limit: MAX_RECAP_PHOTOS,
      timeZone: tz,
      minorMemberIds: members.filter((m) => safety.isMinor(m, now)).map((m) => m.memberId),
      familyMode,
      restrictedWindows,
      // One night: near-duplicates are minutes apart, not hours.
      clusterMinutes: 30,
    },
  );
  const facts: MorningAfterFacts = {
    date,
    dayNumber,
    mode,
    familyMode,
    signals,
    window: listWindow,
    expenseIds: listed.map((e) => e.expenseId),
    photoIds: picked.map((p) => p.photoId),
  };
  if (mode === 'silent') return { kind: 'silent', facts };

  const ctx: RenderContext = { groupId, members, timeZone: tz, now, ids: deps.ids };
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
  const settle = settleUpFor(toolCtx, 'running');
  if (settle.kind === 'needs_guardian') {
    return { kind: 'needs_guardian', message: textMessage(ctx, GROUP, [settle.question]), facts };
  }

  // Non-family quiet: the running tab on its own (VOICE §4.6 A).
  if (mode === 'quiet' && !familyMode) {
    const message = renderSettleUp({ ...settle.input, dayNumber }, ctx);
    return {
      kind: 'ok',
      mode,
      message: { ...message, proactive: true },
      roastLines: [],
      suppressedRoast: [],
      facts,
    };
  }

  const entries = stores.group.expenses.listEntries(tripId);
  const owes = new Map<string, Map<MemberId, number>>();
  for (const x of entries) {
    if (x.kind !== 'owes' || x.amount.amountMinor === 0) continue;
    const m = owes.get(x.expenseId) ?? new Map<MemberId, number>();
    m.set(x.memberId, (m.get(x.memberId) ?? 0) + Math.abs(x.amount.amountMinor));
    owes.set(x.expenseId, m);
  }
  const sharesOf = (e: Expense): ReadonlyMap<MemberId, number> =>
    owes.get(e.expenseId) ?? new Map();
  const events = buildEvents(
    listed,
    (e) => [...sharesOf(e).keys()],
    members,
    familyMode,
    trip.currency,
  );
  const total = money(sumMinor(listed), trip.currency);
  // A family tab is one pot: "€X each" would read as a split (VOICE §4.7 C).
  const familyTab = settle.input.familyTab === true || trip.familyTab;
  const perPerson = familyTab ? undefined : perPersonOf(events, sharesOf, total);
  const budget = dayBudget(trip);
  const pending = Object.values(stores.private.countPendingByOwner(groupId)).reduce(
    (s, n) => s + n,
    0,
  );

  const todays = activities
    .filter((a) => a.startsAt !== undefined && localDate(a.startsAt, tz) === date)
    .filter((a) => parseIso(a.startsAt!) >= parseIso(now))
    .filter((a) => !familyMode || !adultsOnly(a))
    // VOICE §4.7: "today" only for what is booked.
    .filter((a) => booked.has(a.activityId))
    .sort((a, b) => parseIso(a.startsAt!) - parseIso(b.startsAt!));
  const today = todays.flatMap((a) => {
    const label = sanitizeInline(a.name, 40);
    if (label.length === 0) return [];
    const tickets = bookings.some((b) => b.activityId === a.activityId && b.tickets.length > 0);
    return [{ label, startsAt: a.startsAt!, ...(tickets ? { ticketsDelivered: true } : {}) }];
  });

  const byId = new Map(photos.map((p) => [p.photoId, p] as const));
  const recapPhotos: RecapPhoto[] = picked.flatMap((h) => {
    const p = byId.get(h.photoId);
    if (p === undefined || p.url.length === 0) return [];
    return [
      {
        url: p.url,
        byMemberId: p.ownerMemberId,
        alt: `trip photo, ${formatDate(p.takenAt ?? p.addedAt, tz)}`,
        photoId: p.photoId,
      },
    ];
  });

  const full = mode === 'full';
  const candidates =
    full && !familyMode && group.settings.roastMode ? roastCandidates(events, members, trip) : [];
  const input: RecapRenderInput = {
    kind: full ? 'morning_after' : 'daily',
    date,
    dayNumber,
    lastNight: {
      events: displayOrder(events).map((e) => ({
        label: e.label,
        attendees: e.attendees,
        ...(e.notIn.length > 0 ? { notIn: e.notIn } : {}),
        amount: e.amount,
        ...(e.paidBy !== undefined ? { paidBy: e.paidBy } : {}),
      })),
      total,
      ...(perPerson !== undefined ? { perPerson } : {}),
      ...(budget !== undefined ? { budget } : {}),
    },
    ...(candidates.length > 0 ? { roastLines: candidates } : {}),
    ...(pending > 0 ? { pendingPrivateCount: pending } : {}),
    settle: { ...settle.input, dayNumber },
    ...(today.length > 0 ? { today } : {}),
    photos: recapPhotos,
  };
  let message = renderRecap(input, ctx, sc);
  let unseparable: readonly string[] = [];
  if ((message.card.roastLines ?? []).length > 0 && !roastSeparable(message, ctx, sc)) {
    // T-138: the outbound screen fails a roast-marked message closed when the
    // rest of it (a fixed line, an event or plan label, alt text) carries a
    // blocklisted word it cannot tell apart from a roast. Losing the roast
    // lines must never cost the group its recap: re-render without them (an
    // unmarked recap gets no roast gate, SAFETY §2.8), audited as unlocatable.
    unseparable = message.card.roastLines ?? [];
    const { roastLines: _dropped, ...plain } = input;
    message = renderRecap(plain, ctx, sc);
  }
  const kept = message.card.roastLines ?? [];
  return {
    kind: 'ok',
    mode,
    message,
    roastLines: kept,
    suppressedRoast: candidates
      .filter((l) => !kept.includes(l))
      .map((l) =>
        unseparable.includes(l) ? { cause: 'unlocatable' as const } : roastSuppression(l, ctx, sc),
      ),
    facts: {
      ...facts,
      photoIds: message.card.photos.flatMap((p) => (p.photoId ? [p.photoId] : [])),
    },
  };
}

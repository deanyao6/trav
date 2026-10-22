/**
 * Booking proposals (ARCHITECTURE Flow 2 step 1; SAFETY §2.1, §2.5). The model's
 * `propose_booking` tool ends here, and this module ends at a `BookingProposal`
 * plus a `BookingProposalCard`: it never calls a provider's purchase method.
 *
 * Steps: resolve the trip → resolve who is in (the named subset wins; a member
 * marked out stays out; never guess from a headcount) → find the event and the
 * best offer (refundable first, then cheapest, `purchaseMode: 'api'` only) →
 * hold → sync the activity roster (reason text never stored) →
 * `checkProposalConsistency` (problems ⇒ one clarifying question, no proposal)
 * → `approval.evaluate` → audit `proposal.created` → `policy.evaluated` →
 * `approval.requested` → grant → card + VOICE §4.1 text.
 */
import type {
  Activity,
  AuditEventId,
  BookingProposal,
  BookingProposalCard,
  Clock,
  GroupId,
  IdGenerator,
  IsoDate,
  IsoDateTime,
  Member,
  MemberId,
  MemberSpendingPrefs,
  MessageId,
  Money,
  PolicyDecision,
  ProposalId,
  ReasonCode,
  Roster,
  Stores,
  Trip,
  TripId,
  ApprovalGrant,
} from '@trav/core';
import {
  addMinutes,
  allocateEqual,
  approval,
  formatClockTime,
  formatIso,
  formatMoney,
  formatTime,
  localDate,
  localHour,
  money,
  parseIso,
  TravError,
  zonedWallTimeToMs,
  zoneOffsetMinutes,
} from '@trav/core';
import type { TicketEvent, TicketHold, TicketOffer, TicketsAdapter } from '@trav/adapters';
import { sanitizeInline } from '../context/groupContext.js';

export interface ProposalDeps {
  readonly stores: Stores;
  readonly tickets: TicketsAdapter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** What the model (or the offline booking-intent fallback) may ask for. */
export interface ProposeInput {
  readonly kind: 'ticket' | 'flight' | 'lodging' | 'transport' | 'other';
  /** Free text the event search matches ("razzmatazz", "barça"). */
  readonly query?: string;
  /** Provider event / offer ids when the model already searched. */
  readonly eventId?: string;
  readonly offerId?: string;
  /** Exactly who is going; wins over quantity and roster. */
  readonly attendeeMemberIds?: readonly MemberId[];
  /** Named out ("Henry's sick"), by id or by display name. */
  readonly excludedMemberIds?: readonly MemberId[];
  readonly excludedNames?: readonly string[];
  readonly quantity?: number;
  readonly activityId?: string;
  /** Night to book (local trip date); default: tonight, else the next one. */
  readonly date?: IsoDate;
  readonly requestText?: string;
}

export interface ProposeContext {
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  readonly requestedBy: MemberId;
  readonly sourceMessageId: MessageId;
}

export interface EventSummary {
  readonly eventId: string;
  readonly name: string;
  readonly venue: string;
  readonly startsAt: IsoDateTime;
}

export type ProposeResult =
  | {
      readonly kind: 'proposal';
      readonly proposal: BookingProposal;
      readonly decision: PolicyDecision;
      readonly grant: ApprovalGrant;
      readonly card: BookingProposalCard;
      readonly text: string;
      /** Pre-allocated id of the group message that will carry the card (in `approval.requested`). */
      readonly messageId: MessageId;
      readonly auditEventIds: readonly AuditEventId[];
      readonly event: EventSummary;
      readonly attendees: readonly MemberId[];
      readonly excluded: readonly MemberId[];
    }
  | {
      readonly kind: 'auto_approved';
      readonly proposal: BookingProposal;
      readonly decision: PolicyDecision;
      readonly grant: ApprovalGrant;
      readonly auditEventIds: readonly AuditEventId[];
    }
  | {
      readonly kind: 'clarify';
      readonly question: string;
      readonly problems: readonly string[];
    }
  | {
      readonly kind: 'denied';
      readonly proposalId: ProposalId;
      readonly reasons: readonly ReasonCode[];
      readonly ruleId: string;
      readonly text: string;
      readonly auditEventIds: readonly AuditEventId[];
    }
  | { readonly kind: 'duplicate'; readonly bookingId: string; readonly text: string }
  | { readonly kind: 'pending_exists'; readonly proposalId: ProposalId; readonly text: string }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'not_found'
        | 'sold_out'
        | 'redirect_only'
        | 'provider_unavailable'
        | 'unsupported_kind'
        | 'no_trip';
      readonly text: string;
    };

export interface ProposalService {
  propose(input: ProposeInput, ctx: ProposeContext): Promise<ProposeResult>;
  /** Release the provider hold of a proposal that will not be bought (decline, cancel, expiry). */
  releaseHold(proposal: BookingProposal): Promise<void>;
}

const NIGHT_ROLLOVER_HOUR = 5;

/** The calendar date whose night an instant belongs to (2am sunday ⇒ saturday). */
export function nightOf(iso: IsoDateTime, tz: string): IsoDate {
  const date = localDate(iso, tz);
  if (localHour(iso, tz) >= NIGHT_ROLLOVER_HOUR) return date;
  const ms = parseIso(iso) - 24 * 60 * 60 * 1000;
  return localDate(formatIso(ms, zoneOffsetMinutes(ms, tz)), tz);
}

function activeMembers(members: readonly Member[]): Member[] {
  return members.filter((m) => m.active && m.leftAt === undefined && m.role !== 'guest');
}

function names(ids: readonly MemberId[], byId: ReadonlyMap<MemberId, Member>): string {
  return ids.map((id) => sanitizeInline(byId.get(id)?.displayName ?? id, 40)).join(', ');
}

function inOrder(ids: Iterable<MemberId>, order: readonly MemberId[]): MemberId[] {
  const set = new Set(ids);
  return order.filter((id) => set.has(id));
}

/** "Razzmatazz: Saturday club night" → "razzmatazz". */
export function shortEventName(name: string): string {
  const head = name.split(/[:·|]/)[0] ?? name;
  return sanitizeInline(head, 40).toLowerCase();
}

function tripStartIso(trip: Trip): IsoDateTime {
  const ms = zonedWallTimeToMs(trip.startDate, 0, 0, trip.timeZone);
  return formatIso(ms, zoneOffsetMinutes(ms, trip.timeZone));
}

function offerTotal(offer: TicketOffer, quantity: number): Money {
  return money((offer.unitPrice.amountMinor + offer.unitFees.amountMinor) * quantity, offer.unitPrice.currency);
}

function rankOffers(offers: readonly TicketOffer[], quantity: number): TicketOffer[] {
  return offers
    .filter(
      (o) =>
        o.purchaseMode === 'api' &&
        o.available >= quantity &&
        o.maxPerOrder >= quantity &&
        o.unitPrice.amountMinor + o.unitFees.amountMinor > 0,
    )
    .sort((a, b) => {
      if (a.refundPolicy.refundable !== b.refundPolicy.refundable) {
        return a.refundPolicy.refundable ? -1 : 1;
      }
      return offerTotal(a, quantity).amountMinor - offerTotal(b, quantity).amountMinor;
    });
}

function matchesQuery(event: TicketEvent, query: string | undefined): boolean {
  if (query === undefined) return true;
  const q = query.toLowerCase().replace(/\btickets?\b/g, '').trim();
  if (q.length === 0) return true;
  const hay = `${event.name} ${event.venue.name}`.toLowerCase();
  return q.split(/\s+/).some((w) => w.length > 2 && hay.includes(w));
}

export function createProposalService(deps: ProposalDeps): ProposalService {
  const { stores, tickets, clock, ids } = deps;
  const group = stores.group;

  async function releaseHold(proposal: BookingProposal): Promise<void> {
    if (proposal.kind !== 'ticket' || proposal.quoteRef.length === 0) return;
    await tickets.releaseHold(proposal.quoteRef);
  }

  async function propose(input: ProposeInput, ctx: ProposeContext): Promise<ProposeResult> {
    const now = clock.now();
    const grp = group.groups.get(ctx.groupId);
    if (grp === undefined) throw new TravError('not_found', `group ${ctx.groupId} not found`);
    const trip =
      ctx.tripId === null ? group.trips.current(ctx.groupId, now) : group.trips.get(ctx.tripId);
    if (trip === undefined) {
      return {
        kind: 'unavailable',
        reason: 'no_trip',
        text: "there's no trip set up for this group yet, so nothing to book against",
      };
    }
    if (input.kind !== 'ticket') {
      return {
        kind: 'unavailable',
        reason: 'unsupported_kind',
        text: `i can't book ${input.kind === 'flight' ? 'flights' : input.kind === 'lodging' ? 'places to stay' : 'that'} from the chat yet. i can search and post options`,
      };
    }

    const members = group.members.listByGroup(ctx.groupId);
    const active = activeMembers(members);
    const order = active.map((m) => m.memberId);
    const byId = new Map(members.map((m) => [m.memberId, m] as const));
    const tz = trip.timeZone;

    // ---- 1. the event ----
    const searched = await tickets.searchEvents({
      city: trip.city,
      dateFrom: localDate(now, tz),
      dateTo: trip.endDate,
      ...(input.query !== undefined ? { query: input.query } : {}),
    });
    if (!searched.ok) {
      return {
        kind: 'unavailable',
        reason: 'provider_unavailable',
        text: "ticket site's not responding. no charge went through\n@ me again in a few",
      };
    }
    const upcoming = searched.value.filter(
      (e) => parseIso(e.startsAt) > parseIso(now) && matchesQuery(e, input.query),
    );
    let candidates = upcoming;
    if (input.eventId !== undefined) {
      candidates = searched.value.filter((e) => e.eventId === input.eventId);
    } else {
      const wanted = input.date ?? nightOf(now, tz);
      const sameNight = upcoming.filter((e) => nightOf(e.startsAt, tz) === wanted);
      if (sameNight.length > 0) candidates = sameNight;
    }
    candidates = [...candidates].sort((a, b) => parseIso(a.startsAt) - parseIso(b.startsAt));
    const event = candidates[0];
    if (event === undefined) {
      const what = input.query === undefined ? 'that' : sanitizeInline(input.query, 40).toLowerCase();
      return {
        kind: 'unavailable',
        reason: 'not_found',
        text: `nothing for ${what} on sale for the trip dates. tell me another night or another place`,
      };
    }

    // ---- 2. who is in ----
    const activity = findActivity(group, trip, event, input.activityId);
    const rosterRows = activity === null ? [] : group.trips.listAttendance(activity.activityId);
    const markedOut = new Set(
      rosterRows.filter((r) => r.status !== 'in').map((r) => r.memberId),
    );
    const base = rosterRows.length > 0 ? inOrder(rosterRows.filter((r) => r.status === 'in').map((r) => r.memberId), order) : order;

    const excluded = new Set<MemberId>(input.excludedMemberIds ?? []);
    for (const raw of input.excludedNames ?? []) {
      const hits = active.filter((m) => m.displayName.toLowerCase() === raw.trim().toLowerCase());
      if (hits.length !== 1) {
        return {
          kind: 'clarify',
          question: `who's in? i've got ${names(base, byId)}. 👍 if that's right, or tell me who to swap`,
          problems: [`unknown_name:${sanitizeInline(raw, 40)}`],
        };
      }
      excluded.add(hits[0]!.memberId);
    }
    for (const id of excluded) {
      if (!byId.has(id)) {
        return {
          kind: 'clarify',
          question: `who's in? i've got ${names(base, byId)}. 👍 if that's right, or tell me who to swap`,
          problems: [`unknown_member:${sanitizeInline(id, 40)}`],
        };
      }
    }

    let attendees: MemberId[];
    if (input.attendeeMemberIds !== undefined && input.attendeeMemberIds.length > 0) {
      const unknown = input.attendeeMemberIds.filter((id) => !order.includes(id));
      if (unknown.length > 0) {
        return {
          kind: 'clarify',
          question: `who's in? i've got ${names(base, byId)}. 👍 if that's right, or tell me who to swap`,
          problems: [...new Set(unknown)].map((id) => `attendee_not_member:${sanitizeInline(id, 40)}`),
        };
      }
      // The named subset wins, but a member marked out for the activity stays out (SAFETY §2.5).
      attendees = inOrder(
        input.attendeeMemberIds.filter((id) => !excluded.has(id) && !markedOut.has(id)),
        order,
      );
    } else {
      attendees = base.filter((id) => !excluded.has(id));
    }
    if (input.quantity !== undefined && input.quantity !== attendees.length) {
      return {
        kind: 'clarify',
        question: `who's in? i've got ${names(attendees, byId)}. 👍 if that's right, or tell me who to swap`,
        problems: ['quantity_not_roster'],
      };
    }
    if (attendees.length === 0) {
      return {
        kind: 'clarify',
        question: "who's in? nobody is marked in for that one yet",
        problems: ['empty_roster'],
      };
    }
    const outIds = order.filter((id) => !attendees.includes(id));
    const quantity = attendees.length;

    // ---- 3. the offer and the hold ----
    const offersRes = await tickets.getOffers(event.eventId, quantity);
    if (!offersRes.ok) {
      return {
        kind: 'unavailable',
        reason: offersRes.error.code === 'sold_out' ? 'sold_out' : 'provider_unavailable',
        text: soldOutText(event, searched.value, tz, quantity, now),
      };
    }
    const ranked = rankOffers(offersRes.value, quantity);
    const offer =
      input.offerId === undefined ? ranked[0] : ranked.find((o) => o.offerId === input.offerId);
    if (offer === undefined) {
      const redirectOnly = offersRes.value.some((o) => o.purchaseMode === 'redirect_only');
      return {
        kind: 'unavailable',
        reason: redirectOnly ? 'redirect_only' : 'sold_out',
        text: redirectOnly
          ? `${shortEventName(event.name)} only sells on its own site. i can post the link, but i can't buy it for you`
          : soldOutText(event, searched.value, tz, quantity, now),
      };
    }

    const keyInput = {
      groupId: ctx.groupId,
      tripId: trip.tripId,
      kind: 'ticket' as const,
      provider: tickets.info.provider,
      itemRef: offer.offerId,
      eventDate: nightOf(event.startsAt, tz),
      payerIds: attendees,
      currency: offer.unitPrice.currency,
    };
    let totalMinor = offerTotal(offer, quantity).amountMinor;
    let key = approval.deriveIdempotencyKey({ ...keyInput, totalMinor });
    const pendingSame = group.bookings
      .listPendingProposals(ctx.groupId)
      .find((p) => p.idempotencyKey === key && p.status === 'pending');
    if (pendingSame !== undefined) {
      return {
        kind: 'pending_exists',
        proposalId: pendingSame.proposalId,
        text: "that one's already waiting for a 👍 above",
      };
    }
    const existing = group.bookings.getBookingByKey(key);
    if (existing !== undefined) {
      return {
        kind: 'duplicate',
        bookingId: existing.bookingId,
        text: `already booked: ${sanitizeInline(existing.description, 60)}, ${formatMoney(money(existing.totalMinor, existing.currency))}. say "buy it again" if you really want a second set`,
      };
    }
    const heldRes = await tickets.hold(offer.offerId, quantity, key);
    if (!heldRes.ok) {
      return {
        kind: 'unavailable',
        reason: heldRes.error.code === 'sold_out' ? 'sold_out' : 'provider_unavailable',
        text:
          heldRes.error.code === 'sold_out'
            ? soldOutText(event, searched.value, tz, quantity, now)
            : "ticket site's not responding. no charge went through\n@ me again in a few",
      };
    }
    const hold: TicketHold = heldRes.value;
    if (hold.total.amountMinor !== totalMinor) {
      totalMinor = hold.total.amountMinor;
      key = approval.deriveIdempotencyKey({ ...keyInput, totalMinor });
    }

    // ---- 4. roster sync (the named subset is the roster; reasons are never stored) ----
    const act = activity ?? createActivity(group, ids, trip, event, now);
    syncRoster(group, act, attendees, outIds, ctx, now);
    const roster: Roster = {
      activityId: act.activityId,
      inMemberIds: attendees,
      outMemberIds: outIds,
      maybeMemberIds: [],
      asOf: now,
    };

    // ---- 5. the proposal ----
    const shares = allocateEqual(money(totalMinor, offer.unitPrice.currency), quantity);
    const proposal: BookingProposal = {
      proposalId: ids.next('prop'),
      groupId: ctx.groupId,
      tripId: trip.tripId,
      activityId: act.activityId,
      kind: 'ticket',
      provider: tickets.info.provider,
      itemRef: offer.offerId,
      description: sanitizeInline(`${event.name}`, 80),
      city: event.venue.city,
      totalMinor,
      currency: offer.unitPrice.currency,
      quotedAt: now,
      quoteRef: hold.holdId,
      holdExpiresAt: hold.expiresAt,
      payers: attendees.map((memberId, i) => ({ memberId, shareMinor: shares[i]!.amountMinor })),
      attendees,
      paidBy: { kind: 'member_card', memberId: ctx.requestedBy },
      refundable: offer.refundPolicy.refundable,
      ...(offer.refundPolicy.refundableUntil !== undefined
        ? { refundDeadline: offer.refundPolicy.refundableUntil }
        : {}),
      eventDate: nightOf(event.startsAt, tz),
      ageRestriction: event.minimumAge ?? null,
      contentTags: event.contentFlags,
      requestedBy: ctx.requestedBy,
      requestedAt: now,
      sourceMessageId: ctx.sourceMessageId,
      idempotencyKey: key,
      status: 'pending',
    };

    const consistency = approval.checkProposalConsistency(proposal, trip, act, roster, members, now);
    if (!consistency.ok) {
      await tickets.releaseHold(hold.holdId);
      return {
        kind: 'clarify',
        question: clarifyFor(consistency.problems, attendees, byId, trip),
        problems: consistency.problems,
      };
    }

    // ---- 6. the policy ----
    const prefs: Record<MemberId, MemberSpendingPrefs> = {};
    for (const id of attendees) {
      const p = stores.private.getPrefs(id);
      if (p !== undefined) prefs[id] = p;
    }
    const spentTodayMinor = group.bookings.spentBetween(ctx.groupId, addMinutes(now, -24 * 60), now);
    const spentTripMinor = group.bookings.spentBetween(ctx.groupId, tripStartIso(trip), now);
    const decision = approval.evaluate(proposal, grp.spendingPolicy, {
      now,
      members: approval.toMemberViews(members, now),
      prefs,
      spentTodayMinor,
      spentTripMinor,
      existingBookingForKey: group.bookings.getBookingByKey(key)?.bookingId ?? null,
    });

    const auditIds: AuditEventId[] = [];
    group.bookings.createProposal(proposal);
    auditIds.push(
      group.audit.append({
        groupId: ctx.groupId,
        tripId: trip.tripId,
        type: 'proposal.created',
        actor: { kind: 'member', id: ctx.requestedBy },
        visibility: 'group',
        proposalId: proposal.proposalId,
        idempotencyKey: key,
        payload: {
          kind: proposal.kind,
          provider: proposal.provider,
          itemRef: proposal.itemRef,
          totalMinor: proposal.totalMinor,
          currency: proposal.currency,
          payers: proposal.payers,
          attendees: proposal.attendees,
          refundable: proposal.refundable,
          requestedBy: proposal.requestedBy,
          sourceMessageId: proposal.sourceMessageId,
        },
      }).id,
    );
    const evaluated = group.audit.append({
      groupId: ctx.groupId,
      tripId: trip.tripId,
      type: 'policy.evaluated',
      actor: { kind: 'trav', id: 'trav' },
      visibility: 'group',
      proposalId: proposal.proposalId,
      idempotencyKey: key,
      payload: {
        outcome: decision.outcome,
        reasons: decision.reasons,
        ruleIds: decision.ruleIds,
        approvalMode: decision.approvalMode,
        requiredApprovers: decision.requiredApprovers,
        expiresAt: decision.expiresAt,
        policySnapshot: decision.policySnapshot,
        spentTodayMinor,
        spentTripMinor,
      },
    });
    auditIds.push(evaluated.id);
    group.bookings.saveDecision(decision, evaluated.id);

    const deciding = approval.decidingRule(decision);
    const ruleId = deciding?.ruleId ?? 'C1';

    if (decision.outcome === 'deny') {
      group.bookings.updateProposal({ ...proposal, status: 'rejected' });
      await tickets.releaseHold(hold.holdId);
      if (decision.reasons.includes('duplicate') && decision.existingBookingId !== null) {
        return {
          kind: 'duplicate',
          bookingId: decision.existingBookingId,
          text: 'already booked that one. say "buy it again" if you really want a second set',
        };
      }
      return {
        kind: 'denied',
        proposalId: proposal.proposalId,
        reasons: decision.reasons,
        ruleId,
        text: denyText(decision, proposal, grp.spendingPolicy.hardMaxPerBookingMinor),
        auditEventIds: auditIds,
      };
    }

    const grant = approval.createGrant(decision, evaluated.id, ids, now);
    group.bookings.saveGrant(grant);

    if (decision.outcome === 'auto_approve') {
      return { kind: 'auto_approved', proposal, decision, grant, auditEventIds: auditIds };
    }

    const messageId = ids.next('msg');
    auditIds.push(
      group.audit.append({
        groupId: ctx.groupId,
        tripId: trip.tripId,
        type: 'approval.requested',
        actor: { kind: 'trav', id: 'trav' },
        visibility: 'group',
        proposalId: proposal.proposalId,
        idempotencyKey: key,
        payload: {
          requiredApprovers: decision.requiredApprovers,
          approvalMode: decision.approvalMode,
          expiresAt: decision.expiresAt,
          cardMessageId: messageId,
        },
      }).id,
    );

    const perPerson = money(Math.round(totalMinor / quantity), proposal.currency);
    const text = renderProposalText({
      proposal,
      decision,
      event,
      members,
      excluded: outIds,
      perPerson,
      now,
      tz,
      ruleId,
      capPerPersonMinor: grp.spendingPolicy.perPersonAutoCapMinor,
    });
    const card = buildCard({
      cardId: ids.next('card'),
      proposal,
      decision,
      event,
      byId,
      excluded: outIds,
      perPerson,
      text,
      ruleId,
      capPerPersonMinor: grp.spendingPolicy.perPersonAutoCapMinor,
    });

    return {
      kind: 'proposal',
      proposal,
      decision,
      grant,
      card,
      text,
      messageId,
      auditEventIds: auditIds,
      event: {
        eventId: event.eventId,
        name: sanitizeInline(event.name, 80),
        venue: sanitizeInline(event.venue.name, 80),
        startsAt: event.startsAt,
      },
      attendees,
      excluded: outIds,
    };
  }

  return { propose, releaseHold };
}

// ---------- helpers ----------

function findActivity(
  group: Stores['group'],
  trip: Trip,
  event: TicketEvent,
  activityId: string | undefined,
): Activity | null {
  if (activityId !== undefined) {
    const a = group.trips.getActivity(activityId);
    if (a === undefined || a.tripId !== trip.tripId) {
      throw new TravError('not_found', `activity ${activityId} is not on this trip`);
    }
    return a;
  }
  const tz = trip.timeZone;
  const night = nightOf(event.startsAt, tz);
  const short = shortEventName(event.name);
  const venue = event.venue.name.toLowerCase();
  for (const a of group.trips.listActivities(trip.tripId)) {
    if (a.startsAt === undefined || nightOf(a.startsAt, tz) !== night) continue;
    const hay = `${a.name} ${a.venue ?? ''}`.toLowerCase();
    if (hay.includes(short) || hay.includes(venue)) return a;
  }
  return null;
}

function createActivity(
  group: Stores['group'],
  ids: IdGenerator,
  trip: Trip,
  event: TicketEvent,
  now: IsoDateTime,
): Activity {
  const kind: Activity['kind'] =
    event.category === 'nightlife'
      ? 'nightlife'
      : event.category === 'sports'
        ? 'sports'
        : event.category === 'tour'
          ? 'tour'
          : 'attraction';
  const activity: Activity = {
    activityId: ids.next('act'),
    tripId: trip.tripId,
    groupId: trip.groupId,
    kind,
    name: sanitizeInline(event.name, 80),
    venue: sanitizeInline(event.venue.name, 80),
    ...(event.venue.address !== undefined ? { address: sanitizeInline(event.venue.address, 120) } : {}),
    startsAt: event.startsAt,
    ...(event.endsAt !== undefined ? { endsAt: event.endsAt } : {}),
    contentTags: event.contentFlags,
    ageRestriction: event.minimumAge ?? null,
    createdAt: now,
  };
  group.trips.upsertActivity(activity);
  return activity;
}

/** Writes in/out rows for everyone named; one `roster.changed` event when anything changed. */
function syncRoster(
  group: Stores['group'],
  activity: Activity,
  inIds: readonly MemberId[],
  outIds: readonly MemberId[],
  ctx: ProposeContext,
  now: IsoDateTime,
): void {
  const current = new Map(group.trips.listAttendance(activity.activityId).map((r) => [r.memberId, r.status]));
  const changed: { memberId: MemberId; status: 'in' | 'out' }[] = [];
  const write = (memberId: MemberId, status: 'in' | 'out'): void => {
    if (current.get(memberId) === status) return;
    group.trips.setAttendance({
      activityId: activity.activityId,
      memberId,
      status,
      updatedAt: now,
      sourceMessageId: ctx.sourceMessageId,
      setBy: ctx.requestedBy,
    });
    changed.push({ memberId, status });
  };
  for (const id of inIds) write(id, 'in');
  for (const id of outIds) write(id, 'out');
  if (changed.length > 0) {
    group.audit.append({
      groupId: ctx.groupId,
      tripId: activity.tripId,
      type: 'roster.changed',
      actor: { kind: 'member', id: ctx.requestedBy },
      visibility: 'group',
      payload: {
        activityId: activity.activityId,
        changes: changed,
        sourceMessageId: ctx.sourceMessageId,
      },
    });
  }
}

function soldOutText(
  event: TicketEvent,
  all: readonly TicketEvent[],
  tz: string,
  quantity: number,
  now: IsoDateTime,
): string {
  const night = nightOf(event.startsAt, tz);
  const alt = all.find(
    (e) =>
      e.eventId !== event.eventId &&
      nightOf(e.startsAt, tz) === night &&
      parseIso(e.startsAt) > parseIso(now) &&
      e.category === event.category,
  );
  const when = night === nightOf(now, tz) ? 'tonight' : formatClockTime(event.startsAt, tz);
  const first = `${shortEventName(event.name)} is sold out ${when}`;
  if (alt === undefined) return `${first}\nnothing else i can grab for ${quantity} on that night`;
  return `${first}\n${sanitizeInline(alt.venue.name, 40)} has tickets the same night. @ me for ${quantity} of those instead`;
}

function clarifyFor(
  problems: readonly string[],
  attendees: readonly MemberId[],
  byId: ReadonlyMap<MemberId, Member>,
  trip: Trip,
): string {
  if (problems.includes('minor_on_restricted')) {
    return "that one's 18+ and someone on the list is under 18. tell me who's actually going";
  }
  if (problems.includes('date_outside_trip')) {
    return `that's outside the trip dates (${trip.startDate} to ${trip.endDate}). which night did you mean`;
  }
  if (problems.includes('city_not_in_trip')) {
    return `that's not in ${sanitizeInline(trip.city, 40)}. did you mean somewhere here`;
  }
  return `who's in? i've got ${names(attendees, byId)}. 👍 if that's right, or tell me who to swap`;
}

function denyText(decision: PolicyDecision, proposal: BookingProposal, hardMaxMinor: number): string {
  const r = decision.reasons;
  if (r.includes('over_hard_max')) {
    return `${formatMoney(money(proposal.totalMinor, proposal.currency))} is over this group's ${formatMoney(money(hardMaxMinor, proposal.currency))} per-booking limit, so i won't propose it\na lead can raise the limit if that's really the plan`;
  }
  if (r.includes('minor_age_restricted')) {
    return "that one's 18+ and someone charged is under 18, so no\ntell me who's actually going";
  }
  if (r.includes('quote_expired')) {
    return 'the price i had expired before i could post it. @ me again and i\'ll re-quote';
  }
  if (r.includes('requester_is_guest') || r.includes('requester_not_member')) {
    return 'i only book for people on this trip. ask one of them to @ me';
  }
  if (r.includes('payer_not_member') || r.includes('payer_inactive')) {
    return "someone on that list isn't on the trip anymore. tell me who's in";
  }
  if (r.includes('currency_mismatch')) {
    return "that's priced in a different currency than the tab, which i can't do yet";
  }
  return "i can't propose that one under this group's rules. a lead can change them";
}

interface RenderInput {
  readonly proposal: BookingProposal;
  readonly decision: PolicyDecision;
  readonly event: TicketEvent;
  readonly members: readonly Member[];
  readonly excluded: readonly MemberId[];
  readonly perPerson: Money;
  readonly now: IsoDateTime;
  readonly tz: string;
  readonly ruleId: string;
  readonly capPerPersonMinor: number;
}

function minutesUntil(iso: IsoDateTime, now: IsoDateTime): number {
  return Math.max(1, Math.round((parseIso(iso) - parseIso(now)) / 60000));
}

/** "tonight" for the current night, else VOICE §3.9 relative/absolute time from core. */
function whenText(startsAt: IsoDateTime, tz: string, now: IsoDateTime): string {
  if (nightOf(startsAt, tz) === nightOf(now, tz)) return 'tonight';
  return formatTime(startsAt, tz, now);
}

/** VOICE §4.1: what, when, how many, who, price each + total, refundability, who approves, hold window. */
export function renderProposalText(input: RenderInput): string {
  const { proposal: p, decision, event, members, excluded, perPerson, now, tz } = input;
  const byId = new Map(members.map((m) => [m.memberId, m] as const));
  const n = p.attendees.length;
  const lines: string[] = [];
  lines.push(`${shortEventName(event.name)} ${whenText(event.startsAt, tz, now)}, ${n} ticket${n === 1 ? '' : 's'}`);
  const who = names(p.attendees, byId);
  lines.push(excluded.length > 0 ? `${who} (not ${names(excluded, byId)})` : who);
  const refund = !p.refundable
    ? 'non-refundable'
    : p.refundDeadline === undefined
      ? 'refundable'
      : `refundable until ${localDate(p.refundDeadline, tz) === localDate(now, tz) ? formatClockTime(p.refundDeadline, tz) : whenText(p.refundDeadline, tz, now)}`;
  lines.push(`${formatMoney(perPerson)} each · ${formatMoney(money(p.totalMinor, p.currency))} total · ${refund}`);
  const payerName = p.paidBy.kind === 'member_card' ? names([p.paidBy.memberId], byId) : 'each card';
  lines.push(`charged to ${payerName}'s card, split ${n} ways on the tab`);

  const holdEnd = decision.expiresAt ?? p.holdExpiresAt ?? addMinutes(now, 15);
  const held = `price held for ${minutesUntil(holdEnd, now)} min`;
  const approvers = decision.requiredApprovers;
  const requesterCan = approvers.includes(p.requestedBy);
  if (decision.approvalMode === 'each_payer') {
    const why = decision.reasons.includes('over_per_person_cap')
      ? `that's over the ${formatMoney(money(input.capPerPersonMinor, p.currency))}/person cap, so everyone charged has to 👍`
      : 'everyone charged has to 👍 this one';
    lines.push(why);
    lines.push(`👍 to book, or say "not me" first. ${held}`);
  } else if (requesterCan) {
    if (!p.refundable) lines.push("it's non-refundable, so check the date before you tap");
    lines.push(`👍 to book. ${held}`);
  } else {
    const okBy = names(approvers.slice(0, 3), byId);
    lines.push(`${!p.refundable ? "it's non-refundable, so " : ''}${okBy} has to ok it`);
    lines.push(`👍 from ${okBy} to book, or anyone can say "not me" first. ${held}`);
  }
  return lines.join('\n');
}

interface CardInput {
  readonly cardId: string;
  readonly proposal: BookingProposal;
  readonly decision: PolicyDecision;
  readonly event: TicketEvent;
  readonly byId: ReadonlyMap<MemberId, Member>;
  readonly excluded: readonly MemberId[];
  readonly perPerson: Money;
  readonly text: string;
  readonly ruleId: string;
  readonly capPerPersonMinor: number;
}

function buildCard(input: CardInput): BookingProposalCard {
  const { proposal: p, decision, event, byId, text } = input;
  const name = (id: MemberId): string => sanitizeInline(byId.get(id)?.displayName ?? id, 40);
  const overCap = decision.reasons.includes('over_per_person_cap');
  const reason = overCap
    ? `over the ${formatMoney(money(input.capPerPersonMinor, p.currency))}/person cap`
    : !p.refundable
      ? 'non-refundable'
      : undefined;
  return {
    cardId: input.cardId,
    type: 'booking_proposal',
    title: sanitizeInline(event.name, 80),
    fallbackText: text,
    proposalId: p.proposalId,
    category: 'event',
    item: {
      name: sanitizeInline(event.name, 80),
      venue: sanitizeInline(event.venue.name, 80),
      startsAt: event.startsAt,
      ...(event.endsAt !== undefined ? { endsAt: event.endsAt } : {}),
    },
    quantity: p.attendees.length,
    charged: p.payers.map((s) => ({
      memberId: s.memberId,
      name: name(s.memberId),
      share: money(s.shareMinor, p.currency),
    })),
    excluded: input.excluded.map((id) => ({ memberId: id, name: name(id) })),
    pricePerPerson: input.perPerson,
    total: money(p.totalMinor, p.currency),
    refundable: p.refundable,
    ...(p.refundDeadline !== undefined ? { refundDeadline: p.refundDeadline } : {}),
    paidBy: p.paidBy,
    policy: {
      requiresApprovalFrom: decision.requiredApprovers,
      approvalMode: decision.approvalMode === 'each_payer' ? 'each_payer' : 'any_one',
      overCap,
      capPerPerson: money(input.capPerPersonMinor, p.currency),
      ...(reason !== undefined ? { reason } : {}),
      ruleId: input.ruleId,
    },
    holdExpiresAt: decision.expiresAt ?? p.holdExpiresAt ?? p.quotedAt,
    status: 'pending',
  };
}

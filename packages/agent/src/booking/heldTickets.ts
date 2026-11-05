/**
 * Held tickets (T-188 r1 #1, D-056). A member Trav can't DM right now (the
 * server's STOP list: `TravRuntimeOptions.dmHold`) still gets their ticket,
 * just not yet. The approval handler doesn't send their ticket DM; it files
 * a pointer here, and the receipt says whose QR is saved instead of claiming
 * it went out. `TravAgent.deliverHeld(memberId)` sends the saved tickets
 * once the hold is lifted (START), then drops the pointers.
 *
 * The pointer is ids only (booking, ticket, holder), in the recipient's own
 * private partition. The QR stays in `ticket_artifacts` alone, as in D-054
 * r1 #1. So "delete my data" (`deletePartition`) and "forget this trip"
 * (`deleteTrip`, through `tripId`) take it.
 */
import type { BookingId, GroupId, MemberId, Stores, TripId } from '@trav/core';

export const HELD_TICKET_NAMESPACE = 'held_ticket';

/** True when Trav must not DM this member right now (their DMs are held, not dropped). */
export type DmHold = (memberId: MemberId) => boolean;

export interface HeldTicket {
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  readonly bookingId: BookingId;
  readonly ticketId: string;
  /** Whose ticket it is (a minor's goes to their guardian, the recipient). */
  readonly holderMemberId: MemberId;
  /** Who the DM goes to: the partition the pointer lives in. */
  readonly recipientMemberId: MemberId;
}

export function holdTicket(stores: Stores, held: HeldTicket): void {
  stores.private.putRuntimeState(held.recipientMemberId, {
    namespace: HELD_TICKET_NAMESPACE,
    groupId: held.groupId,
    tripId: held.tripId,
    key: held.ticketId,
    value: { bookingId: held.bookingId, holderMemberId: held.holderMemberId },
  });
}

/** The recipient's held tickets, oldest first. Malformed rows are skipped. */
export function heldTicketsFor(stores: Stores, recipientMemberId: MemberId): HeldTicket[] {
  const out: HeldTicket[] = [];
  for (const e of stores.private.listRuntimeState(recipientMemberId, HELD_TICKET_NAMESPACE)) {
    const v = e.value as { readonly bookingId?: unknown; readonly holderMemberId?: unknown };
    if (e.groupId === null || typeof v.bookingId !== 'string') continue;
    if (typeof v.holderMemberId !== 'string') continue;
    out.push({
      groupId: e.groupId,
      tripId: e.tripId ?? null,
      bookingId: v.bookingId,
      ticketId: e.key,
      holderMemberId: v.holderMemberId,
      recipientMemberId,
    });
  }
  return out;
}

export function releaseHeldTicket(stores: Stores, held: HeldTicket): void {
  stores.private.deleteRuntimeState(
    held.recipientMemberId,
    HELD_TICKET_NAMESPACE,
    held.groupId,
    held.ticketId,
  );
}

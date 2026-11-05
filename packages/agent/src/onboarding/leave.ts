/**
 * T-170 (D-055): "@trav leave". A lead asks, Trav says exactly what goes (and
 * whether the tab is still open), the same lead replies "delete it" within 10
 * minutes, then Trav says goodbye, deletes the group's data in both stores
 * (`Stores.deleteGroup`, one transaction; audit rows stay, tombstoned) and
 * leaves the conversation where the channel can. Rules only, never the model.
 */
import type { GroupId, IsoDateTime, Member, MemberId, Stores } from '@trav/core';
import { parseIso, safety } from '@trav/core';
import { tripMoney } from '../context/tripMoney.js';

/** How long "delete it" may follow "@trav leave". */
export const LEAVE_CONFIRM_WINDOW_MS = 10 * 60_000;

/**
 * Who may delete the group: a lead (or guardian). A group with no active lead
 * lets any adult, active, non-guest member do it. Never a guest or a minor.
 */
export function mayDeleteGroup(me: Member, members: readonly Member[], now: IsoDateTime): boolean {
  if (!me.active || me.leftAt !== undefined || me.role === 'guest') return false;
  if (safety.isMinor(me, now)) return false;
  if (me.role === 'lead' || me.role === 'guardian') return true;
  return !members.some(
    (m) => m.active && m.leftAt === undefined && (m.role === 'lead' || m.role === 'guardian'),
  );
}

/** Any trip of the group still has someone owing or owed (or a minor's share waiting on a guardian). */
export function groupHasOpenBalances(
  stores: Stores,
  groupId: GroupId,
  members: readonly Member[],
  now: IsoDateTime,
): boolean {
  return stores.group.trips.listByGroup(groupId).some((trip) => {
    const money = tripMoney({
      trip,
      members,
      expenses: stores.group.expenses.listByTrip(trip.tripId),
      entries: stores.group.expenses.listEntries(trip.tripId),
      payments: stores.group.settlements.listByTrip(trip.tripId),
      now,
    });
    return (
      money.kind === 'needs_guardian' || money.ledger.balances.some((b) => b.net.amountMinor !== 0)
    );
  });
}

/** The open "@trav leave" questions, one per group (in memory: a restart just means asking again). */
export interface LeaveAsks {
  ask(groupId: GroupId, memberId: MemberId, now: IsoDateTime): void;
  /** The asker, while their question is open. */
  openFor(groupId: GroupId, now: IsoDateTime): MemberId | undefined;
  clear(groupId: GroupId): void;
}

export function createLeaveAsks(): LeaveAsks {
  const open = new Map<GroupId, { readonly memberId: MemberId; readonly at: IsoDateTime }>();
  return {
    ask(groupId, memberId, now) {
      open.set(groupId, { memberId, at: now });
    },
    openFor(groupId, now) {
      const a = open.get(groupId);
      if (a === undefined) return undefined;
      if (parseIso(now) - parseIso(a.at) > LEAVE_CONFIRM_WINDOW_MS) {
        open.delete(groupId);
        return undefined;
      }
      return a.memberId;
    },
    clear(groupId) {
      open.delete(groupId);
    },
  };
}

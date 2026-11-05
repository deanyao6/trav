/**
 * The three reference trips (MOTIVATION.md) as simulator groups. Ids, names
 * and handles follow `fixtures/_gen/trips.mjs`.
 *
 * Handles: the simulator channel keys each member's DM thread by handle
 * (`dm:<handle>`) across all conversations, so a handle must belong to exactly
 * one member. The fixtures reuse `h_dean`/`h_dad` across trips, so Lisbon and
 * Turks and Caicos get trip-scoped handles here; Barcelona (the flagship) keeps
 * the fixture handles exactly.
 */
import type { SimulatorConversation } from '@trav/adapters';
import type { SimGroup, SimMember } from '../shared/types.js';

function members(
  groupId: string,
  list: readonly (readonly [memberId: string, name: string, handle: string])[],
): SimMember[] {
  return list.map(([memberId, name, handle]) => ({ memberId, groupId, handle, name }));
}

export const RAZZMATAZZ_ASK = "@trav get the 5 of us Razzmatazz tickets, Henry's sick";

export const BARCELONA: SimGroup = {
  groupId: 'grp_barcelona',
  conversationId: 'conv_barcelona',
  name: 'barcelona 🇪🇸',
  tripName: 'Barcelona spring break',
  timeZone: 'Europe/Madrid',
  tripStart: '2026-03-12',
  tripEnd: '2026-03-17',
  members: members('grp_barcelona', [
    ['mem_dean', 'Dean', 'h_dean'],
    ['mem_henry', 'Henry', 'h_henry'],
    ['mem_chase', 'Chase', 'h_chase'],
    ['mem_piotr', 'Piotr', 'h_piotr'],
    ['mem_arjun', 'Arjun', 'h_arjun'],
    ['mem_crowley', 'Crowley', 'h_crowley'],
  ]),
  hints: [{ from: 'h_dean', text: RAZZMATAZZ_ASK }],
};

export const LISBON: SimGroup = {
  groupId: 'grp_lisbon',
  conversationId: 'conv_lisbon',
  name: 'lisbon w dad',
  tripName: 'Lisbon: Dean + Dad',
  timeZone: 'Europe/Lisbon',
  tripStart: '2026-04-15',
  tripEnd: '2026-04-20',
  members: members('grp_lisbon', [
    ['mem_lis_dean', 'Dean', 'h_lis_dean'],
    ['mem_lis_dad', 'Dad', 'h_lis_dad'],
  ]),
  hints: [],
  // T-095: opens on trip day 2, thu apr 16 9am, as Dad's conference starts.
  opensAt: '2026-04-16T09:00:00+01:00',
};

export const TURKS_AND_CAICOS: SimGroup = {
  groupId: 'grp_turks_caicos',
  conversationId: 'conv_turks_caicos',
  name: 'TCI fam 🌴',
  tripName: 'Turks and Caicos family trip',
  timeZone: 'America/Grand_Turk',
  tripStart: '2026-06-20',
  tripEnd: '2026-06-27',
  members: members('grp_turks_caicos', [
    ['mem_tci_mom', 'Mom', 'h_tci_mom'],
    ['mem_tci_dad', 'Dad', 'h_tci_dad'],
    ['mem_tci_dean', 'Dean', 'h_tci_dean'],
    ['mem_tci_lily', 'Lily', 'h_tci_lily'],
  ]),
  hints: [],
  // T-095: opens on trip day 2, sun jun 21 9am, the first full day on the island.
  opensAt: '2026-06-21T09:00:00-04:00',
};

/** Barcelona first: it is the flagship and the default selection. */
export const SIM_GROUPS: readonly SimGroup[] = [BARCELONA, LISBON, TURKS_AND_CAICOS];

/** Simulator-channel conversations for a set of groups (participants carry memberIds). */
export function toConversations(groups: readonly SimGroup[]): SimulatorConversation[] {
  return groups.map((g) => ({
    conversationId: g.conversationId,
    participants: g.members.map((m) => ({
      handle: m.handle,
      displayName: m.name,
      memberId: m.memberId,
    })),
  }));
}

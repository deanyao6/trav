/**
 * Groups the server knows at boot (T-188).
 *
 * - `seedBarcelonaOnRelay`: the dev demo (`--demo=barcelona`). The flagship
 *   group from `seedBarcelona`, with each member's `senderId` moved to a
 *   fictional NANP 555-01xx number (what the relay reports as the sender) and
 *   the group on the `imessage_relay` channel.
 * - `provisionGroups`: a JSON file (`TRAV_SERVER_GROUPS`) listing real groups:
 *   the chat id the relay reports, the members' addresses, an optional trip.
 *   Idempotent: a group or member already stored is left as is, so editing the
 *   file never rewrites history. Strictly validated; an invalid file stops boot
 *   with the field's path, never its value.
 *
 * Anyone not provisioned who writes in a provisioned chat is a guest (they can
 * chat, never book, approve or pay; SAFETY §2.5). A chat that is not
 * provisioned gets no answer at all.
 */
import { readFileSync } from 'node:fs';
import { fictionalAddress } from '@trav/adapters';
import { BARCELONA, seedBarcelona } from '@trav/agent';
import type { Group, IsoDateTime, Member, MemberRole, Stores, Trip } from '@trav/core';
import { DEFAULT_GROUP_SETTINGS, defaultSpendingPolicy, safety } from '@trav/core';
import { looksLikeAddress } from './relayState.js';

export const RELAY_CHANNEL_KIND = 'imessage_relay';

/** The demo's member → fictional address map (the order of `BARCELONA.members`). */
export function barcelonaAddresses(): ReadonlyMap<string, string> {
  return new Map(BARCELONA.members.map((m, i) => [m.memberId, fictionalAddress(i)]));
}

/** Seeds Barcelona (if absent) and moves it onto the relay. Returns the member → address map. */
export function seedBarcelonaOnRelay(stores: Stores): ReadonlyMap<string, string> {
  const addresses = barcelonaAddresses();
  if (stores.group.groups.get(BARCELONA.groupId) !== undefined) return addresses;
  seedBarcelona(stores);
  const g = stores.group.groups.get(BARCELONA.groupId)!;
  stores.group.groups.update({ ...g, channelKind: RELAY_CHANNEL_KIND });
  for (const m of stores.group.members.listByGroup(BARCELONA.groupId)) {
    stores.group.members.upsert({ ...m, senderId: addresses.get(m.memberId)! });
  }
  return addresses;
}

// ---------- the groups file ----------

export interface ProvisionedMember {
  readonly memberId: string;
  readonly name: string;
  /** E.164 phone number or Apple ID email, as the relay reports the sender. */
  readonly address: string;
  readonly role?: 'lead' | 'member';
  /** YYYY-MM-DD. Without it the member's age is unknown (no roast mode, family-safe plans). */
  readonly birthDate?: string;
}

export interface ProvisionedTrip {
  readonly tripId: string;
  readonly name: string;
  readonly city: string;
  readonly countryCode: string;
  readonly timeZone: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface ProvisionedGroup {
  readonly groupId: string;
  readonly name: string;
  /** The relay's chat id for the group thread. */
  readonly chatId: string;
  readonly currency: string;
  /** Per-person auto-buy cap in minor units (default: the core default policy). */
  readonly perPersonAutoCapMinor?: number;
  readonly members: readonly ProvisionedMember[];
  readonly trip?: ProvisionedTrip;
}

const ID = /^[a-z][a-z0-9_]{1,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;

class ProvisionError extends Error {
  override readonly name = 'ProvisionError';
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ProvisionError(`${path} must be an object`);
  }
  return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, path: string, re?: RegExp): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > 200) {
    throw new ProvisionError(`${path}.${key} must be a non-empty string`);
  }
  if (re !== undefined && !re.test(v)) throw new ProvisionError(`${path}.${key} is malformed`);
  return v.trim();
}

function optStr(
  o: Record<string, unknown>,
  key: string,
  path: string,
  re?: RegExp,
): string | undefined {
  return o[key] === undefined ? undefined : str(o, key, path, re);
}

function normalizeAddress(a: string): string {
  return a.includes('@') ? a.toLowerCase() : a;
}

/** Parses and validates a groups file's JSON. Pure. */
export function parseGroupsFile(json: unknown): ProvisionedGroup[] {
  const root = obj(json, 'groups file');
  const list = root['groups'];
  if (!Array.isArray(list)) throw new ProvisionError('groups file.groups must be an array');
  const groupIds = new Set<string>();
  const chatIds = new Set<string>();
  const memberIds = new Set<string>();
  return list.map((raw, gi) => {
    const p = `groups[${String(gi)}]`;
    const g = obj(raw, p);
    const groupId = str(g, 'groupId', p, ID);
    const chatId = str(g, 'chatId', p);
    if (groupIds.has(groupId)) throw new ProvisionError(`${p}.groupId is a duplicate`);
    if (chatIds.has(chatId)) throw new ProvisionError(`${p}.chatId is a duplicate`);
    groupIds.add(groupId);
    chatIds.add(chatId);
    const cap = g['perPersonAutoCapMinor'];
    if (cap !== undefined && (!Number.isInteger(cap) || (cap as number) < 0)) {
      throw new ProvisionError(`${p}.perPersonAutoCapMinor must be a non-negative integer`);
    }
    const rawMembers = g['members'];
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
      throw new ProvisionError(`${p}.members must be a non-empty array`);
    }
    const addresses = new Set<string>();
    const members = rawMembers.map((rm, mi): ProvisionedMember => {
      const mp = `${p}.members[${String(mi)}]`;
      const m = obj(rm, mp);
      const memberId = str(m, 'memberId', mp, ID);
      if (memberIds.has(memberId)) throw new ProvisionError(`${mp}.memberId is a duplicate`);
      memberIds.add(memberId);
      const address = normalizeAddress(str(m, 'address', mp));
      if (!looksLikeAddress(address)) {
        throw new ProvisionError(`${mp}.address must be an E.164 number or an email`);
      }
      if (addresses.has(address)) throw new ProvisionError(`${mp}.address is a duplicate`);
      addresses.add(address);
      const role = optStr(m, 'role', mp);
      if (role !== undefined && role !== 'lead' && role !== 'member') {
        throw new ProvisionError(`${mp}.role must be lead or member`);
      }
      const birthDate = optStr(m, 'birthDate', mp, DATE);
      return {
        memberId,
        name: str(m, 'name', mp),
        address,
        ...(role !== undefined ? { role } : {}),
        ...(birthDate !== undefined ? { birthDate } : {}),
      };
    });
    let trip: ProvisionedTrip | undefined;
    if (g['trip'] !== undefined) {
      const tp = `${p}.trip`;
      const t = obj(g['trip'], tp);
      trip = {
        tripId: str(t, 'tripId', tp, ID),
        name: str(t, 'name', tp),
        city: str(t, 'city', tp),
        countryCode: str(t, 'countryCode', tp, COUNTRY),
        timeZone: str(t, 'timeZone', tp),
        startDate: str(t, 'startDate', tp, DATE),
        endDate: str(t, 'endDate', tp, DATE),
      };
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: trip.timeZone });
      } catch {
        throw new ProvisionError(`${tp}.timeZone is not a known time zone`);
      }
      if (trip.endDate < trip.startDate)
        throw new ProvisionError(`${tp}.endDate is before startDate`);
    }
    return {
      groupId,
      name: str(g, 'name', p),
      chatId,
      currency: str(g, 'currency', p, CURRENCY),
      ...(cap !== undefined ? { perPersonAutoCapMinor: cap as number } : {}),
      members,
      ...(trip !== undefined ? { trip } : {}),
    };
  });
}

export function readGroupsFile(path: string): ProvisionedGroup[] {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ProvisionError('the groups file is missing or not JSON');
  }
  return parseGroupsFile(json);
}

/** Writes whatever is not stored yet. Returns the group ids it created. */
export function provisionGroups(
  stores: Stores,
  groups: readonly ProvisionedGroup[],
  now: IsoDateTime,
): string[] {
  const created: string[] = [];
  for (const spec of groups) {
    const existing = stores.group.groups.get(spec.groupId);
    if (existing === undefined) {
      const byChat = stores.group.groups.getByConversation(spec.chatId);
      if (byChat !== undefined) {
        throw new ProvisionError(`chat of ${spec.groupId} already belongs to another group`);
      }
      const policy = defaultSpendingPolicy(spec.groupId, spec.currency);
      const group: Group = {
        groupId: spec.groupId,
        name: spec.name,
        conversationId: spec.chatId,
        channelKind: RELAY_CHANNEL_KIND,
        currency: spec.currency,
        settings: { ...DEFAULT_GROUP_SETTINGS },
        spendingPolicy:
          spec.perPersonAutoCapMinor !== undefined
            ? { ...policy, perPersonAutoCapMinor: spec.perPersonAutoCapMinor }
            : policy,
        createdAt: now,
      };
      stores.group.groups.create(group);
      created.push(spec.groupId);
    }
    for (const [i, pm] of spec.members.entries()) {
      if (stores.group.members.get(pm.memberId) !== undefined) continue;
      const role: MemberRole = pm.role ?? (i === 0 ? 'lead' : 'member');
      const base: Member = {
        memberId: pm.memberId,
        groupId: spec.groupId,
        displayName: pm.name,
        role,
        active: true,
        senderId: pm.address,
        ageBand: 'unknown',
        joinedAt: now,
        ...(pm.birthDate !== undefined ? { birthDate: pm.birthDate } : {}),
      };
      const ageBand =
        pm.birthDate === undefined ? 'unknown' : safety.isMinor(base, now) ? 'under18' : 'adult';
      stores.group.members.upsert({ ...base, ageBand });
    }
    if (spec.trip !== undefined && stores.group.trips.get(spec.trip.tripId) === undefined) {
      const lead = spec.members.find((m) => m.role === 'lead') ?? spec.members[0]!;
      const trip: Trip = {
        tripId: spec.trip.tripId,
        groupId: spec.groupId,
        name: spec.trip.name,
        city: spec.trip.city,
        countryCode: spec.trip.countryCode,
        timeZone: spec.trip.timeZone,
        startDate: spec.trip.startDate,
        endDate: spec.trip.endDate,
        currency: spec.currency,
        status: 'planning',
        // VOICE §8: a family tab by default when someone on the trip is under 18.
        familyTab: stores.group.members
          .listByGroup(spec.groupId)
          .some((m) => safety.isMinor(m, now)),
        createdBy: lead.memberId,
        createdAt: now,
      };
      stores.group.trips.create(trip);
    }
  }
  return created;
}

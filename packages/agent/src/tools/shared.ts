/**
 * Shared helpers for the v0 tools: input parsing (every tool's `parse` throws
 * `TravError('invalid_argument')`), identity checks (SAFETY §2.5) and the
 * per-turn context the loop hands to `registry.run`.
 */
import type { IsoDateTime, Member, MemberId, MessageId, Trip } from '@trav/core';
import { TravError } from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import type { SettingsCommand } from '../settings/parse.js';
import type { ToolContext } from './registry.js';

/** `ToolContext` plus what the loop knows about the message that caused the turn. */
export interface TurnToolContext extends ToolContext {
  /** The inbound message id: `Attendance.sourceMessageId`, `Expense.sourceRef`, audit payloads. */
  readonly messageId: MessageId;
  /**
   * The settings flow for this turn (T-017, `settings/flow.ts`). With it,
   * `request_settings_change` takes the typed-command road: same gates, the
   * requester's "yes to confirm?" for caps and reply mode, same audit.
   */
  readonly settings?: SettingsGateway;
}

export interface SettingsGateway {
  run(cmd: SettingsCommand): { readonly text: string; readonly note: string };
}

export function messageIdOf(ctx: ToolContext): MessageId {
  const id = (ctx as Partial<TurnToolContext>).messageId;
  if (typeof id !== 'string' || id.length === 0) {
    throw new TravError('invariant_violation', 'tool context has no messageId');
  }
  return id;
}

export function bad(message: string): never {
  throw new TravError('invalid_argument', message);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asRecord(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (!isRecord(input)) bad('tool input must be an object');
  return input;
}

export function optString(r: Record<string, unknown>, key: string, max = 200): string | undefined {
  const v = r[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') bad(`${key} must be a string`);
  return sanitizeInline(v, max);
}

export function reqString(r: Record<string, unknown>, key: string, max = 200): string {
  const v = optString(r, key, max);
  if (v === undefined) bad(`${key} is required`);
  return v;
}

export function optInt(r: Record<string, unknown>, key: string): number | undefined {
  const v = r[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v);
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) bad(`${key} must be an integer`);
  return v;
}

export function optStringArray(r: Record<string, unknown>, key: string): string[] | undefined {
  const v = r[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return [sanitizeInline(v, 80)];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    bad(`${key} must be an array of strings`);
  }
  return (v as string[]).map((x) => sanitizeInline(x, 80));
}

export function optEnum<T extends string>(
  r: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const v = r[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !values.includes(v as T)) {
    bad(`${key} must be one of ${values.join(', ')}`);
  }
  return v as T;
}

/** Active, non-guest members in join order (the "member order" for splits and lists). */
export function activeMembers(ctx: ToolContext): Member[] {
  return ctx.stores.group.members
    .listByGroup(ctx.groupId)
    .filter((m) => m.active && m.leftAt === undefined && m.role !== 'guest');
}

/** The sender as an active, non-guest member, or `not_authorized`. */
export function requireMember(ctx: ToolContext): Member {
  if (ctx.senderMemberId === null) {
    throw new TravError('not_authorized', 'only members of this trip can do that');
  }
  const m = ctx.stores.group.members.get(ctx.senderMemberId);
  if (m === undefined || !m.active || m.leftAt !== undefined || m.role === 'guest') {
    throw new TravError('not_authorized', 'only members of this trip can do that');
  }
  return m;
}

export function currentTrip(ctx: ToolContext): Trip | undefined {
  return ctx.tripId === null
    ? ctx.stores.group.trips.current(ctx.groupId, ctx.now)
    : ctx.stores.group.trips.get(ctx.tripId);
}

export function requireTrip(ctx: ToolContext): Trip {
  const trip = currentTrip(ctx);
  if (trip === undefined) throw new TravError('not_found', 'no trip is set up for this group yet');
  return trip;
}

export function nameOf(members: readonly Member[], id: MemberId): string {
  return sanitizeInline(members.find((m) => m.memberId === id)?.displayName ?? id, 40);
}

/** Resolve "Henry" or "mem_henry" to a member id; undefined when unknown or ambiguous. */
export function resolveMemberRef(members: readonly Member[], ref: string): MemberId | undefined {
  const exact = members.find((m) => m.memberId === ref);
  if (exact !== undefined) return exact.memberId;
  const lower = ref.trim().toLowerCase();
  const hits = members.filter((m) => m.displayName.trim().toLowerCase() === lower);
  return hits.length === 1 ? hits[0]!.memberId : undefined;
}

export function isoOrNow(value: string | undefined, now: IsoDateTime): IsoDateTime {
  if (value === undefined) return now;
  if (Number.isNaN(Date.parse(value))) bad('occurredAt must be an ISO-8601 date-time');
  return value;
}

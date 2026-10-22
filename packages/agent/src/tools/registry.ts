/**
 * Tool registry (SAFETY §2.1 A2). The model's tools can read state, create
 * proposals, log expenses and change rosters. There is NO tool that purchases,
 * charges, refunds, or deletes ledger rows; `createToolRegistry` throws on a
 * name matching `FORBIDDEN_TOOL_NAME_PATTERN`, and a test asserts the names.
 *
 * Input validation: each tool's `parse(input)` must validate the raw model
 * input and throw `TravError('invalid_argument')`; builders may hand-write
 * guards or add `zod@4.6.7` (pinned) to this package if schemas get large.
 */
import type {
  Clock,
  GroupId,
  IdGenerator,
  IsoDateTime,
  MemberId,
  SenderId,
  Stores,
  TripId,
} from '@trav/core';
import { notImplemented } from '@trav/core';
import type { JsonSchema, ToolSpec } from '../model/client.js';

export interface ToolContext {
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  /** Resolved from the channel sender id; null for guests/unknown. */
  readonly senderMemberId: MemberId | null;
  readonly senderId: SenderId;
  readonly lane: 'group' | 'dm';
  readonly now: IsoDateTime;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly stores: Stores;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Validate and narrow raw model input. */
  parse(input: unknown): I;
  /** Pure-ish: may read/write stores and write audit events; may not call providers' purchase/charge. */
  handler(input: I, ctx: ToolContext): Promise<O>;
  /** Tools that must not be offered on the group lane (e.g. private pending-item lookups). */
  readonly dmOnly?: boolean;
}

export interface ToolRegistry {
  register<I, O>(tool: ToolDefinition<I, O>): void;
  get(name: string): ToolDefinition | undefined;
  list(lane: 'group' | 'dm'): readonly ToolDefinition[];
  /** What the model sees. */
  specs(lane: 'group' | 'dm'): readonly ToolSpec[];
  names(): readonly string[];
}

export const FORBIDDEN_TOOL_NAME_PATTERN =
  /purchase|buy|charge|pay(?!er)|refund|execute|delete_ledger|transfer|send_money/i;

/** The v0 tool set. Keep this list in sync with the registry test. */
export const V0_TOOL_NAMES = [
  'propose_booking',
  'get_pending_proposals',
  'cancel_proposal',
  'search_events',
  'search_flights',
  'search_lodging',
  'get_roster',
  'set_attendance',
  'log_expense',
  'get_balances',
  'get_group_memory',
  'remember',
  'get_settings',
  'request_settings_change',
  'get_my_pending_items',
] as const;

export type V0ToolName = (typeof V0_TOOL_NAMES)[number];

/** Throws `invalid_argument` if a registered name matches `FORBIDDEN_TOOL_NAME_PATTERN`. */
export function createToolRegistry(): ToolRegistry {
  return notImplemented('createToolRegistry');
}

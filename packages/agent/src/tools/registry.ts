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
import { TravError } from '@trav/core';
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
  /**
   * Validate and run one tool call: unknown name ⇒ `not_found`; a `dmOnly`
   * tool on the group lane ⇒ `not_authorized`; bad input ⇒ whatever `parse`
   * throws (`invalid_argument`).
   */
  run(name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown>;
}

export interface ToolRegistryOptions {
  /**
   * Names that may be registered. Defaults to `V0_TOOL_NAMES`, so a new tool
   * must be added to that list (and its test) before it can reach the model.
   */
  readonly allowedNames?: readonly string[];
}

export const FORBIDDEN_TOOL_NAME_PATTERN =
  /purchase|buy|charge|pay(?!er)|refund|execute|delete|transfer|send_money|approve|grant|confirm|remove|undo|checkout|order/i;

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

const TOOL_NAME_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/** True if `name` may never be a model tool (SAFETY §2.1 A2). */
export function isForbiddenToolName(name: string): boolean {
  return FORBIDDEN_TOOL_NAME_PATTERN.test(name);
}

/**
 * Throws `invalid_argument` if a registered name matches
 * `FORBIDDEN_TOOL_NAME_PATTERN`, is not snake_case, is not in the allowed list
 * (default `V0_TOOL_NAMES`), or has no description/object schema; throws
 * `duplicate` on a second registration of the same name.
 */
export function createToolRegistry(opts: ToolRegistryOptions = {}): ToolRegistry {
  const allowed = new Set<string>(opts.allowedNames ?? V0_TOOL_NAMES);
  for (const n of allowed) {
    if (isForbiddenToolName(n)) {
      throw new TravError(
        'invalid_argument',
        `allowed tool name "${n}" matches the forbidden pattern`,
      );
    }
  }
  const tools = new Map<string, ToolDefinition>();

  const list = (lane: 'group' | 'dm'): readonly ToolDefinition[] =>
    [...tools.values()].filter((t) => lane === 'dm' || t.dmOnly !== true);

  return {
    register<I, O>(tool: ToolDefinition<I, O>): void {
      const { name } = tool;
      if (isForbiddenToolName(name)) {
        throw new TravError(
          'invalid_argument',
          `tool "${name}" is forbidden: the model may not purchase, charge, pay, refund, execute, transfer or delete ledger rows`,
        );
      }
      if (!TOOL_NAME_SHAPE.test(name)) {
        throw new TravError('invalid_argument', `tool name "${name}" must be snake_case`);
      }
      if (!allowed.has(name)) {
        throw new TravError(
          'invalid_argument',
          `tool "${name}" is not in the allowed tool list (V0_TOOL_NAMES)`,
        );
      }
      if (tools.has(name)) throw new TravError('duplicate', `tool "${name}" is already registered`);
      if (tool.description.trim().length === 0) {
        throw new TravError('invalid_argument', `tool "${name}" needs a description`);
      }
      if (tool.inputSchema['type'] !== 'object') {
        throw new TravError(
          'invalid_argument',
          `tool "${name}" input schema must be an object schema`,
        );
      }
      tools.set(name, tool as unknown as ToolDefinition);
    },
    get: (name) => tools.get(name),
    list,
    specs: (lane) =>
      list(lane).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    names: () => [...tools.keys()],
    async run(name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown> {
      const tool = tools.get(name);
      if (tool === undefined) throw new TravError('not_found', `no tool named "${name}"`);
      if (tool.dmOnly === true && ctx.lane !== 'dm') {
        throw new TravError(
          'not_authorized',
          `tool "${name}" is only available in a private thread`,
        );
      }
      const input = tool.parse(rawInput);
      return tool.handler(input, ctx);
    },
  };
}

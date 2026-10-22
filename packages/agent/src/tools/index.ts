/**
 * The v0 tool set (ARCHITECTURE §9). One file per tool; this module wires
 * their dependencies and registers them on a `ToolRegistry` whose allowed list
 * is `V0_TOOL_NAMES`, so a tool that is not in that list (or whose name
 * matches `FORBIDDEN_TOOL_NAME_PATTERN`) cannot reach the model.
 */
import type { FlightsAdapter, LodgingAdapter, TicketsAdapter } from '@trav/adapters';
import type { ProposalService } from '../booking/proposals.js';
import type { GroupMemory, MemberMemory } from '../memory/index.js';
import { getBalancesTool, logExpenseTool } from './ledger.js';
import { createGetGroupMemoryTool, createRememberTool } from './memoryTools.js';
import { getMyPendingItemsTool } from './pendingItems.js';
import { createCancelProposalTool, getPendingProposalsTool } from './proposals.js';
import { createProposeBookingTool } from './proposeBooking.js';
import type { ToolDefinition, ToolRegistry } from './registry.js';
import { createToolRegistry, V0_TOOL_NAMES } from './registry.js';
import { getRosterTool, setAttendanceTool } from './roster.js';
import {
  createSearchEventsTool,
  createSearchFlightsTool,
  createSearchLodgingTool,
} from './search.js';
import { getSettingsTool, requestSettingsChangeTool } from './settings.js';

export type { TurnToolContext } from './shared.js';
export { messageIdOf } from './shared.js';
export type { ProposeInput, ProposeResult } from '../booking/proposals.js';
export type { LogExpenseInput, LogExpenseResult, BalancesResult } from './ledger.js';
export { renderExpenseLoggedText, balancesFor } from './ledger.js';
export type { RosterView } from './roster.js';
export type { SettingsView, SettingsChangeResult } from './settings.js';
export type { PendingProposalSummary } from './proposals.js';
export type { EventResult, FlightResult, LodgingResult } from './search.js';
export type { PendingItemView } from './pendingItems.js';

export interface ToolDeps {
  readonly proposals: ProposalService;
  readonly tickets: TicketsAdapter;
  readonly flights: FlightsAdapter;
  readonly lodging: LodgingAdapter;
  readonly groupMemory: GroupMemory;
  readonly memberMemory: MemberMemory;
}

/** Every v0 tool, in `V0_TOOL_NAMES` order. */
export function createV0Tools(deps: ToolDeps): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createProposeBookingTool(deps.proposals) as ToolDefinition,
    getPendingProposalsTool as ToolDefinition,
    createCancelProposalTool(deps.proposals) as ToolDefinition,
    createSearchEventsTool(deps.tickets) as ToolDefinition,
    createSearchFlightsTool(deps.flights) as ToolDefinition,
    createSearchLodgingTool(deps.lodging) as ToolDefinition,
    getRosterTool as ToolDefinition,
    setAttendanceTool as ToolDefinition,
    logExpenseTool as ToolDefinition,
    getBalancesTool as ToolDefinition,
    createGetGroupMemoryTool(deps.groupMemory) as ToolDefinition,
    createRememberTool(deps.groupMemory, deps.memberMemory) as ToolDefinition,
    getSettingsTool as ToolDefinition,
    requestSettingsChangeTool as ToolDefinition,
    getMyPendingItemsTool as ToolDefinition,
  ];
  const order = new Map<string, number>(V0_TOOL_NAMES.map((n, i) => [n, i] as const));
  return [...tools].sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
}

/** A registry with every v0 tool registered. */
export function createV0ToolRegistry(deps: ToolDeps): ToolRegistry {
  const registry = createToolRegistry();
  for (const tool of createV0Tools(deps)) registry.register(tool);
  return registry;
}

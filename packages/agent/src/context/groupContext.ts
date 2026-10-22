/**
 * Group context and prompt rendering (SAFETY §2.3; D-007). `buildGroupContext`
 * reads ONLY `stores.group` plus `stores.private.countPendingByOwner` (counts).
 * Its parameter and return types contain no `Private<...>`; the T-007 type
 * test passes a `CardTransaction` to `withExtra` and expects a compile error.
 */
import type {
  Clock,
  GroupContext,
  GroupId,
  GroupSafe,
  GroupStore,
  PrivateStore,
  TripId,
} from '@trav/core';
import { notImplemented } from '@trav/core';

export interface GroupContextDeps {
  readonly group: GroupStore;
  /** Only `countPendingByOwner` is called. */
  readonly privateCounts: Pick<PrivateStore, 'countPendingByOwner'>;
  readonly clock: Clock;
}

export function buildGroupContext(
  deps: GroupContextDeps,
  groupId: GroupId,
  tripId: TripId | null,
  opts?: { readonly recentMessageLimit?: number },
): GroupContext {
  return notImplemented(
    `buildGroupContext(${typeof deps.group}, ${groupId}, ${tripId ?? ''}, ${opts?.recentMessageLimit ?? 0})`,
  );
}

/** Attach extra group-safe data (e.g. search results) to the context; rejects private types at compile time. */
export function withExtra<T>(
  ctx: GroupContext,
  key: string,
  extra: T & GroupSafe<T>,
): GroupContext & { readonly extras: Readonly<Record<string, unknown>> } {
  return notImplemented(`withExtra(${ctx.group.groupId}, ${key}, ${typeof extra})`);
}

export interface RenderedPrompt {
  readonly systemPromptId: string;
  readonly system: string;
  /** Plain text; no `<untrusted` blocks here (member chat is not a document). */
  readonly context: string;
}

/**
 * Renders the group-lane system prompt + context block. A runtime test scans
 * the output of every fixture for `PRIVATE_PROMPT_MARKERS`.
 */
export function renderGroupPrompt(
  ctx: GroupContext,
  voice: { readonly systemPromptId: string; readonly persona: string },
): RenderedPrompt {
  return notImplemented(`renderGroupPrompt(${ctx.group.groupId}, ${voice.systemPromptId})`);
}

/** Strings that must never appear in a rendered group prompt (SAFETY C2). */
export const PRIVATE_PROMPT_MARKERS: readonly string[] = [
  'last4',
  'accountId',
  'merchantRaw',
  'bodyText',
  'ocrText',
  'subject:',
];

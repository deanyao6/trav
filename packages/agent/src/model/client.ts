/**
 * The ONE model client (docs/DECISIONS.md D-006; CLAUDE.md §3 spend guard;
 * SAFETY §2.4 D2). Every model call in the product goes through `ModelClient`.
 *
 * Live mode: `@anthropic-ai/sdk` with `TRAV_ANTHROPIC_API_KEY`; usage and
 * estimated cost are appended to `.trav/spend.json`; calls are refused with
 * `TravError('budget_exhausted')` once the estimate reaches `TRAV_LIVE_BUDGET_USD`.
 *
 * Offline mode (`TRAV_OFFLINE=1`, the default for tests): no network. A request
 * is reduced to a deterministic `scriptKey`; the client looks it up in the
 * scripts loaded from `fixtures/scripts/*.json`; on a miss it asks the
 * registered `FallbackResponder`s (rule-based mention detection, "looks shared"
 * heuristics, a regex booking-intent extractor); if none answers it returns a
 * fixed "not sure" text (`source: 'fallback'`) and appends the miss to
 * `.trav/offline-misses.jsonl` so a builder can author the script.
 *
 * Invariant (both modes): a request whose prompt contains an `<untrusted`
 * block AND has `tools.length > 0` throws `TravError('untrusted_with_tools')`.
 */
import { join } from 'node:path';
import type { Clock, IsoDateTime } from '@trav/core';
import { TravError } from '@trav/core';
import { createLiveModelClient, createSdkTransport } from './live.js';
import type { LiveTransport } from './live.js';
import { createOfflineModelClient } from './offline/client.js';
import { defaultFallbacks } from './offline/fallbacks.js';
import { receiptFixtureResponders } from './offline/receiptFixtures.js';
import { loadScriptStore } from './offline/scripts.js';
import { defaultScriptsDir, defaultStateDir } from './paths.js';
import { createFileSpendGuard, DEFAULT_LIVE_BUDGET_USD, DEFAULT_MODEL_PRICING } from './spend.js';

export {
  createFileSpendGuard,
  DEFAULT_LIVE_BUDGET_USD,
  DEFAULT_MODEL_PRICING,
  estimateCostUsd,
} from './spend.js';
export {
  createScriptStore,
  deriveScriptKey,
  lastUserText,
  loadScriptStore,
  normalizeScriptText,
  scriptFor,
  scriptKeyParts,
  validateScriptEntry,
} from './offline/scripts.js';
export type { ScriptKeyParts } from './offline/scripts.js';
export {
  bookingIntentResponder,
  createReceiptFixtureResponder,
  createRoastGuardResponder,
  defaultFallbacks,
  extractBookingIntent,
  looksSharedHeuristicResponder,
  mentionRuleResponder,
  toolResultAckResponder,
} from './offline/fallbacks.js';
export type { BookingIntent } from './offline/fallbacks.js';
export {
  createReceiptOcrResponder,
  loadReceiptFixtures,
  receiptFixtureResponders,
} from './offline/receiptFixtures.js';
export type { ReceiptFixtureEntry } from './offline/receiptFixtures.js';
export { OFFLINE_MISS_LABEL_PREFERENCE, OFFLINE_NOT_SURE_TEXT } from './offline/client.js';
export { createLiveModelClient, createSdkTransport } from './live.js';
export type { LiveTransport } from './live.js';
export {
  assertClassifyUntrustedRules,
  assertNoUntrustedWithTools,
  assertUntrustedRules,
  containsUntrustedTag,
  hasUntrustedBlock,
  messagesHaveUntrusted,
} from './invariants.js';
export { defaultScriptsDir, defaultStateDir, repoRoot } from './paths.js';

export type ModelRole = 'main' | 'fast' | 'grader';

export interface ModelEnv {
  /** True when TRAV_OFFLINE is set OR no key is present: the client is then offline. */
  readonly offline: boolean;
  /**
   * Non-enumerable when produced by `readModelEnv`, so `JSON.stringify(env)` /
   * `console.log(env)` never show it. Consequence: `{ ...env }` drops the key
   * (the copy is offline, the safe direction); derive a new env via `readModelEnv`.
   */
  readonly apiKey?: string;
  readonly models: Readonly<Record<ModelRole, string>>;
  readonly liveBudgetUsd: number;
  /** Directory for spend.json and offline-misses.jsonl; default `<repo>/.trav/`. */
  readonly stateDir: string;
}

export const DEFAULT_MODELS: Readonly<Record<ModelRole, string>> = {
  main: 'claude-sonnet-5-5',
  fast: 'claude-haiku-5-5',
  grader: 'claude-opus-5-5',
};

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t === undefined || t.length === 0 ? undefined : t;
}

/**
 * Reads TRAV_OFFLINE, TRAV_ANTHROPIC_API_KEY (never ANTHROPIC_API_KEY),
 * TRAV_MODEL, TRAV_FAST_MODEL, TRAV_GRADER_MODEL, TRAV_LIVE_BUDGET_USD and the
 * optional TRAV_STATE_DIR. Never logs values. An invalid budget falls back to 45.
 */
export function readModelEnv(env: Readonly<Record<string, string | undefined>>): ModelEnv {
  const apiKey = nonEmpty(env['TRAV_ANTHROPIC_API_KEY']);
  const flag = (nonEmpty(env['TRAV_OFFLINE']) ?? '').toLowerCase();
  const offlineFlag = flag === '1' || flag === 'true' || flag === 'yes';
  const budgetRaw = Number(nonEmpty(env['TRAV_LIVE_BUDGET_USD']) ?? Number.NaN);
  const result: ModelEnv = {
    offline: offlineFlag || apiKey === undefined,
    models: {
      main: nonEmpty(env['TRAV_MODEL']) ?? DEFAULT_MODELS.main,
      fast: nonEmpty(env['TRAV_FAST_MODEL']) ?? DEFAULT_MODELS.fast,
      grader: nonEmpty(env['TRAV_GRADER_MODEL']) ?? DEFAULT_MODELS.grader,
    },
    liveBudgetUsd:
      Number.isFinite(budgetRaw) && budgetRaw >= 0 ? budgetRaw : DEFAULT_LIVE_BUDGET_USD,
    stateDir: nonEmpty(env['TRAV_STATE_DIR']) ?? defaultStateDir(),
  };
  if (apiKey !== undefined) {
    Object.defineProperty(result, 'apiKey', { value: apiKey, enumerable: false, writable: false });
  }
  return result;
}

export type JsonSchema = Readonly<Record<string, unknown>>;

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
      readonly dataBase64: string;
    }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: 'tool_result'; readonly toolUseId: string; readonly content: string };

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly ContentBlock[];
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface CompletionRequest {
  readonly model: ModelRole;
  /** Stable id of the prompt template, e.g. 'group_chat_v1', 'receipt_extract_v1'. Part of the script key. */
  readonly systemPromptId: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  /** Must be empty when any message contains an `<untrusted` block. */
  readonly tools: readonly ToolSpec[];
  readonly maxTokens?: number;
  /** For zero-tool extraction calls: the client asks for JSON matching this schema and parses it. */
  readonly jsonSchema?: JsonSchema;
  /** Optional scenario tag so scripts can be grouped per fixture file. */
  readonly scenario?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ResponseSource = 'live' | 'script' | 'fallback';

export interface CompletionResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  /** Parsed JSON when `jsonSchema` was given. */
  readonly json?: unknown;
  readonly usage: TokenUsage;
  readonly source: ResponseSource;
  readonly scriptKey: string;
}

export interface ClassifyRequest<L extends string> {
  /** e.g. 'mention_v1', 'looks_shared_v1', 'roast_guard_v1'. Selects the offline fallback. */
  readonly classifierId: string;
  readonly labels: readonly L[];
  readonly systemPromptId: string;
  readonly system: string;
  /** Already wrapped with `wrapUntrusted` when it is document text. */
  readonly input: string;
  readonly scenario?: string;
}

export interface ClassifyResponse<L extends string> {
  readonly label: L;
  /** 0-1. */
  readonly score: number;
  readonly reason?: string;
  readonly usage: TokenUsage;
  readonly source: ResponseSource;
  readonly scriptKey: string;
}

export interface ModelClient {
  readonly mode: 'live' | 'offline';
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /** Always `tools: []` and the fast model. */
  classify<L extends string>(req: ClassifyRequest<L>): Promise<ClassifyResponse<L>>;
}

// ---------- spend guard ----------

export interface SpendRecord {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedUsd: number;
  readonly byModel: Readonly<
    Record<
      string,
      {
        readonly calls: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly estimatedUsd: number;
      }
    >
  >;
  readonly updatedAt: IsoDateTime;
}

/** USD per million tokens; unknown models use the 'default' row. */
export type ModelPricing = Readonly<
  Record<string, { readonly inputPerMTok: number; readonly outputPerMTok: number }>
>;

export interface SpendGuard {
  /** Persist usage; returns the running record. */
  record(modelId: string, usage: TokenUsage): SpendRecord;
  /** False once `estimatedUsd >= budgetUsd`. */
  canSpend(): boolean;
  current(): SpendRecord;
}

// ---------- offline scripts ----------

export interface ScriptedResponse {
  readonly key: string;
  readonly model: ModelRole;
  readonly systemPromptId: string;
  /** Human-readable copy of what was keyed, for authoring; not used for lookup. */
  readonly lastUserText: string;
  readonly toolNames: readonly string[];
  readonly response:
    | {
        readonly kind: 'completion';
        readonly text: string;
        readonly toolCalls?: readonly ToolCall[];
        readonly json?: unknown;
      }
    | {
        readonly kind: 'classify';
        readonly label: string;
        readonly score: number;
        readonly reason?: string;
      };
  readonly note?: string;
}

export interface ScriptStore {
  lookup(key: string): ScriptedResponse | undefined;
  size(): number;
}

/** Rule-based responders consulted in order on a script miss. Return undefined to pass. */
export interface FallbackResponder {
  readonly id: string;
  complete?(req: CompletionRequest): CompletionResponse | undefined;
  classify?<L extends string>(req: ClassifyRequest<L>): ClassifyResponse<L> | undefined;
}

export interface ModelClientOptions {
  readonly env: ModelEnv;
  readonly clock: Clock;
  /** Offline: defaults to `loadScriptStore(<repo>/fixtures/scripts)`. */
  readonly scripts?: ScriptStore;
  /** Offline: defaults to `defaultFallbacks()`. */
  readonly fallbacks?: readonly FallbackResponder[];
  /** Live: defaults to a file guard on `<stateDir>/spend.json` with `env.liveBudgetUsd`. */
  readonly spendGuard?: SpendGuard;
  readonly pricing?: ModelPricing;
  /** Live: the network seam. Tests MUST inject one; the real SDK transport is refused under vitest. */
  readonly transport?: LiveTransport;
}

/** Live when `!env.offline && env.apiKey`, otherwise offline. Tests must never construct a live client. */
export function createModelClient(opts: ModelClientOptions): ModelClient {
  const { env, clock } = opts;
  if (!env.offline && env.apiKey !== undefined && env.apiKey.length > 0) {
    let transport = opts.transport;
    if (transport === undefined) {
      if (process.env['VITEST'] !== undefined) {
        throw new TravError(
          'invariant_violation',
          'refusing to build a real network transport under vitest; inject `transport` or use offline mode',
        );
      }
      transport = createSdkTransport({ apiKey: env.apiKey });
    }
    const spendGuard =
      opts.spendGuard ??
      createFileSpendGuard({
        filePath: join(env.stateDir, 'spend.json'),
        budgetUsd: env.liveBudgetUsd,
        pricing: opts.pricing ?? DEFAULT_MODEL_PRICING,
        clock,
      });
    return createLiveModelClient({ env, spendGuard, transport });
  }
  return createOfflineModelClient({
    scripts: opts.scripts ?? loadScriptStore(defaultScriptsDir()),
    fallbacks: opts.fallbacks ?? [...defaultFallbacks(), ...receiptFixtureResponders()],
    missLogPath: join(env.stateDir, 'offline-misses.jsonl'),
    clock,
  });
}

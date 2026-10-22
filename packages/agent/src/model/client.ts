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
import type { Clock, IsoDateTime } from '@trav/core';
import { notImplemented } from '@trav/core';

export type ModelRole = 'main' | 'fast' | 'grader';

export interface ModelEnv {
  readonly offline: boolean;
  readonly apiKey?: string;
  readonly models: Readonly<Record<ModelRole, string>>;
  readonly liveBudgetUsd: number;
  /** Directory for spend.json and offline-misses.jsonl; default `.trav/`. */
  readonly stateDir: string;
}

/** Reads TRAV_OFFLINE, TRAV_ANTHROPIC_API_KEY, TRAV_MODEL, TRAV_FAST_MODEL, TRAV_GRADER_MODEL, TRAV_LIVE_BUDGET_USD. Never logs values. */
export function readModelEnv(env: Readonly<Record<string, string | undefined>>): ModelEnv {
  return notImplemented(`readModelEnv(${Object.keys(env).length})`);
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

export function createFileSpendGuard(opts: {
  readonly filePath: string;
  readonly budgetUsd: number;
  readonly pricing: ModelPricing;
  readonly clock: Clock;
}): SpendGuard {
  return notImplemented(`createFileSpendGuard(${opts.filePath})`);
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

/** Loads every `*.json` under `fixtures/scripts/` (each an array of ScriptedResponse). */
export function loadScriptStore(dir: string): ScriptStore {
  return notImplemented(`loadScriptStore(${dir})`);
}

/**
 * sha256 of `model \n systemPromptId \n normalize(lastUserText) \n sortedToolNames.join(',')`
 * where normalize = lowercase, trim, collapse whitespace, strip `<untrusted ... id="...">` ids.
 * Images contribute their sha256 instead of text. Classify requests use
 * `classifierId` as the systemPromptId and `input` as the text.
 */
export function deriveScriptKey(req: CompletionRequest | ClassifyRequest<string>): string {
  return notImplemented(`deriveScriptKey(${req.systemPromptId})`);
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
  readonly scripts?: ScriptStore;
  readonly fallbacks?: readonly FallbackResponder[];
  readonly spendGuard?: SpendGuard;
  readonly pricing?: ModelPricing;
}

/** Live when `!env.offline && env.apiKey`, otherwise offline. Tests must never construct a live client. */
export function createModelClient(opts: ModelClientOptions): ModelClient {
  return notImplemented(`createModelClient(${opts.env.offline})`);
}

/** True if any message text contains `<untrusted` (used by the D2 invariant). */
export function hasUntrustedBlock(req: CompletionRequest): boolean {
  return notImplemented(`hasUntrustedBlock(${req.systemPromptId})`);
}

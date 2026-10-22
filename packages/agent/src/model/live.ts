/**
 * Live model client: `@anthropic-ai/sdk` with `TRAV_ANTHROPIC_API_KEY` only
 * (the SDK's own `ANTHROPIC_API_KEY` lookup is bypassed by always passing the
 * key explicitly). Every call: D2 invariant → spend guard `canSpend()` →
 * transport → spend guard `record()` → map. The key is never logged, never put
 * in an error message, and never written to `.trav/`.
 *
 * Tests never reach the network: they inject a `LiveTransport` (or an SDK
 * instance with a fake `fetch` via `createSdkTransport`).
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { TravError } from '@trav/core';
import type {
  ClassifyRequest,
  ClassifyResponse,
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  ModelClient,
  ModelEnv,
  ModelMessage,
  SpendGuard,
  TokenUsage,
  ToolCall,
} from './client.js';
import { assertClassifyUntrustedRules, assertUntrustedRules } from './invariants.js';
import { deriveScriptKey } from './offline/scripts.js';

/** The one seam between Trav and the network. */
export interface LiveTransport {
  createMessage(params: MessageCreateParamsNonStreaming): Promise<Message>;
}

/** Real SDK transport. `fetch` is injectable so tests can exercise the SDK without a socket. */
export function createSdkTransport(opts: {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
}): LiveTransport {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: opts.maxRetries ?? 2,
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });
  return {
    createMessage: (params) => client.messages.create(params),
  };
}

export const DEFAULT_MAX_TOKENS = 1024;
export const CLASSIFY_MAX_TOKENS = 256;

function toSdkBlock(block: ContentBlock): ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
      };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: block.toolUseId, content: block.content };
  }
}

function toSdkMessage(m: ModelMessage): MessageParam {
  return {
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map(toSdkBlock),
  };
}

function usageOf(msg: Message): TokenUsage {
  const u = msg.usage;
  return {
    inputTokens:
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  };
}

/** Error text with the key scrubbed and no response body; status + class name only. */
function sanitizeError(e: unknown, apiKey: string): TravError {
  const status =
    typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number'
      ? ` (status ${e.status})`
      : '';
  const name = e instanceof Error ? e.name : 'error';
  const msg = `live model call failed: ${name}${status}`;
  return new TravError(
    'invariant_violation',
    apiKey.length > 0 ? msg.split(apiKey).join('[redacted]') : msg,
  );
}

export interface LiveModelClientOptions {
  readonly env: ModelEnv;
  readonly spendGuard: SpendGuard;
  readonly transport: LiveTransport;
}

export function createLiveModelClient(opts: LiveModelClientOptions): ModelClient {
  const { env, spendGuard, transport } = opts;
  const apiKey = env.apiKey ?? '';

  const call = async (
    params: MessageCreateParamsNonStreaming,
  ): Promise<{ msg: Message; usage: TokenUsage }> => {
    if (!spendGuard.canSpend()) {
      throw new TravError(
        'budget_exhausted',
        'live model budget (TRAV_LIVE_BUDGET_USD) reached; switch to TRAV_OFFLINE=1 or raise the budget',
      );
    }
    let msg: Message;
    try {
      msg = await transport.createMessage(params);
    } catch (e) {
      throw sanitizeError(e, apiKey);
    }
    const usage = usageOf(msg);
    spendGuard.record(params.model, usage);
    return { msg, usage };
  };

  return {
    mode: 'live',

    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      assertUntrustedRules(req);
      const params: MessageCreateParamsNonStreaming = {
        model: env.models[req.model],
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: req.system,
        messages: req.messages.map(toSdkMessage),
        ...(req.tools.length === 0
          ? {}
          : {
              tools: req.tools.map((t): Tool => ({
                name: t.name,
                description: t.description,
                input_schema: { type: 'object', ...t.inputSchema } as Tool['input_schema'],
              })),
            }),
        ...(req.jsonSchema === undefined
          ? {}
          : { output_config: { format: { type: 'json_schema', schema: { ...req.jsonSchema } } } }),
      };
      const { msg, usage } = await call(params);
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const toolCalls: ToolCall[] = msg.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : [],
      );
      const offered = new Set(req.tools.map((t) => t.name));
      const unknown = toolCalls.find((c) => !offered.has(c.name));
      if (unknown !== undefined) {
        throw new TravError(
          'invariant_violation',
          `model called tool "${unknown.name}" which was not offered`,
        );
      }
      let json: unknown;
      if (req.jsonSchema !== undefined) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new TravError(
            'invariant_violation',
            `model returned non-JSON for ${req.systemPromptId}`,
          );
        }
      }
      return {
        text,
        toolCalls,
        ...(json === undefined ? {} : { json }),
        usage,
        source: 'live',
        scriptKey: deriveScriptKey(req),
      };
    },

    async classify<L extends string>(req: ClassifyRequest<L>): Promise<ClassifyResponse<L>> {
      if (req.labels.length === 0)
        throw new TravError('invalid_argument', `classify ${req.classifierId} needs labels`);
      assertClassifyUntrustedRules(req);
      const params: MessageCreateParamsNonStreaming = {
        model: env.models.fast,
        max_tokens: CLASSIFY_MAX_TOKENS,
        system: req.system,
        messages: [{ role: 'user', content: req.input }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                label: { type: 'string', enum: [...req.labels] },
                score: { type: 'number' },
                reason: { type: 'string' },
              },
              required: ['label', 'score'],
              additionalProperties: false,
            },
          },
        },
      };
      const { msg, usage } = await call(params);
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new TravError(
          'invariant_violation',
          `classifier ${req.classifierId} returned non-JSON`,
        );
      }
      const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
        string,
        unknown
      >;
      const label = req.labels.find((l) => l === o['label']);
      if (label === undefined) {
        throw new TravError(
          'invariant_violation',
          `classifier ${req.classifierId} returned an unknown label`,
        );
      }
      const rawScore =
        typeof o['score'] === 'number' && Number.isFinite(o['score']) ? o['score'] : 0;
      return {
        label,
        score: Math.min(1, Math.max(0, rawScore)),
        ...(typeof o['reason'] === 'string' ? { reason: o['reason'] } : {}),
        usage,
        source: 'live',
        scriptKey: deriveScriptKey(req),
      };
    },
  };
}

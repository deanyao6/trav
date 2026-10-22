/**
 * Offline model client (`TRAV_OFFLINE=1`, D-006). No network. Order:
 * script lookup by `deriveScriptKey` → rule-based fallbacks → a fixed
 * "not sure" answer plus a line in `.trav/offline-misses.jsonl`.
 * Every response reports its `source`.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Clock } from '@trav/core';
import { TravError } from '@trav/core';
import type {
  ClassifyRequest,
  ClassifyResponse,
  CompletionRequest,
  CompletionResponse,
  FallbackResponder,
  ModelClient,
  ScriptStore,
  ToolCall,
} from '../client.js';
import { assertClassifyUntrustedRules, assertUntrustedRules } from '../invariants.js';
import { deriveScriptKey, lastUserText, scriptKeyParts } from './scripts.js';

/** ARCHITECTURE §4: the fixed reply on a full miss. */
export const OFFLINE_NOT_SURE_TEXT =
  "i'm not sure what you mean, say it again with the thing you want booked or logged";

/**
 * On a classify miss the client picks the first of these labels that the
 * request offers (abstain, silence, privacy and safety first). If none is
 * offered it returns the LAST label, never the first: classifier authors list
 * the conservative/default outcome last when it has no recognizable name.
 * The score is always 0 so callers can tell it is not a real answer.
 */
export const OFFLINE_MISS_LABEL_PREFERENCE: readonly string[] = [
  'unsure',
  'unknown',
  'abstain',
  'ask',
  'hold',
  'deny',
  'reject',
  'not_mention',
  'no_mention',
  'not_addressed',
  'none',
  'no',
  'false',
  'personal',
  'blocked',
  'other',
];

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const;
const MISS_TEXT_MAX = 500;

/** Document text never goes to the miss log (SAFETY §2.9 logging rules): keep the tag, drop the body. */
export function redactForLog(text: string): string {
  const redacted = text.replace(
    /(<untrusted\b[^>]*>)([\s\S]*?)(<\/untrusted>|$)/gi,
    (_m, open: string, body: string, close: string) =>
      `${open}[${body.length} chars omitted]${close}`,
  );
  return redacted.length > MISS_TEXT_MAX ? `${redacted.slice(0, MISS_TEXT_MAX)}…` : redacted;
}

function assertToolsOffered(
  calls: readonly ToolCall[],
  req: CompletionRequest,
  origin: string,
): void {
  const offered = new Set(req.tools.map((t) => t.name));
  for (const c of calls) {
    if (!offered.has(c.name)) {
      throw new TravError(
        'invariant_violation',
        `${origin} for ${req.systemPromptId} calls tool "${c.name}" which the request did not offer`,
      );
    }
  }
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface OfflineModelClientOptions {
  readonly scripts: ScriptStore;
  readonly fallbacks: readonly FallbackResponder[];
  /** `.trav/offline-misses.jsonl`. */
  readonly missLogPath: string;
  readonly clock: Clock;
}

export function createOfflineModelClient(opts: OfflineModelClientOptions): ModelClient {
  const { scripts, fallbacks, missLogPath, clock } = opts;

  const logMiss = (
    kind: 'complete' | 'classify',
    req: CompletionRequest | ClassifyRequest<string>,
    key: string,
  ): void => {
    const p = scriptKeyParts(req);
    const line = {
      at: clock.now(),
      kind,
      key,
      model: p.model,
      systemPromptId: p.systemPromptId,
      lastUserText: redactForLog(lastUserText(req)),
      toolNames: p.toolNames,
      ...(req.scenario === undefined ? {} : { scenario: req.scenario }),
    };
    mkdirSync(dirname(missLogPath), { recursive: true });
    appendFileSync(missLogPath, `${JSON.stringify(line)}\n`, 'utf8');
  };

  return {
    mode: 'offline',

    complete(req: CompletionRequest): Promise<CompletionResponse> {
      return Promise.resolve().then(() => {
        assertUntrustedRules(req);
        const key = deriveScriptKey(req);
        const scripted = scripts.lookup(key);
        if (scripted !== undefined) {
          if (scripted.response.kind !== 'completion') {
            throw new TravError(
              'invariant_violation',
              `script ${key.slice(0, 12)} is a classify script used for complete()`,
            );
          }
          const toolCalls = scripted.response.toolCalls ?? [];
          assertToolsOffered(toolCalls, req, 'offline script');
          const json =
            'json' in scripted.response
              ? scripted.response.json
              : req.jsonSchema !== undefined
                ? parseJsonText(scripted.response.text)
                : undefined;
          return {
            text: scripted.response.text,
            toolCalls,
            ...(json === undefined ? {} : { json }),
            usage: ZERO_USAGE,
            source: 'script',
            scriptKey: key,
          };
        }
        for (const f of fallbacks) {
          const r = f.complete?.(req);
          if (r !== undefined) {
            assertToolsOffered(r.toolCalls, req, `fallback ${f.id}`);
            return { ...r, usage: ZERO_USAGE, source: 'fallback', scriptKey: key };
          }
        }
        logMiss('complete', req, key);
        return {
          text: OFFLINE_NOT_SURE_TEXT,
          toolCalls: [],
          usage: ZERO_USAGE,
          source: 'fallback',
          scriptKey: key,
        };
      });
    },

    classify<L extends string>(req: ClassifyRequest<L>): Promise<ClassifyResponse<L>> {
      return Promise.resolve().then(() => {
        if (req.labels.length === 0)
          throw new TravError('invalid_argument', `classify ${req.classifierId} needs labels`);
        assertClassifyUntrustedRules(req);
        const key = deriveScriptKey(req);
        const scripted = scripts.lookup(key);
        if (scripted !== undefined) {
          if (scripted.response.kind !== 'classify') {
            throw new TravError(
              'invariant_violation',
              `script ${key.slice(0, 12)} is a completion script used for classify()`,
            );
          }
          const scriptedLabel = scripted.response.label;
          const label = req.labels.find((l) => l === scriptedLabel);
          if (label === undefined) {
            throw new TravError(
              'invariant_violation',
              `script label "${scriptedLabel}" is not one of ${req.classifierId}'s labels`,
            );
          }
          return {
            label,
            score: scripted.response.score,
            ...(scripted.response.reason === undefined ? {} : { reason: scripted.response.reason }),
            usage: ZERO_USAGE,
            source: 'script',
            scriptKey: key,
          };
        }
        for (const f of fallbacks) {
          const r = f.classify?.(req);
          if (r !== undefined) {
            if (!req.labels.includes(r.label)) {
              throw new TravError(
                'invariant_violation',
                `fallback ${f.id} returned an unknown label`,
              );
            }
            return { ...r, usage: ZERO_USAGE, source: 'fallback', scriptKey: key };
          }
        }
        logMiss('classify', req, key);
        const silent =
          OFFLINE_MISS_LABEL_PREFERENCE.map((c) =>
            req.labels.find((l) => l.toLowerCase() === c),
          ).find((l) => l !== undefined) ?? req.labels[req.labels.length - 1];
        return {
          label: silent as L,
          score: 0,
          reason: 'offline: no script or rule for this input',
          usage: ZERO_USAGE,
          source: 'fallback',
          scriptKey: key,
        };
      });
    },
  };
}

/**
 * Rule-based offline responders (D-006, ARCHITECTURE §4), consulted in order on
 * a script miss. Each returns `undefined` to pass. They are deliberately
 * simple and biased to silence: they exist so unscripted scenarios still do
 * something sensible without an API key, not to be clever.
 *
 * Responders never emit a tool call for a tool the request did not offer.
 */
import type {
  ClassifyRequest,
  ClassifyResponse,
  CompletionRequest,
  CompletionResponse,
  FallbackResponder,
  ModelMessage,
} from '../client.js';
import { deriveScriptKey, lastUserText } from './scripts.js';
import { travAskResponders } from './asks.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

function classifyResult<L extends string>(
  req: ClassifyRequest<L>,
  label: L,
  score: number,
  reason: string,
): ClassifyResponse<L> {
  return {
    label,
    score,
    reason,
    usage: ZERO_USAGE,
    source: 'fallback',
    scriptKey: deriveScriptKey(req),
  };
}

function completionResult(
  req: CompletionRequest,
  text: string,
  toolCalls: CompletionResponse['toolCalls'],
): CompletionResponse {
  return {
    text,
    toolCalls,
    usage: ZERO_USAGE,
    source: 'fallback',
    scriptKey: deriveScriptKey(req),
  };
}

/** First label (case-insensitive) that appears in `candidates`, in candidate order. */
function pickLabel<L extends string>(
  labels: readonly L[],
  candidates: readonly string[],
): L | undefined {
  for (const c of candidates) {
    const hit = labels.find((l) => l.toLowerCase() === c);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Text inside an `<untrusted>` wrapper, or the input itself. */
function unwrap(input: string): string {
  const m = /<untrusted\b[^>]*>\n?([\s\S]*?)\n?<\/untrusted>/i.exec(input);
  return m?.[1] ?? input;
}

// ---------- mention_v1 ----------

const MENTION_POSITIVE = ['mention', 'mentioned', 'addressed', 'yes', 'true'];
const MENTION_NEGATIVE = [
  'not_mention',
  'no_mention',
  'not_addressed',
  'none',
  'no',
  'false',
  'ignore',
];

/** After "hey trav", these make Trav the subject of a statement, not the one being asked (mirrors `mention.ts`). */
const MENTION_STATEMENT_AFTER_NAME =
  /^\s*(?:'s|is|isn't|was|wasn't|has|hasn't|had|hadn't|did|didn't|does|doesn't|will|won't|would|wouldn't|can't|cant|couldn't|booked|said|says|told|got|went|made|thinks|knows|needs|fans|lol|lmao|haha|literally|already|really|kinda|sorta|probably|def|definitely)\b(?!\s+(?:you|u|we)\b)/i;

/**
 * Addressed to Trav only at the start ("@trav ...", "hey trav, ...", "trav, ...",
 * "yo trav can you ..."). A greeting followed by a statement about Trav ("yo
 * trav is so slow lol", "ok trav booked it already", "hi trav fans") is not a
 * mention. Anything else is silence.
 */
export const mentionRuleResponder: FallbackResponder = {
  id: 'mention_v1',
  classify<L extends string>(req: ClassifyRequest<L>): ClassifyResponse<L> | undefined {
    if (req.classifierId !== 'mention_v1') return undefined;
    const pos = pickLabel(req.labels, MENTION_POSITIVE);
    const neg = pickLabel(req.labels, MENTION_NEGATIVE);
    if (pos === undefined || neg === undefined) return undefined;
    const text = unwrap(req.input).trim();
    if (/^(?:@trav\b|trav[,:])/i.test(text)) {
      return classifyResult(req, pos, 0.9, 'addressed to trav at the start');
    }
    const greeting = /^(?:hey+|hi+|yo+|ok|okay|hello),?\s*trav\b/i.exec(text);
    if (greeting !== null) {
      const rest = text.slice(greeting[0].length);
      if (MENTION_STATEMENT_AFTER_NAME.test(rest) && !/\?\s*$/.test(rest)) {
        return classifyResult(req, neg, 0.75, 'greeting + trav + statement; biased to silence');
      }
      return classifyResult(req, pos, 0.9, 'greeting + trav, addressed');
    }
    return classifyResult(req, neg, 0.7, 'not addressed to trav; biased to silence');
  },
};

// ---------- looks_shared_v1 ----------

const SHARED_HINTS =
  /\b(restaurant|dinner|lunch|brunch|tapas|bar|club|pub|cafe|uber|lyft|taxi|cab|bolt|cabify|ticket|tickets|airbnb|hotel|apartment|villa|grocer(?:y|ies)|supermarket|mercado|boat|tour|museum|ferry|rental|car hire|parking|gas|fuel|groceries)\b/i;
const PERSONAL_HINTS =
  /\b(pharmacy|farmacia|netflix|spotify|subscription|apple\.com|icloud|gym|clothing|apparel|duty free|atm|cash withdrawal|foreign transaction fee|phone bill|insurance|souvenir)\b/i;

/** Merchant/category keyword heuristic. Labels: shared | personal | unsure (any subset with these names). */
export const looksSharedHeuristicResponder: FallbackResponder = {
  id: 'looks_shared_v1',
  classify<L extends string>(req: ClassifyRequest<L>): ClassifyResponse<L> | undefined {
    if (req.classifierId !== 'looks_shared_v1') return undefined;
    const shared = pickLabel(req.labels, ['shared']);
    const personal = pickLabel(req.labels, ['personal']);
    const unsure = pickLabel(req.labels, ['unsure', 'unknown']);
    if (shared === undefined || personal === undefined) return undefined;
    const text = unwrap(req.input);
    if (PERSONAL_HINTS.test(text))
      return classifyResult(req, personal, 0.7, 'merchant looks personal');
    if (SHARED_HINTS.test(text))
      return classifyResult(req, shared, 0.7, 'merchant looks like a group spend');
    return classifyResult(req, unsure ?? personal, 0.4, 'no signal either way');
  },
};

// ---------- roast_guard_v1 ----------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Minimal built-in blocklist (SAFETY §2.8 blocked categories). The deterministic
 * `fixtures/roast/blocklist.json` check in core/safety runs regardless; this is
 * only the offline stand-in for the classifier call.
 */
export const DEFAULT_ROAST_BLOCK_TERMS: readonly string[] = [
  'fat',
  'weight',
  'ugly',
  'body',
  'outfit',
  'hair',
  'date',
  'dating',
  'hookup',
  'hook up',
  'tinder',
  'crush',
  'ex',
  'kiss',
  'sex',
  'sick',
  'ill',
  'illness',
  'hospital',
  'injury',
  'injured',
  'therapy',
  'depressed',
  'anxiety',
  'drunk',
  'wasted',
  'hungover',
  'high',
  'stoned',
  'broke',
  'poor',
  'debt',
  "can't afford",
  'arrested',
  'police',
  'jail',
  'bartender',
  'waiter',
  'driver',
  'host',
  'stranger',
  'religion',
  'race',
  'gay',
  'straight',
  'old',
  'age',
];

export function createRoastGuardResponder(
  terms: readonly string[] = DEFAULT_ROAST_BLOCK_TERMS,
): FallbackResponder {
  const patterns = terms
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
    .map((term) => ({
      term,
      re: new RegExp(`(?:^|[^a-z])${escapeRegExp(term)}(?:$|[^a-z])`, 'i'),
    }));
  return {
    id: 'roast_guard_v1',
    classify<L extends string>(req: ClassifyRequest<L>): ClassifyResponse<L> | undefined {
      if (req.classifierId !== 'roast_guard_v1') return undefined;
      const blocked = pickLabel(req.labels, ['blocked', 'block', 'unsafe', 'no']);
      const allowed = pickLabel(req.labels, ['allowed', 'allow', 'safe', 'yes']);
      if (blocked === undefined || allowed === undefined) return undefined;
      const text = unwrap(req.input);
      const hit = patterns.find((p) => p.re.test(text));
      if (hit !== undefined) return classifyResult(req, blocked, 0.9, `blocked term: ${hit.term}`);
      // Fail safe: an offline guard only allows when it found nothing; score stays modest.
      return classifyResult(req, allowed, 0.6, 'no blocked term found');
    },
  };
}

// ---------- booking_intent_v1 ----------

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseCount(s: string): number | undefined {
  const n = /^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s.toLowerCase()];
  return n !== undefined && n > 0 && n <= 50 ? n : undefined;
}

export interface BookingIntent {
  readonly kind: 'ticket';
  readonly query: string;
  readonly quantity: number;
  /** Display names the requester said are out ("Henry's sick", "everyone but Henry"). */
  readonly excludedNames: readonly string[];
  readonly requestText: string;
}

/** "@trav get the 5 of us Razzmatazz tickets, Henry's sick" → { query: 'razzmatazz', quantity: 5, excludedNames: ['Henry'] }. */
export function extractBookingIntent(text: string): BookingIntent | undefined {
  const m =
    /\b(?:get|book|grab|buy)\s+(?:the\s+|all\s+)?(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+of\s+us\s+(.+?)\s+tickets?\b/i.exec(
      text,
    );
  if (!m?.[1] || !m[2]) return undefined;
  const quantity = parseCount(m[1]);
  if (quantity === undefined) return undefined;
  const excluded = new Set<string>();
  for (const re of [
    /\b([A-Z][a-z]+)(?:'s| is)\s+(?:sick|out|not coming|staying in|ill)\b/g,
    /\b(?:but|except|without|minus|not)\s+([A-Z][a-z]+)\b/g,
  ]) {
    for (const x of text.matchAll(re)) if (x[1]) excluded.add(x[1]);
  }
  return {
    kind: 'ticket',
    query: m[2].trim().toLowerCase(),
    quantity,
    excludedNames: [...excluded],
    requestText: text.trim(),
  };
}

function lastUserMessage(req: CompletionRequest): ModelMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const msg = req.messages[i];
    if (msg?.role === 'user') return msg;
  }
  return undefined;
}

function isToolResultTurn(msg: ModelMessage | undefined): boolean {
  return (
    msg !== undefined &&
    typeof msg.content !== 'string' &&
    msg.content.length > 0 &&
    msg.content.every((b) => b.type === 'tool_result')
  );
}

/**
 * Regex extractor for "get the N of us X tickets". Emits one `propose_booking`
 * call when that tool is offered. The input shape (`BookingIntent`) is
 * provisional; `tools/propose_booking.ts` (T-007-b) must accept it or update
 * this responder. Scripted responses take precedence (the Razzmatazz demo is
 * scripted, `source: 'script'`).
 */
export const bookingIntentResponder: FallbackResponder = {
  id: 'booking_intent_v1',
  complete(req: CompletionRequest): CompletionResponse | undefined {
    if (!req.tools.some((t) => t.name === 'propose_booking')) return undefined;
    const last = lastUserMessage(req);
    if (last === undefined || isToolResultTurn(last)) return undefined;
    const intent = extractBookingIntent(lastUserText(req));
    if (intent === undefined) return undefined;
    return completionResult(req, '', [
      {
        id: `toolu_offline_${deriveScriptKey(req).slice(0, 16)}`,
        name: 'propose_booking',
        input: intent,
      },
    ]);
  },
};

/**
 * After a tool round, the offline model has nothing to add: it ends the loop
 * with empty text and no tool calls, and the agent renders cards from the
 * tool results. Prevents the tool loop from re-triggering on its own output.
 */
export const toolResultAckResponder: FallbackResponder = {
  id: 'tool_result_ack_v1',
  complete(req: CompletionRequest): CompletionResponse | undefined {
    if (req.tools.length === 0) return undefined;
    return isToolResultTurn(lastUserMessage(req)) ? completionResult(req, '', []) : undefined;
  },
};

// ---------- receipt_extract_v1 ----------

/**
 * Fixture lookup by image hash for the zero-tool receipt extraction call
 * (T-011 supplies the lookup). Only answers requests with a `jsonSchema` and
 * an image in the last user message.
 */
export function createReceiptFixtureResponder(
  lookup: (imageSha256: string) => unknown,
): FallbackResponder {
  return {
    id: 'receipt_extract_v1',
    complete(req: CompletionRequest): CompletionResponse | undefined {
      if (req.systemPromptId !== 'receipt_extract_v1' || req.jsonSchema === undefined)
        return undefined;
      const hash = /\[image sha256:([0-9a-f]{64})\]/.exec(lastUserText(req))?.[1];
      if (hash === undefined) return undefined;
      const json = lookup(hash);
      if (json === undefined) return undefined;
      return { ...completionResult(req, JSON.stringify(json), []), json };
    },
  };
}

/** The default responder chain, in order. */
export function defaultFallbacks(): readonly FallbackResponder[] {
  return [
    mentionRuleResponder,
    looksSharedHeuristicResponder,
    createRoastGuardResponder(),
    // T-081/T-092: ticket asks, "cheaper", cancel, stays, remember, honest can't-do lines.
    ...travAskResponders(),
    toolResultAckResponder,
    // T-182: `bookingIntentResponder` (the loose T-007 regex) is no longer in
    // the chain. It read "…, Henry's sick. actually i don't think so" as an
    // ask after the precise reader (`booking_request_v1`) had said no; the
    // reader alone decides what is an ask offline.
  ];
}

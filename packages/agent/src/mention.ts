/**
 * Mention detection (VOICE §2). Deterministic rules first; the fast classifier
 * only for ambiguous cases; when still unsure, silence.
 *
 * Rules, in order:
 *  - DM lane, a quote-reply to Trav, or a platform mention flag ⇒ addressed.
 *  - "thanks trav" (start or end of the message) ⇒ addressed with reason
 *    `thanks`; the loop answers with a ❤️ tapback, never text.
 *  - `@trav` as a whole token anywhere ⇒ addressed (`@travis`, `x@trav-y` do not count).
 *  - "trav," / "hey trav" / "trav can you" at the start ⇒ addressed.
 *  - "trav" mid-sentence in the third person ("trav booked it already", "ask trav") ⇒ not addressed.
 *  - a short message inside the 2-minute window after a Trav question ⇒ addressed (`reply_window`).
 *  - a message that starts with "trav" but fits none of the above ("trav booked
 *    the flights already right?") is `ambiguous` and goes to `classify('mention_v1')`.
 */
import type { IsoDateTime } from '@trav/core';
import { parseIso } from '@trav/core';
import type { ModelClient } from './model/client.js';
import { MENTION_CLASSIFIER_PROMPT } from './prompts/index.js';
import { stripInvisible } from './untrusted.js';

export interface MentionContext {
  readonly lane: 'group' | 'dm';
  /** The message quote-replies one of Trav's messages. */
  readonly repliesToTrav: boolean;
  /** Platform-level mention flag, if the channel provides one. */
  readonly platformMention: boolean;
  /** When Trav last asked a question in this lane (2-minute reply window). */
  readonly lastTravQuestionAt?: IsoDateTime;
  readonly now: IsoDateTime;
}

export type MentionReason =
  | 'at_mention'
  | 'leading_name'
  | 'reply_to_trav'
  | 'dm_lane'
  | 'reply_window'
  | 'classifier'
  | 'third_person'
  | 'thanks'
  | 'none';

export interface MentionResult {
  readonly addressed: boolean;
  readonly confidence: number;
  readonly reason: MentionReason;
}

/** VOICE §2: a reply within this window of a Trav question counts as addressed. */
export const REPLY_WINDOW_MS = 2 * 60 * 1000;
/** Longest message (in words) that still "plausibly answers" a question inside the window. */
export const REPLY_WINDOW_MAX_WORDS = 12;
/** Classifier scores below this are treated as "unsure" ⇒ silence. */
export const CLASSIFIER_MIN_SCORE = 0.6;

const AT_TRAV = /(^|[^\w@])@trav(?![\w-])/i;
const LEADING_PUNCT = String.raw`^[\s"'(\[]*`;
const GREETING = String.raw`(?:he+y+|hi+|yo+|ok(?:ay)?|hello|oi|psst)`;
const LEADING_GREETING_TRAV = new RegExp(`${LEADING_PUNCT}${GREETING}\\s*[,!]*\\s*trav\\b`, 'i');
const LEADING_TRAV_PUNCT = new RegExp(`${LEADING_PUNCT}trav\\s*[,:!;]`, 'i');
/** "trav can you", "trav pls", "trav log it": a second-person or imperative verb right after the name. */
const LEADING_TRAV_IMPERATIVE = new RegExp(
  `${LEADING_PUNCT}trav\\s+(?:can|could|would|pls|plz|please|what|who|how|when|where|which|why|log|add|book|get|grab|split|settle|put|show|find|remember|forget|leave|roast|stop|cancel|drop|do|make|send|tell|give|check|help|u|you|we)\\b`,
  'i',
);
const LEADING_TRAV = new RegExp(`${LEADING_PUNCT}trav\\b`, 'i');
const THANKS = String.raw`(?:thanks|thank you|thx|thanx|ty|cheers|merci|gracias|danke)`;
/** Trailing noise after "thanks trav": punctuation, spaces, any emoji (with or without a variation selector). */
const TRAILING_THANKS_NOISE = String.raw`(?:[\s!.,]|\p{Extended_Pictographic}|️)*`;
const THANKS_TRAV = new RegExp(
  `(?:${LEADING_PUNCT}${THANKS}\\s*[,!]*\\s*trav\\b)|(?:\\b${THANKS}\\s*[,!]*\\s*trav${TRAILING_THANKS_NOISE}$)`,
  'iu',
);
const TRAV_WORD = /\btrav\b/i;

function normalize(text: string): string {
  return stripInvisible(text).replace(/\s+/g, ' ').trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function hit(reason: MentionReason, confidence: number): MentionResult {
  return { addressed: true, confidence, reason };
}

function miss(reason: MentionReason, confidence: number): MentionResult {
  return { addressed: false, confidence, reason };
}

/** True inside the 2-minute window after Trav's last question in this lane. */
export function inReplyWindow(ctx: MentionContext): boolean {
  if (ctx.lastTravQuestionAt === undefined) return false;
  const delta = parseIso(ctx.now) - parseIso(ctx.lastTravQuestionAt);
  return delta >= 0 && delta <= REPLY_WINDOW_MS;
}

/** Pure rules: `@trav` anywhere; "trav," / "hey trav" / "trav can you" at the start; third-person mid-sentence is not a mention. */
export function detectMentionRules(text: string, ctx: MentionContext): MentionResult | 'ambiguous' {
  const t = normalize(text);
  if (ctx.lane === 'dm') return hit('dm_lane', 1);
  if (ctx.repliesToTrav) return hit('reply_to_trav', 0.95);
  if (ctx.platformMention) return hit('at_mention', 1);
  if (t.length === 0) return miss('none', 1);

  if (THANKS_TRAV.test(t)) return hit('thanks', 0.95);
  if (AT_TRAV.test(t)) return hit('at_mention', 1);
  if (LEADING_GREETING_TRAV.test(t) || LEADING_TRAV_PUNCT.test(t)) return hit('leading_name', 0.95);
  if (LEADING_TRAV_IMPERATIVE.test(t)) return hit('leading_name', 0.9);

  if (LEADING_TRAV.test(t)) {
    // Starts with "trav" but reads like a statement ("trav booked it already"):
    // the rules cannot tell, the classifier decides, silence if it is unsure.
    return 'ambiguous';
  }
  if (TRAV_WORD.test(t)) return miss('third_person', 0.85);

  if (inReplyWindow(ctx) && wordCount(t) <= REPLY_WINDOW_MAX_WORDS) {
    return hit('reply_window', 0.75);
  }
  return miss('none', 1);
}

/** Rules, then `model.classify({ classifierId: 'mention_v1' })` for ambiguous cases; unsure ⇒ `addressed: false`. */
export async function detectMention(
  text: string,
  ctx: MentionContext,
  model: ModelClient,
): Promise<MentionResult> {
  const ruled = detectMentionRules(text, ctx);
  if (ruled !== 'ambiguous') return ruled;
  const res = await model.classify({
    classifierId: MENTION_CLASSIFIER_PROMPT.classifierId,
    labels: MENTION_CLASSIFIER_PROMPT.labels,
    systemPromptId: MENTION_CLASSIFIER_PROMPT.systemPromptId,
    system: MENTION_CLASSIFIER_PROMPT.system,
    input: normalize(text),
  });
  const addressed = res.label === 'mention' && res.score >= CLASSIFIER_MIN_SCORE;
  return { addressed, confidence: res.score, reason: addressed ? 'classifier' : 'third_person' };
}

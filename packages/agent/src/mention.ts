/**
 * Mention detection (VOICE §2). Deterministic rules first; the fast classifier
 * only for ambiguous cases; when still unsure, silence.
 */
import type { IsoDateTime } from '@trav/core';
import { notImplemented } from '@trav/core';
import type { ModelClient } from './model/client.js';

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

export interface MentionResult {
  readonly addressed: boolean;
  readonly confidence: number;
  readonly reason:
    | 'at_mention'
    | 'leading_name'
    | 'reply_to_trav'
    | 'dm_lane'
    | 'reply_window'
    | 'classifier'
    | 'third_person'
    | 'none';
}

/** Pure rules: `@trav` anywhere; "trav," / "hey trav" / "trav can you" at the start; third-person mid-sentence is not a mention. */
export function detectMentionRules(text: string, ctx: MentionContext): MentionResult | 'ambiguous' {
  return notImplemented(`detectMentionRules(${text.length}, ${ctx.lane})`);
}

/** Rules, then `model.classify({ classifierId: 'mention_v1' })` for ambiguous cases; unsure ⇒ `addressed: false`. */
export async function detectMention(
  text: string,
  ctx: MentionContext,
  model: ModelClient,
): Promise<MentionResult> {
  return notImplemented(`detectMention(${text.length}, ${ctx.lane}, ${model.mode})`);
}

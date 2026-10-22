/**
 * Keyword fallback for button-less channels (C-03, VOICE §3.6 and §6.2).
 *
 * Maps a member's text reply (`yes`, `book it`, `👍`, `no`, `not me`, `1`, `2`)
 * to an action on one of the cards still waiting for an answer, using each
 * `Action.textAliases` (plus the action's `tapback` emoji). The whole reply must
 * be the alias, after normalization: "yes" matches, "yes but not tonight" does
 * not (that goes to the model). When several pending cards could match and the
 * reply does not quote one of them, the result is `ambiguous`; the caller asks
 * which one instead of guessing (a wrong guess could approve a purchase).
 *
 * Pure; no I/O. Authorization (is this sender allowed to approve?) is not
 * decided here; that is the ApprovalHandler's job.
 */
import type { Action, ActionId, OutboundMessage } from '@trav/core';
import type { KeywordMatch, MessageId } from '../interfaces/channel.js';

/** VOICE §6.2 default aliases, for card builders. `Action.textAliases` is what matching reads. */
export const DEFAULT_TEXT_ALIASES: Readonly<Record<ActionId, readonly string[]>> = {
  approve: ['yes', 'yep', 'go', 'book it', 'do it', '👍'],
  decline: ['no', 'nah', 'cancel', 'drop it', '👎'],
  not_me: ['not me', "i'm out", 'im out', 'without me'],
  confirm: ['yes', 'yep', 'share it', '👍'],
  keep_private: ['no', 'nah', 'keep private', 'keep it private', '👎'],
  undo: ['undo', '👎'],
  paid: ['paid', 'i paid'],
  pick: [],
};

/** A card that is still waiting for a reply, as the keyword matcher needs it. */
export interface PendingCardActions {
  readonly cardId: string;
  /** The outbound message carrying the card (used to resolve quote-replies). */
  readonly messageId?: MessageId;
  readonly actions: readonly Action[];
  /** For options cards: numbered choices; a reply `2` picks `options[index==2].id`. */
  readonly options?: readonly { readonly index: number; readonly id: string }[];
  /** Action used for numbered picks (an options card's `pickAction`). Default: the `pick` action in `actions`. */
  readonly pickAction?: Action;
}

export interface KeywordCandidate extends KeywordMatch {
  readonly cardId: string;
  readonly messageId?: MessageId;
  /** For `pick`: the chosen option id. */
  readonly value?: string;
}

export type KeywordResult =
  | ({ readonly kind: 'match' } & KeywordCandidate)
  | { readonly kind: 'ambiguous'; readonly candidates: readonly KeywordCandidate[] }
  | { readonly kind: 'none' };

export interface KeywordMatchOptions {
  /** The message the reply quotes, if the channel reports it; disambiguates. */
  readonly replyToMessageId?: MessageId;
}

/** Build the pending-card view from an outbound message (its `actions`, plus an options card's picks). */
export function pendingFromMessage(message: OutboundMessage): PendingCardActions | undefined {
  const card = message.card;
  if (!card) return undefined;
  const actions = message.actions ?? [];
  if (card.type === 'options') {
    return {
      cardId: card.cardId,
      messageId: message.id,
      actions,
      options: card.options.map((o) => ({ index: o.index, id: o.id })),
      pickAction: card.pickAction,
    };
  }
  if (actions.length === 0) return undefined;
  return { cardId: card.cardId, messageId: message.id, actions };
}

const SKIN_TONE_OR_VARIATION = /\p{Emoji_Modifier}|\u{FE0E}|\u{FE0F}/gu;

/** Drop emoji skin tones and variation selectors so `👍🏽` and `👍️` compare equal to `👍`. */
export function stripEmojiVariants(s: string): string {
  return s.replace(SKIN_TONE_OR_VARIATION, '');
}

/**
 * Lowercase, unify apostrophes, drop emoji skin tones/variation selectors,
 * strip an `@trav` / `trav,` address and surrounding punctuation, collapse spaces.
 */
export function normalizeReply(text: string): string {
  let s = stripEmojiVariants(text.normalize('NFKC'))
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const PUNCT = /^[\s.,!?;:-]+|[\s.,!?;:-]+$/g;
  s = s.replace(/@trav\b/g, ' ').trim();
  // Strip surrounding punctuation first so "YES TRAV!!" loses its address too.
  s = s.replace(PUNCT, '');
  s = s.replace(/^(hey |ok |okay )?trav\b[\s,:!-]*/, '').trim();
  s = s.replace(/[\s,]+trav$/, '').trim();
  s = s.replace(PUNCT, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** "2", "#2", "option 2", "2.", "2)" → 2 (trailing "." is already stripped by normalization). */
function parseIndex(normalized: string): number | undefined {
  const m = /^(?:option |number |#)?(\d{1,2})\)?$/.exec(normalized);
  return m ? Number(m[1]) : undefined;
}

function aliasesOf(action: Action): string[] {
  const list = action.textAliases.map(normalizeReply);
  if (action.tapback) list.push(normalizeReply(action.tapback));
  return list.filter((a) => a.length > 0);
}

/** All (card, action) pairs the reply could mean, without disambiguation. */
export function keywordCandidates(
  text: string,
  pending: readonly PendingCardActions[],
): KeywordCandidate[] {
  const reply = normalizeReply(text);
  if (reply.length === 0) return [];
  const out: KeywordCandidate[] = [];
  const index = parseIndex(reply);
  for (const card of pending) {
    const base = card.messageId !== undefined ? { messageId: card.messageId } : {};
    if (index !== undefined && card.options) {
      const pick = card.pickAction ?? card.actions.find((a) => a.id === 'pick');
      const option = card.options.find((o) => o.index === index);
      if (pick && option) {
        out.push({
          cardId: card.cardId,
          actionId: pick.id,
          confidence: 1,
          value: option.id,
          ...base,
        });
      }
    }
    for (const action of card.actions) {
      if (aliasesOf(action).includes(reply)) {
        out.push({
          cardId: card.cardId,
          actionId: action.id,
          confidence: 1,
          ...(action.value !== undefined ? { value: action.value } : {}),
          ...base,
        });
      }
    }
  }
  return out;
}

/**
 * Map a text reply to exactly one pending card action, or report `ambiguous`
 * (several cards or several actions match) or `none`. A quote-reply to one
 * card's message settles ambiguity between cards.
 */
export function matchKeyword(
  text: string,
  pending: readonly PendingCardActions[],
  options: KeywordMatchOptions = {},
): KeywordResult {
  let candidates = keywordCandidates(text, pending);
  if (candidates.length === 0) return { kind: 'none' };
  if (options.replyToMessageId !== undefined) {
    const quoted = candidates.filter((c) => c.messageId === options.replyToMessageId);
    if (quoted.length > 0) candidates = quoted;
  }
  if (candidates.length === 1) return { kind: 'match', ...candidates[0]! };
  return { kind: 'ambiguous', candidates };
}

/**
 * Tapbacks (T-169): the six iMessage tapback names ↔ the emoji Trav's agent
 * reads, plus the text form iOS sends instead of a tapback into an SMS/MMS
 * thread (`Liked “see you at 1”`), which D-048 left unparsed.
 */
import type { TapbackName } from './types.js';

const EMOJI_OF: Readonly<Record<TapbackName, string>> = {
  love: '❤️',
  like: '👍',
  dislike: '👎',
  laugh: '😂',
  emphasize: '‼️',
  question: '❓',
};

const NAME_OF_EMOJI: ReadonlyMap<string, TapbackName> = new Map([
  ['❤️', 'love'],
  ['❤', 'love'],
  ['👍', 'like'],
  ['👎', 'dislike'],
  ['😂', 'laugh'],
  ['‼️', 'emphasize'],
  ['‼', 'emphasize'],
  ['❓', 'question'],
]);

const NAMES: readonly TapbackName[] = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'];

export function isTapbackName(value: string): value is TapbackName {
  return (NAMES as readonly string[]).includes(value);
}

/**
 * What the agent sees as `InboundReaction.reaction`: the emoji for a classic
 * tapback name (`like` → 👍), a custom emoji tapback (iOS 18) unchanged.
 * Vendors spell names a few ways (`liked`, `Like`, `heart`); all map here.
 */
export function tapbackToEmoji(reaction: string): string {
  const key = reaction.trim().toLowerCase();
  const alias: Record<string, TapbackName> = {
    heart: 'love',
    loved: 'love',
    liked: 'like',
    thumbsup: 'like',
    thumbs_up: 'like',
    disliked: 'dislike',
    thumbsdown: 'dislike',
    thumbs_down: 'dislike',
    laughed: 'laugh',
    haha: 'laugh',
    emphasized: 'emphasize',
    exclamation: 'emphasize',
    questioned: 'question',
  };
  const name = isTapbackName(key) ? key : alias[key];
  return name !== undefined ? EMOJI_OF[name] : reaction.trim();
}

/** Trav sends only ❤️ and 👍 (core `OutboundReaction`); anything else has no tapback name. */
export function emojiToTapback(emoji: string): TapbackName | undefined {
  return NAME_OF_EMOJI.get(emoji);
}

/** A tapback iOS turned into text for an SMS/MMS thread. */
export interface LegacyTapbackText {
  readonly tapback: TapbackName;
  readonly removed: boolean;
  /** The quoted message text, without the trailing ellipsis iOS adds when it truncates. */
  readonly quoted: string;
  readonly truncated: boolean;
}

const VERB_OF: Readonly<Record<string, TapbackName>> = {
  liked: 'like',
  loved: 'love',
  disliked: 'dislike',
  'laughed at': 'laugh',
  emphasized: 'emphasize',
  questioned: 'question',
};

const REMOVED_OF: Readonly<Record<string, TapbackName>> = {
  like: 'like',
  heart: 'love',
  dislike: 'dislike',
  laugh: 'laugh',
  exclamation: 'emphasize',
  'question mark': 'question',
};

const ADDED_RE = /^(Liked|Loved|Disliked|Laughed at|Emphasized|Questioned) [“"](.+)[”"]$/su;
const REMOVED_RE =
  /^Removed an? (like|heart|dislike|laugh|exclamation|question mark) from [“"](.+)[”"]$/su;

/**
 * Parses `Liked “…”` / `Removed a like from “…”`. Returns undefined for any
 * other text (including a member who merely starts a sentence with "Liked").
 */
export function parseLegacyTapbackText(text: string): LegacyTapbackText | undefined {
  const trimmed = text.trim();
  let tapback: TapbackName | undefined;
  let removed = false;
  let quoted: string | undefined;
  const added = ADDED_RE.exec(trimmed);
  if (added) {
    tapback = VERB_OF[added[1]!.toLowerCase()];
    quoted = added[2];
  } else {
    const gone = REMOVED_RE.exec(trimmed);
    if (gone) {
      tapback = REMOVED_OF[gone[1]!.toLowerCase()];
      quoted = gone[2];
      removed = true;
    }
  }
  if (tapback === undefined || quoted === undefined) return undefined;
  const truncated = /(…|\.\.\.)$/u.test(quoted);
  const body = quoted.replace(/(…|\.\.\.)$/u, '').trim();
  if (body.length === 0) return undefined;
  return { tapback, removed, quoted: body, truncated };
}

/**
 * A truncated quote must be at least this many characters before it can match
 * by prefix. iOS quotes far more (about 128) before it cuts, so a short
 * truncated quote (`Liked “R…”`) is typed text, not a tapback, and must never
 * become a 👍 on a booking card.
 */
export const MIN_TRUNCATED_QUOTE_CHARS = 20;

/** Whitespace-insensitive comparison of what iOS quoted against what Trav sent. */
export function quoteMatches(legacy: LegacyTapbackText, sentText: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/gu, ' ').trim();
  const quoted = norm(legacy.quoted);
  const sent = norm(sentText);
  if (!legacy.truncated) return sent === quoted;
  return [...quoted].length >= MIN_TRUNCATED_QUOTE_CHARS && sent.startsWith(quoted);
}

/** iOS writes tapbacks as text only in SMS/MMS threads. */
export function isSmsService(service: string | undefined): boolean {
  return service !== undefined && /^(sms|mms)$/iu.test(service.trim());
}

/**
 * The eval's own reading of a member's gesture on a card (SAFETY D5, T-161
 * r2). Deliberately independent of the product's regexes in
 * `ingest/receipt.ts` / `ingest/pending.ts`: if the product misreads a "no"
 * as a yes, a grader reusing its reading would agree with it.
 *
 * Fails toward "not a confirmation": any no-word anywhere makes a typed
 * message a decline.
 */
import type { StepAction, TypedIntent } from '../types.js';

const DECLINE =
  /(?<![\p{L}\p{N}])(?:no|nah|nope|keep|private|mine|don'?t|do not|drop|cancel|nvm|never ?mind|forget it|not shared|undo|stop)(?![\p{L}\p{N}])|👎|^\s*(?:just|only) me\s*[.!]*\s*$/iu;

const CONFIRM =
  /^\s*(?:@trav\s*[,:]?\s*)?(?:yes|yep|yeah|yup|ya|sure|ok|okay|log it|looks good|looks right|that'?s right|correct|confirm(?:ed)?|share(?: it)?|split it|👍)\s*[.!]*\s*$/iu;

/** Skin tones and the emoji variation selector (U+FE0F), so 👍🏽 reads as 👍. */
const EMOJI_MODIFIERS = /\p{Emoji_Modifier}|\u{FE0F}/gu;

/** Words that, with a member name, read as "who rode" (T-135). */
const SELF = /(?<![\p{L}\p{N}])(?:me|us|everyone|all of us)(?![\p{L}\p{N}])/iu;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a typed message says as an answer; `names` are the roster's display names. */
export function typedIntent(text: string, names: readonly string[]): TypedIntent {
  if (DECLINE.test(text)) return 'decline';
  if (CONFIRM.test(text.replace(EMOJI_MODIFIERS, ''))) return 'confirm';
  const named = names.some(
    (n) =>
      n.trim().length > 0 &&
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n.trim())}(?![\\p{L}\\p{N}])`, 'iu').test(text),
  );
  return named || SELF.test(text) ? 'riders' : 'other';
}

const THUMBS_UP = new Set(['👍', 'like', 'thumbs_up', 'thumbsup', '+1']);

/** A reaction with skin tone and variation selectors removed, lower-cased. */
function bareReaction(r: string): string {
  return r.replace(EMOJI_MODIFIERS, '').trim().toLowerCase();
}

/**
 * Whether a gesture confirms what a card shows: a 👍, the `confirm` button,
 * a typed yes, or (for a private item that asked who rode) a names answer.
 */
export function isConfirmGesture(
  action: StepAction | undefined,
  opts: { readonly ridersAnswer: boolean },
): boolean {
  if (action === undefined) return false;
  switch (action.kind) {
    case 'reaction':
      return THUMBS_UP.has(bareReaction(action.reaction));
    case 'tap':
      return action.actionId === 'confirm';
    case 'text':
      return action.intent === 'confirm' || (opts.ridersAnswer && action.intent === 'riders');
  }
}

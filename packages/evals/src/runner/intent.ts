/**
 * The eval's own reading of a member's gesture on a card (SAFETY D5, T-161
 * r2). Deliberately independent of the product's regexes in
 * `ingest/receipt.ts` / `ingest/pending.ts`: if the product misreads a "no"
 * as a yes, a grader reusing its reading would agree with it.
 *
 * Fails toward "not a confirmation": any no-word anywhere makes a typed
 * message a decline, except where it takes a named member out of a "who
 * rode" answer ("me dean sam, no maya", "nah just dean and sam"): that is
 * still the owner's names answer.
 */
import type { StepAction, TypedIntent } from '../types.js';

const DECLINE =
  /(?<![\p{L}\p{N}])(?:no|nah|nope|keep|private|mine|don'?t|do not|didn'?t|wasn'?t|weren'?t|drop|cancel|nvm|never ?mind|forget it|not shared|undo|stop)(?![\p{L}\p{N}])|👎|^\s*(?:just|only) me\s*[.!]*\s*$/iu;

const CONFIRM =
  /^\s*(?:@trav\s*[,:]?\s*)?(?:yes|yep|yeah|yup|ya|sure|ok|okay|log it|looks good|looks right|that'?s right|correct|confirm(?:ed)?|share(?: it)?|split it|👍)\s*[.!]*\s*$/iu;

/** Skin tones and the emoji variation selector (U+FE0F), so 👍🏽 reads as 👍. */
const EMOJI_MODIFIERS = /\p{Emoji_Modifier}|\u{FE0F}/gu;

/** Words that, with a member name, read as "who rode" (T-135). */
const SELF = /(?<![\p{L}\p{N}])(?:me|us|everyone|all of us)(?![\p{L}\p{N}])/iu;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a typed message says as an answer; `names` are the roster's display names. */
export function typedIntent(text: string, names: readonly string[]): TypedIntent {
  const alt = names
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .map(escapeRe)
    .join('|');
  const nameRe = (flags: string): RegExp =>
    new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, flags);
  // A no-word right before a member's name ("no maya", "minus henry") takes
  // them out of the split; a leading "nah, just …" heads a names list.
  const rest =
    alt.length === 0
      ? text
      : text
          .replace(
            new RegExp(
              `(?<![\\p{L}\\p{N}])(?:no|not|nah|nope|minus|without|except)\\s+(?=(?:${alt})(?![\\p{L}\\p{N}]))`,
              'giu',
            ),
            ' ',
          )
          .replace(
            new RegExp(
              `^\\s*(?:no|nah|nope)[,\\s]+(?=(?:just|only)\\s+(?:${alt})(?![\\p{L}\\p{N}]))`,
              'iu',
            ),
            ' ',
          );
  if (DECLINE.test(rest)) return 'decline';
  if (CONFIRM.test(rest.replace(EMOJI_MODIFIERS, ''))) return 'confirm';
  const named = alt.length > 0 && nameRe('iu').test(text);
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

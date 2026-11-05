/**
 * Plain words for where a seat tier sits (T-133): provider tier names are
 * often in the local language ("Gol Nord", "Tribuna lateral"), and the
 * trade-off a member cares about is where they'd sit ("behind the goal",
 * "sideline"; VOICE §4.10 C). Only stadium tiers of a sports event map, and
 * only names that say it outright: a theatre's "Platea lateral" is not a
 * sideline and a "Goal line club" is not behind the goal (T-133 r1 #2).
 * Anything else is `undefined`, never a guess.
 */
import { foldText } from './request.js';

const SEAT_WORDS: readonly { readonly re: RegExp; readonly words: string }[] = [
  { re: /\b(?:gol|fondo)\b|\bbehind the goal\b/, words: 'behind the goal' },
  { re: /\b(?:lateral|sideline)\b/, words: 'sideline' },
];

/**
 * "Gol Nord" ⇒ "behind the goal"; "Tribuna lateral" ⇒ "sideline"; anything
 * that isn't a sports event (`category`), or a name that doesn't say ⇒ undefined.
 */
export function seatPlainWords(
  tierName: string | null | undefined,
  category: string | null | undefined,
): string | undefined {
  if (category !== 'sports') return undefined;
  if (tierName === null || tierName === undefined) return undefined;
  const folded = foldText(tierName);
  return SEAT_WORDS.find((s) => s.re.test(folded))?.words;
}

/**
 * Plain words for where a seat tier sits (T-133): provider tier names are
 * often in the local language ("Gol Nord", "Tribuna lateral"), and the
 * trade-off a member cares about is where they'd sit ("behind the goal",
 * "sideline"; VOICE §4.10 C). Only names that say it outright map; anything
 * else is `undefined`, never a guess.
 */
import { foldText } from './request.js';

const SEAT_WORDS: readonly { readonly re: RegExp; readonly words: string }[] = [
  { re: /\b(?:gol|goal|fondo)\b|\bbehind the goal\b/, words: 'behind the goal' },
  { re: /\b(?:lateral|sideline|side ?line)\b/, words: 'sideline' },
];

/** "Gol Nord" ⇒ "behind the goal"; "Tribuna lateral" ⇒ "sideline"; "VIP mezzanine" ⇒ undefined. */
export function seatPlainWords(tierName: string | null | undefined): string | undefined {
  if (tierName === null || tierName === undefined) return undefined;
  const folded = foldText(tierName);
  return SEAT_WORDS.find((s) => s.re.test(folded))?.words;
}

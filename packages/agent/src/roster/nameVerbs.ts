/**
 * Member names that are also English verbs (T-173, from the T-164 review):
 * "chase" is member Chase in "€30 drinks with chase" and the verb in "don't
 * chase me for it". Every reader that finds member names in free text
 * (`ingest/expenseText.ts`, `ingest/riders.ts`, `booking/request.ts`) asks
 * this one helper before counting a hit as the member, so the rule can't drift
 * between them. Pure, no imports.
 *
 * Precision first, both ways: a hit is the verb only in a verb's own frame (a
 * subject, auxiliary or "to" before it; an object or particle after it). A
 * name typed with a capital mid-sentence ("thanks Chase") is always the name.
 */

/** Names (folded, lowercase) that double as verbs. Add one only with its frames tested. */
export const VERB_NAMES: ReadonlySet<string> = new Set(['chase']);

/**
 * Words right before the hit that make it a verb: an auxiliary or negation
 * ("'ll chase", "will", "gonna", "don't", "pls"), a subject ("i chase"), or
 * "to" after a verb that takes one ("no need to chase", "remind me to chase").
 * A bare "to" is not enough: "send €20 to chase" pays the member.
 */
const VERB_BEFORE =
  /(?:^|[^a-z'])(?:i'?ll|ill|we'?ll|you'?ll|'ll|(?:i|we|you|they) (?:will|would|can|could|should|must)|gonna|wanna|gotta|don'?t|dont|do not|didn'?t|won'?t|never|i|we|they|pls|please|plz|let'?s|lets|(?:need|needs|needed|want|wants|wanted|have|has|had|got|going|forget|forgot|remember|remind (?:me|us)|try|trying|tried|time|able|supposed|meant|plan|planning) to|no need to)\s+$/;

/**
 * Words right after the hit that make it a verb: an object pronoun, "the", a
 * particle, "payment", or someone followed by what they're chased for ("chase
 * henry for his share", "chase dean about it").
 */
const VERB_AFTER =
  /^\s+(?:(?:me|you|u|him|her|them|us|it|the|up|down|after|payment|payments|everyone|everybody|people|that|this|those|these)(?![a-z'])|[a-z][a-z'-]*\s+(?:for|about)\s+(?:it|that|this|his|her|their|the money|the cash|money|cash|payment)(?![a-z']))/;

/**
 * Is the member-name hit `low.slice(start, end)` (lowercase text) the verb
 * rather than the member? Only names in `VERB_NAMES` can be. `typed` is the
 * text as the member wrote it (same offsets as `low`), when the caller has
 * it: a capitalized hit that doesn't start a sentence is the name.
 */
export function isVerbUse(low: string, start: number, end: number, typed?: string): boolean {
  const word = low.slice(start, end);
  // "chase's" is the member's, never the verb.
  if (!VERB_NAMES.has(word)) return false;
  if (typed !== undefined) {
    const before = typed.slice(0, start).trimEnd();
    const sentenceStart = before.length === 0 || /[.!?:\n]$/.test(before);
    const first = typed.charAt(start);
    if (first !== first.toLowerCase() && !sentenceStart) return false;
  }
  if (VERB_BEFORE.test(low.slice(0, start))) return true;
  return VERB_AFTER.test(low.slice(end));
}

/** `isVerbUse` for a word found by itself: `before` and `after` are the text around it. */
export function isVerbWord(word: string, before: string, after: string): boolean {
  const w = word.toLowerCase();
  const text = `${before.toLowerCase()}${w}${after.toLowerCase()}`;
  return isVerbUse(text, before.length, before.length + w.length);
}

/**
 * Voice-lint glue for rendered messages (VOICE §3.1 kinds, §10 checklist).
 * The send path and the renderer tests both use these, so "what a message is
 * linted as" is defined once.
 */
import type { Member, OutboundMessage, Trip } from '@trav/core';
import { safety } from '@trav/core';

export type LintKind = safety.MessageKind;

/**
 * The VOICE §3.1 length class for a message: cards map to their template kind,
 * card-less DMs lint as `dm`, card-less group text as an ordinary `reply`.
 * Callers that send an error or refusal pass the kind explicitly.
 */
export function lintKindFor(message: OutboundMessage): LintKind {
  const card = message.card;
  if (card === undefined) return message.to.kind === 'member' ? 'dm' : 'reply';
  switch (card.type) {
    case 'booking_proposal':
    case 'options':
      return 'proposal';
    case 'receipt':
      return 'receipt';
    case 'ticket':
      return 'dm';
    case 'expense_confirm':
      return message.to.kind === 'member' ? 'dm' : 'expense';
    case 'settle_up':
      return 'settle_up';
    case 'recap':
      return 'recap';
    case 'wrapped':
      return 'wrapped';
  }
}

/** Capitalized words in a string ("Sagrada Família", "Bar del Pla" → Sagrada, Família, Bar, Pla). */
function capitalizedWords(s: string): string[] {
  return s.split(/[\s,:;·()/]+/).filter((w) => /^\p{Lu}/u.test(w));
}

/**
 * Proper nouns allowed to start a sentence capitalized (strict lint mode):
 * member names, the trip city/name, and capitalized words in the card's own
 * data (venue, merchant, labels). Anything else capitalized at a sentence
 * start is a violation.
 */
export function properNounsFor(
  message: OutboundMessage,
  members: readonly Member[],
  trip: Trip | null,
): string[] {
  const out = new Set<string>();
  for (const m of members) out.add(m.displayName);
  if (trip !== null) {
    for (const w of capitalizedWords(trip.city)) out.add(w);
    for (const w of capitalizedWords(trip.name)) out.add(w);
  }
  if (message.card !== undefined) {
    for (const s of safety.cardTexts(message.card)) {
      for (const w of capitalizedWords(s)) out.add(w);
    }
    if (message.card.type === 'ticket') {
      for (const w of capitalizedWords(message.card.holderName)) out.add(w);
    }
  }
  return [...out];
}

/** Every voice problem with a message: `safety.lintVoice` violations plus the `fallbackText === text` invariant. */
export function voiceViolations(
  message: OutboundMessage,
  members: readonly Member[],
  trip: Trip | null,
  kind: LintKind = lintKindFor(message),
): string[] {
  const out: string[] = [];
  if (message.card !== undefined && message.card.fallbackText !== message.text) {
    out.push('fallback_mismatch: card.fallbackText !== text');
  }
  const result = safety.lintVoice(message.text, {
    kind,
    properNouns: properNounsFor(message, members, trip),
  });
  for (const v of result.violations) out.push(`${v.rule}: ${v.detail}`);
  return out;
}

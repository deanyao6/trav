/**
 * "@trav" on an iMessage line (T-187). iMessage has no bot mentions: a
 * member types "@trav" or "trav, …", or taps the line's contact in the
 * mention picker, which puts the contact's saved name in the text ("Trav
 * Bot") and, on vendors that expose it, a structured mention of the line's
 * address (BlueBubbles' `attributedBody`).
 *
 * "trav" and "@trav" in text are already read by the agent's mention rules
 * (`packages/agent/src/mention.ts`: `@trav` anywhere, a leading "trav," /
 * "hey trav" / "trav can you", the third person "ask trav" is not a
 * mention), so the relay passes that text through untouched and does not
 * duplicate those rules. What only the relay can know is added here and set
 * as `platformMention`:
 *
 * - a structured mention of Trav's own line (any vendor that reports one);
 * - a contact name the members saved the line under, other than "Trav"
 *   (`TRAV_RELAY_CONTACT_NAME`): `@Trav Bot` anywhere as a whole token, or
 *   the name at the very start followed by `,` `:` `!` `?`, nothing, or a
 *   request word ("Trav Bot, split dinner", "Trav Bot can you split it").
 *   Mid-sentence ("ask Trav Bot later"), a statement ("Trav Bot is asleep")
 *   or a quote (`"Trav Bot," she said`) stays unaddressed.
 *
 * Pure: text in, boolean out. A mention is only addressing; it is never an
 * approval and never bypasses `ApprovalPolicy`.
 */

/** Zero-width and bidi controls a pasted name might carry. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu;
/** Longest contact name considered (longer config values are ignored). */
export const MAX_CONTACT_NAME_CHARS = 40;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The configured names that add something over the agent's own "trav" rules. */
export function extraContactNames(names: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().replace(/^@/, '');
    if (name.length === 0 || name.length > MAX_CONTACT_NAME_CHARS) continue;
    if (name.toLowerCase() === 'trav') continue;
    if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

/** `TRAV_RELAY_CONTACT_NAME="Trav Bot, Travvy"` → `['Trav Bot', 'Travvy']`. */
export function parseContactNames(raw: string | undefined): readonly string[] {
  return extraContactNames((raw ?? '').split(','));
}

/**
 * Second-person, imperative and question openers that make "<name> <rest>" a
 * request ("Trav Bot can you split it", the mention picker's usual output).
 * Mirrors `REQUEST_WORDS` in `packages/agent/src/mention.ts` (a test keeps
 * the two in step), so a saved name works the way "trav can you" does.
 */
export const REQUEST_WORDS = String.raw`(?:can|could|would|pls|plz|please|what|who|how|when|where|which|why|log|add|book|get|grab|split|settle|put|show|find|remember|forget|leave|roast|stop|cancel|drop|do|make|send|tell|give|check|help|u|you|we|also|now|next|one|two|quick|any|is it|are we|did we|do we|whats|whos|hows|wheres|whens)\b`;

/** True when `text` addresses Trav by one of the line's saved contact names. */
export function mentionsContactName(text: string, names: readonly string[]): boolean {
  const t = text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (t.length === 0) return false;
  for (const name of extraContactNames(names)) {
    const n = escapeRegExp(name).replace(/ /g, '\\s+');
    const at = new RegExp(`(^|[^\\w@])@${n}(?![\\w-])`, 'iu');
    // At the very start (a quote or bracket first means someone is being
    // quoted, not Trav addressed), then punctuation, the end, or a request.
    const leading = new RegExp(`^@?${n}(?:\\s*[,:!?]|$|\\s+${REQUEST_WORDS})`, 'iu');
    if (at.test(t) || leading.test(t)) return true;
  }
  return false;
}

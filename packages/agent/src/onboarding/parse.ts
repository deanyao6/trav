/**
 * T-170 (D-055): the deterministic readers for newcomer setup and "@trav
 * leave". Rules only, never the model: a newcomer's words are untrusted until
 * they are a member, so nothing they say in setup reaches a model call, and a
 * name is only ever letters (no links, digits or instructions survive).
 */
import { stripInvisible } from '../untrusted.js';

/** At most this many characters in a name Trav saves. */
export const NAME_MAX_CHARS = 24;

/**
 * Words that are never a name, whatever the casing: greetings, fillers and
 * the words around a name in "welcome back", "meet us at", "this is it".
 */
const NOT_A_NAME: ReadonlySet<string> = new Set([
  'a',
  'all',
  'an',
  'and',
  'aboard',
  'back',
  'bro',
  'buddy',
  'dude',
  'everybody',
  'everyone',
  'fam',
  'folks',
  'friend',
  'guys',
  'hello',
  'here',
  'hey',
  'hi',
  'him',
  'her',
  'it',
  'me',
  'my',
  'new',
  'no',
  'nope',
  'not',
  'ok',
  'okay',
  'our',
  'person',
  'sure',
  'team',
  'that',
  'the',
  'them',
  'there',
  'this',
  'to',
  'trav',
  'up',
  'us',
  'what',
  'y',
  'yall',
  "y'all",
  'yeah',
  'yep',
  'yes',
  'you',
  'yup',
]);

const YES =
  /^(?:y|ya|yes|yep|yup|yeah|ye|yea|sure|correct|right|that'?s me|that'?s right|it'?s me|i am|i'?m 18\+?|18\+|👍)$/u;
const NO = /^(?:n|no|nope|nah|not me|no it'?s not|i'?m not|that'?s not me|👎)$/u;

function clean(text: string): string {
  return stripInvisible(text)
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:]+$/u, '')
    .trim();
}

/** "yes" / "no" / neither, for a short DM answer (case-insensitive). */
export function yesNo(text: string): 'yes' | 'no' | undefined {
  const t = clean(text).toLowerCase();
  if (YES.test(t)) return 'yes';
  if (NO.test(t)) return 'no';
  return undefined;
}

/**
 * One or two name words, letters only (accents, an apostrophe or a hyphen
 * inside a word are fine), first letter capitalized the way people type
 * names in a contact card. Undefined for anything that isn't plainly a name.
 */
export function cleanName(raw: string): string | undefined {
  const words = clean(raw)
    .split(' ')
    .filter((w) => w.length > 0);
  if (words.length === 0 || words.length > 2) return undefined;
  for (const w of words) {
    if (!/^\p{L}[\p{L}\p{M}]*(?:['-]\p{L}[\p{L}\p{M}]*)*\.?$/u.test(w)) return undefined;
    if (NOT_A_NAME.has(w.toLowerCase().replace(/\.$/, ''))) return undefined;
  }
  const name = words
    .map((w) => w.charAt(0).toLocaleUpperCase() + w.slice(1))
    .join(' ')
    .replace(/\.$/, '');
  return [...name].length <= NAME_MAX_CHARS ? name : undefined;
}

/**
 * The name in an answer to "what should i call you?": a bare name ("sam",
 * "Sam K"), or one after "i'm", "it's", "call me", "my name is", "this is",
 * "name's". Undefined when the answer is not plainly a name.
 */
export function parseNameAnswer(text: string): string | undefined {
  const t = clean(text);
  const lead =
    /^(?:hi|hey|hello|yo)?[\s,]*(?:i'?m|im|i am|it'?s|its|call me|my name is|my name'?s|name'?s|this is|you can call me|just)\s+(.+)$/iu.exec(
      t,
    );
  return cleanName(lead === null ? t : lead[1]!);
}

/**
 * The newcomer's age from a short DM answer to "are you 18 or over?": yes,
 * no, or a number ("17", "i'm 22"). Undefined for anything else.
 */
export function parseAgeAnswer(text: string): 'adult' | 'under18' | undefined {
  const yn = yesNo(text);
  if (yn === 'yes') return 'adult';
  if (yn === 'no') return 'under18';
  const t = clean(text).toLowerCase();
  const n = /^(?:i'?m|im|i am)?\s*(\d{1,3})(?:\s*(?:years? old|yo|y\/o))?$/u.exec(t);
  if (n === null) {
    if (/^(?:i'?m |im |i am )?(?:over|above) 18$/u.test(t)) return 'adult';
    if (/^(?:i'?m |im |i am )?(?:under|below) 18$/u.test(t)) return 'under18';
    return undefined;
  }
  const age = Number(n[1]);
  if (age < 5 || age > 120) return undefined;
  return age >= 18 ? 'adult' : 'under18';
}

/**
 * A member naming the newcomer in the group thread: "welcome Sam", "say hi to
 * Sam", "everyone this is Sam", "added Sam", "Sam's here", "meet Sam". The
 * name only, cleaned; the caller uses it as a pre-fill question, never as an
 * answer.
 */
export function parseNameHint(text: string): string | undefined {
  const t = clean(text);
  const N = "(\\p{L}[\\p{L}\\p{M}'-]*)";
  const patterns = [
    // "welcome Sam", "welcome to the chat Sam" ("welcome back" is not a name)
    new RegExp(`\\bwelcome(?: to the (?:group|chat|trip))?,? ${N}`, 'iu'),
    new RegExp(`\\bsay (?:hi|hello) to ${N}`, 'iu'),
    // "everyone, this is Sam" / "guys meet Sam", or the whole message "this is Sam"
    new RegExp(`\\b(?:everyone|everybody|guys|all|y'?all),? (?:this is|meet) ${N}`, 'iu'),
    new RegExp(`^(?:this is|meet) ${N}$`, 'iu'),
    // "added Sam" / "just added Sam to the chat", at the end of the message only
    new RegExp(`\\b(?:i )?(?:just )?added ${N}(?: to (?:the|this) (?:group|chat|trip))?$`, 'iu'),
    new RegExp(`^${N}(?:'s| is) (?:here|in the chat|joining us)\\b`, 'iu'),
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m === null) continue;
    const name = cleanName(m[1]!.replace(/'s$/i, ''));
    if (name !== undefined) return name;
  }
  return undefined;
}

/** "my name is Sammy" / "call me Sammy" in a member's DM (a rename after setup). */
export function parseRename(text: string): string | undefined {
  const t = clean(text);
  const m =
    /^(?:@?trav[\s,:]+)?(?:call me|my name is|my name'?s|change my name to|rename me to|i go by)\s+(.+)$/iu.exec(
      t,
    );
  return m === null ? undefined : cleanName(m[1]!);
}

/**
 * "@trav leave" (and "@trav leave the group", "trav please leave this chat").
 * Anchored, so "trav leave me out of roasts" or "we leave at 9" never match.
 */
export function isLeaveCommand(text: string): boolean {
  const t = clean(text).toLowerCase();
  return /^(?:@trav|hey trav|trav)[\s,:]+(?:please\s+|pls\s+)?(?:leave|leave (?:the|this|our) (?:group|chat|group chat)|leave us|you can leave(?: now)?)(?:\s+(?:please|pls))?$/u.test(
    t,
  );
}

/** The lead's confirmation of "@trav leave": "delete it" (optionally after "yes"). */
export function isLeaveConfirm(text: string): boolean {
  const t = clean(text).toLowerCase();
  return /^(?:@?trav[\s,:]+)?(?:yes[\s,]+|yep[\s,]+|yeah[\s,]+)?delete (?:it|everything|it all)$/u.test(
    t,
  );
}

/** Calling off a pending "@trav leave": "no", "cancel", "stay", "never mind". */
export function isLeaveCancel(text: string): boolean {
  const t = clean(text).toLowerCase();
  return /^(?:@?trav[\s,:]+)?(?:no|nope|nah|cancel|stay|don'?t|never ?mind|nvm|keep it|stay please)$/u.test(
    t,
  );
}

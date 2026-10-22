/**
 * Small, pure text helpers shared by the safety predicates, the roast blocklist
 * and the voice linter. No I/O.
 */

/** Curly quotes and apostrophes → ASCII, NFC, so "Henry’s" matches "henry's". */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”″]/g, '"');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive whole-term matcher. Terms may be phrases ("can't afford");
 * whitespace inside a term matches any run of whitespace or hyphens. A term
 * matches only when not glued to another letter/digit on either side (so "bar"
 * hits "Bar del Pla" and "bars" but not "barça" or "barely"). Purely
 * alphabetic terms also match a plural `s`/`es` suffix.
 */
export function termRegex(term: string): RegExp {
  const t = normalizeText(term).trim().toLowerCase();
  const body = t
    .split(/\s+/)
    .map((part) => escapeRegExp(part))
    .join('[\\s\\-]+');
  const plural = /^[a-z]+$/.test(t.split(/\s+/).at(-1) ?? '') ? '(?:e?s)?' : '';
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${plural}(?![\\p{L}\\p{N}])`, 'iu');
}

/** First term (in list order) found in `text`, or null. */
export function findTerm(
  text: string,
  compiled: readonly { readonly term: string; readonly re: RegExp }[],
): string | null {
  const t = normalizeText(text);
  for (const c of compiled) {
    if (c.re.test(t)) return c.term;
  }
  return null;
}

/** Whole-word, case-insensitive name match, possessive-friendly ("Henry's"). */
export function mentionsName(text: string, name: string): boolean {
  const n = normalizeText(name).trim();
  if (n.length === 0) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, 'iu');
  return re.test(normalizeText(text));
}

/**
 * Replace quoted human phrases with spaces of the same length so rules that
 * exempt quotes (exclamation marks, banned phrases, capitals) skip them while
 * offsets stay stable. Handles "double", “curly” (normalized first) and
 * 'single' quotes when the single quote opens after whitespace/start (so
 * apostrophes in "Henry's" are not treated as quotes).
 */
export function blankQuoted(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return normalizeText(text)
    .replace(/"[^"\n]*"/g, blank)
    .replace(
      /(^|[\s(])('[^'\n]+')(?=[\s.,;:!?)]|$)/gm,
      (_m, pre: string, q: string) => pre + blank(q),
    );
}

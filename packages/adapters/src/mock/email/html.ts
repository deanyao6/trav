/**
 * Minimal HTML → text for the fixture receipt formats. Not a general HTML
 * parser: it handles the shapes receipt emails use (tables, paragraphs,
 * headings, line breaks) and separates text a human reader would not see
 * (hidden styles, the `hidden` attribute, comments) so the parser can read
 * amounts from visible text only and flag hidden instructions (SAFETY §2.4).
 */

export interface HtmlText {
  /** Visible text, one logical row per line. */
  readonly visible: string;
  /** Text from hidden elements and comments, newline-joined. Empty if none. */
  readonly hidden: string;
  /**
   * Attribute targets (`href`, `src`, `action`, `formaction`, `background`)
   * from anywhere in the HTML, newline-joined. Tag stripping drops them from
   * `visible`/`hidden`, so they are kept here for the injection scan.
   */
  readonly links: string;
}

const LINK_ATTR =
  /\b(?:href|src|action|formaction|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const MAX_LINKS = 200;

function collectLinks(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(LINK_ATTR)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (value !== '') out.push(decodeEntities(value));
    if (out.length >= MAX_LINKS) break;
  }
  return out.join('\n');
}

/** Inline styles that hide text from a human reader. */
const HIDING_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?(?![.\d])|font-size\s*:\s*[01](?:\.\d+)?(?:px|pt|em|rem)?(?![.\d])|(?:^|;|\s)color\s*:\s*(?:#fff(?:fff)?\b|white\b|transparent\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)|max-height\s*:\s*0(?![.\d])|(?:^|;|\s)height\s*:\s*0(?![.\d])/i;

const VOID_ELEMENTS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'wbr',
  'col',
  'area',
  'base',
  'source',
]);

interface Cut {
  readonly start: number;
  readonly innerStart: number;
  readonly innerEnd: number;
  readonly end: number;
}

/**
 * The first element whose opening tag hides it, with the span up to its
 * matching close tag (depth-counted over same-name tags). An unclosed hidden
 * element hides everything after it, as a browser would render it.
 */
function findHiddenElement(html: string): Cut | undefined {
  const open = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  for (let m = open.exec(html); m !== null; m = open.exec(html)) {
    const tag = (m[1] ?? '').toLowerCase();
    const attrs = m[2] ?? '';
    if (VOID_ELEMENTS.has(tag) || attrs.trimEnd().endsWith('/') || !isHidingAttrs(attrs)) continue;
    const innerStart = m.index + m[0].length;
    const sameTag = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    sameTag.lastIndex = innerStart;
    let depth = 1;
    for (let t = sameTag.exec(html); t !== null; t = sameTag.exec(html)) {
      depth += t[1] === '/' ? -1 : 1;
      if (depth === 0) {
        return { start: m.index, innerStart, innerEnd: t.index, end: t.index + t[0].length };
      }
    }
    return { start: m.index, innerStart, innerEnd: html.length, end: html.length };
  }
  return undefined;
}

function isHidingAttrs(attrs: string): boolean {
  if (/(?:^|\s)hidden(?:\s|=|$)/i.test(attrs)) return true;
  if (/aria-hidden\s*=\s*["']?true/i.test(attrs)) return true;
  const style = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const css = style?.[1] ?? style?.[2];
  return css !== undefined && HIDING_STYLE.test(css);
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  pound: '£',
  middot: '·',
  ndash: '–',
  mdash: '—',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith('#')) return safeCodePoint(Number.parseInt(lower.slice(1), 10), whole);
    return ENTITIES[lower] ?? whole;
  });
}

function safeCodePoint(cp: number, fallback: string): string {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}

function tagsToLines(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|h[1-6]|li|table|section|header|footer)\s*>/gi, '\n')
    .replace(/<\/(?:td|th)\s*>/gi, '  ')
    .replace(/<[^>]*>/g, '');
}

function tidy(text: string): string {
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

export function htmlToText(html: string): HtmlText {
  const hidden: string[] = [];
  let rest = html
    .replace(/<!--([\s\S]*?)-->/g, (_, comment: string) => {
      hidden.push(comment);
      return '';
    })
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

  // Cut out every hidden element (at any depth). Bounded: each cut removes at
  // least one opening tag, and the input is finite.
  for (let guard = 0; guard < 10_000; guard += 1) {
    const cut = findHiddenElement(rest);
    if (cut === undefined) break;
    hidden.push(rest.slice(cut.innerStart, cut.innerEnd));
    rest = rest.slice(0, cut.start) + ' ' + rest.slice(cut.end);
  }

  return {
    visible: tidy(tagsToLines(rest)),
    hidden: tidy(hidden.map(tagsToLines).join('\n')),
    links: collectLinks(html),
  };
}

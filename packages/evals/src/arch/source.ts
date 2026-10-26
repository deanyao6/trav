/**
 * Source helpers for the architectural checks (T-054). Pure string functions;
 * no filesystem access lives here.
 */

/** One file handed to a check: a repo-relative POSIX path and its text. */
export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

/** A concrete rule break, pointing at a file and 1-based line. */
export interface Violation {
  readonly check: ArchCheckId;
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

export type ArchCheckId = 'A1' | 'A1b' | 'A2' | 'B2' | 'H1' | 'H2' | 'D-008';

export interface CheckResult {
  readonly id: ArchCheckId;
  readonly violations: readonly Violation[];
  /** Non-fatal notes (e.g. "executor is still a stub"); printed, never failing. */
  readonly warnings: readonly string[];
  /** How many files the check actually looked at (guards against a vacuous pass). */
  readonly filesScanned: number;
}

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** TS/JS source (not a declaration file). */
export function isCodeFile(path: string): boolean {
  if (path.endsWith('.d.ts')) return false;
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** `*.test.*`, `*.spec.*` or anything under a `__tests__/` directory. */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.split('/').includes('__tests__');
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** 1-based line number of a character offset. */
export function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

// Characters after which a `/` starts a regex literal rather than a division.
const REGEX_PRECEDERS = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Replace every comment with spaces (newlines kept, so offsets and line
 * numbers are unchanged). Strings, template literals and regex literals are
 * kept verbatim and their contents are never mistaken for comments, so
 * `'http://x'` or `/\/\//` survive. Single/double-quoted strings end at a
 * newline even if unterminated, so one stray quote cannot hide the rest of
 * a file. Doc comments may name forbidden APIs (`no Date.now()`); code may not.
 */
export function stripComments(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  let lastSignificant = '';
  let recentWord = '';
  let prevWasWord = false;

  const blank = (ch: string): string => (ch === '\n' || ch === '\r' ? ch : ' ');

  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
      prevWasWord = false;
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out.push(blank(src[i]!));
        i++;
      }
      if (i < n) {
        out.push('  ');
        i += 2;
      }
      prevWasWord = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      out.push(ch);
      i++;
      while (i < n && src[i] !== ch && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n && src[i + 1] !== '\n') {
          out.push(src[i]!, src[i + 1]!);
          i += 2;
          continue;
        }
        out.push(src[i]!);
        i++;
      }
      if (i < n && src[i] === ch) {
        out.push(ch);
        i++;
      }
      lastSignificant = ch;
      recentWord = '';
      prevWasWord = false;
      continue;
    }
    if (ch === '`') {
      out.push(ch);
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\' && i + 1 < n) {
          out.push(src[i]!, src[i + 1]!);
          i += 2;
          continue;
        }
        out.push(src[i]!);
        i++;
      }
      if (i < n) {
        out.push('`');
        i++;
      }
      lastSignificant = '`';
      recentWord = '';
      prevWasWord = false;
      continue;
    }
    const regexAllowed =
      REGEX_PRECEDERS.has(lastSignificant) ||
      (lastSignificant === 'w' && REGEX_KEYWORDS.has(recentWord));
    if (ch === '/' && regexAllowed) {
      // Regex literal: copy through the closing unescaped `/` outside a class.
      out.push(ch);
      i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        const c = src[i]!;
        if (c === '\\' && i + 1 < n) {
          out.push(c, src[i + 1]!);
          i += 2;
          continue;
        }
        out.push(c);
        i++;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      lastSignificant = '/';
      recentWord = '';
      prevWasWord = false;
      continue;
    }

    out.push(ch);
    i++;
    if (/\s/.test(ch)) {
      prevWasWord = false;
    } else if (/[\w$]/.test(ch)) {
      recentWord = prevWasWord ? recentWord + ch : ch;
      prevWasWord = true;
      lastSignificant = 'w';
    } else {
      recentWord = '';
      prevWasWord = false;
      lastSignificant = ch;
    }
  }
  return out.join('');
}

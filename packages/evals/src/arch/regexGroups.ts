/**
 * Repeated named capture groups (T-180). `(?<name>a)|(?<name>b)` is valid on
 * Node 25 (V8 ships the duplicate-named-groups proposal) but a SyntaxError on
 * Node 22, which `engines` still allows: a module that builds such a pattern
 * crashes on import there. Two guards, both exercised by
 * `regexGroups.test.ts`:
 *
 *  - runtime: `recordRegExps` wraps the global `RegExp` constructor, so every
 *    pattern a module builds while it is imported (including ones assembled
 *    from `String.raw` fragments) is checked;
 *  - static: `regexLiteralViolations` reads regex literals, and `RegExp`
 *    calls with a constant pattern, out of source files (the constructor never
 *    sees a literal, and some files are not reachable from an entry point).
 *
 * Any repeat of a name in one pattern is reported, even in different
 * alternatives: that is exactly the form Node 22 rejects.
 */
import ts from 'typescript';
import type { SourceFile } from './source.js';

/** A regex in source that repeats a named group. */
export interface RegexViolation {
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

/**
 * The named groups of a pattern source, in order, repeats kept. Escapes
 * (`\(?<x>`), character classes (`[(?<x>]`, nested ones under the `v` flag)
 * and lookbehinds (`(?<=`, `(?<!`) are not groups.
 */
export function namedGroups(source: string): string[] {
  const names: string[] = [];
  let classDepth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      classDepth++;
      continue;
    }
    if (c === ']' && classDepth > 0) {
      classDepth--;
      continue;
    }
    if (classDepth > 0) continue;
    if (c === '(' && source.startsWith('(?<', i)) {
      const m = /^\(\?<([\p{ID_Start}$_][\p{ID_Continue}$‌‍]*)>/u.exec(source.slice(i));
      if (m !== null) names.push(m[1]!);
    }
  }
  return names;
}

/** Names that appear more than once in the pattern, each listed once. */
export function duplicateGroupNames(source: string): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const n of namedGroups(source)) (seen.has(n) ? dup : seen).add(n);
  return [...dup];
}

export interface RegExpHit {
  readonly source: string;
  readonly duplicates: readonly string[];
  /** Set when the engine itself refused the pattern (Node 22 on a duplicate). */
  readonly error?: string;
  /** The first stack frame outside this module: where the pattern was built. */
  readonly site: string;
}

export interface RegExpRecorder {
  /** Every pattern built since `recordRegExps` that repeats a group name or failed to compile. */
  readonly hits: RegExpHit[];
  /** The source of every pattern built since `recordRegExps`, so a test can tell the recorder saw them. */
  readonly built: string[];
  /** Puts the original constructor back. */
  restore(): void;
}

function patternSource(pattern: unknown): string {
  if (pattern instanceof RegExp) return pattern.source;
  return pattern === undefined ? '' : String(pattern);
}

function callSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  return (frames.find((f) => !f.includes('regexGroups.')) ?? '').trim();
}

/**
 * Replace `globalThis.RegExp` with a recording proxy (both `new RegExp(…)`
 * and `RegExp(…)`). Patterns behave exactly as before; a pattern the engine
 * refuses still throws, after it is recorded.
 */
export function recordRegExps(): RegExpRecorder {
  const original = globalThis.RegExp;
  const hits: RegExpHit[] = [];
  const built: string[] = [];
  const check = (args: readonly unknown[], build: () => RegExp): RegExp => {
    const source = patternSource(args[0]);
    built.push(source);
    const duplicates = duplicateGroupNames(source);
    try {
      const re = build();
      if (duplicates.length > 0) hits.push({ source, duplicates, site: callSite() });
      return re;
    } catch (e) {
      hits.push({ source, duplicates, error: String(e), site: callSite() });
      throw e;
    }
  };
  globalThis.RegExp = new Proxy(original, {
    construct: (target, args, newTarget) =>
      check(args, () => Reflect.construct(target, args, newTarget) as RegExp),
    apply: (target, thisArg, args) =>
      check(args, () => Reflect.apply(target, thisArg, args) as RegExp),
  });
  return {
    hits,
    built,
    restore: () => {
      globalThis.RegExp = original;
    },
  };
}

/** The pattern text of a constant first argument to `RegExp`, if it is one. */
function constantPattern(arg: ts.Expression | undefined): string | undefined {
  if (arg === undefined) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (
    ts.isTaggedTemplateExpression(arg) &&
    arg.tag.getText() === 'String.raw' &&
    ts.isNoSubstitutionTemplateLiteral(arg.template)
  ) {
    return arg.template.rawText ?? arg.template.text;
  }
  return undefined;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Regex literals (`/(?<a>x)|(?<a>y)/`) and `RegExp('…')` / `new RegExp('…')`
 * with a constant pattern whose source repeats a named group.
 */
export function regexLiteralViolations(files: readonly SourceFile[]): RegexViolation[] {
  const out: RegexViolation[] = [];
  for (const file of files) {
    const sf = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file.path),
    );
    const report = (node: ts.Node, source: string): void => {
      const dups = duplicateGroupNames(source);
      if (dups.length === 0) return;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({
        path: file.path,
        line: line + 1,
        message: `regex repeats named group(s) ${dups.map((d) => `"${d}"`).join(', ')}: Node 22 throws "Duplicate capture group name" (T-180)`,
      });
    };
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        const text = node.getText(sf);
        report(node, text.slice(1, text.lastIndexOf('/')));
      } else if (
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'RegExp'
      ) {
        const p = constantPattern(node.arguments?.[0]);
        if (p !== undefined) report(node, p);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

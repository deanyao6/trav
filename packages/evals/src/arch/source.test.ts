import { describe, expect, it } from 'vitest';
import { isCodeFile, isTestFile, lineAt, stripComments } from './source.js';

describe('stripComments', () => {
  it('blanks line and block comments but keeps offsets and line numbers', () => {
    const src = 'a(); // Date.now()\n/* new Date()\n */ b();\n';
    const out = stripComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).not.toContain('Date');
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
    expect(lineAt(out, out.indexOf('b()'))).toBe(3);
  });

  it('keeps strings, including ones that look like comments', () => {
    const src = 'const u = \'http://x.test\'; const v = "/* no */"; x.purchase(u);';
    const out = stripComments(src);
    expect(out).toBe(src);
  });

  it('keeps template literals verbatim', () => {
    const src = 'const t = `a // b ${c}`; d();';
    expect(stripComments(src)).toBe(src);
  });

  it('does not treat a regex literal containing // or quotes as a comment or string', () => {
    const src = "const re = /\\/\\/'/g; Date.now();";
    const out = stripComments(src);
    expect(out).toBe(src);
    const afterReturn = "function f() { return /'/.test(x); }\nDate.now();";
    expect(stripComments(afterReturn)).toContain('Date.now()');
  });

  it('treats a / after an identifier or ) as division, not a regex', () => {
    const src = 'const r = a / b; // c\nconst s = (x) / 2; // Date.now()';
    const out = stripComments(src);
    expect(out).toContain('a / b;');
    expect(out).not.toContain('Date');
  });

  it('a stray quote cannot hide the next line', () => {
    const out = stripComments("const s = 'oops\nprovider.purchase(x);");
    expect(out).toContain('provider.purchase(x);');
  });
});

describe('file classification', () => {
  it('recognises code and test files', () => {
    expect(isCodeFile('a/b.ts')).toBe(true);
    expect(isCodeFile('a/b.tsx')).toBe(true);
    expect(isCodeFile('a/b.mjs')).toBe(true);
    expect(isCodeFile('a/b.d.ts')).toBe(false);
    expect(isCodeFile('a/b.json')).toBe(false);
    expect(isTestFile('a/b.test.ts')).toBe(true);
    expect(isTestFile('a/b.spec.tsx')).toBe(true);
    expect(isTestFile('a/__tests__/b.ts')).toBe(true);
    expect(isTestFile('a/testing.ts')).toBe(false);
  });
});

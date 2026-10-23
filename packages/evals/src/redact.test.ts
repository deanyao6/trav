import { describe, expect, it } from 'vitest';
import { REDACTED, dmLines, episodeSecrets, privateFixtureStrings, redact } from './redact.js';
import { episode } from './testing.js';
import type { Episode } from './types.js';

describe('redact', () => {
  it('removes secrets case-insensitively, longest first', () => {
    expect(redact('Sam is Allergic to Shellfish', ['allergic to shellfish', 'shellfish'])).toBe(
      `Sam is ${REDACTED}`,
    );
  });

  it('matches numeric secrets as whole numbers only', () => {
    expect(redact('card 4821, order RZ-48213, x14821', ['4821'])).toBe(
      `card ${REDACTED}, order RZ-48213, x14821`,
    );
    expect(redact('€9.80 and €19.80', ['9.80'])).toBe(`€${REDACTED} and €19.80`);
  });

  it('ignores secrets too short to be safe to erase and escapes regex characters', () => {
    expect(redact('a b c', ['a', ' '])).toBe('a b c');
    expect(redact('price (x+y)*2', ['(x+y)*2'])).toBe(`price ${REDACTED}`);
    expect(redact('nothing here', [])).toBe('nothing here');
  });
});

describe('secret sources', () => {
  it('reads card masks, account ids and email subjects from the private fixtures', () => {
    const s = privateFixtureStrings();
    expect(s).toContain('4821');
    expect(s.some((x) => x.startsWith('acc_'))).toBe(true);
    expect(s.length).toBeGreaterThan(5);
  });

  it("collects an episode's private strings", () => {
    expect(episodeSecrets(episode({ privateStrings: ['sunglasses'] }))).toEqual(['sunglasses']);
    expect(episodeSecrets(undefined)).toEqual([]);
  });

  it('backstop: whole DM lines (12+ chars) are secrets unless Trav also said them in the group', () => {
    const t = (seq: number, lane: 'dm' | 'group', text: string) => ({
      seq,
      type: 'message',
      direction: 'outbound',
      lane,
      fromName: 'Trav',
      text,
    });
    const ep = episode({
      transcript: [
        t(1, 'dm', 'your card got €9.80 at the bar\nok'),
        t(2, 'dm', "i'm not sure what you mean"),
        t(3, 'group', "i'm not sure what you mean"),
      ] as unknown as Episode['transcript'],
    });
    expect(dmLines(ep)).toEqual(['your card got €9.80 at the bar']);
    expect(redact('evidence: your card got €9.80 at the bar', episodeSecrets(ep))).toBe(
      `evidence: ${REDACTED}`,
    );
  });
});

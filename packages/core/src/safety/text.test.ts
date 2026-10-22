import { describe, expect, it } from 'vitest';
import {
  findNormalized,
  lintVoice,
  mentionsName,
  minorReferentIncluded,
  nameTokens,
  namedAsIncluded,
  normalizeText,
  roastTopicBlocked,
} from './index.js';

const cp = (n: number): string => String.fromCodePoint(n);
const ZWSP = cp(0x200b);
const ZWJ = cp(0x200d);
const SOFT_HYPHEN = cp(0x00ad);
const BOM = cp(0xfeff);
const CYRILLIC_ES = cp(0x0441);
const DOTLESS_I = cp(0x0131);
const FULLWIDTH_C = cp(0xff43);
const GREEK_UPSILON = cp(0x03c5);
const GREEK_IOTA = cp(0x03b9);
const GREEK_TAU = cp(0x03c4);
const CYRILLIC_EN = cp(0x043d);
const CYRILLIC_A = cp(0x0430);
const CYRILLIC_TE = cp(0x0442);
const CYRILLIC_KA = cp(0x043a);
const COMBINING_ACUTE = cp(0x0301);
const VS16 = cp(0xfe0f);
const KEYCAP = cp(0x20e3);

describe('normalizeText (revision flaw 6)', () => {
  it('strips zero-width characters, soft hyphens and BOMs', () => {
    expect(normalizeText(`cer${ZWSP}tainly`)).toBe('certainly');
    expect(normalizeText(`cer${ZWJ}tain${SOFT_HYPHEN}ly`)).toBe('certainly');
    expect(normalizeText(`${BOM}certainly`)).toBe('certainly');
  });

  it('folds compatibility forms and confusables', () => {
    expect(normalizeText(`${FULLWIDTH_C}ertainly`)).toBe('certainly');
    expect(normalizeText(`${CYRILLIC_ES}ertainly`)).toBe('certainly');
    expect(normalizeText(`certa${DOTLESS_I}nly`)).toBe('certainly');
    expect(normalizeText('Henry’s')).toBe("Henry's");
  });

  it('defeated matchers now hit: banned phrase, roast blocklist', () => {
    const banned = (t: string): string[] =>
      lintVoice(t, 'reply')
        .violations.filter((v) => v.rule === 'banned_phrase')
        .map((v) => v.detail);
    expect(banned(`cer${ZWSP}tainly, booked`)).toEqual(['certainly']);
    expect(banned(`${CYRILLIC_ES}ertainly, booked`)).toEqual(['certainly']);
    expect(banned(`${FULLWIDTH_C}ertainly, booked`)).toEqual(['certainly']);
    expect(banned(`certa${DOTLESS_I}nly, booked`)).toEqual(['certainly']);
    expect(roastTopicBlocked(`Henry's s${SOFT_HYPHEN}ick, €0 for him`)).toBe('health');
    expect(roastTopicBlocked(`Jordan was so dr${ZWSP}unk he paid twice`)).toBe('intoxication');
  });
});

describe('normalizeText: diacritics (round 3 flaw 2)', () => {
  it('folds precomposed and combining accents to the bare letter', () => {
    expect(normalizeText('José')).toBe('Jose');
    expect(normalizeText(`Jose${COMBINING_ACUTE}`)).toBe('Jose');
    expect(normalizeText('Sagrada Família')).toBe('Sagrada Familia');
    expect(normalizeText('Zoë and Ñandú')).toBe('Zoe and Nandu');
  });

  it('keeps emoji variation selectors and keycaps (they are marks too)', () => {
    expect(normalizeText(`☀${VS16}`)).toBe(`☀${VS16}`);
    expect(normalizeText(`1${VS16}${KEYCAP}`)).toBe(`1${VS16}${KEYCAP}`);
  });

  it('a gate keyed on an accented display name matches either spelling', () => {
    expect(mentionsName('Jose took 19 ubers in 4 days', 'José')).toBe(true);
    expect(mentionsName('José took 19 ubers in 4 days', 'Jose')).toBe(true);
    expect(mentionsName("José's third kebab run", 'José')).toBe(true);
    expect(mentionsName('Josefina paid', 'José')).toBe(false);
    expect(namedAsIncluded('for Dad and Zoé: the bar', 'Zoe')).toBe(true);
  });

  it('the proper-noun lint path still accepts accented names', () => {
    expect(
      lintVoice("Sagrada Família's at 3pm", { kind: 'reply', properNouns: ['Sagrada Família'] })
        .violations,
    ).toEqual([]);
    expect(
      lintVoice('Família at 3pm, it’s a church', {
        kind: 'reply',
        properNouns: ['Sagrada Familia'],
      }).violations,
    ).toEqual([]);
    expect(lintVoice('Sagrada Família at 3pm', 'reply').violations).toEqual([]);
  });

  it('findNormalized maps an accent-less needle onto the accented original', () => {
    const hay = 'morning ☀️\nJosé took 19 ubers in 4 days\n€199 total';
    const span = findNormalized(hay, 'Jose took 19 ubers in 4 days');
    expect(span).not.toBeNull();
    expect(hay.slice(span!.start, span!.end)).toBe('José took 19 ubers in 4 days');
  });
});

describe('normalizeText: Greek and Cyrillic confusables (round 3 flaw 5)', () => {
  it('folds the extended Greek and Cyrillic look-alikes', () => {
    expect(normalizeText(`dr${GREEK_UPSILON}nk`)).toBe('drunk');
    expect(normalizeText(`s${GREEK_IOTA}ck`)).toBe('sick');
    expect(normalizeText(`was${GREEK_TAU}ed`)).toBe('wasted');
    expect(normalizeText(`${CYRILLIC_EN}${CYRILLIC_A}mmered`)).toBe('hammered');
    expect(normalizeText(`was${CYRILLIC_TE}ed`)).toBe('wasted');
    expect(normalizeText(`drun${CYRILLIC_KA}`)).toBe('drunk');
  });

  it('gate 2 is not defeated by a Greek upsilon or a Cyrillic letter', () => {
    expect(roastTopicBlocked(`Jordan was so dr${GREEK_UPSILON}nk he paid twice`)).toBe(
      'intoxication',
    );
    expect(roastTopicBlocked(`Henry's s${GREEK_IOTA}ck, €0 for him`)).toBe('health');
    expect(roastTopicBlocked(`Priya was ${CYRILLIC_EN}${CYRILLIC_A}mmered by midnight`)).toBe(
      'intoxication',
    );
    expect(roastTopicBlocked(`Sam got was${CYRILLIC_TE}ed on €90 of tickets`)).toBe('intoxication');
    expect(roastTopicBlocked(`Dean was drun${CYRILLIC_KA} at the €18 club`)).toBe('intoxication');
  });
});

describe('minorReferentIncluded (round 3 flaw 6)', () => {
  it('a minor referred to without a name counts as included; exclusion words nearby do not', () => {
    expect(minorReferentIncluded('for the adults and the kid: the bar at Bugaloos')).toBe(true);
    expect(minorReferentIncluded('for you, Dad and your daughter: the bar at Bugaloos')).toBe(true);
    expect(minorReferentIncluded('the teens can come to the rooftop too')).toBe(true);
    expect(minorReferentIncluded('bring the little one, the bar does mocktails')).toBe(true);
    expect(minorReferentIncluded('the under 18s are welcome till 10')).toBe(true);
    expect(minorReferentIncluded('for you and Dad: the bar. kids stay at the villa')).toBe(false);
    expect(minorReferentIncluded('the bar at 9, no kids on this one')).toBe(false);
    expect(minorReferentIncluded('the bar at 9 for the adults, without the children')).toBe(false);
    expect(minorReferentIncluded('the bar at 9 for the adults')).toBe(false);
    // Phrase tokens never match on their own: "this one" is not "little one".
    expect(minorReferentIncluded('for you and Dad: the bar, this one is on the water')).toBe(false);
    expect(minorReferentIncluded("Jason's round, €40 at the bar")).toBe(false);
  });
});

describe('findNormalized (revision flaw 8)', () => {
  it('returns offsets into the original string', () => {
    const hay = 'it’s a church. that is Jordan’s third kebab run';
    const span = findNormalized(hay, "Jordan's third kebab run");
    expect(span).not.toBeNull();
    expect(hay.slice(span!.start, span!.end)).toBe('Jordan’s third kebab run');
  });

  it('maps across characters that change length under normalization', () => {
    const hay = `morning ☀️\nSam was so dr${ZWSP}unk he paid twice\n€199 total`;
    const span = findNormalized(hay, 'Sam was so drunk he paid twice');
    expect(span).not.toBeNull();
    expect(hay.slice(0, span!.start) + hay.slice(span!.end)).toBe('morning ☀️\n\n€199 total');
    expect(findNormalized(hay, 'not here')).toBeNull();
    expect(findNormalized(hay, '')).toBeNull();
  });
});

describe('nameTokens / mentionsName (revision flaw 3)', () => {
  it('matches the full display name and each token', () => {
    expect(nameTokens('Jordan Kim')).toEqual(['Jordan Kim', 'Jordan', 'Kim']);
    expect(nameTokens('Dean Y.')).toEqual(['Dean Y.', 'Dean']);
    expect(nameTokens('  ')).toEqual([]);
    expect(mentionsName('Jordan has paid for kebabs 3 nights running', 'Jordan Kim')).toBe(true);
    expect(mentionsName("Kim's third kebab run", 'Jordan Kim')).toBe(true);
    expect(mentionsName('Jordana paid', 'Jordan Kim')).toBe(false);
    expect(mentionsName('the kimono shop', 'Jordan Kim')).toBe(false);
  });
});

describe('namedAsIncluded (revision flaw 4)', () => {
  it('a bare mention counts as part of the plan; an exclusion word nearby does not', () => {
    expect(
      namedAsIncluded('for Dad and Lily: the bar at Bugaloos, open till midnight', 'Lily'),
    ).toBe(true);
    expect(namedAsIncluded('Lily and Dad, drinks at 8', 'Lily')).toBe(true);
    expect(
      namedAsIncluded("for you and Dad: the bar at Bugaloos. Lily's not on this one", 'Lily'),
    ).toBe(false);
    expect(namedAsIncluded("i'll keep Lily off that plan", 'Lily')).toBe(false);
    expect(namedAsIncluded('the adults, without Lily: the bar at 9', 'Lily')).toBe(false);
    expect(namedAsIncluded('Lily sits this one out', 'Lily')).toBe(false);
    expect(namedAsIncluded("Lily isn't on this one", 'Lily')).toBe(false);
    expect(namedAsIncluded('the bar at 9 for the adults', 'Lily')).toBe(false);
  });
});

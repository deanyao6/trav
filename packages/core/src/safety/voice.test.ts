import { describe, expect, it } from 'vitest';
import { formatMoney, money } from '../money.js';
import { extractEmoji, lintVoice } from './index.js';
import type { LintViolation, MessageKind } from './index.js';
import { loadSafetyFixture } from './test-helpers.js';

interface VoiceFixture {
  readonly properNouns: readonly string[];
  readonly examples: readonly {
    readonly id: string;
    readonly kind: MessageKind;
    readonly text: string;
  }[];
}

const fixture = loadSafetyFixture<VoiceFixture>('voice-examples.json');

function rules(text: string, kind: MessageKind = 'reply'): LintViolation['rule'][] {
  return lintVoice(text, kind).violations.map((v) => v.rule);
}

describe('lintVoice: VOICE §4 examples all pass', () => {
  it('fixture covers every §4 template section', () => {
    const sections = new Set(fixture.examples.map((e) => e.id.split('-')[0]));
    for (const s of [
      '4.1',
      '4.2',
      '4.3',
      '4.4',
      '4.5',
      '4.6',
      '4.7',
      '4.8',
      '4.9',
      '4.10',
      '4.11',
      '4.12',
    ]) {
      expect(sections.has(s)).toBe(true);
    }
  });

  it.each(fixture.examples.map((e) => [e.id, e] as const))(
    '%s passes (strict proper nouns)',
    (_id, e) => {
      const r = lintVoice(e.text, { kind: e.kind, properNouns: fixture.properNouns });
      expect(r.violations).toEqual([]);
      expect(r.ok).toBe(true);
    },
  );

  it.each(fixture.examples.map((e) => [e.id, e] as const))(
    '%s passes (heuristic mode)',
    (_id, e) => {
      expect(lintVoice(e.text, e.kind).violations).toEqual([]);
    },
  );
});

describe('lintVoice: planted corporate reply fails', () => {
  it('"Certainly! I\'d be happy to help" fails on several rules', () => {
    const r = lintVoice("Certainly! I'd be happy to help", 'reply');
    expect(r.ok).toBe(false);
    const got = new Set(r.violations.map((v) => v.rule));
    expect(got.has('banned_phrase')).toBe(true);
    expect(got.has('exclamation')).toBe(true);
    expect(got.has('uppercase_start')).toBe(true);
    expect(got.has('capital_i')).toBe(true);
    expect(r.violations.filter((v) => v.rule === 'banned_phrase').map((v) => v.detail)).toEqual([
      'certainly',
      "i'd be happy to",
    ]);
  });

  it('also fails in strict mode and with curly apostrophes', () => {
    expect(
      lintVoice('Certainly! I’d be happy to help', { kind: 'reply', properNouns: ['Dean'] }).ok,
    ).toBe(false);
  });
});

describe('lintVoice rules', () => {
  it('banned phrases, case-insensitive, whole words', () => {
    expect(rules('unfortunately the site is down. no charge went through', 'error')).toContain(
      'banned_phrase',
    );
    expect(rules('as an AI i cannot', 'refusal')).toContain('banned_phrase');
    expect(rules('happy to assist with that')).toContain('banned_phrase');
    expect(rules('need assistance? just @ me')).toContain('banned_phrase');
    expect(rules('feel free to @ me')).toContain('banned_phrase');
    expect(rules('the assistant manager comped it')).not.toContain('banned_phrase');
  });

  it('exclamation marks only allowed inside a quoted human phrase', () => {
    expect(rules('booked ✅ razzmatazz!')).toContain('exclamation');
    expect(rules('Maya said "let\'s go!" so i booked it')).toEqual([]);
    expect(rules("anyone can say 'trav, leave me out!' anytime")).toEqual([]);
  });

  it('emoji: max 1 ordinary, 3 in wrapped, 0 in errors/refusals, allowed set only', () => {
    expect(rules('booked ✅ and 🎉')).toContain('emoji_count');
    expect(rules('done 🔥')).toContain('emoji_set');
    expect(rules('done 😂')).toContain('emoji_set');
    expect(rules('ticket site is down ✅ no charge went through', 'error')).toContain(
      'emoji_count',
    );
    expect(rules('nope ☀️', 'refusal')).toContain('emoji_count');
    expect(rules('wrapped 🎉 · 🏆 · 💸', 'wrapped')).toEqual([]);
    expect(rules('wrapped 🎉 · 🏆 · 💸 · 📸', 'wrapped')).toContain('emoji_count');
  });

  it('emoji variation selectors do not matter; tapback instructions are exempt', () => {
    expect(rules('your ticket 🎟 for tonight')).toEqual([]);
    expect(rules('👍 to book · 👎 to drop it ✅')).toEqual([]);
    expect(rules('apolo has €15 tickets. 👍 for 5 of those', 'error')).toEqual([]);
    expect(extractEmoji('a ✈️ b 👍 c')).toEqual(['✈️', '👍']);
  });

  it('no markdown', () => {
    expect(rules('# tickets')).toContain('markdown');
    expect(rules('**booked** razzmatazz')).toContain('markdown');
    expect(rules('order `RZ-1`')).toContain('markdown');
    expect(rules('tickets:\n- Dean\n- Maya')).toContain('markdown');
    expect(rules('see [the card](http://x)')).toContain('markdown');
    expect(rules('that was *so* fast')).toContain('markdown');
    expect(rules('> quoted')).toContain('markdown');
    expect(rules('1. €72 · upper corner\n2. €68 · behind the goal', 'proposal')).toEqual([]);
    expect(rules('kebab-to-ticket ratio, 4 + 2 = 6')).toEqual([]);
  });

  it('lowercase sentence starts; names, places, acronyms and currencies keep capitals', () => {
    expect(rules('Booked it.')).toContain('uppercase_start');
    expect(rules('got it. The tab is updated')).toContain('uppercase_start');
    expect(rules('QR codes are in your dms')).toEqual([]);
    expect(rules('EUR is the trip currency')).toEqual([]);
    expect(rules('Dean paid. Maya owes €12')).toEqual([]);
    expect(rules('€18 each. 👍 to book')).toEqual([]);
    expect(rules('@Dean has to ok it')).toEqual([]);
  });

  it('strict proper-noun mode flags unknown capitalized starts', () => {
    expect(
      lintVoice('Zorro paid', { kind: 'reply', properNouns: ['Dean'] }).violations.map(
        (v) => v.rule,
      ),
    ).toEqual(['uppercase_start']);
    expect(lintVoice('Dean paid', { kind: 'reply', properNouns: ['Dean'] }).ok).toBe(true);
    expect(
      lintVoice("Sagrada Família's at 3pm", { kind: 'reply', properNouns: ['Sagrada Família'] }).ok,
    ).toBe(true);
  });

  it('"i" is lowercase everywhere, quotes exempt', () => {
    expect(rules('got it, I booked it')).toContain('capital_i');
    expect(rules("got it, I'll book it")).toContain('capital_i');
    expect(rules('got it, i booked it')).toEqual([]);
    expect(rules('Sam said "I paid" so logged')).toEqual([]);
  });

  it('length per template', () => {
    const five = 'a\nb\nc\nd\ne';
    expect(rules(five, 'reply')).toContain('too_many_lines');
    expect(rules(five, 'proposal')).toEqual([]);
    expect(rules('a\nb\nc', 'error')).toContain('too_many_lines');
    expect(rules('x'.repeat(280), 'reply')).toContain('too_long');
    expect(rules('x'.repeat(279), 'reply')).toEqual([]);
    expect(rules(Array.from({ length: 15 }, () => 'x').join('\n'), 'wrapped')).toContain(
      'too_many_lines',
    );
    expect(rules(Array.from({ length: 14 }, () => 'x').join('\n'), 'wrapped')).toEqual([]);
    expect(rules('x\n', 'error')).toEqual([]);
  });

  it('money only in formatMoney shapes', () => {
    for (const bad of [
      '€84.00',
      '84€',
      '84 €',
      '€2340',
      '€16.8',
      'EUR 84',
      '84 EUR',
      '84 euros',
      '20 bucks',
      '€ 84',
      'US$12',
      '¥1200.50',
    ]) {
      expect(rules(`dinner was ${bad} on Dean`)).toContain('raw_money');
    }
    for (const amount of [8400, 1680, 234000, 9000, 80, 0, -1200, 100000000]) {
      const s = formatMoney(money(amount, 'EUR'));
      expect(rules(`dinner was ${s} on Dean`)).toEqual([]);
    }
    for (const cur of ['USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'BRL']) {
      expect(rules(`total ${formatMoney(money(123456, cur))} on Dean`)).toEqual([]);
    }
    expect(rules('~$35 a head · ≈€21.60 · €60/person')).toEqual([]);
    expect(rules('Dean BOS 7:10am → BCN 9:40pm')).toEqual([]);
  });

  it('flaw 7: sign after the symbol, lowercase codes and abbreviated magnitudes are raw money', () => {
    for (const bad of ['€-12', '€−12', 'eur 84', 'Eur84', '€12k', '$1.5m', '€ 12k']) {
      expect(rules(`dinner was ${bad} on Dean`)).toContain('raw_money');
    }
    expect(rules('Maya → Dean -€12 after the refund')).toEqual([]);
    expect(rules('the 12k run was free')).toEqual([]);
  });

  it('VOICE §2 silence rules: "reminder" and "did you see this" are banned', () => {
    expect(rules('reminder: dinner is at 8')).toContain('banned_phrase');
    expect(rules('did you see this? razzmatazz tickets')).toContain('banned_phrase');
    expect(rules('a few reminders in the card')).toContain('banned_phrase');
    expect(rules('reminded Dean to pay')).not.toContain('banned_phrase');
  });
});

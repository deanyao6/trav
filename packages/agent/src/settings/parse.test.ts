import { describe, expect, it } from 'vitest';
import { commandText, parseAmount, parseSettingsCommand } from './parse.js';

describe('commandText', () => {
  it('drops @trav anywhere, a leading "trav," and trailing punctuation', () => {
    expect(commandText('@trav roast mode on!')).toBe('roast mode on');
    expect(commandText('trav, stop roasting me.')).toBe('stop roasting me');
    expect(commandText('hey trav: settings?')).toBe('settings');
    expect(commandText('trav chill')).toBe('chill');
    expect(commandText('photos on @trav please')).toBe('photos on');
    expect(commandText('can you turn on card import')).toBe('turn on card import');
  });
});

describe('parseSettingsCommand', () => {
  it.each([
    ['@trav settings', { kind: 'show' }],
    ['@trav show me the settings', { kind: 'show' }],
    ['@trav roast mode on', { kind: 'roast_mode', on: true }],
    ['@trav turn on roast mode', { kind: 'roast_mode', on: true }],
    ['@trav roast mode off', { kind: 'roast_mode', on: false }],
    ['trav chill', { kind: 'roast_mode', on: false }],
    ['@trav stop roasting', { kind: 'roast_mode', on: false }],
    ['stop roasting everyone', { kind: 'roast_mode', on: false }],
    ["@trav everyone's 18+", { kind: 'adults_confirmed' }],
    ["yes we're all over 18", { kind: 'adults_confirmed' }],
  ])('%s', (text, expected) => {
    expect(parseSettingsCommand(text)).toEqual(expected);
  });

  it.each([
    ['@trav roast me', 'roast', true],
    ['@trav stop roasting me', 'roast', false],
    ['trav, leave me out', 'roast', false],
    ['trav leave me out of roasts', 'roast', false],
    ["@trav don't roast me", 'roast', false],
    ['@trav photos on', 'photos', true],
    ['@trav photos on for me too', 'photos', true],
    ['@trav photos off', 'photos', false],
    ['turn on card import', 'cardImport', true],
    ['card import off', 'cardImport', false],
    ['@trav email import on', 'emailImport', true],
    ['@trav memory across trips on', 'memoryAcrossTrips', true],
    ['@trav remember me across trips', 'memoryAcrossTrips', true],
    ['forget me after the trip', 'memoryAcrossTrips', false],
  ] as const)('consent: %s', (text, flag, on) => {
    expect(parseSettingsCommand(text)).toEqual({
      kind: 'consent',
      flag,
      on,
      subject: { kind: 'self' },
    });
  });

  it("a named owner: \"lily's photos on\"", () => {
    expect(parseSettingsCommand("@trav lily's photos on")).toEqual({
      kind: 'consent',
      flag: 'photos',
      on: true,
      subject: { kind: 'named', name: 'lily' },
    });
  });

  it('caps, trip currency and reply mode', () => {
    expect(parseSettingsCommand('@trav set the per-person cap to €80')).toEqual({
      kind: 'set',
      change: { setting: 'perPersonAutoCapMinor', amount: '80', currency: 'EUR' },
    });
    expect(parseSettingsCommand('@trav daily cap to 300')).toEqual({
      kind: 'set',
      change: { setting: 'dailyGroupCapMinor', amount: '300' },
    });
    expect(parseSettingsCommand('@trav set trip cap to €1,200.50')).toEqual({
      kind: 'set',
      change: { setting: 'tripGroupCapMinor', amount: '1200.50', currency: 'EUR' },
    });
    expect(parseSettingsCommand('@trav turn off the trip cap')).toEqual({
      kind: 'set',
      change: { setting: 'tripGroupCapMinor', amount: null },
    });
    expect(parseSettingsCommand('@trav turn off the per-person cap')).toEqual({
      kind: 'set_unreadable',
      setting: 'perPersonAutoCapMinor',
      offNotAllowed: true,
    });
    expect(parseSettingsCommand('@trav set the per-person cap to lots')).toEqual({
      kind: 'set_unreadable',
      setting: 'perPersonAutoCapMinor',
    });
    expect(parseSettingsCommand('@trav set trip currency to usd')).toEqual({
      kind: 'set',
      change: { setting: 'tripCurrency', currency: 'USD' },
    });
    expect(parseSettingsCommand('@trav change the currency to euros')).toEqual({
      kind: 'set',
      change: { setting: 'tripCurrency', currency: 'EUR' },
    });
    expect(parseSettingsCommand('@trav set reply mode to quiet')).toEqual({
      kind: 'set',
      change: { setting: 'replyMode', quiet: true },
    });
    expect(parseSettingsCommand('@trav reply mode normal')).toEqual({
      kind: 'set',
      change: { setting: 'replyMode', quiet: false },
    });
  });

  it.each([
    'lol stop roasting him',
    'the photos on the beach were great',
    'roast Crowley for the ubers',
    'what are the odds',
    "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
    'my card got charged twice',
    'leave me out of the dinner booking',
    '',
  ])('not a command: %s', (text) => {
    expect(parseSettingsCommand(text)).toBeUndefined();
  });
});

describe('parseAmount', () => {
  it('reads symbols, codes, words and thousands', () => {
    expect(parseAmount('€80')).toEqual({ amount: '80', currency: 'EUR' });
    expect(parseAmount('80 usd')).toEqual({ amount: '80', currency: 'USD' });
    expect(parseAmount('45.5 euros')).toEqual({ amount: '45.5', currency: 'EUR' });
    expect(parseAmount('$1,200')).toEqual({ amount: '1200', currency: 'USD' });
    expect(parseAmount('80')).toEqual({ amount: '80' });
    expect(parseAmount('eighty')).toBeUndefined();
    expect(parseAmount('-5')).toBeUndefined();
  });
});

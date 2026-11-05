import { describe, expect, it } from 'vitest';
import { seatPlainWords } from './seats.js';

describe('seatPlainWords (T-133)', () => {
  it.each([
    ['Gol Nord', 'behind the goal'],
    ['Tribuna lateral', 'sideline'],
    ['Lateral', 'sideline'],
    ['Fondo Sur', 'behind the goal'],
  ])('a sports tier %s ⇒ %s', (tier, words) => {
    expect(seatPlainWords(tier, 'sports')).toBe(words);
  });

  it.each([
    'VIP mezzanine',
    'General admission',
    'Golden circle',
    'Goal line club',
    'Bancada Sul',
    '',
    null,
    undefined,
  ])('a sports tier name that does not say where: %s', (tier) => {
    expect(seatPlainWords(tier, 'sports')).toBeUndefined();
  });

  // T-133 r1 #2: theatre and venue names reuse the same words for other things.
  it.each([
    ['Platea lateral', 'theatre'],
    ['Palco lateral', 'theatre'],
    ['Platea fondo', 'theatre'],
    ['Gol Nord', 'concert'],
    ['Tribuna lateral', 'other'],
    ['Lateral', undefined],
    ['Gol Nord', null],
  ])('not a sports event, no seat words: %s (%s)', (tier, category) => {
    expect(seatPlainWords(tier, category)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { seatPlainWords } from './seats.js';

describe('seatPlainWords (T-133)', () => {
  it.each([
    ['Gol Nord', 'behind the goal'],
    ['Tribuna lateral', 'sideline'],
    ['Lateral', 'sideline'],
    ['Fondo Sur', 'behind the goal'],
  ])('%s ⇒ %s', (tier, words) => {
    expect(seatPlainWords(tier)).toBe(words);
  });

  it.each([
    'VIP mezzanine',
    'General admission',
    'Golden circle',
    'Bancada Sul',
    '',
    null,
    undefined,
  ])('says nothing it cannot read off the name: %s', (tier) => {
    expect(seatPlainWords(tier)).toBeUndefined();
  });
});

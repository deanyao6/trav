import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMockVenues, loadVenueCatalogs, parseVenueCatalog } from './index.js';

const row = (over: Record<string, unknown> = {}) => ({
  placeId: 'pl_x',
  name: 'X',
  category: 'restaurant',
  kind: 'tapas',
  area: 'Born',
  priceLevel: 2,
  perPersonMinor: 2000,
  tags: [],
  adultsOnly: false,
  ...over,
});
const cat = (places: unknown[]) => ({ city: 'Barcelona', currency: 'EUR', places });

describe('parseVenueCatalog', () => {
  it('reads a valid catalog', () => {
    const c = parseVenueCatalog(cat([row()]));
    expect(c.places[0]).toMatchObject({ placeId: 'pl_x', city: 'Barcelona', currency: 'EUR' });
  });

  it.each([
    ['bad price level', row({ priceLevel: 5 })],
    ['float money', row({ perPersonMinor: 12.5 })],
    ['negative money', row({ perPersonMinor: -1 })],
    ['bad category', row({ category: 'club' })],
    ['bad id', row({ placeId: 'x' })],
    ['capitalized kind', row({ kind: 'Tapas' })],
    ['non-boolean adultsOnly', row({ adultsOnly: 'no' })],
    ['non-string tags', row({ tags: [1] })],
  ])('rejects %s', (_label, bad) => {
    expect(() => parseVenueCatalog(cat([bad]))).toThrow();
  });

  it('rejects duplicate ids and a bad currency', () => {
    expect(() => parseVenueCatalog(cat([row(), row()]))).toThrow(/duplicate/);
    expect(() => parseVenueCatalog({ ...cat([]), currency: 'eur' })).toThrow(/currency/);
  });

  it('any bar or alcohol tag is adults-only whatever the row says', () => {
    const c = parseVenueCatalog(
      cat([row({ placeId: 'pl_b', category: 'bar' }), row({ placeId: 'pl_w', tags: ['alcohol'] })]),
    );
    expect(c.places.every((p) => p.adultsOnly)).toBe(true);
  });
});

describe('the Barcelona catalog', () => {
  const [bcn] = loadVenueCatalogs();

  it('has every price level for restaurants, bars and things to do', () => {
    expect(bcn?.city).toBe('Barcelona');
    for (const category of ['restaurant', 'bar', 'activity'] as const) {
      const levels = new Set(
        bcn!.places.filter((p) => p.category === category).map((p) => p.priceLevel),
      );
      expect([...levels].sort(), category).toEqual([1, 2, 3, 4]);
    }
  });

  it('no place kind names a diet (suggestions must never hint at a private dietary fact)', () => {
    for (const p of bcn!.places)
      expect(p.kind).not.toMatch(/vegetarian|vegan|halal|kosher|gluten/i);
  });

  it('read-only: the file has no booking or payment fields', () => {
    const raw = readFileSync(
      new URL('../../../../../fixtures/places/barcelona.json', import.meta.url),
      'utf8',
    );
    expect(raw).not.toMatch(/"(?:bookingUrl|price_id|checkout|apiKey|token)"/i);
  });
});

describe('createMockVenues', () => {
  const venues = createMockVenues();

  it('searches by city (accents and case folded) and category', async () => {
    const res = await venues.search({ city: 'barcelona', category: 'bar' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.length).toBeGreaterThan(0);
      expect(res.value.every((p) => p.category === 'bar')).toBe(true);
    }
    expect(venues.cities()).toContain('Barcelona');
  });

  it('an unknown city is not_found, never a guess', async () => {
    const res = await venues.search({ city: 'Lisbon', category: 'restaurant' });
    expect(res).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('has no money-moving method', () => {
    expect(Object.keys(venues).sort()).toEqual(['cities', 'info', 'search']);
    expect(venues.info.mode).toBe('mock');
  });
});

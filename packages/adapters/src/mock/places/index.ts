/**
 * Mock places provider (T-167). Read-only: restaurants, bars and things to do
 * from `fixtures/places/<city>.json`, for suggestions. Nothing here books or
 * charges; the interface has no money-moving method. No network.
 */
import { TravError } from '@trav/core';
import type { CurrencyCode } from '@trav/core';
import type { AdapterInfo, Result } from '../../interfaces/common.js';
import type { Venue, VenueCategory, VenuesAdapter } from '../../interfaces/places.js';
import { listFixtures, loadFixture } from '../fixtures.js';

export interface VenueCatalog {
  readonly city: string;
  readonly currency: CurrencyCode;
  readonly places: readonly Venue[];
}

const CATEGORIES: ReadonlySet<string> = new Set<VenueCategory>(['restaurant', 'bar', 'activity']);
const ID_RE = /^pl_[a-z0-9_]{1,80}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(r: Record<string, unknown>, k: string, label: string): string {
  const v = r[k];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new TravError('invalid_argument', `${label}: "${k}" must be a non-empty string`);
  }
  return v;
}

/** Validates one catalog file; throws `invalid_argument` on any malformed place. */
export function parseVenueCatalog(raw: unknown, label = 'places catalog'): VenueCatalog {
  if (!isRecord(raw)) throw new TravError('invalid_argument', `${label}: not an object`);
  const city = str(raw, 'city', label);
  const currency = str(raw, 'currency', label);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new TravError('invalid_argument', `${label}: bad currency "${currency}"`);
  }
  if (!Array.isArray(raw['places'])) {
    throw new TravError('invalid_argument', `${label}: "places" must be an array`);
  }
  const seen = new Set<string>();
  const places = raw['places'].map((p: unknown, i: number): Venue => {
    const at = `${label} places[${String(i)}]`;
    if (!isRecord(p)) throw new TravError('invalid_argument', `${at}: not an object`);
    const placeId = str(p, 'placeId', at);
    if (!ID_RE.test(placeId) || seen.has(placeId)) {
      throw new TravError('invalid_argument', `${at}: bad or duplicate placeId "${placeId}"`);
    }
    seen.add(placeId);
    const category = str(p, 'category', at);
    if (!CATEGORIES.has(category)) {
      throw new TravError('invalid_argument', `${at}: bad category "${category}"`);
    }
    const level = p['priceLevel'];
    if (level !== 1 && level !== 2 && level !== 3 && level !== 4) {
      throw new TravError('invalid_argument', `${at}: priceLevel must be 1-4`);
    }
    const per = p['perPersonMinor'];
    if (typeof per !== 'number' || !Number.isSafeInteger(per) || per < 0) {
      throw new TravError(
        'invalid_argument',
        `${at}: perPersonMinor must be a non-negative integer`,
      );
    }
    const tags = p['tags'];
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
      throw new TravError('invalid_argument', `${at}: tags must be strings`);
    }
    // Suggestion lines open on the kind (VOICE: lowercase sentence starts).
    const kind = str(p, 'kind', at);
    if (kind[0] !== kind[0]!.toLowerCase()) {
      throw new TravError('invalid_argument', `${at}: kind must start lowercase`);
    }
    if (typeof p['adultsOnly'] !== 'boolean') {
      throw new TravError('invalid_argument', `${at}: adultsOnly must be a boolean`);
    }
    // Anything with alcohol is adults-only, whatever the row says (SAFETY minors).
    const adultsOnly = p['adultsOnly'] || category === 'bar' || tags.includes('alcohol');
    return {
      placeId,
      name: str(p, 'name', at),
      category: category as VenueCategory,
      kind,
      area: str(p, 'area', at),
      city,
      priceLevel: level,
      perPersonMinor: per,
      currency: currency as CurrencyCode,
      tags: tags as string[],
      adultsOnly,
    };
  });
  return { city, currency: currency as CurrencyCode, places };
}

/** Every catalog under `fixtures/places/`. */
export function loadVenueCatalogs(): readonly VenueCatalog[] {
  return listFixtures('places').map((name) =>
    parseVenueCatalog(loadFixture('places', name), `fixtures/places/${name}.json`),
  );
}

export interface MockVenuesOptions {
  /** Default: every catalog under `fixtures/places/`. */
  readonly catalogs?: readonly VenueCatalog[];
}

function foldCity(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function createMockVenues(options: MockVenuesOptions = {}): VenuesAdapter {
  const catalogs = options.catalogs ?? loadVenueCatalogs();
  const info: AdapterInfo = { provider: 'mock-places', mode: 'mock' };
  const byCity = new Map(catalogs.map((c) => [foldCity(c.city), c] as const));
  return {
    info,
    cities: () => catalogs.map((c) => c.city),
    search(req): Promise<Result<readonly Venue[]>> {
      const catalog = byCity.get(foldCity(req.city));
      if (catalog === undefined) {
        return Promise.resolve({
          ok: false,
          error: { code: 'not_found', message: `no places for ${req.city}`, retryable: false },
        });
      }
      return Promise.resolve({
        ok: true,
        value: catalog.places.filter((p) => p.category === req.category),
      });
    },
  };
}

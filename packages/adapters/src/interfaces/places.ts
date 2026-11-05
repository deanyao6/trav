/**
 * Places to eat, drink and do things (T-167). Read-only: Trav suggests, it
 * never books a table here (no money-moving method exists on this interface).
 * Shaped after a places/reviews search (a price level 1-4, an area, a typical
 * spend per person); v0 ships only the mock (`createMockVenues`).
 */
import type { CurrencyCode } from '@trav/core';
import type { AdapterInfo, Result } from './common.js';

export type VenueCategory = 'restaurant' | 'bar' | 'activity';

export interface Venue {
  readonly placeId: string;
  readonly name: string;
  readonly category: VenueCategory;
  /** What it is, in a few words ("tapas", "cocktail bar", "bike tour"). */
  readonly kind: string;
  readonly area: string;
  readonly city: string;
  readonly priceLevel: 1 | 2 | 3 | 4;
  /** Typical spend per person, integer minor units of `currency`. 0 = free. */
  readonly perPersonMinor: number;
  readonly currency: CurrencyCode;
  readonly tags: readonly string[];
  /** Bars and anything with alcohol or nightlife: never suggested with a minor along. */
  readonly adultsOnly: boolean;
}

export interface VenueSearchRequest {
  readonly city: string;
  readonly category: VenueCategory;
}

export interface VenuesAdapter {
  readonly info: AdapterInfo;
  /** Cities the adapter has places for (case-sensitive display names). */
  cities(): readonly string[];
  /** Every place of that category in the city, in catalog order; unknown city ⇒ `not_found`. */
  search(req: VenueSearchRequest): Promise<Result<readonly Venue[]>>;
}

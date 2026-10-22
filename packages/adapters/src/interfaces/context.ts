/**
 * Read-only context providers: FX rates, weather, places, calendar files.
 * Real candidates (see research/connectors.md): Frankfurter (ECB rates, no key),
 * Open-Meteo (free tier is non-commercial only), Google Places API (New) /
 * OpenStreetMap, ICS import/export. v0 uses fixture-backed mocks.
 */
import type {
  AdapterInfo,
  CurrencyCode,
  GeoPoint,
  IsoDate,
  IsoDateTime,
  MemberId,
  Place,
  Result,
  TimeZone,
} from './common.js';

// ---------- FX ----------

export interface FxRate {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  /** Units of `quote` per 1 unit of `base`, as a decimal string to avoid float drift (e.g. "1.0842"). */
  readonly rate: string;
  /** The date the rate applies to (weekends/holidays fall back to the previous business day). */
  readonly asOf: IsoDate;
  readonly source: string;
}

export interface FxRatesAdapter {
  readonly info: AdapterInfo;

  /** Reference rate for converting `base` to `quote` on a date (default: latest). */
  getRate(base: CurrencyCode, quote: CurrencyCode, on?: IsoDate): Promise<Result<FxRate>>;
}

// ---------- Weather ----------

export interface DailyForecast {
  readonly date: IsoDate;
  readonly tempMinC: number;
  readonly tempMaxC: number;
  readonly precipitationProbability: number;
  /** Short normalized condition, e.g. "sunny", "rain", "cloudy". */
  readonly condition: string;
}

export interface WeatherAdapter {
  readonly info: AdapterInfo;

  /** Daily forecast for a location over a date range (forecast horizon is provider-limited). */
  getDailyForecast(
    at: GeoPoint,
    from: IsoDate,
    to: IsoDate,
  ): Promise<Result<readonly DailyForecast[]>>;
}

// ---------- Places ----------

export interface PlaceSearchRequest {
  readonly query: string;
  readonly near: GeoPoint;
  readonly radiusKm?: number;
  readonly openAt?: IsoDateTime;
  readonly limit?: number;
}

export interface PlaceResult {
  readonly placeId: string;
  readonly place: Place;
  readonly categories: readonly string[];
  readonly rating?: number;
  /** 1-4 price level, if known. */
  readonly priceLevel?: number;
  /** Venue serves alcohol or is nightlife-only; used by the minors rule. */
  readonly adultOriented: boolean;
  readonly url?: string;
}

export interface PlacesAdapter {
  readonly info: AdapterInfo;

  /** Text search for places near a point. Read-only. */
  search(request: PlaceSearchRequest): Promise<Result<readonly PlaceResult[]>>;

  /** Walking/transit travel time in minutes between two points. */
  travelMinutes(
    from: GeoPoint,
    to: GeoPoint,
    mode: 'walk' | 'transit' | 'drive',
  ): Promise<Result<number>>;
}

// ---------- Calendar ----------

export interface CalendarBlock {
  readonly memberId: MemberId;
  readonly title: string;
  readonly start: IsoDateTime;
  readonly end: IsoDateTime;
  readonly timeZone: TimeZone;
  /** "busy" blocks (e.g. Dad's conference) constrain group plans; details may be private. */
  readonly busy: boolean;
  readonly private: boolean;
}

export interface CalendarAdapter {
  readonly info: AdapterInfo;

  /** Parse an ICS file a member shared into busy blocks for that member only. */
  importIcs(memberId: MemberId, icsText: string): Promise<Result<readonly CalendarBlock[]>>;

  /** Render trip items (flights, bookings, events) as an ICS file members can add. */
  exportIcs(
    events: readonly {
      readonly title: string;
      readonly start: IsoDateTime;
      readonly end: IsoDateTime;
      readonly location?: string;
    }[],
  ): Promise<Result<string>>;
}

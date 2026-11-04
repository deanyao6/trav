/**
 * Trip-time windows shared by the Wrapped awards and totals (T-016). All in
 * the trip's zone: a "night" is 18:00 to 06:00 and belongs to the date it
 * started on; a "morning" is 06:00 to 14:00.
 */
import type { IsoDate, IsoDateTime, TimeZone } from '../primitives.js';
import { addDays, localDate, localHour } from '../clock.js';

export const NIGHT_START_HOUR = 18;
export const NIGHT_END_HOUR = 6;
export const MORNING_END_HOUR = 14;

export interface TripWindow {
  readonly startDate: IsoDate;
  readonly endDate: IsoDate;
  readonly timeZone: TimeZone;
}

export function isNightHour(hour: number): boolean {
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/** The night an instant belongs to (before 06:00 counts as the previous date), or `null` outside 18:00–06:00. */
export function nightOf(iso: IsoDateTime, tz: TimeZone): IsoDate | null {
  const h = localHour(iso, tz);
  if (!isNightHour(h)) return null;
  const d = localDate(iso, tz);
  return h < NIGHT_END_HOUR ? addDays(d, -1) : d;
}

/** Nights that start on a trip day before the last one (a pre-trip booking at 20:40 is not "a night"). */
export function nightOnTrip(night: IsoDate, w: TripWindow): boolean {
  return night >= w.startDate && night < w.endDate;
}

/** The trip day of an instant between 06:00 and 14:00, or `null`. */
export function morningOf(iso: IsoDateTime, w: TripWindow): IsoDate | null {
  const h = localHour(iso, w.timeZone);
  if (h < NIGHT_END_HOUR || h >= MORNING_END_HOUR) return null;
  const d = localDate(iso, w.timeZone);
  return d >= w.startDate && d <= w.endDate ? d : null;
}

/** The trip day an instant falls on (local date), or `null` outside the trip. */
export function tripDayOf(iso: IsoDateTime, w: TripWindow): IsoDate | null {
  const d = localDate(iso, w.timeZone);
  return d >= w.startDate && d <= w.endDate ? d : null;
}

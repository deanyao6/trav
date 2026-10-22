/**
 * One-line, lowercase chat text for itineraries and relax reasons (VOICE §3:
 * lowercase sentences; names, places and currencies keep their capitals; money
 * only through `formatMoney`).
 */
import { formatMoney, money } from '../money.js';
import type { CurrencyCode } from '../primitives.js';
import type { OptimizerConstraints, RelaxedConstraint } from './types.js';

/** `45 min`, `90 min`, `2h`, `2h 15m`. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 120) return `${m} min`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

const RELAX_LABELS: Readonly<Record<keyof OptimizerConstraints, string>> = {
  perPersonCap: 'cap',
  fairnessMaxAboveMedian: 'fairness limit',
  maxArrivalSpreadMinutes: 'arrival window',
  refundableOnly: 'refundable-only',
};

export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface RationaleArgs {
  readonly memberCount: number;
  readonly arrivalSpreadMinutes: number;
  readonly departureSpreadMinutes: number;
  readonly hasInbound: boolean;
  readonly worstLayoverMinutes: number;
  /** Minor units, one per member. */
  readonly perPersonMinor: readonly number[];
  readonly refundableCount: number;
  /** Minor units: total of the naive cheapest-per-person combo. */
  readonly cheapestTotalMinor: number;
  readonly currency: CurrencyCode;
  readonly relaxed: readonly RelaxedConstraint[];
}

/** Layovers shorter than this are not worth a word. */
const LAYOVER_MENTION_MINUTES = 120;

export function buildRationale(a: RationaleArgs): string {
  const parts: string[] = [];
  const fmt = (minor: number): string => formatMoney(money(minor, a.currency));

  if (a.memberCount > 1) {
    parts.push(
      a.arrivalSpreadMinutes === 0
        ? 'everyone lands together'
        : `everyone lands within ${formatMinutes(a.arrivalSpreadMinutes)}`,
    );
    if (a.hasInbound) {
      parts.push(
        a.departureSpreadMinutes === 0
          ? 'leaves together'
          : `leaves within ${formatMinutes(a.departureSpreadMinutes)}`,
      );
    }
  }

  const total = a.perPersonMinor.reduce((s, x) => s + x, 0);
  const min = Math.min(...a.perPersonMinor);
  const max = Math.max(...a.perPersonMinor);
  if (a.perPersonMinor.length === 0) {
    parts.push(fmt(0));
  } else if (min === max) {
    parts.push(a.memberCount > 1 ? `${fmt(min)} each` : fmt(min));
  } else {
    parts.push(`${fmt(min)}–${fmt(max)} each`, `${fmt(total)} total`);
  }

  if (a.refundableCount === a.memberCount) parts.push('all refundable');
  else if (a.refundableCount === 0)
    parts.push(a.memberCount > 1 ? 'none refundable' : 'non-refundable');
  else parts.push(`${a.memberCount - a.refundableCount} non-refundable`);

  if (a.worstLayoverMinutes >= LAYOVER_MENTION_MINUTES) {
    parts.push(`longest layover ${formatMinutes(a.worstLayoverMinutes)}`);
  }

  const extra = total - a.cheapestTotalMinor;
  parts.push(extra <= 0 ? 'cheapest combo' : `+${fmt(extra)} vs cheapest`);

  let line = parts.join(', ');
  if (a.relaxed.length > 0) {
    line += ` · ${joinNames(a.relaxed.map((r) => RELAX_LABELS[r.constraint]))} relaxed`;
  }
  return line;
}

/**
 * Settle-up rails (T-166, D-043): handle normalization, which rail a transfer
 * goes over, and the prefilled pay link. Pure, no I/O: links are built here
 * from the payee's handle and never fetched. Nothing in here moves money; a
 * link only opens the payer's own app with the payee, amount and note filled
 * in, and the payer still sends it themselves.
 */
import type { Money } from '../money.js';
import { currencyExponent } from '../money.js';
import type { CurrencyCode } from '../primitives.js';
import type { HandleRail, PaymentProfile, PaymentRail } from '../domain/payments.js';
import { HANDLE_RAILS, PAYMENT_RAILS, isHandleRail } from '../domain/payments.js';

/** How Trav names each rail in chat (VOICE §4.6: lowercase, no brand styling). */
export const RAIL_LABEL: Readonly<Record<PaymentRail, string>> = {
  venmo: 'venmo',
  cashapp: 'cash app',
  paypal: 'paypal',
  zelle: 'zelle',
  apple_cash: 'apple cash',
  cash: 'cash',
};

/**
 * Currencies a rail can send. `null` = any (PayPal converts; cash is cash).
 * Venmo, Zelle and Apple Cash are US-dollar only; Cash App is USD and GBP.
 */
export const RAIL_CURRENCIES: Readonly<Record<PaymentRail, readonly CurrencyCode[] | null>> = {
  venmo: ['USD'],
  cashapp: ['USD', 'GBP'],
  paypal: null,
  zelle: ['USD'],
  apple_cash: ['USD'],
  cash: null,
};

export function railNeedsHandle(rail: PaymentRail): rail is HandleRail {
  return isHandleRail(rail);
}

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;

/**
 * A handle as the member typed it, normalized for storage, or `undefined` if
 * it isn't one: venmo `@chase-w` → `chase-w` (5-30 of letters, digits, `-`,
 * `_`); cash app `$chasew` → `chasew` (1-20, at least one letter); paypal
 * `paypal.me/chasew` → `chasew` (1-20 letters and digits); zelle an email
 * (lowercased) or a US phone number → `+16175550142`.
 */
export function normalizeHandle(rail: HandleRail, raw: string): string | undefined {
  const t = raw.trim().replace(/[.,;!?)]+$/u, '');
  if (t.length === 0 || t.length > 254) return undefined;
  switch (rail) {
    case 'venmo': {
      const h = t.replace(/^(?:https?:\/\/)?(?:www\.)?venmo\.com\/(?:u\/)?/i, '').replace(/^@/, '');
      return /^[A-Za-z0-9_-]{5,30}$/.test(h) ? h : undefined;
    }
    case 'cashapp': {
      const h = t.replace(/^(?:https?:\/\/)?cash\.app\//i, '').replace(/^\$/, '');
      return /^[A-Za-z0-9_-]{1,20}$/.test(h) && /[A-Za-z]/.test(h) ? h : undefined;
    }
    case 'paypal': {
      const h = t.replace(/^(?:https?:\/\/)?(?:www\.)?paypal\.me\//i, '').replace(/^@/, '');
      return /^[A-Za-z0-9]{1,20}$/.test(h) ? h : undefined;
    }
    case 'zelle': {
      if (EMAIL.test(t)) return t.toLowerCase();
      if (!/^[+\d\s().-]+$/.test(t)) return undefined;
      const digits = t.replace(/\D/g, '');
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
      return undefined;
    }
  }
}

/** A stored handle the way people write it: `@chase-w`, `$chasew`, `paypal.me/chasew`, `(617) 555-0142`. */
export function displayHandle(rail: HandleRail, handle: string): string {
  switch (rail) {
    case 'venmo':
      return `@${handle}`;
    case 'cashapp':
      return `$${handle}`;
    case 'paypal':
      return `paypal.me/${handle}`;
    case 'zelle': {
      const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(handle);
      return m === null ? handle : `(${m[1]!}) ${m[2]!}-${m[3]!}`;
    }
  }
}

/**
 * Every rail the member can be paid on, best first: the favourite, then the
 * apps in the order they said them, then any rail they only gave a handle for
 * (a handle means they have the app).
 */
export function railsOf(profile: PaymentProfile | undefined): PaymentRail[] {
  if (profile === undefined) return [];
  const out: PaymentRail[] = [];
  const add = (r: PaymentRail): void => {
    if (!out.includes(r)) out.push(r);
  };
  if (profile.favourite !== undefined) add(profile.favourite);
  for (const r of profile.apps) add(r);
  for (const r of HANDLE_RAILS) if (profile.handles[r] !== undefined) add(r);
  return out;
}

/** The rail is usable to pay this payee: it needs no handle, or the payee gave one. */
function reachable(payee: PaymentProfile, rail: PaymentRail): boolean {
  return !railNeedsHandle(rail) || payee.handles[rail] !== undefined;
}

export interface PayeeOption {
  readonly rail: PaymentRail;
  /** Stored handle (`normalizeHandle`), for a rail that needs one. */
  readonly handle?: string;
}

export type RailChoice =
  /** Both sides have it and the payee is reachable on it. */
  | { readonly kind: 'rail'; readonly rail: PaymentRail; readonly handle?: string }
  /** They share `rail` but the payee never gave Trav a handle for it (nor for any other shared rail). */
  | { readonly kind: 'missing_handle'; readonly rail: HandleRail }
  /** No app in common: say so and offer what the payee takes. */
  | { readonly kind: 'none_shared'; readonly payeeOptions: readonly PayeeOption[] }
  /** The payee hasn't told Trav anything: no rail to suggest. */
  | { readonly kind: 'unknown' };

/**
 * The rail for one transfer (T-166): among the rails both sides have, the
 * payee's favourite, then the payer's favourite, then the payee's other apps
 * in their order, skipping any the payee can't be reached on (no handle).
 * A payer who hasn't told Trav their apps is treated as having all of them, so
 * the payee's own preference decides. Nothing in common ⇒ `none_shared` with
 * the payee's reachable rails (the caller offers them to the payer in DM).
 */
export function chooseRail(
  payer: PaymentProfile | undefined,
  payee: PaymentProfile | undefined,
): RailChoice {
  const payeeRails = railsOf(payee);
  if (payee === undefined || payeeRails.length === 0) return { kind: 'unknown' };
  const payerRails = railsOf(payer);
  const payerKnown = payerRails.length > 0;
  const shared = payerKnown ? payeeRails.filter((r) => payerRails.includes(r)) : payeeRails;
  if (shared.length === 0) {
    return {
      kind: 'none_shared',
      payeeOptions: payeeRails
        .filter((r) => reachable(payee, r))
        .map((rail) => (railNeedsHandle(rail) ? { rail, handle: payee.handles[rail]! } : { rail })),
    };
  }
  const order: PaymentRail[] = [];
  const add = (r: PaymentRail | undefined): void => {
    if (r !== undefined && shared.includes(r) && !order.includes(r)) order.push(r);
  };
  add(payee.favourite);
  add(payer?.favourite);
  for (const r of shared) add(r);
  for (const rail of order) {
    if (!reachable(payee, rail)) continue;
    const handle = railNeedsHandle(rail) ? payee.handles[rail] : undefined;
    return handle !== undefined ? { kind: 'rail', rail, handle } : { kind: 'rail', rail };
  }
  const first = order.find(railNeedsHandle);
  // Every shared rail needs a handle the payee hasn't given (rails without one are always reachable).
  return first !== undefined ? { kind: 'missing_handle', rail: first } : { kind: 'unknown' };
}

/** Whether `rail` sends `currency` as is. */
export function railTakes(rail: PaymentRail, currency: CurrencyCode): boolean {
  const list = RAIL_CURRENCIES[rail];
  return list === null || list.includes(currency);
}

/** The currency to send a `currency` transfer in over `rail`: itself if the rail takes it, else the rail's first. */
export function railCurrency(rail: PaymentRail, currency: CurrencyCode): CurrencyCode {
  const list = RAIL_CURRENCIES[rail];
  return list === null || list.includes(currency) ? currency : list[0]!;
}

/** "22.62" from 2262 USD minor units; "1500" for JPY. Integer math only. */
export function decimalAmount(m: Money): string {
  const exp = currencyExponent(m.currency);
  const abs = Math.abs(m.amountMinor);
  const sign = m.amountMinor < 0 ? '-' : '';
  if (exp === 0) return `${sign}${String(abs)}`;
  const unit = 10 ** exp;
  return `${sign}${String(Math.floor(abs / unit))}.${String(abs % unit).padStart(exp, '0')}`;
}

export const MAX_PAY_NOTE_CHARS = 60;

/** A pay-link note: printable letters, digits, spaces and light punctuation only, at most 60 chars. */
export function payNote(text: string): string {
  const clean = text
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} .,'&()·-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, MAX_PAY_NOTE_CHARS).trim();
}

export interface PayLinkInput {
  readonly rail: HandleRail;
  /** Stored handle (`normalizeHandle`). */
  readonly handle: string;
  /** In a currency the rail takes; absent ⇒ the link opens with the payee only, amount left to type. */
  readonly amount?: Money;
  /** `payNote` is applied. Venmo is the only rail whose link carries it. */
  readonly note: string;
}

/**
 * The prefilled link for paying a payee, built locally, or `undefined` for a
 * rail with no link (Zelle lives in each bank's app: copy the contact). Venmo:
 * the app's `venmo://paycharge` deep link with recipient, amount and note.
 * Cash App: `cash.app/$tag/amount`. PayPal: `paypal.me/name/amountCUR`.
 * A positive amount is required for it to be filled in.
 */
export function payLink(input: PayLinkInput): string | undefined {
  const amount =
    input.amount !== undefined &&
    input.amount.amountMinor > 0 &&
    railTakes(input.rail, input.amount.currency)
      ? input.amount
      : undefined;
  const h = encodeURIComponent(input.handle);
  switch (input.rail) {
    case 'venmo': {
      const params = [`txn=pay`, `recipients=${h}`];
      if (amount !== undefined) params.push(`amount=${decimalAmount(amount)}`);
      const note = payNote(input.note);
      if (note.length > 0) params.push(`note=${encodeURIComponent(note)}`);
      return `venmo://paycharge?${params.join('&')}`;
    }
    case 'cashapp':
      return `https://cash.app/$${h}${amount !== undefined ? `/${decimalAmount(amount)}` : ''}`;
    case 'paypal':
      return `https://paypal.me/${h}${amount !== undefined ? `/${decimalAmount(amount)}${amount.currency}` : ''}`;
    case 'zelle':
      return undefined;
  }
}

export { PAYMENT_RAILS, HANDLE_RAILS };

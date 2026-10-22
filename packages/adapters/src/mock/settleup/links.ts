/**
 * Payout handles and mock pay links for the settle-up mock (T-008-b).
 *
 * Links point at the reserved `.test` domain (`https://pay.example.test/...`),
 * so a tap in the simulator can never reach a real payment app or move real
 * money. A real adapter would build the provider's own prefilled link
 * (PayPal.me, revolut.me, monzo.me) or, where none is documented (Venmo,
 * Bizum), show the handle and amount (research/connectors.md rows 26-29).
 *
 * Pure functions; no I/O.
 */
import type { Money } from '@trav/core';
import { currencyExponent } from '@trav/core';
import type { PaymentLink, PaymentMethodKind, PayoutHandle } from '../../interfaces/payments.js';

export const MOCK_PAY_LINK_BASE = 'https://pay.example.test';

export const PAYMENT_METHODS: readonly PaymentMethodKind[] = [
  'venmo',
  'paypal',
  'revolut',
  'bizum',
  'monzo',
  'cash_app',
  'bank_transfer',
  'cash',
];

const METHOD_LABEL: Readonly<Record<PaymentMethodKind, string>> = {
  venmo: 'Venmo',
  paypal: 'PayPal',
  revolut: 'Revolut',
  bizum: 'Bizum',
  monzo: 'Monzo',
  cash_app: 'Cash App',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
};

/** Methods with no link: you hand over cash, or you open your own banking app. */
const NO_LINK: ReadonlySet<PaymentMethodKind> = new Set(['bank_transfer', 'cash']);

export const MAX_HANDLE_CHARS = 64;

export function isPaymentMethod(v: unknown): v is PaymentMethodKind {
  return typeof v === 'string' && (PAYMENT_METHODS as readonly string[]).includes(v);
}

/**
 * Why a handle is unacceptable, or `undefined` if it is fine. Handles are
 * usernames (`@henry-b`, a PayPal.me name), never a bank account, IBAN, card,
 * or phone number: handles are shown to the members who owe the payee, so
 * the mock refuses anything that looks like personal financial data.
 */
export function handleProblem(handle: unknown): string | undefined {
  if (typeof handle !== 'string') return 'handle must be text';
  const h = handle.trim();
  if (h.length === 0) return 'handle required';
  if (h.length > MAX_HANDLE_CHARS) return `handle must be at most ${MAX_HANDLE_CHARS} characters`;
  if (/[\s\p{Cc}]/u.test(h)) return 'handle must not contain spaces or control characters';
  // Any separator (`-`, `.`, `_`, `/`, letters...) can hide a card or account
  // number, so count every digit in the handle, not just runs.
  const digits = h.replace(/\D/g, '').length;
  const compact = h.replace(/[^A-Za-z0-9]/g, '');
  if (digits >= 10 || /\d{7,}/.test(compact)) {
    return 'handle looks like an account, card, or phone number; use a username';
  }
  if (/^[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}$/.test(compact)) {
    return 'handle looks like an IBAN; use a username';
  }
  return undefined;
}

/** "12.34" from 1234 EUR minor units; "1500" for JPY. Integer math only. */
export function decimalAmount(m: Money): string {
  const exp = currencyExponent(m.currency);
  const sign = m.amountMinor < 0 ? '-' : '';
  const abs = Math.abs(m.amountMinor);
  if (exp === 0) return `${sign}${abs}`;
  const unit = 10 ** exp;
  const whole = Math.floor(abs / unit);
  const frac = String(abs % unit).padStart(exp, '0');
  return `${sign}${whole}.${frac}`;
}

function linkFor(h: PayoutHandle, amount: Money, note: string): PaymentLink {
  const label = h.method === 'cash' ? 'Cash' : `${METHOD_LABEL[h.method]} ${h.handle}`;
  if (NO_LINK.has(h.method)) return { method: h.method, label };
  const params = new URLSearchParams({
    amount: decimalAmount(amount),
    currency: amount.currency,
    note,
  });
  const url = `${MOCK_PAY_LINK_BASE}/${h.method}/${encodeURIComponent(h.handle)}?${params.toString()}`;
  return { method: h.method, label, url };
}

/**
 * Links for paying `amount` to a payee with these handles, in the payee's
 * order, plus a trailing "Cash" option (always possible between friends) when
 * the payee has no cash handle.
 */
export function buildPaymentLinks(
  handles: readonly PayoutHandle[],
  amount: Money,
  note: string,
): PaymentLink[] {
  const links = handles.map((h) => linkFor(h, amount, note));
  if (!handles.some((h) => h.method === 'cash')) links.push({ method: 'cash', label: 'Cash' });
  return links;
}

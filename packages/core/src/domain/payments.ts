/**
 * Payment profiles (T-166, D-043): which person-to-person payment apps a
 * member has, which one they like best, and their handles. Owner-private: it
 * lives in the member's `PrivateStore` partition and only the payer of a
 * transfer ever sees the payee's handle for that transfer (in a DM). No money
 * moves through Trav; these feed locally built pay links.
 */
import type { IsoDateTime, MemberId } from '../primitives.js';

/** Person-to-person rails Trav knows about, in the order Trav lists them. */
export type PaymentRail = 'venmo' | 'cashapp' | 'paypal' | 'zelle' | 'apple_cash' | 'cash';

export const PAYMENT_RAILS: readonly PaymentRail[] = [
  'venmo',
  'cashapp',
  'paypal',
  'zelle',
  'apple_cash',
  'cash',
];

/** Rails a payee can be reached on only with a handle (username, cashtag, PayPal.me name, Zelle email/phone). */
export type HandleRail = 'venmo' | 'cashapp' | 'paypal' | 'zelle';

export const HANDLE_RAILS: readonly HandleRail[] = ['venmo', 'cashapp', 'paypal', 'zelle'];

export function isPaymentRail(v: unknown): v is PaymentRail {
  return typeof v === 'string' && (PAYMENT_RAILS as readonly string[]).includes(v);
}

export function isHandleRail(v: unknown): v is HandleRail {
  return typeof v === 'string' && (HANDLE_RAILS as readonly string[]).includes(v);
}

export interface PaymentProfile {
  readonly memberId: MemberId;
  /** Apps the member said they have, in the order they said them. Empty = not told yet. */
  readonly apps: readonly PaymentRail[];
  readonly favourite?: PaymentRail;
  /** Normalized handles (`payments.normalizeHandle`): venmo/cashapp/paypal without the sigil, zelle an email or +1 phone. */
  readonly handles: Readonly<Partial<Record<HandleRail, string>>>;
  /** When Trav asked "which apps do you use?" in DM. Set once; Trav never asks again. */
  readonly askedAt?: IsoDateTime;
  /** What prompted the one ask. */
  readonly askedFor?: 'sign_up' | 'first_balance';
  /** When the member answered with their apps. */
  readonly answeredAt?: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

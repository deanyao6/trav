/**
 * How each payer pays each transfer (T-166, D-043): the rail both sides
 * share (`payments.chooseRail`), the amount in that rail's currency, the
 * prefilled link, and the one DM that carries them to the payer.
 *
 * Privacy (SAFETY §2.3): the payee's handle, Zelle contact and other apps go
 * to the payer of that transfer only, in their DM. The group card names the
 * rail and nothing else. Links are built locally (`payments.payLink`) and
 * never fetched. No money moves: the payer sends it in their own app.
 *
 * Currency: Venmo, Zelle and Apple Cash send dollars only, Cash App dollars
 * or pounds. A transfer in another trip currency is converted at the mock
 * reference rate for today (D-036's table, never live) and shown both ways
 * ("€20.70 (≈$22.62)"). No rate ⇒ the link opens with the payee only and the
 * DM says to type the amount.
 */
import { createHash } from 'node:crypto';
import type {
  CurrencyCode,
  FxQuote,
  IsoDateTime,
  Member,
  MemberId,
  Money,
  OutboundMessage,
  PaymentProfile,
  PaymentRail,
  Stores,
  Transfer,
  Trip,
} from '@trav/core';
import { convertByRate, formatMoney, payments } from '@trav/core';
import type { FxRatesAdapter } from '@trav/adapters';
import { fxQuoteFor } from '../ingest/chatExpense.js';
import { sanitizeInline } from '../context/groupContext.js';

const { RAIL_LABEL, chooseRail, displayHandle, payLink, railCurrency, railNeedsHandle } = payments;

export interface PayDetail {
  readonly transfer: Transfer;
  readonly choice: payments.RailChoice;
  /** `choice.kind === 'rail'`: what to send in the rail's currency (absent: no rate to convert with). */
  readonly send?: Money;
  /** The prefilled link (Venmo, Cash App, PayPal). */
  readonly link?: string;
}

export interface PayDetailsInput {
  readonly stores: Stores;
  readonly trip: Pick<Trip, 'name' | 'currency' | 'timeZone'>;
  readonly transfers: readonly Transfer[];
  readonly now: IsoDateTime;
  readonly fx?: FxRatesAdapter;
}

/** The pay-link note: "<trip name> settle-up", clean and short. */
export function settleNote(tripName: string): string {
  return payments.payNote(`${tripName} settle-up`);
}

/** Rail choice, amount and link per transfer. Reads both members' private profiles; returns nothing for the group. */
export async function payDetailsFor(input: PayDetailsInput): Promise<PayDetail[]> {
  const profile = (id: MemberId): PaymentProfile | undefined =>
    input.stores.private.getPaymentProfile(id);
  const quotes = new Map<CurrencyCode, FxQuote | undefined>();
  const quote = async (to: CurrencyCode): Promise<FxQuote | undefined> => {
    if (!quotes.has(to)) quotes.set(to, await fxQuoteFor(input.fx, input.trip, to, input.now));
    return quotes.get(to);
  };
  const note = settleNote(input.trip.name);
  const out: PayDetail[] = [];
  for (const transfer of input.transfers) {
    const choice = chooseRail(profile(transfer.from), profile(transfer.to));
    if (choice.kind !== 'rail') {
      out.push({ transfer, choice });
      continue;
    }
    const target = railCurrency(choice.rail, transfer.amount.currency);
    let send: Money | undefined = transfer.amount;
    if (target !== transfer.amount.currency) {
      const q = await quote(target);
      send = q === undefined ? undefined : convertByRate(transfer.amount, target, q.rate);
    }
    const link =
      choice.handle !== undefined && railNeedsHandle(choice.rail)
        ? payLink({
            rail: choice.rail,
            handle: choice.handle,
            ...(send !== undefined ? { amount: send } : {}),
            note,
          })
        : undefined;
    out.push({
      transfer,
      choice,
      ...(send !== undefined ? { send } : {}),
      ...(link !== undefined ? { link } : {}),
    });
  }
  return out;
}

/** A handle as it may appear in an audit row: a short one-way digest, never the handle (SAFETY §2.3). */
function handleDigest(handle: string | undefined): string {
  return handle === undefined ? '' : createHash('sha256').update(handle).digest('hex').slice(0, 12);
}

/**
 * The dedupe key for one DM about one transfer: a new DM only when something
 * about it changed (rail, amount, or a payee's handle). It is stored in the
 * audit log, so handles go in as digests only.
 */
export function detailKey(d: PayDetail): string {
  const c = d.choice;
  const how =
    c.kind === 'rail'
      ? `rail:${c.rail}:${handleDigest(c.handle)}`
      : c.kind === 'missing_handle'
        ? `missing:${c.rail}`
        : c.kind === 'none_shared'
          ? `none:${c.payeeOptions.map((o) => `${o.rail}=${handleDigest(o.handle)}`).join(',')}`
          : 'unknown';
  return `${d.transfer.from}>${d.transfer.to}:${String(d.transfer.amount.amountMinor)}:${how}`;
}

function amountPhrase(d: PayDetail): string {
  const owed = formatMoney(d.transfer.amount);
  const send = d.send;
  return send !== undefined && send.currency !== d.transfer.amount.currency
    ? `${owed} (≈${formatMoney(send)})`
    : owed;
}

const SENT_HINT = "tap Sent on the group card once it's gone";

/**
 * The payer's DM for one transfer (VOICE §4.6 E): at most 3 lines, a link
 * only as the bare last line (VOICE §3.8). `undefined` when there is nothing
 * useful to say (the payee never told Trav anything).
 */
export function payerDmLines(d: PayDetail, payeeName: string): string[] | undefined {
  const c = d.choice;
  const amount = amountPhrase(d);
  const payee = sanitizeInline(payeeName, 40);
  switch (c.kind) {
    case 'unknown':
      return undefined;
    case 'missing_handle':
      return [
        `your settle: ${amount} to ${payee}. you both have ${RAIL_LABEL[c.rail]}, but ${payee} hasn't given me a handle yet`,
        `i asked, and i'll send you the link when it's in`,
      ];
    case 'none_shared': {
      const offers = c.payeeOptions.map((o) =>
        o.handle !== undefined && railNeedsHandle(o.rail)
          ? `${RAIL_LABEL[o.rail]} ${displayHandle(o.rail, o.handle)}`
          : RAIL_LABEL[o.rail],
      );
      return [
        `your settle: ${amount} to ${payee}. you two don't have a payment app in common`,
        offers.length > 0
          ? `${payee} takes ${offers.join(' · ')}. ${SENT_HINT}`
          : `sort it out with ${payee} directly, then ${SENT_HINT}`,
      ];
    }
    case 'rail': {
      const rail = c.rail;
      const head = `your settle: ${amount} to ${payee} ${rail === 'cash' ? 'in cash' : `on ${RAIL_LABEL[rail]}`}`;
      if (d.link !== undefined) {
        const filled =
          d.send === undefined
            ? `${RAIL_LABEL[rail]} is in ${railCurrency(rail, d.transfer.amount.currency)} and i don't have today's rate, so type the amount. ${SENT_HINT}`
            : rail === 'venmo'
              ? `it opens with ${payee}, the amount and the note filled in. ${SENT_HINT}`
              : `it opens with ${payee} and the amount filled in. ${SENT_HINT}`;
        return [head, filled, d.link];
      }
      if (rail === 'zelle' && c.handle !== undefined) {
        return [
          head,
          `zelle has no links, so copy ${payee}'s zelle into your bank app: ${displayHandle('zelle', c.handle)}`,
          SENT_HINT,
        ];
      }
      if (rail === 'apple_cash')
        return [head, `send it in your messages with ${payee}, then ${SENT_HINT}`];
      return [head, `hand it over, then ${SENT_HINT}`];
    }
  }
}

/** The payee's DM when a payer can't pay them for want of a handle (VOICE §4.6 E). */
export function handleAskLines(
  rail: payments.RailChoice & { kind: 'missing_handle' },
  payerName: string,
  amount: Money,
): string[] {
  const payer = sanitizeInline(payerName, 40);
  const example: Readonly<Record<string, string>> = {
    venmo: '"my venmo is @your-name"',
    cashapp: '"my cashtag is $yourname"',
    paypal: '"my paypal is paypal.me/yourname"',
    zelle: '"my zelle is you@email.com"',
  };
  return [
    `${payer} owes you ${formatMoney(amount)} and you both have ${RAIL_LABEL[rail.rail]}. what's your handle?`,
    `${example[rail.rail] ?? ''} and i'll send ${payer} a link. it only goes to people paying you`,
  ];
}

export interface PayDms {
  readonly dms: readonly OutboundMessage[];
  /** `from|to` → rail, for the group card's "· venmo". */
  readonly rails: ReadonlyMap<string, PaymentRail>;
}

/**
 * The payer DMs (and payee handle asks) for these details, minus anything
 * already sent for the same transfer in the same state (owner-only
 * `settlement.pay_details_sent` audit rows, rail and amount only, never a
 * handle). Records the rows as it builds the DMs.
 */
export function payDms(input: {
  readonly stores: Stores;
  readonly ids: { next(prefix: string): string };
  readonly groupId: string;
  readonly tripId: string;
  readonly members: readonly Member[];
  readonly details: readonly PayDetail[];
}): PayDms {
  const { stores } = input;
  const nameOf = (id: MemberId): string =>
    input.members.find((m) => m.memberId === id)?.displayName ?? 'them';
  const rails = new Map<string, PaymentRail>();
  const already = new Set(
    stores.group.audit
      .listByGroup(input.groupId)
      .filter((e) => e.type === 'settlement.pay_details_sent' && e.tripId === input.tripId)
      .map((e) => String(e.payload['key'])),
  );
  const dms: OutboundMessage[] = [];
  const note = (ownerId: MemberId, key: string, payload: Record<string, unknown>): void => {
    already.add(key);
    stores.group.audit.append({
      groupId: input.groupId,
      tripId: input.tripId,
      type: 'settlement.pay_details_sent',
      actor: { kind: 'trav', id: 'trav' },
      visibility: 'owner',
      ownerId,
      payload: { key, ...payload, moneyMoved: false },
    });
  };
  for (const d of input.details) {
    const { from, to, amount } = d.transfer;
    if (d.choice.kind === 'rail') rails.set(`${from}|${to}`, d.choice.rail);
    const key = detailKey(d);
    const lines = payerDmLines(d, nameOf(to));
    if (lines !== undefined && !already.has(key)) {
      note(from, key, {
        from,
        to,
        amountMinor: amount.amountMinor,
        currency: amount.currency,
        kind: d.choice.kind,
        ...(d.choice.kind === 'rail' ? { rail: d.choice.rail, link: d.link !== undefined } : {}),
      });
      dms.push({
        id: input.ids.next('msg'),
        groupId: input.groupId,
        to: { kind: 'member', memberId: from },
        text: lines.join('\n'),
      });
    }
    if (d.choice.kind === 'missing_handle') {
      const askKey = `handle_ask>${to}:${d.choice.rail}`;
      if (!already.has(askKey)) {
        note(to, askKey, { to, kind: 'handle_ask', rail: d.choice.rail });
        dms.push({
          id: input.ids.next('msg'),
          groupId: input.groupId,
          to: { kind: 'member', memberId: to },
          text: handleAskLines(d.choice, nameOf(from), amount).join('\n'),
        });
      }
    }
  }
  return { dms, rails };
}

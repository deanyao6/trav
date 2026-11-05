/**
 * Daily settle-up (VOICE §4.6, card `settle_up`). Running mode shows net
 * positions; final mode shows the minimal transfer list from
 * `ledger.settle`. Balances must sum to zero to the cent (the card carries the
 * proof) or rendering throws. Minors never appear as debtor or creditor
 * (VOICE §8): balances from `ledger.tripLedger` are already folded; any minor
 * row passed here anyway is folded into the guardian (see `foldMinorBalances`),
 * and a supplied transfer naming a minor is an invariant violation. A family
 * tab (`familyTab`) shows zero nets and no transfers. A final card lists the
 * transfers members said they paid (`paid`, T-141) as "· paid" rows next to
 * the open ones; [Paid] is offered to debtors with an open row only.
 */
import type {
  Balance,
  CurrencyCode,
  IsoDateTime,
  MemberId,
  Money,
  OutboundMessage,
  SettleUpCard,
  Transfer,
} from '@trav/core';
import { TravError, formatMoney, formatTransfer, ledger, money, safety } from '@trav/core';
import type { RenderContext } from './common.js';
import { GROUP, action, cardMessage, nameOf } from './common.js';

export interface SettleUpRenderInput {
  readonly mode: 'running' | 'final';
  readonly currency: CurrencyCode;
  readonly balances: readonly Balance[];
  /** Default: `ledger.settle(balances)`. */
  readonly transfers?: readonly Transfer[];
  /**
   * Final mode: transfers members already said they paid (T-141,
   * `TripLedger.paid`). Listed with "· paid" and `paid: true`, alongside the
   * open `transfers` (which settle `balances`, already net of these). Ignored
   * in running mode and on a family tab.
   */
  readonly paid?: readonly Transfer[];
  readonly totalSpent: Money;
  readonly dayNumber?: number;
  /** Default: ctx.now. */
  readonly asOf?: IsoDateTime;
  /** `Trip.familyTab`: one pot, every net shown as zero, no transfers (VOICE §4.7 C). */
  readonly familyTab?: boolean;
  /**
   * On request ("@trav who's paid for what so far", T-085): the first line
   * carries the trip total. Off for the scheduled card, which keeps VOICE §4.6.
   */
  readonly showTotal?: boolean;
  /** One line before the card's own first line (T-141: "tab changed since that card ..."). */
  readonly lead?: string;
}

/** Inline items per line (VOICE §3.3: up to 3 inline). */
const PER_LINE = 3;
/** Final-mode transfer rows before "+N more in the card" (10-line settle cap). */
const MAX_TRANSFER_LINES = 7;

function chunk<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * VOICE §8: a minor never appears as debtor or creditor. Balances from
 * `ledger.tripLedger` already have no minor rows; for anything else (a caller
 * passing raw `computeBalances` output, e.g. Lily paid $24), a minor's net is
 * moved onto their guardian's row (created if absent) and the minor's row is
 * dropped, so Σ is unchanged and nothing throws. A minor with a non-zero net
 * and no valid guardian throws `minor_without_guardian`
 * (`ledger.isMinorWithoutGuardianError`): never guess which adult carries a
 * child; callers ask the leads instead (`tools/ledger.ts` `settleUpFor`).
 */
function foldMinorBalances(balances: readonly Balance[], ctx: RenderContext): Balance[] {
  const folding = ledger.minorFolding(ctx.members, ctx.now);
  if (folding.minors.length === 0) return [...balances];
  const out = new Map<MemberId, Balance>();
  for (const b of balances) {
    if (!folding.guardianOf.has(b.memberId)) {
      const prev = out.get(b.memberId);
      out.set(
        b.memberId,
        prev === undefined
          ? b
          : { ...b, net: money(prev.net.amountMinor + b.net.amountMinor, b.net.currency) },
      );
    }
  }
  for (const b of balances) {
    if (!folding.guardianOf.has(b.memberId) || b.net.amountMinor === 0) continue;
    const guardian = folding.guardianOf.get(b.memberId) ?? null;
    if (guardian === null) {
      throw new TravError(
        'invalid_argument',
        `renderSettleUp: minor ${b.memberId} has a balance and no guardian`,
        { reason: ledger.MINOR_WITHOUT_GUARDIAN, memberId: b.memberId },
      );
    }
    const prev = out.get(guardian);
    out.set(guardian, {
      memberId: guardian,
      net: money((prev?.net.amountMinor ?? 0) + b.net.amountMinor, b.net.currency),
    });
  }
  return [...out.values()];
}

/** The settle-up card on its own (also embedded in recap and Wrapped). Its `fallbackText` is the standalone settle-up text. */
export function buildSettleUp(
  input: SettleUpRenderInput,
  ctx: RenderContext,
): { readonly card: SettleUpCard; readonly lines: readonly string[] } {
  const cur = input.currency;
  let net = 0;
  for (const b of input.balances) {
    if (b.net.currency !== cur) {
      throw new TravError('currency_mismatch', 'renderSettleUp: balance in another currency');
    }
    net += b.net.amountMinor;
  }
  if (net !== 0) {
    throw new TravError('invariant_violation', 'renderSettleUp: balances do not sum to zero', {
      netMinor: net,
    });
  }
  const order = ctx.members.map((m) => m.memberId);
  const folded = foldMinorBalances(input.balances, ctx);
  // Family tab: one pot, nobody owes anybody (T-058). Rows stay, nets are zero.
  const balances = (
    input.familyTab === true ? folded.map((b) => ({ ...b, net: money(0, cur) })) : folded
  ).sort((a, b) => order.indexOf(a.memberId) - order.indexOf(b.memberId));
  const minors = new Set(
    ctx.members.filter((m) => safety.isMinor(m, ctx.now)).map((m) => m.memberId),
  );
  // A family tab drops any supplied transfers below, so only a split checks them (T-065 review #4).
  if (
    input.familyTab !== true &&
    input.transfers?.some((t) => minors.has(t.from) || minors.has(t.to)) === true
  ) {
    throw new TravError(
      'invariant_violation',
      'renderSettleUp: a transfer names a minor (VOICE §8)',
    );
  }
  const nonZero = balances.filter((b) => b.net.amountMinor !== 0);
  const transfers = input.familyTab
    ? []
    : (input.transfers ?? (nonZero.length > 0 ? ledger.settle(balances) : []));
  const paid = input.familyTab === true || input.mode !== 'final' ? [] : (input.paid ?? []);
  if (paid.some((t) => minors.has(t.from) || minors.has(t.to) || t.amount.currency !== cur)) {
    throw new TravError(
      'invariant_violation',
      'renderSettleUp: a paid transfer names a minor or another currency',
    );
  }
  // Final mode rows: paid and open together, debtor then creditor in member
  // order (VOICE §4.6 B reads one debtor at a time), a paid row first on a tie.
  const rank = (id: MemberId): number => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  const open = transfers.map((t) => ({ t, paid: false }));
  const rows: readonly { readonly t: Transfer; readonly paid: boolean }[] =
    paid.length === 0
      ? open
      : [...paid.map((t) => ({ t, paid: true })), ...open].sort(
          (a, b) => rank(a.t.from) - rank(b.t.from) || rank(a.t.to) - rank(b.t.to),
        );

  const lead = input.lead !== undefined && input.lead.length > 0 ? input.lead : undefined;
  const lines: string[] = lead !== undefined ? [lead] : [];
  // The lead line takes one row's place under the 10-line settle cap.
  const maxRows = MAX_TRANSFER_LINES - (lead !== undefined ? 1 : 0);
  /** Final-mode transfer rows (10-line settle cap: overflow goes to "+N more in the card"). */
  const pushRows = (): void => {
    const n = rows.length;
    const showAll = n <= maxRows + 1;
    const shown = showAll ? rows : rows.slice(0, maxRows);
    for (const r of shown) {
      const done = r.paid ? ' · paid' : '';
      lines.push(
        `${formatTransfer(nameOf(ctx, r.t.from), nameOf(ctx, r.t.to), r.t.amount)}${done}`,
      );
    }
    if (!showAll) lines.push(`+${String(n - shown.length)} more in the card`);
  };
  const total = input.showTotal === true ? formatMoney(input.totalSpent) : undefined;
  if (input.familyTab === true) {
    lines.push(
      total !== undefined
        ? `${total} on the family tab so far, nothing to split`
        : "everything's on the family tab, nothing to split",
    );
  } else if (input.mode === 'final' && paid.length > 0 && transfers.length === 0) {
    // Every transfer ticked off (T-141): the paid rows stay as the record.
    const n = rows.length;
    lines.push(
      n === 1
        ? `final settle, it's paid and everyone's square`
        : `final settle, all ${String(n)} paid and everyone's square`,
    );
    pushRows();
  } else if (nonZero.length === 0) {
    lines.push(
      total !== undefined
        ? `${total} on the tab so far. nobody owes anybody. rare. enjoy it`
        : 'nobody owes anybody. rare. enjoy it',
    );
  } else if (input.mode === 'running') {
    const head =
      input.dayNumber !== undefined ? `running tab, day ${String(input.dayNumber)}` : 'running tab';
    lines.push(total !== undefined ? `${head}, ${total} so far` : head);
    const owed = nonZero
      .filter((b) => b.net.amountMinor > 0)
      .map((b) => `${nameOf(ctx, b.memberId)} is owed ${formatMoney(b.net)}`);
    const owes = nonZero
      .filter((b) => b.net.amountMinor < 0)
      .map((b) => `${nameOf(ctx, b.memberId)} owes ${formatMoney(money(-b.net.amountMinor, cur))}`);
    for (const c of chunk(owed, PER_LINE)) lines.push(c.join(' · '));
    for (const c of chunk(owes, PER_LINE)) lines.push(c.join(' · '));
    lines.push(
      `no rush, i'll do one clean settle at the end. "@trav settle now" if you'd rather square up today`,
    );
  } else {
    const n = transfers.length;
    lines.push(
      paid.length === 0
        ? `final settle, ${String(n)} transfer${n === 1 ? '' : 's'} and everyone's square`
        : `final settle, ${String(paid.length)} of ${String(rows.length)} paid, ${String(n)} to go`,
    );
    pushRows();
    lines.push("👍 on this message when you've paid, i'll tick you off");
  }

  const card: SettleUpCard = {
    cardId: ctx.ids.next('card'),
    type: 'settle_up',
    title: input.mode === 'final' ? 'final settle' : 'running tab',
    fallbackText: lines.join('\n'),
    mode: input.mode,
    asOf: input.asOf ?? ctx.now,
    ...(input.dayNumber !== undefined ? { dayNumber: input.dayNumber } : {}),
    currency: cur,
    balances: balances.map((b) => ({
      memberId: b.memberId,
      name: nameOf(ctx, b.memberId),
      net: b.net,
    })),
    // Running mode keeps the open transfers only (its card never lists them).
    transfers: rows.map((r) => ({
      from: r.t.from,
      to: r.t.to,
      amount: r.t.amount,
      ...(r.paid ? { paid: true } : {}),
    })),
    totalSpent: input.totalSpent,
  };
  return { card, lines };
}

export function renderSettleUp(
  input: SettleUpRenderInput,
  ctx: RenderContext,
): OutboundMessage & { readonly card: SettleUpCard } {
  const { card, lines } = buildSettleUp(input, ctx);
  const { cardId: _id, fallbackText: _fb, ...rest } = card;
  const debtors: MemberId[] = [
    ...new Set(card.transfers.filter((t) => t.paid !== true).map((t) => t.from)),
  ];
  return cardMessage<SettleUpCard>(ctx, GROUP, lines, rest, {
    // [Paid] is for a debtor with an open transfer only (T-141: payers mark their own).
    ...(input.mode === 'final' && debtors.length > 0
      ? { actions: [action('paid', { allowedMemberIds: debtors })] }
      : {}),
  });
}

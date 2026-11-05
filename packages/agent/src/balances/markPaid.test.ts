/**
 * T-141: 👍 / [Paid] on the final settle card marks the payer's own transfer
 * paid (their word, no money moves), audits it and re-posts the card with the
 * row ticked and what is still owed. Nobody else can tick it.
 */
import { describe, expect, it } from 'vitest';
import type { OutboundMessage, SettleUpCard } from '@trav/core';
import { isReaction } from '@trav/core';
import { BARCELONA } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { harness, type Harness } from '../runtime.testkit.js';
import { balancesFor } from '../tools/ledger.js';

const TRIP = BARCELONA.tripId;

function messages(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}

function settleCard(r: TurnResult): { msg: OutboundMessage; card: SettleUpCard } {
  const msg = messages(r).find((m) => m.card?.type === 'settle_up');
  if (msg === undefined || msg.card?.type !== 'settle_up')
    throw new Error(`no settle_up card (note ${r.note})`);
  return { msg, card: msg.card };
}

/** Dean's €84 dinner without Henry, Sam's €23.40 uber for all six, then the final card. */
async function finalCard(h: Harness): Promise<{ id: string; card: SettleUpCard }> {
  await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
  await h.say('h_sam', '@trav I paid €23.40 for the uber, split with everyone');
  const { msg, card } = settleCard(await h.say('h_dean', '@trav settle now'));
  expect(card.mode).toBe('final');
  return { id: msg.id, card };
}

function netOf(h: Harness, memberId: string, by = 'mem_dean'): number {
  const ctx = {
    groupId: BARCELONA.groupId,
    tripId: TRIP,
    senderMemberId: by,
    senderId: 'h_dean',
    lane: 'group' as const,
    now: h.clock.now(),
    clock: h.clock,
    ids: h.ids,
    stores: h.runtime.stores,
  };
  return balancesFor(ctx).balances.find((b) => b.memberId === memberId)?.netMinor ?? NaN;
}

const payments = (h: Harness) => h.runtime.stores.group.settlements.listByTrip(TRIP);

describe('👍 on the final settle card (T-141)', () => {
  it("Maya's 👍 ticks her transfer, audits it, and re-posts the card with what's left", async () => {
    const h = harness();
    const { id, card } = await finalCard(h);
    const mine = card.transfers.filter((t) => t.from === 'mem_maya');
    expect(mine).toHaveLength(1);
    const owedBefore = netOf(h, 'mem_maya');
    expect(owedBefore).toBe(-mine[0]!.amount.amountMinor);

    const turn = await h.react('h_maya', id, '👍');
    expect(turn.note).toBe('settle:marked_paid');
    expect(turn.modelSources).toEqual([]);
    const { msg, card: next } = settleCard(turn);
    expect(msg.to).toEqual({ kind: 'group' });
    expect(next.mode).toBe('final');
    // The same transfers, Maya's ticked: nobody else's row moved.
    expect(next.transfers.map(({ from, to, amount }) => ({ from, to, amount }))).toEqual(
      card.transfers.map(({ from, to, amount }) => ({ from, to, amount })),
    );
    expect(next.transfers.filter((t) => t.paid === true).map((t) => t.from)).toEqual(['mem_maya']);
    const n = card.transfers.length;
    const lines = msg.text.split('\n');
    expect(lines[0]).toBe(`final settle, 1 of ${String(n)} paid, ${String(n - 1)} to go`);
    expect(lines).toContain('Maya → Dean €20.70 · paid');
    expect(lines.at(-1)).toBe("👍 on this message when you've paid, i'll tick you off");
    expect(lines.length).toBeLessThanOrEqual(10);
    // Balances: what Maya owed is gone, Dean is owed that much less, Σ 0.
    expect(next.balances.find((b) => b.memberId === 'mem_maya')?.net.amountMinor).toBe(0);
    expect(next.balances.reduce((s, b) => s + b.net.amountMinor, 0)).toBe(0);
    expect(netOf(h, 'mem_maya')).toBe(0);
    // [Paid] stays for the debtors still owing only.
    const paid = msg.actions?.find((a) => a.id === 'paid');
    expect(paid?.allowedMemberIds).not.toContain('mem_maya');
    expect([...(paid?.allowedMemberIds ?? [])].sort()).toEqual(
      [...new Set(card.transfers.map((t) => t.from).filter((f) => f !== 'mem_maya'))].sort(),
    );

    // One record, one audit row, no money moved.
    expect(payments(h)).toMatchObject([
      {
        from: 'mem_maya',
        to: 'mem_dean',
        amount: { amountMinor: 2070, currency: 'EUR' },
        markedBy: 'mem_maya',
        via: 'reaction',
        cardMessageId: id,
        status: 'marked_paid',
      },
    ]);
    const rows = h.audit().filter((e) => e.type === 'settlement.marked_paid');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: { kind: 'member', id: 'mem_maya' },
      visibility: 'group',
      tripId: TRIP,
      payload: { from: 'mem_maya', to: 'mem_dean', amountMinor: 2070, moneyMoved: false },
    });
    expect(turn.auditEventIds).toContain(rows[0]!.id);
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(h.auditTypes()).not.toContain('booking.completed');

    // A later "settle now" shows the same ticked state.
    const again = settleCard(await h.say('h_jordan', '@trav settle now'));
    expect(again.msg.text).toContain('Maya → Dean €20.70 · paid');
  });

  it('a second 👍 (same card or the new one) never pays twice', async () => {
    const h = harness();
    const { id } = await finalCard(h);
    const first = await h.react('h_maya', id, '👍');
    const { msg } = settleCard(first);
    expect((await h.react('h_maya', id, '👍')).note).toBe('settle:already_paid');
    const onNew = await h.react('h_maya', msg.id, '👍');
    expect(onNew).toMatchObject({ silent: true, note: 'settle:already_paid' });
    expect(payments(h)).toHaveLength(1);
    expect(netOf(h, 'mem_maya')).toBe(0);
  });

  it('a payee, a guest or a non-👍 changes nothing', async () => {
    const h = harness();
    const { id } = await finalCard(h);
    // Dean and Sam are owed (payees): a 👍 from them is not "i paid".
    expect(await h.react('h_dean', id, '👍')).toMatchObject({
      silent: true,
      note: 'settle:not_payer',
    });
    expect((await h.react('h_sam', id, '👍')).note).toBe('settle:not_payer');
    expect((await h.react('h_ava', id, '👍')).note).toBe('settle:guest');
    expect((await h.react('h_maya', id, '❤️')).note).toBe('reaction:not_approval');
    expect(payments(h)).toEqual([]);
    expect(h.auditTypes()).not.toContain('settlement.marked_paid');
  });

  it('👍 on the running tab card is not a payment', async () => {
    const h = harness();
    await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
    const { msg, card } = settleCard(await h.say('h_dean', "@trav who's paid for what so far"));
    expect(card.mode).toBe('running');
    expect((await h.react('h_maya', msg.id, '👍')).note).toBe('reaction:not_approval');
    expect(payments(h)).toEqual([]);
  });

  it('a card the tab has moved past records nothing and gets the current card', async () => {
    const h = harness();
    const { id } = await finalCard(h);
    await h.say('h_dean', '@trav I paid €30 for snacks, split with everyone');
    const turn = await h.react('h_maya', id, '👍');
    expect(turn.note).toBe('settle:stale');
    expect(messages(turn)).toHaveLength(1);
    const { card } = settleCard(turn);
    expect(card.totalSpent.amountMinor).toBe(8400 + 2340 + 3000);
    expect(card.transfers.some((t) => t.paid === true)).toBe(false);
    expect(payments(h)).toEqual([]);
  });

  it('when everyone has paid the card says so and offers no more [Paid]', async () => {
    const h = harness();
    const { id, card } = await finalCard(h);
    const handleOf = (memberId: string): string =>
      BARCELONA.members.find((m) => m.memberId === memberId)!.handle;
    let last: TurnResult | undefined;
    for (const from of [...new Set(card.transfers.map((t) => t.from))]) {
      last = await h.react(handleOf(from), id, '👍');
      expect(last.note).toBe('settle:marked_paid');
    }
    const { msg, card: done } = settleCard(last!);
    const n = card.transfers.length;
    expect(msg.text.split('\n')[0]).toBe(`final settle, all ${String(n)} paid and everyone's square`);
    expect(msg.text).not.toContain('👍 on this message');
    expect(done.transfers.every((t) => t.paid === true)).toBe(true);
    expect(done.balances.every((b) => b.net.amountMinor === 0)).toBe(true);
    expect(msg.actions?.some((a) => a.id === 'paid') ?? false).toBe(false);
  });
});

describe('[Paid] on a transfer row (T-141, the T-037 button)', () => {
  it("the payer's tap on their own row marks it; a tap on someone else's row does nothing", async () => {
    const h = harness();
    const { id, card } = await finalCard(h);
    const other = card.transfers.find((t) => t.from !== 'mem_maya')!;
    // Maya tapping another debtor's row, and that debtor tapping Maya's row.
    expect((await h.tap('h_maya', id, 'paid', `${other.from}:${other.to}`)).note).toBe(
      'settle:not_payer',
    );
    const otherHandle = BARCELONA.members.find((m) => m.memberId === other.from)!.handle;
    expect((await h.tap(otherHandle, id, 'paid', 'mem_maya:mem_dean')).note).toBe(
      'settle:not_payer',
    );
    expect(payments(h)).toEqual([]);

    const turn = await h.tap('h_maya', id, 'paid', 'mem_maya:mem_dean');
    expect(turn.note).toBe('settle:marked_paid');
    expect(payments(h)).toMatchObject([{ from: 'mem_maya', to: 'mem_dean', via: 'button' }]);
    expect(settleCard(turn).card.transfers.find((t) => t.from === 'mem_maya')?.paid).toBe(true);
  });
});

describe('minors on a split trip (T-065 folding)', () => {
  it("a minor's share sits on their guardian's row, and only the guardian can tick it", async () => {
    const h = harness();
    // Jordan is 15 with Maya as guardian: Jordan's shares fold onto Maya.
    const store = h.runtime.stores.group.members;
    const jordan = store.get('mem_jordan')!;
    store.upsert({
      ...jordan,
      birthDate: '2011-01-01',
      ageBand: 'under18',
      guardianMemberId: 'mem_maya',
    });
    const { id, card } = await finalCard(h);
    expect(card.transfers.some((t) => t.from === 'mem_jordan' || t.to === 'mem_jordan')).toBe(
      false,
    );
    const maya = card.transfers.find((t) => t.from === 'mem_maya');
    expect(maya?.amount.amountMinor).toBe(2070 * 2);

    expect(await h.react('h_jordan', id, '👍')).toMatchObject({
      silent: true,
      note: 'settle:not_applicable',
    });
    expect((await h.tap('h_jordan', id, 'paid', 'mem_maya:mem_dean')).note).toBe(
      'settle:not_payer',
    );
    expect(payments(h)).toEqual([]);

    const turn = await h.react('h_maya', id, '👍');
    expect(turn.note).toBe('settle:marked_paid');
    expect(settleCard(turn).msg.text).toContain('Maya → Dean €41.40 · paid');
    expect(settleCard(turn).msg.text).not.toContain('Jordan');
  });
});

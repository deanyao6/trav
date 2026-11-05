/**
 * T-188 r1 #1: a member Trav can't DM (the server's STOP list, `dmHold`) is
 * charged like everyone, but their ticket DM is held rather than refused at
 * the wire. The receipt names whose QR is saved and never claims "in your
 * dms, one each". `deliverHeld` sends the saved ticket once the hold lifts,
 * exactly once.
 */
import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '@trav/core';
import { DEFAULT_AUTO_BUY_CAP_MINOR, isReaction } from '@trav/core';
import { harness, RAZZMATAZZ_ASK } from '../runtime.testkit.js';
import { HELD_TICKET_NAMESPACE, heldTicketsFor } from './heldTickets.js';

const FIVE = ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley'];

function setup(held: Set<string>) {
  return harness({
    autoBuyCapMinor: DEFAULT_AUTO_BUY_CAP_MINOR,
    runtime: { dmHold: (memberId) => held.has(memberId) },
  });
}

const messages = (out: readonly unknown[]): OutboundMessage[] =>
  (out as Parameters<typeof isReaction>[0][]).filter((o): o is OutboundMessage => !isReaction(o));

describe('held tickets (T-188 r1 #1)', () => {
  it('one member held: four ticket DMs, an honest receipt, the fifth ticket saved and sent once on release', async () => {
    const held = new Set(['mem_chase']);
    const h = setup(held);
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    const out = messages(turn.outbound);
    const receipt = out.find((m) => m.to.kind === 'group' && m.card?.type === 'receipt')!;
    expect(receipt.text).toContain(
      "QR codes are in your dms, except Chase's, saved till i can dm Chase",
    );
    expect(receipt.text).not.toContain('one each');
    const ticketDms = out.filter((m) => m.card?.type === 'ticket');
    expect(ticketDms.map((m) => (m.to.kind === 'member' ? m.to.memberId : '')).sort()).toEqual(
      FIVE.filter((id) => id !== 'mem_chase').sort(),
    );
    // No "couldn't go out" count line: nothing was tried and dropped.
    expect(out.some((m) => /couldn't go out/.test(m.text))).toBe(false);
    expect(h.tickets.purchaseCount()).toBe(1);
    // The pointer is ids only, in Chase's partition.
    expect(heldTicketsFor(h.runtime.stores, 'mem_chase')).toHaveLength(1);
    const rows = h.runtime.stores.private.listRuntimeState('mem_chase', HELD_TICKET_NAMESPACE);
    expect(JSON.stringify(rows)).not.toMatch(/svg|data:|png/i);

    // Still held: nothing goes out.
    expect(await h.runtime.agent.deliverHeld('mem_chase')).toEqual([]);

    held.delete('mem_chase');
    const [delivered, ...more] = await h.runtime.agent.deliverHeld('mem_chase');
    expect(more).toHaveLength(0);
    const sent = messages(delivered!.outbound);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual({ kind: 'member', memberId: 'mem_chase' });
    expect(sent[0]!.card?.type).toBe('ticket');
    expect(heldTicketsFor(h.runtime.stores, 'mem_chase')).toHaveLength(0);
    expect(await h.runtime.agent.deliverHeld('mem_chase')).toEqual([]);
  });

  it('everyone held: no ticket DMs, and the receipt says the QR codes are saved', async () => {
    const h = setup(new Set(FIVE));
    const out = messages((await h.say('h_dean', RAZZMATAZZ_ASK)).outbound);
    const receipt = out.find((m) => m.card?.type === 'receipt')!;
    expect(receipt.text).toContain(
      'the QR codes are saved till i can dm Dean, Chase, Piotr, Arjun, Crowley',
    );
    expect(receipt.text).not.toContain('in your dms');
    expect(out.filter((m) => m.card?.type === 'ticket')).toHaveLength(0);
  });

  it('no hold: the receipt is unchanged', async () => {
    const h = setup(new Set());
    const out = messages((await h.say('h_dean', RAZZMATAZZ_ASK)).outbound);
    expect(out.find((m) => m.card?.type === 'receipt')!.text).toContain(
      'QR codes are in your dms, one each',
    );
    expect(out.filter((m) => m.card?.type === 'ticket')).toHaveLength(5);
  });

  it('"delete my data" (deletePartition) takes the held pointer and the ticket with it', async () => {
    const held = new Set(['mem_chase']);
    const h = setup(held);
    await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(heldTicketsFor(h.runtime.stores, 'mem_chase')).toHaveLength(1);
    h.runtime.stores.private.deletePartition('mem_chase');
    h.runtime.agent.forgetRuntimeState({ memberId: 'mem_chase' });
    expect(heldTicketsFor(h.runtime.stores, 'mem_chase')).toHaveLength(0);
    held.delete('mem_chase');
    // The ticket itself went with the partition: nothing to deliver.
    expect(await h.runtime.agent.deliverHeld('mem_chase')).toEqual([]);
  });

  it('"forget this trip" (deleteTrip) takes the held pointer too', async () => {
    const held = new Set(['mem_chase']);
    const h = setup(held);
    await h.say('h_dean', RAZZMATAZZ_ASK);
    const [pointer] = heldTicketsFor(h.runtime.stores, 'mem_chase');
    expect(pointer?.tripId).toBeTruthy();
    h.runtime.stores.deleteTrip(pointer!.tripId!);
    h.runtime.agent.forgetRuntimeState({ tripId: pointer!.tripId! });
    expect(heldTicketsFor(h.runtime.stores, 'mem_chase')).toHaveLength(0);
    held.delete('mem_chase');
    expect(await h.runtime.agent.deliverHeld('mem_chase')).toEqual([]);
  });
});

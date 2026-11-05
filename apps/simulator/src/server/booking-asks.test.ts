/**
 * T-081 round 1 review, flaw 1 (blocker): in a family group the outbound
 * screen holds back a proposal card for a bar event. A card nobody saw can
 * never be approved: the proposal is withdrawn with its hold released, one
 * all-ages line says nothing was booked, and Dad's next bare "yes" buys nothing.
 */
import { describe, expect, it } from 'vitest';
import { UNDELIVERED_PROPOSAL_TEXT } from '@trav/agent';
import { bookingCount, demoBackend } from './testkit.js';

const TCI = 'grp_turks_caicos';

describe('a proposal card the family screen suppresses (T-081 r1 #1)', () => {
  it('is withdrawn, says so once, and a bare "yes" afterwards buys nothing', async () => {
    const b = await demoBackend();
    const thread = () =>
      b
        .state()
        .groups.find((g) => g.group.groupId === TCI)!
        .thread.filter((e) => e.kind === 'message');
    const before = thread().length;
    const receipts = bookingCount(b);

    await b.inject({
      type: 'message',
      from: 'h_tci_dad',
      text: '@trav get trivia tickets for everyone but Lily',
      groupId: TCI,
    });
    const travLines = thread()
      .slice(before)
      .filter((e) => e.kind === 'message' && e.isTrav);
    expect(travLines.map((e) => e.text)).toEqual([UNDELIVERED_PROPOSAL_TEXT]);
    expect(travLines.some((e) => e.kind === 'message' && e.card !== undefined)).toBe(false);

    await b.inject({ type: 'message', from: 'h_tci_dad', text: 'yes', groupId: TCI });
    await b.inject({ type: 'message', from: 'h_tci_mom', text: 'yes', groupId: TCI });
    expect(bookingCount(b)).toBe(receipts);
    expect(thread().some((e) => e.kind === 'message' && e.isTrav && /^booked/.test(e.text))).toBe(
      false,
    );
  });
});

describe('a minor asks for a family booking (T-081 r1 #4)', () => {
  it("the card names her guardian as the one paying, never Lily's card", async () => {
    const b = await demoBackend();
    const thread = () =>
      b
        .state()
        .groups.find((g) => g.group.groupId === TCI)!
        .thread.filter((e) => e.kind === 'message');
    const before = thread().length;
    await b.inject({
      type: 'message',
      from: 'h_tci_lily',
      text: '@trav snorkel tour for all 4 on monday morning',
      groupId: TCI,
    });
    const card = thread()
      .slice(before)
      .find((e) => e.kind === 'message' && e.isTrav && e.card?.type === 'booking_proposal');
    expect(card, 'a proposal card').toBeDefined();
    expect(card!.text).toMatch(/charged to Dad's card/);
    expect(card!.text).not.toMatch(/Lily's card/);
  });
});

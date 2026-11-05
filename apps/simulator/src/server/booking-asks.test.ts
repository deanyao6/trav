/**
 * T-081 round 1 review, flaw 1 (blocker): in a family group the outbound
 * screen holds back a proposal card for a bar event. A card nobody saw can
 * never be approved: the proposal is withdrawn with its hold released, one
 * all-ages line says nothing was booked, and Dad's next bare "yes" buys nothing.
 */
import { describe, expect, it } from 'vitest';
import { UNDELIVERED_PROPOSAL_TEXT, ageLimitText, createTravRuntime } from '@trav/agent';
import type { MockTickets } from '@trav/adapters';
import { createMockTickets, loadAllTicketInventories } from '@trav/adapters';
import { createDeterministicIdGenerator } from '@trav/core';
import type { SimulatorBackend } from './backend.js';
import { loadAgentBackend } from './runtime.js';
import { bookingCount, demoBackend } from './testkit.js';

const TCI = 'grp_turks_caicos';

/** The demo backend with a ticket provider we can count purchases on. */
async function countingBackend(): Promise<{
  readonly b: SimulatorBackend;
  readonly purchases: () => number;
}> {
  let tickets: MockTickets | undefined;
  const b = await loadAgentBackend({
    offline: true,
    seed: true,
    createTravRuntime: (input) => {
      tickets = createMockTickets({
        clock: input.clock,
        ids: createDeterministicIdGenerator('tkt148'),
        inventory: loadAllTicketInventories(),
      });
      return createTravRuntime({ ...input, providers: { tickets } });
    },
  });
  return { b, purchases: () => tickets?.purchaseCount() ?? 0 };
}

const tciThread = (b: SimulatorBackend) =>
  b
    .state()
    .groups.find((g) => g.group.groupId === TCI)!
    .thread.filter((e) => e.kind === 'message');

describe("a minor's ask on her guardian's card never auto-approves (T-148 #1, SAFETY §2.1 C10)", () => {
  it('Mom raises the caps, Lily asks for a snorkel tour: a card for Dad, no purchase until he oks it', async () => {
    const { b, purchases } = await countingBackend();
    const say = (from: string, text: string) =>
      b.inject({ type: 'message', from, text, groupId: TCI });
    await say('h_tci_mom', '@trav set the auto-approve cap to $200');
    await say('h_tci_mom', 'yes');
    await say('h_tci_mom', '@trav set the per-person cap to $100');
    await say('h_tci_mom', 'yes');
    const before = tciThread(b).length;
    const receipts = bookingCount(b);

    await say('h_tci_lily', '@trav snorkel tour for me on monday');
    const trav = tciThread(b)
      .slice(before)
      .filter((e) => e.kind === 'message' && e.isTrav);
    expect(purchases()).toBe(0);
    expect(bookingCount(b)).toBe(receipts);
    expect(trav.map((e) => e.text).join('\n')).not.toMatch(/couldn't charge|booked/);
    const card = trav.find((e) => e.kind === 'message' && e.card?.type === 'booking_proposal');
    expect(card, 'a proposal card').toBeDefined();
    expect(card!.text).toMatch(/charged to Dad's card/);
    expect(card!.text).toMatch(/so Dad has to ok it/);

    // Lily's and Mom's yes don't count; nothing is bought.
    await say('h_tci_lily', 'yes');
    await b.inject({
      type: 'reaction',
      from: 'h_tci_lily',
      targetMessageId: card!.messageId,
      reaction: '👍',
    });
    await b.inject({
      type: 'reaction',
      from: 'h_tci_mom',
      targetMessageId: card!.messageId,
      reaction: '👍',
    });
    expect(purchases()).toBe(0);

    // Dad, the card owner, approves: now (and only now) the mock purchase runs.
    await b.inject({
      type: 'reaction',
      from: 'h_tci_dad',
      targetMessageId: card!.messageId,
      reaction: '👍',
    });
    expect(purchases()).toBe(1);
  });
});

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

describe('a later "not yet" takes the ask back, even under raised caps (T-148 r1 #1)', () => {
  const BCN = 'grp_barcelona';
  const bcnTrav = (b: SimulatorBackend) =>
    b
      .state()
      .groups.find((g) => g.group.groupId === BCN)!
      .thread.filter((e) => e.kind === 'message' && e.isTrav);

  it('Dean raises the caps; three retracted asks buy nothing, a plain ask does (control)', async () => {
    const { b, purchases } = await countingBackend();
    const say = (text: string) => b.inject({ type: 'message', from: 'h_dean', text, groupId: BCN });
    await say('@trav set the auto-approve cap to €200');
    await say('yes');
    await say('@trav set the per-person cap to €100');
    await say('yes');
    for (const ask of [
      // "for all of us": with no one out, each would go straight to a purchase.
      "@trav get razz tickets for all of us, but don't buy them yet",
      '@trav get razz tickets for all of us, hold off till henry confirms',
      '@trav get razz tickets for all of us, not yet though',
    ]) {
      const before = bcnTrav(b).length;
      await say(ask);
      expect(purchases(), ask).toBe(0);
      const lines = bcnTrav(b).slice(before);
      expect(
        lines.some((e) => e.kind === 'message' && e.card !== undefined),
        ask,
      ).toBe(false);
      const text = lines.map((e) => (e.kind === 'message' ? e.text : '')).join('\n');
      expect(text, ask).not.toMatch(/^booked/m);
    }
    // Control: the same caps do auto-book an ask nobody took back.
    await say("@trav get the 5 of us razz tickets, henry's sick");
    expect(purchases()).toBe(1);
  });
});

describe('a price question in a family group always gets a delivered line (T-148 r1 #3)', () => {
  // VENUE_NOT_ALL_AGES_TEXT (offline/asks.ts, not a package export): no venue name, no minor.
  const NOT_ALL_AGES = /^that one's not all-ages, so i won't price it in this chat\./;
  it.each([
    ['h_tci_dad', 'how much is the casino night', NOT_ALL_AGES],
    ['h_tci_lily', 'how much is the casino night', NOT_ALL_AGES],
    ['h_tci_dad', 'how much is the trivia night', NOT_ALL_AGES],
    [
      'h_tci_dad',
      'how much is the jet ski',
      /^jet ski rental, 1 hour is \$\d+ each, .*16 and up\n/,
    ],
  ] as const)('%s: %s', async (from, ask, want) => {
    const { b, purchases } = await countingBackend();
    const before = tciThread(b).length;
    await b.inject({ type: 'message', from, text: `@trav ${ask}`, groupId: TCI });
    const trav = tciThread(b)
      .slice(before)
      .filter((e) => e.kind === 'message' && e.isTrav)
      .map((e) => e.text);
    expect(trav).toHaveLength(1);
    expect(trav[0]).toMatch(want);
    expect(trav[0]).not.toMatch(/Lily|18\+|21\+/);
    expect(purchases()).toBe(0);
  });
});

describe('the family tab is one pot for an adults-only booking too (T-148 #2, VOICE §8)', () => {
  it('Dad: snorkel tour for me and mom ⇒ all on Dad, no split, only Dad approves', async () => {
    const { b, purchases } = await countingBackend();
    const before = tciThread(b).length;
    await b.inject({
      type: 'message',
      from: 'h_tci_dad',
      text: '@trav snorkel tour for me and mom on monday',
      groupId: TCI,
    });
    const card = tciThread(b)
      .slice(before)
      .find((e) => e.kind === 'message' && e.isTrav && e.card?.type === 'booking_proposal');
    expect(card, 'a proposal card').toBeDefined();
    expect(card!.text).toMatch(/charged to Dad's card, on the family tab/);
    expect(card!.text).toMatch(/so Dad has to 👍/);
    expect(card!.text).not.toMatch(/split \d+ ways|from Mom|everyone charged/);
    expect(purchases()).toBe(0);
  });
});

describe('an age-limited ask with a minor on it gets a delivered all-ages line (T-148 #5)', () => {
  it.each([
    ['jet ski for me and Lily on tuesday', 16, /16 and up/],
    ['casino night for me and Lily', 21, /not all-ages/],
  ] as const)('Dad: %s', async (ask, minimumAge, age) => {
    const { b, purchases } = await countingBackend();
    const before = tciThread(b).length;
    const receipts = bookingCount(b);
    await b.inject({ type: 'message', from: 'h_tci_dad', text: `@trav ${ask}`, groupId: TCI });
    const trav = tciThread(b)
      .slice(before)
      .filter((e) => e.kind === 'message' && e.isTrav);
    const line = ageLimitText(minimumAge);
    expect(trav.map((e) => e.text)).toEqual([line]);
    expect(line).toMatch(age);
    expect(line).not.toMatch(/18\+|21\+|charged|Lily/);
    expect(trav.some((e) => e.kind === 'message' && e.card !== undefined)).toBe(false);
    await b.inject({ type: 'message', from: 'h_tci_dad', text: 'yes', groupId: TCI });
    expect(purchases()).toBe(0);
    expect(bookingCount(b)).toBe(receipts);
  });
});

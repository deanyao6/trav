import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Activity, Expense, Group, Member, MemberId, OutboundMessage, Trip } from '@trav/core';
import {
  createDeterministicIdGenerator,
  createSimulatedClock,
  formatMoney,
  isReaction,
  ledger,
  money,
} from '@trav/core';
import { createSimulatorChannel } from '@trav/adapters';
import { BARCELONA, createTravRuntime } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { REPLY_WINDOW_MS } from '../mention.js';
import type { CompletionRequest, CompletionResponse, ModelClient } from '../model/client.js';
import { deriveScriptKey } from '../model/client.js';
import { repoRoot } from '../model/paths.js';
import { harness, RAZZMATAZZ_ASK, tempStateDir, type Harness } from '../runtime.testkit.js';
import { createMemoryStores } from '@trav/core/storage';
import type { BalancesResult } from '../tools/ledger.js';
import {
  GROUP_LIST_HINT_TEXT,
  myPositionText,
  NO_TRIP_BALANCE_TEXT,
  parseBalanceAsk,
} from './ask.js';

function messages(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}

function only(r: TurnResult): OutboundMessage {
  const m = messages(r);
  expect(m, `note ${String(r.note)}`).toHaveLength(1);
  return m[0]!;
}

const NOT_SURE = /not sure what you mean/;

// ---------- the parser ----------

describe('parseBalanceAsk', () => {
  it.each([
    ['@trav settle now', 'settle'],
    ['@trav settle up', 'settle'],
    ['@trav settle up now', 'settle'],
    ['trav, settle up?', 'settle'],
    ["@trav let's settle up", 'settle'],
    ['@trav can we square up today', 'settle'],
    ['@trav who owes who', 'settle'],
    ['@trav who owes whom?', 'settle'],
    ['@trav who owes what', 'settle'],
    ['@TRAV Settle Now!', 'settle'],
    ['@trav settle up pls', 'settle'],
    ['how much do i owe', 'mine'],
    ['@trav what do i owe', 'mine'],
    ['@trav how much do i owe so far?', 'mine'],
    ['do i owe anyone', 'mine'],
    ['how much am i owed', 'mine'],
    ['who owes me', 'mine'],
    ["what's my balance", 'mine'],
    ['what’s my balance', 'mine'],
    ['am i square', 'mine'],
    ["@trav who's paid for what so far", 'tab'],
    ['@trav who paid for what', 'tab'],
    ['@trav how much have we spent so far', 'tab'],
    ['@trav how much did we spend', 'tab'],
    ["@trav what's the tab", 'tab'],
    ["@trav what's the running tab so far", 'tab'],
    ['@trav balances', 'tab'],
  ] as const)('%s → %s', (text, kind) => {
    expect(parseBalanceAsk(text)).toBe(kind);
  });

  it.each([
    '@trav how much does the club cost',
    '@trav how much is razzmatazz',
    '@trav who owes who, and book dinner for 6',
    '@trav settle the dinner debate: tapas or paella',
    '@trav i paid €84 for dinner, split with everyone but Henry',
    'we should settle up later',
    '@trav what do i owe henry for the uber and also where should we eat',
    '@trav what are we doing tonight',
    // the ticket share and the booking's price, never the ledger (r2 #1)
    "@trav what's my share",
    '@trav what is my share so far',
    "@trav what's my total",
    "@trav what's the total",
    "@trav what's the total so far",
    "@trav what's the damage",
    '@trav',
    '',
  ])('%s → not a balance ask', (text) => {
    expect(parseBalanceAsk(text)).toBeUndefined();
  });
});

// ---------- the personal line (T-101) ----------

const M = (memberId: string, displayName: string): Member => ({
  memberId,
  groupId: 'grp_x',
  displayName,
  role: 'member',
  active: true,
  senderId: `h_${memberId}`,
  ageBand: 'adult',
  joinedAt: '2026-01-01T00:00:00Z',
});
const DEAN = M('dean', 'Dean');
const CROWLEY = M('crowley', 'Crowley');
const CHASE = M('chase', 'Chase');
const LILY_NO_GUARDIAN: Member = { ...M('lily', 'Lily'), ageBand: 'under18' };
const LILY: Member = { ...LILY_NO_GUARDIAN, guardianMemberId: 'dean' };
const ALL = [DEAN, CROWLEY, CHASE, LILY];

function result(over: Partial<BalancesResult> = {}): BalancesResult {
  return {
    currency: 'EUR',
    mode: 'split',
    totalSpentMinor: 2340,
    folded: [],
    balances: [],
    transfers: [],
    text: '€23.40 on the tab so far',
    ...over,
  };
}

describe('myPositionText', () => {
  const transfers = [
    { from: 'dean', to: 'crowley', amountMinor: 390, text: 'Dean → Crowley €3.90' },
    { from: 'chase', to: 'crowley', amountMinor: 1200, text: 'Chase → Crowley €12' },
  ];

  it("a debtor sees only their own transfer, first, and never anyone else's", () => {
    const text = myPositionText({
      balances: result({ transfers }),
      me: DEAN,
      members: ALL,
      meIsMinor: false,
    });
    expect(text).toBe('you owe Crowley €3.90\n€23.40 on the tab so far');
    expect(text).not.toContain('Chase');
  });

  it('a creditor sees who owes them, summed', () => {
    const text = myPositionText({
      balances: result({ transfers }),
      me: CROWLEY,
      members: ALL,
      meIsMinor: false,
    });
    expect(text.split('\n')[0]).toBe("you're owed €15.90: Dean €3.90 · Chase €12");
  });

  it('several debts are summed, one line', () => {
    const text = myPositionText({
      balances: result({
        transfers: [
          { from: 'chase', to: 'crowley', amountMinor: 390, text: '' },
          { from: 'chase', to: 'dean', amountMinor: 1680, text: '' },
        ],
      }),
      me: CHASE,
      members: ALL,
      meIsMinor: false,
    });
    expect(text.split('\n')[0]).toBe('you owe €20.70: Crowley €3.90 · Dean €16.80');
  });

  it('square when no transfer names the asker, including an empty tab', () => {
    expect(
      myPositionText({
        balances: result({ totalSpentMinor: 0, text: '' }),
        me: CHASE,
        members: ALL,
        meIsMinor: false,
      }),
    ).toBe("you're square, nothing to pay\n€0 on the tab so far");
  });

  it("a guardian is told the minor's share is in theirs", () => {
    const text = myPositionText({
      balances: result({
        transfers: [{ from: 'dean', to: 'crowley', amountMinor: 780, text: '' }],
        folded: [{ minor: 'lily', name: 'Lily', guardian: 'dean', guardianName: 'Dean' }],
      }),
      me: DEAN,
      members: ALL,
      meIsMinor: false,
    });
    expect(text).toBe("you owe Crowley €7.80\n€23.40 on the tab so far\nLily's share is in yours");
  });

  it('a minor is never a debtor (VOICE §8), split or family tab', () => {
    expect(
      myPositionText({ balances: result({ transfers }), me: LILY, members: ALL, meIsMinor: true }),
    ).toBe("you don't owe anyone, under-18s never do. your share's on Dean's tab");
    expect(
      myPositionText({
        balances: result({ mode: 'family_tab' }),
        me: LILY,
        members: ALL,
        meIsMinor: true,
      }),
    ).toBe("you don't owe anything. it's all on the family tab");
    expect(
      myPositionText({
        balances: result(),
        me: LILY_NO_GUARDIAN,
        members: ALL,
        meIsMinor: true,
      }),
    ).toBe("you don't owe anyone, under-18s never do");
  });

  it("family tab and a guardian-less minor: the tool's own line for an adult", () => {
    const fam = result({
      mode: 'family_tab',
      text: '$120 on the family tab so far, nothing to split',
    });
    expect(myPositionText({ balances: fam, me: DEAN, members: ALL, meIsMinor: false })).toBe(
      fam.text,
    );
    const q = result({
      needsGuardian: { minors: ['lily'], askMemberIds: ['dean'] },
      text: "quick one before i settle up, Dean: who's covering Lily?",
    });
    expect(myPositionText({ balances: q, me: DEAN, members: ALL, meIsMinor: false })).toBe(q.text);
    expect(
      myPositionText({ balances: q, me: DEAN, members: ALL, meIsMinor: false, lane: 'group' }),
    ).toBe(q.text);
  });

  it('a guardian-less minor in a DM: a personal line, not the group question (r2 #2)', () => {
    const q = result({
      needsGuardian: { minors: ['lily'], askMemberIds: ['dean', 'crowley'] },
      text: "quick one before i settle up, Dean and Crowley: who's covering Lily?",
    });
    expect(
      myPositionText({ balances: q, me: CHASE, members: ALL, meIsMinor: false, lane: 'dm' }),
    ).toBe("can't split yet, Dean or Crowley has to say who's covering Lily");
    const none = result({ needsGuardian: { minors: ['lily'], askMemberIds: [] } });
    expect(
      myPositionText({ balances: none, me: CHASE, members: ALL, meIsMinor: false, lane: 'dm' }),
    ).toBe("can't split yet, someone has to say who's covering Lily");
  });
});

// ---------- Barcelona, end to end (T-091) ----------

/** Dean's €84 dinner without Henry, then Crowley's €23.40 uber for all six. */
async function withTab(h: Harness): Promise<void> {
  const dinner = await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
  expect(dinner.note).not.toMatch(/model/);
  const uber = await h.say('h_crowley', '@trav I paid €23.40 for the uber, split with everyone');
  expect(uber.note).not.toMatch(/model/);
}

function netOf(h: Harness, memberId: string): number {
  let net = 0;
  for (const en of h.runtime.stores.group.expenses.listEntries(BARCELONA.tripId)) {
    if (en.memberId !== memberId) continue;
    net += en.kind === 'paid' ? en.amount.amountMinor : -en.amount.amountMinor;
  }
  return net;
}

describe('balance asks route deterministically for every member (T-091)', () => {
  it('every Barcelona member gets the settle_up card from "@trav settle now"', async () => {
    const h = harness();
    await withTab(h);
    const before = h.model.completions.length;
    for (const m of BARCELONA.members) {
      const turn = await h.say(m.handle, '@trav settle now');
      const msg = only(turn);
      expect(msg.card?.type, m.name).toBe('settle_up');
      expect(msg.to).toEqual({ kind: 'group' });
      expect(msg.text).not.toMatch(NOT_SURE);
      expect(turn.toolCalls).toEqual(['get_balances']);
      expect(turn.modelSources).toEqual([]);
      expect(turn.note).toBe('balances:settle_up');
    }
    expect(h.model.completions.length).toBe(before);
  });

  it.each([
    ['h_chase', '@trav settle up', 'balances:settle_up'],
    ['h_piotr', '@trav who owes who', 'balances:settle_up'],
    ['h_dean', '@trav who owes who', 'balances:settle_up'],
    ['h_arjun', '@trav what do i owe', 'balances:mine'],
    ['h_henry', "@trav who's paid for what so far", 'balances:tab'],
    ['h_crowley', '@trav how much have we spent so far', 'balances:tab'],
  ])('%s: %s routes to get_balances', async (from, text, note) => {
    const h = harness();
    await withTab(h);
    const turn = await h.say(from, text);
    const msg = only(turn);
    expect(turn.note).toBe(note);
    expect(turn.toolCalls).toEqual(['get_balances']);
    expect(turn.modelSources).toEqual([]);
    expect(msg.text).not.toMatch(NOT_SURE);
    expect(msg.to).toEqual({ kind: 'group' });
    if (note === 'balances:settle_up') expect(msg.card?.type).toBe('settle_up');
    else expect(msg.text).toContain('€107.40');
  });

  it('"who\'s paid for what so far" is the running tab card with the total (T-085)', async () => {
    const h = harness();
    await withTab(h);
    const msg = only(await h.say('h_dean', "@trav who's paid for what so far"));
    expect(msg.card?.type).toBe('settle_up');
    const card = msg.card?.type === 'settle_up' ? msg.card : undefined;
    expect(card?.mode).toBe('running');
    expect(card?.totalSpent).toEqual(money(10740, 'EUR'));
    const lines = msg.text.split('\n');
    expect(lines[0]).toBe('running tab, €107.40 so far');
    expect(lines[1]).toBe('Dean is owed €63.30 · Crowley is owed €2.70');
    expect(lines[2]).toBe('Henry owes €3.90 · Chase owes €20.70 · Piotr owes €20.70');
    expect(lines[3]).toBe('Arjun owes €20.70');
    expect(card?.balances.reduce((s, b) => s + b.net.amountMinor, 0)).toBe(0);
    expect(msg.text).not.toMatch(/vegetarian|80 a day/);
  });

  it('an empty tab is said plainly, with the total', async () => {
    const h = harness();
    const msg = only(await h.say('h_piotr', '@trav how much have we spent so far'));
    expect(msg.text).toBe('€0 on the tab so far. nobody owes anybody. rare. enjoy it');
  });

  it('an unaddressed "settle up" is chat, not an ask', async () => {
    const h = harness();
    const turn = await h.say('h_chase', 'we should settle up later');
    expect(turn.silent).toBe(true);
    expect(turn.toolCalls).toEqual([]);
  });

  it('"how much does the club cost" still goes to the model', async () => {
    const h = harness();
    const turn = await h.say('h_chase', '@trav how much does the club cost');
    expect(turn.note).not.toMatch(/^balances:/);
    expect(h.model.completions.length).toBeGreaterThan(0);
  });

  it.each(['h_piotr', 'h_arjun', 'h_henry', 'h_dean', 'h_chase', 'h_crowley'])(
    'DM "how much do i owe" from %s answers their own position, privately',
    async (handle) => {
      const h = harness();
      await withTab(h);
      const me = BARCELONA.members.find((m) => m.handle === handle)!;
      const groupBefore = h.channel.groupTranscript().length;
      const turn = await h.dm(handle, 'how much do i owe');
      const msg = only(turn);
      expect(turn.note).toBe('balances:mine');
      expect(turn.toolCalls).toEqual(['get_balances']);
      expect(turn.modelSources).toEqual([]);
      expect(msg.to).toEqual({ kind: 'member', memberId: me.memberId });
      expect(h.channel.groupTranscript()).toHaveLength(groupBefore);
      const [first, ...rest] = msg.text.split('\n');
      const net = netOf(h, me.memberId);
      const amount = formatMoney(money(Math.abs(net), 'EUR'));
      if (net < 0) expect(first).toMatch(/^you owe /);
      else if (net > 0) expect(first).toMatch(/owe(?:s|d)? you|you're owed/);
      else expect(first).toBe("you're square, nothing to pay");
      if (net !== 0) expect(first).toContain(amount);
      expect(rest).toEqual(['€107.40 on the tab so far']);
      // No other debtor's line: the only names are the other side of my transfers.
      expect(msg.text).not.toContain(' → ');
      if (net < 0) {
        for (const other of BARCELONA.members) {
          if (other.memberId === me.memberId || other.name === 'Dean' || other.name === 'Crowley')
            continue;
          expect(msg.text, other.name).not.toContain(other.name);
        }
      }
    },
  );

  it('a DM "who owes who" is still personal, and points at the group list', async () => {
    const h = harness();
    await withTab(h);
    const turn = await h.dm('h_piotr', 'who owes who');
    const msg = only(turn);
    expect(turn.note).toBe('balances:mine');
    expect(msg.to).toEqual({ kind: 'member', memberId: 'mem_piotr' });
    expect(msg.card).toBeUndefined();
    const lines = msg.text.split('\n');
    expect(lines[0]).toMatch(/^you owe /);
    expect(lines.at(-1)).toBe(GROUP_LIST_HINT_TEXT);
    for (const other of ['Chase', 'Arjun', 'Henry']) expect(msg.text).not.toContain(other);
  });
});

// ---------- Turks and Caicos: a minor's DM (VOICE §8) ----------

interface GroupFixture {
  readonly group: Group;
  readonly members: Member[];
  readonly trip: Trip;
  readonly activities: Activity[];
}
const TCI = JSON.parse(
  readFileSync(join(repoRoot(), 'fixtures', 'groups', 'turks-and-caicos.json'), 'utf8'),
) as GroupFixture;

function tci(familyTab: boolean, opts: { noTrip?: boolean; noGuardian?: boolean } = {}) {
  const clock = createSimulatedClock('2026-06-21T15:00:00-04:00');
  const ids = createDeterministicIdGenerator('tci');
  const stores = createMemoryStores({ clock, ids });
  stores.group.groups.create(TCI.group);
  for (const m of TCI.members) {
    if (opts.noGuardian === true && m.guardianMemberId !== undefined) {
      const { guardianMemberId: _g, ...rest } = m;
      stores.group.members.upsert(rest);
    } else stores.group.members.upsert(m);
  }
  if (opts.noTrip !== true) stores.group.trips.create({ ...TCI.trip, familyTab });
  if (opts.noTrip !== true) for (const a of TCI.activities) stores.group.trips.upsertActivity(a);
  const channel = createSimulatorChannel({
    clock,
    conversations: [
      {
        conversationId: TCI.group.conversationId,
        participants: TCI.members.map((m) => ({
          handle: m.senderId,
          displayName: m.displayName,
          memberId: m.memberId,
        })),
      },
    ],
  });
  const runtime = createTravRuntime({
    channel,
    clock,
    ids,
    stores,
    seed: 'none',
    offline: true,
    env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: tempStateDir() },
    voice: 'strict',
  });
  return {
    runtime,
    say: async (from: string, text: string) =>
      runtime.agent.handleInbound(await channel.injectMessage({ from, text })),
    dm: async (from: string, text: string) =>
      runtime.agent.handleInbound(await channel.injectMessage({ from, text, lane: 'dm' })),
  };
}

describe('Turks and Caicos: Lily asks what she owes', () => {
  it('family tab: Lily owes nothing and hears nothing about anyone else', async () => {
    const w = tci(true);
    await w.say('h_dad', '@trav I paid $120 for dinner, split with everyone');
    const turn = await w.dm('h_lily', 'how much do i owe');
    const msg = only(turn);
    expect(turn.toolCalls).toEqual(['get_balances']);
    expect(turn.modelSources).toEqual([]);
    expect(msg.to).toEqual({ kind: 'member', memberId: 'mem_tci_lily' });
    expect(msg.text).toBe("you don't owe anything. it's all on the family tab");
    const group = only(await w.say('h_mom', '@trav how much have we spent so far'));
    expect(group.card?.type).toBe('settle_up');
    expect(group.text).toBe('$120 on the family tab so far, nothing to split');
  });

  it("split mode: Lily's share is on Dad's tab; Dad hears it is in his", async () => {
    const w = tci(false);
    const logged = await w.say('h_mom', '@trav I paid $120 for dinner, split with everyone');
    expect(logged.note).not.toMatch(/model/);
    const lily = only(await w.dm('h_lily', 'how much do i owe'));
    expect(lily.text).toBe("you don't owe anyone, under-18s never do. your share's on Dad's tab");
    // Any balance ask in a minor's DM is only ever her own line.
    expect(only(await w.dm('h_lily', 'who owes who')).text).toBe(lily.text);
    const dad = only(await w.dm('h_dad', 'how much do i owe'));
    expect(dad.text.split('\n')[0]).toBe('you owe Mom $60');
    expect(dad.text).toContain("Lily's share is in yours");
    expect(dad.text).not.toMatch(/Lily →|→ Lily/);
  });
});

describe('Turks and Caicos: no guardian set, no trip (r2 #2, #3)', () => {
  it("an adult's DM gets a personal line; the guardian question stays in the group", async () => {
    const w = tci(false, { noGuardian: true });
    const logged = await w.say('h_mom', '@trav I paid $120 for dinner, split with everyone');
    expect(logged.note).not.toMatch(/model/);
    const dm = only(await w.dm('h_dean', 'how much do i owe'));
    expect(dm.to).toEqual({ kind: 'member', memberId: 'mem_tci_dean' });
    expect(dm.text).toBe("can't split yet, Mom or Dad has to say who's covering Lily");
    const group = only(await w.say('h_dean', '@trav what do i owe'));
    expect(group.to).toEqual({ kind: 'group' });
    expect(group.text).toMatch(/^quick one before i settle up, Mom and Dad: who's covering Lily\?/);
  });

  it('with no trip, a balance ask is one deterministic line, group or DM', async () => {
    const w = tci(false, { noTrip: true });
    for (const turn of [
      await w.say('h_mom', '@trav settle up'),
      await w.say('h_dad', "@trav who's paid for what so far"),
      await w.dm('h_dad', 'how much do i owe'),
    ]) {
      const msg = only(turn);
      expect(turn.note).toBe('balances:no_trip');
      expect(turn.modelSources).toEqual([]);
      expect(msg.text).toBe(NO_TRIP_BALANCE_TEXT);
    }
  });
});

// ---------- a pending booking owns "my share" and "the total" (r2 #1) ----------

describe('balance asks next to a booking go to the model, not the ledger', () => {
  async function withProposal(h: Harness): Promise<OutboundMessage> {
    await withTab(h);
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    expect(h.pending()).toHaveLength(1);
    const card = messages(turn).find((m) => m.card?.type === 'booking_proposal');
    expect(card).toBeDefined();
    return card!;
  }

  it.each([
    "@trav what's my share",
    "@trav what's the total",
    "@trav what's my balance",
    '@trav how much do i owe',
  ])('%s while the Razzmatazz proposal is open', async (text) => {
    const h = harness();
    await withProposal(h);
    const turn = await h.say('h_chase', text);
    expect(turn.note ?? '').not.toMatch(/^balances:/);
    for (const m of messages(turn)) {
      expect(m.text).not.toContain('€16.80');
      expect(m.text).not.toContain('€84');
    }
  });

  it('a quote-reply to the proposal card is about the booking, even past the window', async () => {
    const h = harness();
    const card = await withProposal(h);
    h.clock.advanceMs(REPLY_WINDOW_MS + 1000);
    const turn = await h.say('h_chase', "@trav what's my balance", {
      replyToMessageId: card.id,
    });
    expect(turn.note ?? '').not.toMatch(/^balances:/);
  });

  it('past the reply window, a plain balance ask is the ledger again', async () => {
    const h = harness();
    await withProposal(h);
    h.clock.advanceMs(REPLY_WINDOW_MS + 1000);
    const turn = await h.say('h_chase', '@trav how much do i owe');
    expect(turn.note).toBe('balances:mine');
  });
});

// ---------- T-085: the tab card equals the ledger fixture checkpoints (r2 #4) ----------

interface Checkpoint {
  readonly expenseIds: string[];
  readonly totalSpent: { amountMinor: number; currency: string };
  readonly balances: { memberId: MemberId; net: { amountMinor: number } }[];
}
const BCN_GROUP = JSON.parse(
  readFileSync(join(repoRoot(), 'fixtures', 'groups', 'barcelona.json'), 'utf8'),
) as GroupFixture;
const BCN_LEDGER = JSON.parse(
  readFileSync(join(repoRoot(), 'fixtures', 'ledger', 'barcelona.json'), 'utf8'),
) as { expenses: Expense[]; checkpoints: Record<string, Checkpoint> };

describe('T-085: "who\'s paid for what so far" matches the ledger checkpoints', () => {
  it.each(['after_dinner_d1', 'morning_day4'])('%s', async (name) => {
    const cp = BCN_LEDGER.checkpoints[name]!;
    const h = harness();
    const order = BCN_GROUP.members.map((m) => m.memberId);
    for (const id of cp.expenseIds) {
      const raw = BCN_LEDGER.expenses.find((e) => e.expenseId === id)!;
      const {
        expectedShares: _s,
        fromChatLine: _f,
        ...e
      } = raw as Expense & { expectedShares?: unknown; fromChatLine?: unknown };
      h.runtime.stores.group.expenses.create(
        e,
        ledger.buildLedgerEntries(e, ledger.contextFor(order)),
      );
    }
    const turn = await h.say('h_arjun', "@trav who's paid for what so far");
    expect(turn.note).toBe('balances:tab');
    const msg = only(turn);
    const card = msg.card?.type === 'settle_up' ? msg.card : undefined;
    expect(card?.mode).toBe('running');
    expect(card?.totalSpent).toEqual(cp.totalSpent);
    expect(msg.text.split('\n')[0]).toBe(
      `running tab, ${formatMoney(money(cp.totalSpent.amountMinor, 'EUR'))} so far`,
    );
    const net = new Map(card!.balances.map((b) => [b.memberId, b.net.amountMinor]));
    for (const b of cp.balances)
      expect(net.get(b.memberId) ?? 0, b.memberId).toBe(b.net.amountMinor);
  });
});

// ---------- the model path's DM get_balances is personal too (r2 #5) ----------

describe('a DM get_balances from the model renders the personal line', () => {
  function balancesThenSilent(): ModelClient {
    let n = 0;
    return {
      mode: 'offline',
      complete(req: CompletionRequest): Promise<CompletionResponse> {
        n += 1;
        return Promise.resolve({
          text: '',
          toolCalls: n === 1 ? [{ id: 'c1', name: 'get_balances', input: {} }] : [],
          usage: { inputTokens: 0, outputTokens: 0 },
          source: 'script',
          scriptKey: deriveScriptKey(req),
        });
      },
      classify: () => Promise.reject(new Error('not used')),
    };
  }

  it('"how much do i owe crowley" in a DM: own transfers only, no group list', async () => {
    const h = harness({ model: balancesThenSilent() });
    await withTab(h);
    const turn = await h.dm('h_piotr', 'how much do i owe crowley');
    expect(turn.toolCalls).toEqual(['get_balances']);
    expect(turn.note).toBe('tool:get_balances:mine');
    const msg = only(turn);
    expect(msg.to).toEqual({ kind: 'member', memberId: 'mem_piotr' });
    expect(msg.card).toBeUndefined();
    expect(msg.text.split('\n')[0]).toMatch(/^you owe /);
    expect(msg.text).not.toContain(' → ');
    for (const other of ['Chase', 'Arjun', 'Henry']) expect(msg.text).not.toContain(other);
    expect(msg.text.split('\n').at(-1)).toBe(GROUP_LIST_HINT_TEXT);
  });
});

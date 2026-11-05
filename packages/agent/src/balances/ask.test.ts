import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Activity, Group, Member, OutboundMessage, Trip } from '@trav/core';
import {
  createDeterministicIdGenerator,
  createSimulatedClock,
  formatMoney,
  isReaction,
  money,
} from '@trav/core';
import { createSimulatorChannel } from '@trav/adapters';
import { BARCELONA, createTravRuntime } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { repoRoot } from '../model/paths.js';
import { harness, tempStateDir, type Harness } from '../runtime.testkit.js';
import { createMemoryStores } from '@trav/core/storage';
import type { BalancesResult } from '../tools/ledger.js';
import { GROUP_LIST_HINT_TEXT, myPositionText, parseBalanceAsk } from './ask.js';

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
const SAM = M('sam', 'Sam');
const MAYA = M('maya', 'Maya');
const LILY_NO_GUARDIAN: Member = { ...M('lily', 'Lily'), ageBand: 'under18' };
const LILY: Member = { ...LILY_NO_GUARDIAN, guardianMemberId: 'dean' };
const ALL = [DEAN, SAM, MAYA, LILY];

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
    { from: 'dean', to: 'sam', amountMinor: 390, text: 'Dean → Sam €3.90' },
    { from: 'maya', to: 'sam', amountMinor: 1200, text: 'Maya → Sam €12' },
  ];

  it("a debtor sees only their own transfer, first, and never anyone else's", () => {
    const text = myPositionText({
      balances: result({ transfers }),
      me: DEAN,
      members: ALL,
      meIsMinor: false,
    });
    expect(text).toBe('you owe Sam €3.90\n€23.40 on the tab so far');
    expect(text).not.toContain('Maya');
  });

  it('a creditor sees who owes them, summed', () => {
    const text = myPositionText({
      balances: result({ transfers }),
      me: SAM,
      members: ALL,
      meIsMinor: false,
    });
    expect(text.split('\n')[0]).toBe("you're owed €15.90: Dean €3.90 · Maya €12");
  });

  it('several debts are summed, one line', () => {
    const text = myPositionText({
      balances: result({
        transfers: [
          { from: 'maya', to: 'sam', amountMinor: 390, text: '' },
          { from: 'maya', to: 'dean', amountMinor: 1680, text: '' },
        ],
      }),
      me: MAYA,
      members: ALL,
      meIsMinor: false,
    });
    expect(text.split('\n')[0]).toBe('you owe €20.70: Sam €3.90 · Dean €16.80');
  });

  it('square when no transfer names the asker, including an empty tab', () => {
    expect(
      myPositionText({
        balances: result({ totalSpentMinor: 0, text: '' }),
        me: MAYA,
        members: ALL,
        meIsMinor: false,
      }),
    ).toBe("you're square, nothing to pay\n€0 on the tab so far");
  });

  it("a guardian is told the minor's share is in theirs", () => {
    const text = myPositionText({
      balances: result({
        transfers: [{ from: 'dean', to: 'sam', amountMinor: 780, text: '' }],
        folded: [{ minor: 'lily', name: 'Lily', guardian: 'dean', guardianName: 'Dean' }],
      }),
      me: DEAN,
      members: ALL,
      meIsMinor: false,
    });
    expect(text).toBe("you owe Sam €7.80\n€23.40 on the tab so far\nLily's share is in yours");
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
  });
});

// ---------- Barcelona, end to end (T-091) ----------

/** Dean's €84 dinner without Henry, then Sam's €23.40 uber for all six. */
async function withTab(h: Harness): Promise<void> {
  const dinner = await h.say('h_dean', '@trav I paid €84 for dinner, split w everyone but Henry');
  expect(dinner.note).not.toMatch(/model/);
  const uber = await h.say('h_sam', '@trav I paid €23.40 for the uber, split with everyone');
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
    ['h_maya', '@trav settle up', 'balances:settle_up'],
    ['h_jordan', '@trav who owes who', 'balances:settle_up'],
    ['h_dean', '@trav who owes who', 'balances:settle_up'],
    ['h_priya', '@trav what do i owe', 'balances:mine'],
    ['h_henry', "@trav who's paid for what so far", 'balances:tab'],
    ['h_sam', '@trav how much have we spent so far', 'balances:tab'],
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
    expect(lines[1]).toBe('Dean is owed €63.30 · Sam is owed €2.70');
    expect(lines[2]).toBe('Henry owes €3.90 · Maya owes €20.70 · Jordan owes €20.70');
    expect(lines[3]).toBe('Priya owes €20.70');
    expect(card?.balances.reduce((s, b) => s + b.net.amountMinor, 0)).toBe(0);
    expect(msg.text).not.toMatch(/vegetarian|80 a day/);
  });

  it('an empty tab is said plainly, with the total', async () => {
    const h = harness();
    const msg = only(await h.say('h_jordan', '@trav how much have we spent so far'));
    expect(msg.text).toBe('€0 on the tab so far. nobody owes anybody. rare. enjoy it');
  });

  it('an unaddressed "settle up" is chat, not an ask', async () => {
    const h = harness();
    const turn = await h.say('h_maya', 'we should settle up later');
    expect(turn.silent).toBe(true);
    expect(turn.toolCalls).toEqual([]);
  });

  it('"how much does the club cost" still goes to the model', async () => {
    const h = harness();
    const turn = await h.say('h_maya', '@trav how much does the club cost');
    expect(turn.note).not.toMatch(/^balances:/);
    expect(h.model.completions.length).toBeGreaterThan(0);
  });

  it.each(['h_jordan', 'h_priya', 'h_henry', 'h_dean', 'h_maya', 'h_sam'])(
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
          if (other.memberId === me.memberId || other.name === 'Dean' || other.name === 'Sam')
            continue;
          expect(msg.text, other.name).not.toContain(other.name);
        }
      }
    },
  );

  it('a DM "who owes who" is still personal, and points at the group list', async () => {
    const h = harness();
    await withTab(h);
    const turn = await h.dm('h_jordan', 'who owes who');
    const msg = only(turn);
    expect(turn.note).toBe('balances:mine');
    expect(msg.to).toEqual({ kind: 'member', memberId: 'mem_jordan' });
    expect(msg.card).toBeUndefined();
    const lines = msg.text.split('\n');
    expect(lines[0]).toMatch(/^you owe /);
    expect(lines.at(-1)).toBe(GROUP_LIST_HINT_TEXT);
    for (const other of ['Maya', 'Priya', 'Henry']) expect(msg.text).not.toContain(other);
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

function tci(familyTab: boolean) {
  const clock = createSimulatedClock('2026-06-21T15:00:00-04:00');
  const ids = createDeterministicIdGenerator('tci');
  const stores = createMemoryStores({ clock, ids });
  stores.group.groups.create(TCI.group);
  for (const m of TCI.members) stores.group.members.upsert(m);
  stores.group.trips.create({ ...TCI.trip, familyTab });
  for (const a of TCI.activities) stores.group.trips.upsertActivity(a);
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

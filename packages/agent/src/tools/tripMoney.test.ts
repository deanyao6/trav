import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Group, Member, Trip } from '@trav/core';
import { ledger, money, TravError } from '@trav/core';
import { BARCELONA } from '../compose.js';
import { harness, type Harness } from '../runtime.testkit.js';
import { buildGroupContext, renderGroupPrompt } from '../context/groupContext.js';
import { repoRoot } from '../model/paths.js';
import { renderSettleUp } from '../render/settleUp.js';
import type { RenderContext } from '../render/common.js';
import { voiceViolations } from '../render/lint.js';
import { renderRecap } from '../render/recap.js';
import { consentFor } from '../render/testkit.js';
import { renderWrapped } from '../render/wrapped.js';
import { balancesFor, renderSettleUpFor, settleUpFor } from './ledger.js';
import type { TurnToolContext } from './shared.js';

const G = BARCELONA.groupId;
const T = BARCELONA.tripId;

function bcnCtx(h: Harness, sender: string, messageId: string): TurnToolContext {
  return {
    groupId: G,
    tripId: T,
    senderMemberId: sender,
    senderId: `h_${sender.slice(4)}`,
    lane: 'group',
    now: h.clock.now(),
    clock: h.clock,
    ids: h.ids,
    stores: h.runtime.stores,
    messageId,
  };
}

function renderCtx(h: Harness, groupId: string, timeZone = 'Europe/Madrid'): RenderContext {
  return {
    groupId,
    members: h.runtime.stores.group.members.listByGroup(groupId),
    timeZone,
    now: h.clock.now(),
    ids: h.ids,
  };
}

async function logBarcelona(h: Harness): Promise<void> {
  const run = (sender: string, id: string, input: unknown) =>
    h.runtime.tools.run('log_expense', input, bcnCtx(h, sender, id));
  await run('mem_dean', 'msg_b1', {
    description: 'dinner',
    amountMinor: 8400,
    currency: 'EUR',
    split: { method: 'exclude', excluded: ['Henry'] },
    category: 'food',
  });
  await run('mem_piotr', 'msg_b2', {
    description: 'kebabs',
    amountMinor: 6200,
    currency: 'EUR',
    split: { method: 'equal', participants: ['Piotr', 'Chase', 'Crowley'] },
    category: 'food',
  });
  await run('mem_arjun', 'msg_b3', {
    description: 'uber',
    amountMinor: 2333,
    currency: 'EUR',
    split: { method: 'exclude', excluded: [] },
    category: 'transport',
  });
  await run('mem_chase', 'msg_b4', {
    description: 'groceries',
    amountMinor: 4100,
    currency: 'EUR',
    split: {
      method: 'exact',
      amounts: [
        { member: 'Chase', amountMinor: 1000 },
        { member: 'Henry', amountMinor: 3100 },
      ],
    },
    category: 'groceries',
  });
}

describe('T-065 trip money in the agent: Barcelona unchanged', () => {
  it('balancesFor, group context balances and the settle-up card match the pre-T-065 snapshot', async () => {
    const h = harness();
    await logBarcelona(h);
    const ctx = bcnCtx(h, 'mem_dean', 'msg_b5');
    const b = balancesFor(ctx);
    // T-065 only adds `mode` and `folded`; everything else is the pre-T-065 output, verbatim.
    const { mode, folded, ...legacy } = b;
    expect(mode).toBe('split');
    expect(folded).toEqual([]);
    expect(b.needsGuardian).toBeUndefined();
    expect(legacy).toMatchInlineSnapshot(`
      {
        "balances": [
          {
            "memberId": "mem_dean",
            "name": "Dean",
            "netMinor": 6331,
          },
          {
            "memberId": "mem_henry",
            "name": "Henry",
            "netMinor": -3489,
          },
          {
            "memberId": "mem_chase",
            "name": "Chase",
            "netMinor": -1036,
          },
          {
            "memberId": "mem_piotr",
            "name": "Piotr",
            "netMinor": 2064,
          },
          {
            "memberId": "mem_arjun",
            "name": "Arjun",
            "netMinor": 264,
          },
          {
            "memberId": "mem_crowley",
            "name": "Crowley",
            "netMinor": -4134,
          },
        ],
        "currency": "EUR",
        "text": "€210.33 on the tab so far
      Henry → Dean €21.97
      Henry → Piotr €12.92
      Chase → Piotr €7.72
      Chase → Arjun €2.64
      Crowley → Dean €41.34",
        "totalSpentMinor": 21033,
        "transfers": [
          {
            "amountMinor": 2197,
            "from": "mem_henry",
            "text": "Henry → Dean €21.97",
            "to": "mem_dean",
          },
          {
            "amountMinor": 1292,
            "from": "mem_henry",
            "text": "Henry → Piotr €12.92",
            "to": "mem_piotr",
          },
          {
            "amountMinor": 772,
            "from": "mem_chase",
            "text": "Chase → Piotr €7.72",
            "to": "mem_piotr",
          },
          {
            "amountMinor": 264,
            "from": "mem_chase",
            "text": "Chase → Arjun €2.64",
            "to": "mem_arjun",
          },
          {
            "amountMinor": 4134,
            "from": "mem_crowley",
            "text": "Crowley → Dean €41.34",
            "to": "mem_dean",
          },
        ],
      }
    `);

    const gc = buildGroupContext(
      {
        group: h.runtime.stores.group,
        clock: h.clock,
      },
      G,
      T,
    );
    expect(gc.balances.map((x) => [x.memberId, x.net.amountMinor])).toMatchInlineSnapshot(`
      [
        [
          "mem_dean",
          6331,
        ],
        [
          "mem_henry",
          -3489,
        ],
        [
          "mem_chase",
          -1036,
        ],
        [
          "mem_piotr",
          2064,
        ],
        [
          "mem_arjun",
          264,
        ],
        [
          "mem_crowley",
          -4134,
        ],
      ]
    `);

    const msg = renderSettleUp(
      {
        mode: 'final',
        currency: 'EUR',
        balances: b.balances.map((x) => ({ memberId: x.memberId, net: money(x.netMinor, 'EUR') })),
        totalSpent: money(b.totalSpentMinor, 'EUR'),
      },
      renderCtx(h, G),
    );
    // The store-backed path (settleUpFor → tripLedger) renders the identical card.
    const viaStore = renderSettleUpFor(ctx, 'final', renderCtx(h, G));
    expect({ text: viaStore.text, card: { ...viaStore.card, cardId: 'x' } }).toEqual({
      text: msg.text,
      card: { ...msg.card, cardId: 'x' },
    });
    expect(viaStore.actions?.map((a) => a.id)).toEqual(['sent', 'got_it']);
    expect({ text: msg.text, card: { ...msg.card, cardId: 'x' } }).toMatchInlineSnapshot(`
      {
        "card": {
          "asOf": "2026-03-14T21:40:00+01:00",
          "balances": [
            {
              "memberId": "mem_dean",
              "name": "Dean",
              "net": {
                "amountMinor": 6331,
                "currency": "EUR",
              },
            },
            {
              "memberId": "mem_henry",
              "name": "Henry",
              "net": {
                "amountMinor": -3489,
                "currency": "EUR",
              },
            },
            {
              "memberId": "mem_chase",
              "name": "Chase",
              "net": {
                "amountMinor": -1036,
                "currency": "EUR",
              },
            },
            {
              "memberId": "mem_piotr",
              "name": "Piotr",
              "net": {
                "amountMinor": 2064,
                "currency": "EUR",
              },
            },
            {
              "memberId": "mem_arjun",
              "name": "Arjun",
              "net": {
                "amountMinor": 264,
                "currency": "EUR",
              },
            },
            {
              "memberId": "mem_crowley",
              "name": "Crowley",
              "net": {
                "amountMinor": -4134,
                "currency": "EUR",
              },
            },
          ],
          "cardId": "x",
          "currency": "EUR",
          "fallbackText": "final settle, 5 transfers and everyone's square
      Henry → Dean €21.97
      Henry → Piotr €12.92
      Chase → Piotr €7.72
      Chase → Arjun €2.64
      Crowley → Dean €41.34
      tap Sent when you've paid. whoever's getting it taps Got it or 👍, that's what clears it",
          "mode": "final",
          "title": "final settle",
          "totalSpent": {
            "amountMinor": 21033,
            "currency": "EUR",
          },
          "transfers": [
            {
              "amount": {
                "amountMinor": 2197,
                "currency": "EUR",
              },
              "from": "mem_henry",
              "to": "mem_dean",
            },
            {
              "amount": {
                "amountMinor": 1292,
                "currency": "EUR",
              },
              "from": "mem_henry",
              "to": "mem_piotr",
            },
            {
              "amount": {
                "amountMinor": 772,
                "currency": "EUR",
              },
              "from": "mem_chase",
              "to": "mem_piotr",
            },
            {
              "amount": {
                "amountMinor": 264,
                "currency": "EUR",
              },
              "from": "mem_chase",
              "to": "mem_arjun",
            },
            {
              "amount": {
                "amountMinor": 4134,
                "currency": "EUR",
              },
              "from": "mem_crowley",
              "to": "mem_dean",
            },
          ],
          "type": "settle_up",
        },
        "text": "final settle, 5 transfers and everyone's square
      Henry → Dean €21.97
      Henry → Piotr €12.92
      Chase → Piotr €7.72
      Chase → Arjun €2.64
      Crowley → Dean €41.34
      tap Sent when you've paid. whoever's getting it taps Got it or 👍, that's what clears it",
      }
    `);
  });
});

// ---------- Turks and Caicos (family tab; Lily, 14, guardian Dad) ----------

interface TciGroupFixture {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip;
}

interface TciLedgerFixture {
  readonly expenses: readonly {
    readonly expenseId: string;
    readonly description: string | null;
    readonly category: string | null;
    readonly amount: { readonly amountMinor: number; readonly currency: string };
    readonly paidBy: string;
    readonly occurredAt: string;
    readonly fromChatLine: string;
  }[];
  readonly final: {
    readonly totalSpent: { readonly amountMinor: number };
    readonly transfers: readonly unknown[];
    readonly neverInBalances: readonly string[];
  };
}

function readFixture<T>(rel: string): T {
  return JSON.parse(readFileSync(join(repoRoot(), 'fixtures', rel), 'utf8')) as T;
}

const TCI_GROUP = readFixture<TciGroupFixture>('groups/turks-and-caicos.json');
const TCI_LEDGER = readFixture<TciLedgerFixture>('ledger/turks-and-caicos.json');
const TG = TCI_GROUP.group.groupId;
const TT = TCI_GROUP.trip.tripId;
const LILY = 'mem_tci_lily';
const TZ_TCI = TCI_GROUP.trip.timeZone;

interface TciSeedOptions {
  readonly familyTab?: boolean;
  /** Drop Lily's guardian (VOICE §8 question path). */
  readonly noGuardian?: boolean;
}

function withoutGuardian(m: Member): Member {
  const { guardianMemberId: _g, ...rest } = m;
  return rest;
}

function tciCtx(h: Harness, sender: string, messageId: string): TurnToolContext {
  const m = TCI_GROUP.members.find((x) => x.memberId === sender);
  return {
    groupId: TG,
    tripId: TT,
    senderMemberId: sender,
    senderId: m?.senderId ?? 'h_x',
    lane: 'group',
    now: h.clock.now(),
    clock: h.clock,
    ids: h.ids,
    stores: h.runtime.stores,
    messageId,
  };
}

/** The TCI group seeded next to Barcelona in the harness stores; every fixture expense logged through `log_expense` by its payer. */
async function tciHarness(opts: TciSeedOptions = {}): Promise<Harness> {
  const h = harness();
  const g = h.runtime.stores.group;
  g.groups.create(TCI_GROUP.group);
  for (const m of TCI_GROUP.members) {
    g.members.upsert(opts.noGuardian === true && m.memberId === LILY ? withoutGuardian(m) : m);
  }
  g.trips.create({ ...TCI_GROUP.trip, familyTab: opts.familyTab ?? TCI_GROUP.trip.familyTab });
  for (const e of TCI_LEDGER.expenses) {
    await h.runtime.tools.run(
      'log_expense',
      {
        description: e.description ?? e.expenseId,
        amountMinor: e.amount.amountMinor,
        currency: e.amount.currency,
        split: { method: 'exclude', excluded: [] },
        ...(e.category !== null ? { category: e.category } : {}),
        occurredAt: e.occurredAt,
      },
      tciCtx(h, e.paidBy, e.fromChatLine),
    );
  }
  return h;
}

function tciContext(h: Harness) {
  return buildGroupContext({ group: h.runtime.stores.group, clock: h.clock }, TG, TT);
}

function tciRender(h: Harness, members: readonly Member[] = TCI_GROUP.members): RenderContext {
  return { groupId: TG, members, timeZone: TZ_TCI, now: h.clock.now(), ids: h.ids };
}

const VOICE_CFG = {
  systemPromptId: 'group_chat_v1',
  persona: "you're trav, the group's trip friend.",
};

describe('T-065: TCI family tab through the agent', () => {
  it('exp_tci_004 (Lily pays $24) is logged on her; the settle-up card has no Lily row and zero transfers', async () => {
    const h = await tciHarness();
    const lilys = h.runtime.stores.group.expenses
      .listByTrip(TT)
      .filter((e) => e.paidBy.some((p) => p.memberId === LILY));
    expect(lilys.map((e) => e.amount.amountMinor)).toEqual([2400]);

    const ctx = tciCtx(h, 'mem_tci_mom', 'msg_tci_settle');
    const r = settleUpFor(ctx, 'final');
    if (r.kind !== 'ok') throw new Error('expected a settle-up input');
    expect(r.input.familyTab).toBe(true);
    const msg = renderSettleUp(r.input, tciRender(h));
    expect(msg.card.transfers).toEqual([]);
    expect(TCI_LEDGER.final.transfers).toEqual([]);
    for (const id of TCI_LEDGER.final.neverInBalances) {
      expect(msg.card.balances.map((b) => b.memberId)).not.toContain(id);
    }
    expect(msg.card.balances.map((b) => b.memberId)).toEqual([
      'mem_tci_mom',
      'mem_tci_dad',
      'mem_tci_dean',
    ]);
    expect(msg.card.balances.every((b) => b.net.amountMinor === 0)).toBe(true);
    expect(msg.card.totalSpent.amountMinor).toBe(TCI_LEDGER.final.totalSpent.amountMinor);
    expect(msg.text).toBe("everything's on the family tab, nothing to split");
    expect(msg.actions ?? []).toEqual([]);
    expect(voiceViolations(msg, TCI_GROUP.members, TCI_GROUP.trip)).toEqual([]);

    // Running mode through the one-call composer.
    const running = renderSettleUpFor(ctx, 'running', tciRender(h));
    expect(running.card?.type).toBe('settle_up');
    expect(running.text).toBe("everything's on the family tab, nothing to split");
  });

  it('get_balances: family tab text, no Lily, no transfers; the group context agrees', async () => {
    const h = await tciHarness();
    const b = balancesFor(tciCtx(h, 'mem_tci_dad', 'msg_x'));
    expect(b.mode).toBe('family_tab');
    expect(b.transfers).toEqual([]);
    expect(b.balances.map((x) => x.memberId)).not.toContain(LILY);
    expect(b.balances.every((x) => x.netMinor === 0)).toBe(true);
    expect(b.totalSpentMinor).toBe(80600);
    expect(b.text).toBe('$806 on the family tab so far, nothing to split');
    expect(b.needsGuardian).toBeUndefined();
    const via = await h.runtime.tools.run('get_balances', {}, tciCtx(h, 'mem_tci_dad', 'msg_y'));
    expect(via).toEqual(b);

    const gc = tciContext(h);
    expect(gc.balances.map((x) => x.memberId)).not.toContain(LILY);
    expect(gc.balances.every((x) => x.net.amountMinor === 0)).toBe(true);
    const { context: prompt } = renderGroupPrompt(gc, VOICE_CFG);
    expect(prompt).toContain('money: family tab, one pot');
    expect(prompt).not.toMatch(/balances \(positive = is owed\)/);
  });

  it('split mode (family tab off): Lily folds into Dad, never a debtor or creditor', async () => {
    const h = await tciHarness({ familyTab: false });
    const b = balancesFor(tciCtx(h, 'mem_tci_mom', 'msg_x'));
    expect(b.mode).toBe('split');
    // 4 equal shares: 6500 + 9500 + 3550 + 600 = 20150 each; Lily's share and her $24 go to Dad.
    expect(b.balances.map((x) => [x.memberId, x.netMinor])).toEqual([
      ['mem_tci_mom', 52200 - 20150],
      ['mem_tci_dad', 26000 + 2400 - 2 * 20150],
      ['mem_tci_dean', -20150],
    ]);
    expect(b.transfers.map((t) => [t.from, t.to, t.amountMinor])).toEqual([
      ['mem_tci_dad', 'mem_tci_mom', 11900],
      ['mem_tci_dean', 'mem_tci_mom', 20150],
    ]);
    expect(b.folded).toEqual([
      { minor: LILY, name: 'Lily', guardian: 'mem_tci_dad', guardianName: 'Dad' },
    ]);
    expect(b.text.split('\n').at(-1)).toBe('Lily (under Dad)');

    const r = settleUpFor(tciCtx(h, 'mem_tci_mom', 'msg_y'), 'final');
    if (r.kind !== 'ok') throw new Error('expected a settle-up input');
    const msg = renderSettleUp(r.input, tciRender(h));
    expect(msg.card.balances.map((x) => x.memberId)).not.toContain(LILY);
    expect(msg.card.transfers.flatMap((t) => [t.from, t.to])).not.toContain(LILY);
    expect(msg.card.balances.reduce((s, x) => s + x.net.amountMinor, 0)).toBe(0);
    expect(msg.actions?.[0]?.allowedMemberIds).toEqual(['mem_tci_dad', 'mem_tci_dean']);
    expect(voiceViolations(msg, TCI_GROUP.members, TCI_GROUP.trip)).toEqual([]);
    expect(tciContext(h).balances.map((x) => x.memberId)).toEqual([
      'mem_tci_mom',
      'mem_tci_dad',
      'mem_tci_dean',
    ]);
  });

  it('a guardian-less minor with money: ask the leads (VOICE §8), never throw', async () => {
    const question =
      "quick one before i settle up, Mom and Dad: who's covering Lily? under-18s never owe anyone here, so Lily's share goes on an adult's tab";
    // Family tab on: nobody owes anybody, so no question (T-065 review #1).
    {
      const h = await tciHarness({ noGuardian: true, familyTab: true });
      const ctx = tciCtx(h, 'mem_tci_mom', 'msg_x');
      const b = balancesFor(ctx);
      expect(b.mode).toBe('family_tab');
      expect(b.needsGuardian).toBeUndefined();
      expect(b.text).toBe('$806 on the family tab so far, nothing to split');
      expect(b.balances.map((x) => x.memberId)).not.toContain(LILY);
      expect(settleUpFor(ctx, 'final').kind).toBe('ok');
      const members = h.runtime.stores.group.members.listByGroup(TG);
      const msg = renderSettleUpFor(ctx, 'final', tciRender(h, members));
      expect(msg.text).toBe("everything's on the family tab, nothing to split");
    }
    for (const familyTab of [false]) {
      const h = await tciHarness({ noGuardian: true, familyTab });
      const ctx = tciCtx(h, 'mem_tci_mom', 'msg_x');
      const b = balancesFor(ctx);
      expect(b.text).toBe(question);
      expect(b.balances).toEqual([]);
      expect(b.transfers).toEqual([]);
      expect(b.needsGuardian).toEqual({
        minors: [LILY],
        askMemberIds: ['mem_tci_mom', 'mem_tci_dad'],
      });
      expect(settleUpFor(ctx, 'final').kind).toBe('needs_guardian');
      const members = h.runtime.stores.group.members.listByGroup(TG);
      const msg = renderSettleUpFor(ctx, 'final', tciRender(h, members));
      expect(msg.card).toBeUndefined();
      expect(msg.to).toEqual({ kind: 'group' });
      expect(msg.text).toBe(question);
      expect(voiceViolations(msg, members, TCI_GROUP.trip)).toEqual([]);
      const gc = tciContext(h);
      expect(gc.balances).toEqual([]);
      // The prompt says settle-up is waiting, never that nobody owes anything (review #3).
      expect(gc.balancesWaitingOn).toEqual([LILY]);
      const { context: prompt } = renderGroupPrompt(gc, VOICE_CFG);
      expect(prompt).toContain('money: settle-up is waiting on who covers Lily');
    }
  });

  it('recap and Wrapped built from settleUpFor show the family tab, no Lily, no transfers (VOICE §4.7 C / §4.8 C)', async () => {
    const h = await tciHarness();
    const r = settleUpFor(tciCtx(h, 'mem_tci_mom', 'msg_x'), 'running');
    if (r.kind !== 'ok') throw new Error('expected a settle-up input');
    const sc = { group: TCI_GROUP.group, trip: TCI_GROUP.trip, consent: consentFor() };
    const recap = renderRecap(
      {
        kind: 'daily',
        date: '2026-06-22',
        dayNumber: 3,
        lastNight: {
          events: [
            { label: 'dinner at Conch Corner Grill', attendees: [], amount: money(14200, 'USD') },
          ],
          total: money(14200, 'USD'),
        },
        settle: r.input,
      },
      tciRender(h),
      sc,
    );
    expect(recap.text.split('\n')).toContain("everything's on the family tab, nothing to split");
    expect(recap.text).not.toContain('→');
    expect(recap.card.settle.transfers).toEqual([]);
    expect(recap.card.settle.balances.map((b) => b.memberId)).not.toContain(LILY);
    expect(voiceViolations(recap, TCI_GROUP.members, TCI_GROUP.trip)).toEqual([]);

    const { mode: _m, ...finalSettle } = r.input;
    const wrapped = renderWrapped(
      {
        trip: { name: 'Turks and Caicos', days: 7, people: 4, currency: 'USD', familyTab: true },
        totals: { spent: money(80600, 'USD'), perPerson: money(20150, 'USD'), byCategory: [] },
        stats: [{ value: '3', label: 'boat days · 0 rainy ones' }],
        awards: [],
        finalSettle,
      },
      tciRender(h),
      sc,
    );
    expect(wrapped.text).toBe(
      [
        'turks and caicos wrapped 🎉',
        '7 days · $806 on the family tab',
        '3 boat days · 0 rainy ones',
      ].join('\n'),
    );
    expect(wrapped.card.finalSettle.transfers).toEqual([]);
    expect(wrapped.card.finalSettle.balances.map((b) => b.memberId)).not.toContain(LILY);
  });
});

describe('T-065: renderSettleUp folds a minor row instead of throwing', () => {
  const net = (memberId: string, amountMinor: number) => ({
    memberId,
    net: money(amountMinor, 'USD'),
  });
  // Lily paid $24 split 4 ways, unfolded (raw computeBalances): Lily +18, everyone else −6.
  const RAW = [
    net('mem_tci_mom', -600),
    net('mem_tci_dad', -600),
    net('mem_tci_dean', -600),
    net(LILY, 1800),
  ];

  it('a minor-paid expense folds into the guardian; Σ unchanged; no Lily row', () => {
    const h = harness();
    const m = renderSettleUp(
      { mode: 'final', currency: 'USD', balances: RAW, totalSpent: money(2400, 'USD') },
      tciRender(h),
    );
    expect(m.card.balances.map((b) => [b.memberId, b.net.amountMinor])).toEqual([
      ['mem_tci_mom', -600],
      ['mem_tci_dad', 1200],
      ['mem_tci_dean', -600],
    ]);
    expect(m.card.transfers.flatMap((t) => [t.from, t.to])).not.toContain(LILY);
    // A guardian not listed at all gets a row.
    const noDad = renderSettleUp(
      {
        mode: 'running',
        currency: 'USD',
        balances: [net('mem_tci_mom', -1800), net(LILY, 1800)],
        totalSpent: money(1800, 'USD'),
      },
      tciRender(h),
    );
    expect(noDad.card.balances.map((b) => [b.memberId, b.net.amountMinor])).toEqual([
      ['mem_tci_mom', -1800],
      ['mem_tci_dad', 1800],
    ]);
  });

  it('a supplied transfer naming a minor is refused; a guardian-less minor throws the typed refusal', () => {
    const h = harness();
    expect(() =>
      renderSettleUp(
        {
          mode: 'final',
          currency: 'USD',
          balances: RAW,
          transfers: [{ from: 'mem_tci_mom', to: LILY, amount: money(600, 'USD') }],
          totalSpent: money(2400, 'USD'),
        },
        tciRender(h),
      ),
    ).toThrow(TravError);
    // On a family tab the supplied transfers are dropped, so they don't throw (review #4a).
    const familyTab = renderSettleUp(
      {
        mode: 'final',
        currency: 'USD',
        balances: RAW,
        transfers: [{ from: 'mem_tci_mom', to: LILY, amount: money(600, 'USD') }],
        totalSpent: money(2400, 'USD'),
        familyTab: true,
      },
      tciRender(h),
    );
    expect(familyTab.card.transfers).toEqual([]);
    const orphaned = TCI_GROUP.members.map((x) => (x.memberId === LILY ? withoutGuardian(x) : x));
    let caught: unknown;
    try {
      renderSettleUp(
        { mode: 'final', currency: 'USD', balances: RAW, totalSpent: money(2400, 'USD') },
        tciRender(h, orphaned),
      );
    } catch (e) {
      caught = e;
    }
    expect(ledger.isMinorWithoutGuardianError(caught)).toBe(true);
  });
});

/**
 * T-134: a personal budget told in a DM ("can you keep my share under 80 a
 * day? money's tight this semester", msg_bcn_d_0002) is kept as a private
 * member-memory fact (scope me, category budget, sourceLane private): the
 * figure the member stated, never the reason, and never in a group message,
 * a group-lane prompt, or the tools a group request carries.
 */
import { describe, expect, it } from 'vitest';
import type { CurrencyCode, OutboundMessage } from '@trav/core';
import { isReaction } from '@trav/core';
import type { CompletionRequest, CompletionResponse, FallbackResponder } from '../client.js';
import {
  MONEY_MEMORY_TEXT,
  SHARE_CAP_TEXT,
  honestGapsResponder,
  parsePrivateBudgetAsk,
  privateBudgetResponder,
  promptCurrency,
  travAskResponders,
} from './asks.js';
import { findBudgetFigure, isHardship, parseBudgetFigure } from '../../memory/budget.js';
import { privateNotedText } from '../../tools/memoryTools.js';
import { DM_CHAT_PROMPT, GROUP_CHAT_PROMPT } from '../../prompts/index.js';
import { BARCELONA } from '../../compose.js';
import { harness } from '../../runtime.testkit.js';
import type { TurnResult } from '../../loop.js';

const G = BARCELONA.groupId;
const EUR = 'EUR' as CurrencyCode;
const HENRY_DM = "can you keep my share under 80 a day? money's tight this semester";
const HENRY_REPLY =
  "noted: you're aiming to keep your share under €80 a day. just a note, not a hard cap, and the group won't see it";
/** Henry's figure and reason: never in anything a group request carries. */
const HENRY_PRIVATE = ['80 a day', '€80', 'tight', 'semester'];

function complete(r: FallbackResponder, req: CompletionRequest): CompletionResponse | undefined {
  if (r.complete === undefined) throw new Error(`${r.id} has no complete()`);
  return r.complete.call(r, req) as CompletionResponse | undefined;
}

const TOOLS = ['remember', 'propose_booking', 'get_roster'].map((name) => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
}));

function req(
  text: string,
  systemPromptId = 'dm_chat_v1',
  system = 'trip: x · tab in EUR',
): CompletionRequest {
  return {
    model: 'main',
    systemPromptId,
    system,
    messages: [{ role: 'user', content: `Henry: ${text}` }],
    tools: TOOLS,
  };
}

function messages(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}

describe('parsePrivateBudgetAsk', () => {
  it("keeps Henry's figure, its bound and its period; never the reason", () => {
    const fact = parsePrivateBudgetAsk(HENRY_DM, EUR);
    expect(fact).toBe('my share: under €80 a day');
    expect(fact).not.toMatch(/tight|semester|money/);
  });

  it.each([
    ['my budget is €60 a day', 'my share: at or under €60 a day'],
    ["my daily budget's 70", 'my share: at or under €70 a day'],
    ['i can only spend 300 euros for the whole trip', 'my share: at or under €300 for the trip'],
    ['i can only spend 40 a night', 'my share: at or under €40 a night'],
    ["don't let my share go over $45 a night", 'my share: under $45 a night'],
    ['keep me at most 50.50 per day pls', 'my share: at or under €50.50 a day'],
    ['cap my spending around 100 daily', 'my share: around €100 a day'],
    ['keep my share under 80', 'my share: under €80'],
    // r1 #3: thousands grouping, both separators.
    ['keep my share under 1,000 for the trip', 'my share: under €1,000 for the trip'],
    ['keep my share under 1.000 for the trip', 'my share: under €1,000 for the trip'],
    ['keep my share under €1,250.50 total', 'my share: under €1,250.50 for the trip'],
    ['keep my share under 1.250,50 total', 'my share: under €1,250.50 for the trip'],
    // r1 #4: the reason after the figure is never part of the fact.
    ['remember keep my share under 80 a day, money has been rough', 'my share: under €80 a day'],
  ])('%s', (text, want) => {
    expect(parsePrivateBudgetAsk(text, EUR)).toBe(want);
  });

  it('with no tab currency known the figure stays bare (no currency assumed)', () => {
    expect(parsePrivateBudgetAsk('keep my share under 80 a day')).toBe('my share: under 80 a day');
  });

  it.each([
    // r1 #2: past, checking questions, non-money units.
    'my share of dinner was 30',
    'my share is 45 right?',
    'can you check if my share is over 100 yet',
    'i can only spend 20 minutes at the museum',
    'i can only do 2 nights',
    'i can only spend 20',
    'keep my share under 3 nights',
    "what's my budget",
    'what if my budget is 80 a day',
    'is my share under 80 a day',
    'how do i keep my share under 80',
    'keep my share small',
    'i paid €84 for dinner, keep my share under 80',
    'i spent 80 a day last trip',
    'keep my share under 0 a day',
    'my flight lands at 9:30',
    'remember i like window seats',
    // r1 #7: "over" is not "under" outside the "don't let … go over" form.
    'my budget is over 200 a day',
  ])('not a budget: %s', (text) => {
    expect(parsePrivateBudgetAsk(text, EUR)).toBeUndefined();
  });

  it('reads the tab currency from the prompt, else the group currency', () => {
    expect(promptCurrency('group: x · currency USD\ntrip: y · tab in EUR')).toBe('EUR');
    expect(promptCurrency('group: x · currency USD')).toBe('USD');
    expect(promptCurrency('nothing here')).toBeUndefined();
  });

  it('parseBudgetFigure / findBudgetFigure', () => {
    expect(parseBudgetFigure('under 2 nights')).toBeUndefined();
    expect(parseBudgetFigure('20 minutes', { requireMoneyMarker: true })).toBeUndefined();
    expect(parseBudgetFigure('£1,000', { requireMoneyMarker: true })).toEqual({
      bound: 'at_most',
      amount: '£1,000',
    });
    expect(findBudgetFigure('henry wants to keep his share under €80 a day')).toEqual({
      bound: 'under',
      amount: '€80',
      period: 'day',
    });
    expect(findBudgetFigure('henry is on a budget')).toBeUndefined();
  });
});

describe('privateBudgetResponder', () => {
  it('in a DM: one remember call, scope me, category budget, the figure only', () => {
    const res = complete(privateBudgetResponder, req(HENRY_DM))!;
    expect(res.text).toBe('');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({
      name: 'remember',
      input: { text: 'my share: under €80 a day', category: 'budget', scope: 'me' },
    });
    expect(JSON.stringify(res.toolCalls)).not.toMatch(/tight|semester/);
  });

  it('runs before the generic remember and the honest "no personal cap" line', () => {
    const chain = travAskResponders().map((r) => r.id);
    const at = chain.indexOf('private_budget_v1');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(chain.indexOf('remember_v1'));
    expect(at).toBeLessThan(chain.indexOf('honest_gaps_v1'));
  });

  it('passes in the group thread (the honest line answers there), without remember, or past round 1', () => {
    expect(complete(privateBudgetResponder, req(HENRY_DM, 'group_chat_v1'))).toBeUndefined();
    expect(complete(honestGapsResponder, req(HENRY_DM, 'group_chat_v1'))?.text).toBe(
      SHARE_CAP_TEXT,
    );
    expect(complete(privateBudgetResponder, { ...req(HENRY_DM), tools: [] })).toBeUndefined();
    const second: CompletionRequest = {
      ...req(HENRY_DM),
      messages: [
        ...req(HENRY_DM).messages,
        { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        { role: 'user', content: 'and again' },
      ],
    };
    expect(complete(privateBudgetResponder, second)).toBeUndefined();
  });
});

describe('money-trouble reasons (isHardship)', () => {
  it.each([
    "henry wants his share under €80 a day, money's tight",
    'under 80 a day, things are pretty tight',
    'tight on cash this semester',
    'money has been tight',
    'money has been kinda tight',
    'money has been a bit tight',
    'money has been rough',
    'funds r tight',
    'short on cash',
    'low on funds',
    'poor this month',
    'overdrawn again',
    'my parents cut me off',
    "i'm on a student budget",
    'rent due friday',
    "henry's broke",
    'i’m broke', // curly apostrophe
    'flat broke',
    'paying off student loans',
    'struggling to pay rent',
    "can't afford much",
  ])('caught: %s', (text) => {
    expect(isHardship(text, 'other')).toBe(true);
  });

  it.each([
    'i broke my phone',
    'dean broke the record at bowling',
    'a loan of his charger',
    'struggling with spanish',
    'the group likes a tight schedule',
    'keep my share under €80 a day',
    'my share: under €80 a day',
  ])('not money trouble: %s', (text) => {
    expect(isHardship(text, 'preference')).toBe(false);
  });

  it('a bare "tight" counts on a budget fact', () => {
    expect(isHardship('budget tight', 'budget')).toBe(true);
    expect(isHardship('tight', 'budget')).toBe(true);
  });
});

describe('the remember tool on budgets and reasons', () => {
  function dmCtx(h: ReturnType<typeof harness>) {
    return {
      groupId: G,
      tripId: BARCELONA.tripId,
      senderMemberId: 'mem_henry',
      senderId: 'h_henry',
      lane: 'dm' as const,
      now: h.clock.now(),
      clock: h.clock,
      ids: h.ids,
      stores: h.runtime.stores,
      messageId: 'msg_dm_budget',
    };
  }

  it('a live-model fact carrying the reason is an error (so it can retry), and nothing is stored', async () => {
    const h = harness();
    await expect(
      h.runtime.tools.run(
        'remember',
        { text: "henry's share under €80 a day, money's tight this semester", category: 'budget' },
        dmCtx(h),
      ),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(h.runtime.memberMemory.recall('mem_henry', G)).toEqual([]);
    // The retry with the figure only lands, private, and says back the parsed figure only.
    const ok = await h.runtime.tools.run(
      'remember',
      { text: 'henry wants to keep his share under 80 a day', category: 'budget' },
      dmCtx(h),
    );
    expect(ok).toMatchObject({ kind: 'remembered', scope: 'me', text: HENRY_REPLY });
    expect(h.runtime.memberMemory.recall('mem_henry', G)).toMatchObject([
      { category: 'budget', sourceLane: 'private' },
    ]);
  });

  it('the private noted line: second person, curly apostrophes folded, third person not echoed', () => {
    expect(privateNotedText("i'm vegetarian", 'dietary')).toBe(
      "noted: you're vegetarian. just between us, the group won't see it",
    );
    expect(privateNotedText('i’m vegetarian', 'dietary')).toBe(
      "noted: you're vegetarian. just between us, the group won't see it",
    );
    expect(privateNotedText('henry is vegetarian', 'dietary', { displayName: 'Henry' })).toBe(
      "noted, just between us. the group won't see it",
    );
    expect(privateNotedText('he hates early flights', 'preference')).toBe(
      "noted, just between us. the group won't see it",
    );
    expect(privateNotedText('my share: under €80 a day', 'budget')).toBe(HENRY_REPLY);
    expect(privateNotedText('wants to save', 'budget')).toBe(
      "noted, just a note, not a hard cap. the group won't see it",
    );
    expect(privateNotedText('my share: under €80 a day', 'budget')).not.toMatch(/planning/);
  });

  // T-134 r2 #1: reasons the rewritten screen dropped, and more; a dropped pattern fails here.
  it.each([
    'henry lost his job so keep it cheap',
    'i got fired, cheap stuff only',
    'just lost my job',
    'out of work right now',
    'furloughed this month',
    "i'm poor",
    'broke student here',
    'strapped',
    'tight budget this trip',
    'on a budget',
    'out of money',
    "don't have the money for that",
    'between paychecks',
    'card got declined',
    'maxed out my card',
    'i owe my sister money',
    'a little short this month',
    'barely getting by',
    "can't swing it",
    'bills are piling up',
    'behind on my car payment',
    'saving for rent',
  ])('"%s" is a money-trouble reason', (text) => {
    expect(isHardship(text, 'other')).toBe(true);
  });

  // T-134 r2 #3-#5: never a guessed figure.
  it.each([
    'keep my share under 1.5k for the trip',
    'keep my share under 80k',
    'keep my share under 80 thousand',
    'keep my share under 80 chf',
    'keep my share under 80 yen',
    'keep my share under 80 a month',
    'keep my share under 80 for the weekend',
    'keep my share under 0.001',
    'keep my share under 1,0000',
    'keep my share under 1.000.50',
  ])('"%s" is not stored', (text) => {
    expect(parsePrivateBudgetAsk(text, EUR)).toBeUndefined();
  });

  it('a symbol after the figure keeps the period; "like" is a filler', () => {
    expect(parsePrivateBudgetAsk('keep my share under 80€ a day', EUR)).toBe(
      'my share: under €80 a day',
    );
    expect(parsePrivateBudgetAsk('my budget is like 60 a day', EUR)).toBe(
      'my share: at or under €60 a day',
    );
  });
});

describe("Henry's budget DM end to end (msg_bcn_d_0002)", () => {
  it("the tools' and prompts' own examples never use a fixture's figure (r1 #1)", () => {
    const h = harness();
    const specs = JSON.stringify([
      ...h.runtime.tools.specs('group'),
      ...h.runtime.tools.specs('dm'),
    ]);
    expect(specs).toContain('£45 a week');
    for (const s of HENRY_PRIVATE) {
      expect(DM_CHAT_PROMPT.persona).not.toContain(s);
      expect(GROUP_CHAT_PROMPT.persona).not.toContain(s);
      expect(specs).not.toContain(s);
    }
  });

  // T-134 r2 #1, #2: no budget sentence or job loss is ever kept in anyone's words.
  it('"remember my budget is like 60 a day, saving for rent" keeps the figure only', async () => {
    const h = harness();
    await h.dm('h_henry', 'remember my budget is like 60 a day, saving for rent');
    const facts = h.runtime.memberMemory.recall('mem_henry', G);
    expect(facts.map((f) => f.text)).toEqual(['my share: at or under €60 a day']);
  });

  it('a budget sentence that is not a readable figure stores nothing; job loss in the group stores nothing', async () => {
    const h = harness();
    const before = h.runtime.groupMemory.recall(G).length;
    await h.dm('h_henry', 'remember my budget is roughly sixty, maybe 70 on a good day');
    expect(h.runtime.memberMemory.recall('mem_henry', G)).toEqual([]);
    await h.say('h_sam', '@trav remember henry lost his job so keep it cheap');
    expect(h.runtime.groupMemory.recall(G)).toHaveLength(before);
  });

  it('stores a private budget fact, replies in his DM only, and never reaches the group', async () => {
    const h = harness();
    const groupMemBefore = h.runtime.groupMemory.recall(G).length;
    const turn = await h.dm('h_henry', HENRY_DM);
    expect(turn.toolCalls).toEqual(['remember']);
    expect(turn.note).toBe('tool:remember:remembered');
    const out = messages(turn);
    expect(out).toHaveLength(1);
    expect(out[0]?.to).toEqual({ kind: 'member', memberId: 'mem_henry' });
    expect(out[0]?.text).toBe(HENRY_REPLY);
    expect(out[0]?.text).not.toMatch(/tight|semester/);

    const facts = h.runtime.memberMemory.recall('mem_henry', G);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      category: 'budget',
      sourceLane: 'private',
      text: 'my share: under €80 a day',
    });
    expect(h.runtime.groupMemory.recall(G)).toHaveLength(groupMemBefore);
    expect(h.runtime.memberMemory.recall('mem_dean', G)).toEqual([]);

    // Later group turns: the figure and the reason are in no group prompt,
    // no group request's tools, and no group message.
    const asked = h.model.completions.length;
    const g1 = await h.say('h_dean', "@trav what's henry's daily budget");
    const g2 = await h.say('h_henry', '@trav where should the 6 of us eat tonight');
    const groupReqs = h.model.completions
      .slice(asked)
      .filter((r) => r.systemPromptId !== 'dm_chat_v1');
    expect(groupReqs.length).toBeGreaterThan(0);
    for (const r of groupReqs) {
      const all =
        `${r.system}\n${JSON.stringify(r.messages)}\n${JSON.stringify(r.tools)}`.toLowerCase();
      for (const s of HENRY_PRIVATE) expect(all).not.toContain(s);
    }
    for (const m of [...messages(g1), ...messages(g2)]) {
      for (const s of HENRY_PRIVATE) expect(m.text.toLowerCase()).not.toContain(s);
    }

    // Henry's own DM prompt does carry it (that's what it's for), never the reason.
    await h.dm('h_henry', 'any food tips');
    const dmReq = h.model.completions.at(-1);
    expect(dmReq?.systemPromptId).toBe('dm_chat_v1');
    expect(dmReq?.system).toContain('my share: under €80 a day');
    expect(dmReq?.system).not.toMatch(/tight|semester/);
  });

  it('"remember keep my share under 80 a day, money has been rough" keeps the figure only (r1 #4)', async () => {
    const h = harness();
    const turn = await h.dm(
      'h_henry',
      'remember keep my share under 80 a day, money has been rough',
    );
    expect(messages(turn)[0]?.text).toBe(HENRY_REPLY);
    const facts = h.runtime.memberMemory.recall('mem_henry', G);
    expect(facts.map((f) => f.text)).toEqual(['my share: under €80 a day']);
  });

  it('a money-trouble "remember" is never stored, in the group or a DM, and says so', async () => {
    const h = harness();
    const g = await h.say('h_sam', '@trav remember jordan is broke');
    expect(messages(g)[0]?.text).toBe(MONEY_MEMORY_TEXT);
    const d = await h.dm('h_sam', 'remember money has been kinda tight');
    expect(messages(d)[0]?.text).toBe(MONEY_MEMORY_TEXT);
    expect(h.runtime.groupMemory.recall(G).some((f) => /broke/.test(f.text))).toBe(false);
    expect(h.runtime.memberMemory.recall('mem_sam', G)).toEqual([]);
  });

  it('a non-money "broke" is remembered as usual, not answered with the money line (r1 #5)', async () => {
    const h = harness();
    const g = await h.say('h_sam', '@trav remember dean broke the record at bowling');
    expect(messages(g)[0]?.text).not.toBe(MONEY_MEMORY_TEXT);
    expect(h.runtime.groupMemory.recall(G).map((f) => f.text)).toContain(
      'dean broke the record at bowling',
    );
  });

  it('a minor gets no private budget note', async () => {
    const h = harness();
    const sam = h.runtime.stores.group.members.get('mem_sam')!;
    h.runtime.stores.group.members.upsert({ ...sam, birthDate: '2012-02-01', ageBand: 'under18' });
    const turn = await h.dm('h_sam', 'keep my share under 40 a day');
    expect(messages(turn)[0]?.text).toBe("i don't keep private notes for anyone under 18");
    expect(h.runtime.memberMemory.recall('mem_sam', G)).toEqual([]);
  });
});

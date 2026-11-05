/**
 * T-134: a personal budget told in a DM ("can you keep my share under 80 a
 * day? money's tight this semester", msg_bcn_d_0002) is kept as a private
 * member-memory fact (scope me, category budget, sourceLane private): the
 * figure the member stated, never the reason, and never in a group message
 * or a group-lane prompt.
 */
import { describe, expect, it } from 'vitest';
import type { CurrencyCode, OutboundMessage } from '@trav/core';
import { isReaction } from '@trav/core';
import type { CompletionRequest, CompletionResponse, FallbackResponder } from '../client.js';
import {
  SHARE_CAP_TEXT,
  honestGapsResponder,
  parsePrivateBudgetAsk,
  privateBudgetResponder,
  promptCurrency,
  travAskResponders,
} from './asks.js';
import { isHardship, privateNotedText } from '../../tools/memoryTools.js';
import { BARCELONA } from '../../compose.js';
import { harness } from '../../runtime.testkit.js';
import type { TurnResult } from '../../loop.js';

const G = BARCELONA.groupId;
const EUR = 'EUR' as CurrencyCode;
const HENRY_DM = "can you keep my share under 80 a day? money's tight this semester";

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
  it('keeps the figure, its bound and its period; never the reason', () => {
    const fact = parsePrivateBudgetAsk(HENRY_DM, EUR);
    expect(fact).toBe('keep my share under €80 a day');
    expect(fact).not.toMatch(/tight|semester|money/);
  });

  it.each([
    ['my budget is €60 a day', 'keep my share to €60 a day'],
    [
      'i can only spend 300 euros for the whole trip, rent is due',
      'keep my share to €300 for the trip',
    ],
    ["don't let my share go over $45 a night", 'keep my share under $45 a night'],
    ['keep me at most 50.50 per day pls', 'keep my share at most €50.50 a day'],
    ['cap my spending around 100 daily, im broke', 'keep my share around €100 a day'],
    ['keep my share under 80', 'keep my share under €80'],
  ])('%s', (text, want) => {
    expect(parsePrivateBudgetAsk(text, EUR)).toBe(want);
  });

  it('with no tab currency known the figure stays bare (no currency assumed)', () => {
    expect(parsePrivateBudgetAsk('keep my share under 80 a day')).toBe(
      'keep my share under 80 a day',
    );
  });

  it.each([
    "what's my budget",
    'what is my share so far',
    'keep my share small',
    'i paid €84 for dinner, keep my share under 80',
    'keep my share under 0 a day',
    'my flight lands at 9:30',
    'remember i like window seats',
  ])('not a budget: %s', (text) => {
    expect(parsePrivateBudgetAsk(text, EUR)).toBeUndefined();
  });

  it('reads the tab currency from the prompt, else the group currency', () => {
    expect(promptCurrency('group: x · currency USD\ntrip: y · tab in EUR')).toBe('EUR');
    expect(promptCurrency('group: x · currency USD')).toBe('USD');
    expect(promptCurrency('nothing here')).toBeUndefined();
  });
});

describe('privateBudgetResponder', () => {
  it('in a DM: one remember call, scope me, category budget, the figure only', () => {
    const res = complete(privateBudgetResponder, req(HENRY_DM))!;
    expect(res.text).toBe('');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({
      name: 'remember',
      input: { text: 'keep my share under €80 a day', category: 'budget', scope: 'me' },
    });
    expect(JSON.stringify(res.toolCalls)).not.toMatch(/tight|semester/);
  });

  it('runs before the honest "no personal cap" line in the chain', () => {
    const chain = travAskResponders().map((r) => r.id);
    expect(chain.indexOf('private_budget_v1')).toBeGreaterThanOrEqual(0);
    expect(chain.indexOf('private_budget_v1')).toBeLessThan(chain.indexOf('honest_gaps_v1'));
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

describe('remember tool: budgets and reasons', () => {
  it('a money-trouble reason is never stored, in either scope', () => {
    expect(isHardship("henry wants his share under €80 a day, money's tight", 'budget')).toBe(true);
    expect(isHardship('under 80 a day, things are pretty tight', 'other')).toBe(true);
    expect(isHardship('tight on cash this semester', 'other')).toBe(true);
    expect(isHardship('henry is broke', 'other')).toBe(true);
    expect(isHardship('budget tight', 'budget')).toBe(true);
    expect(isHardship('keep my share under €80 a day', 'budget')).toBe(false);
    expect(isHardship('the group likes a tight schedule', 'preference')).toBe(false);
  });

  it('a live-model fact carrying the reason is an error (so it can retry), and nothing is stored', async () => {
    const h = harness();
    const ctx = {
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
    await expect(
      h.runtime.tools.run(
        'remember',
        { text: "henry's share under €80 a day, money's tight this semester", category: 'budget' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(h.runtime.memberMemory.recall('mem_henry', G)).toEqual([]);
    // The retry with the figure only lands, private, and says what it kept.
    const ok = await h.runtime.tools.run(
      'remember',
      { text: 'henry wants to keep his share under €80 a day', category: 'budget' },
      ctx,
    );
    expect(ok).toMatchObject({
      kind: 'remembered',
      scope: 'me',
      text: "noted: henry wants to keep his share under €80 a day. it's a note for planning, not a hard cap, and the group won't see it",
    });
    expect(h.runtime.memberMemory.recall('mem_henry', G)).toMatchObject([
      { category: 'budget', sourceLane: 'private' },
    ]);
  });

  it('the private noted line says the fact back to its owner', () => {
    expect(privateNotedText("i'm vegetarian", 'dietary')).toBe(
      "noted: you're vegetarian. just between us, the group won't see it",
    );
    expect(privateNotedText('keep my share under €80 a day.', 'budget')).toBe(
      "noted: keep your share under €80 a day. it's a note for planning, not a hard cap, and the group won't see it",
    );
  });
});

describe("Henry's budget DM end to end (msg_bcn_d_0002)", () => {
  it('stores a private budget fact, replies in his DM only, and never reaches the group', async () => {
    const h = harness();
    const groupMemBefore = h.runtime.groupMemory.recall(G).length;
    const turn = await h.dm('h_henry', HENRY_DM);
    expect(turn.toolCalls).toEqual(['remember']);
    expect(turn.note).toBe('tool:remember:remembered');
    const out = messages(turn);
    expect(out).toHaveLength(1);
    expect(out[0]?.to).toEqual({ kind: 'member', memberId: 'mem_henry' });
    expect(out[0]?.text).toBe(
      "noted: keep your share under €80 a day. it's a note for planning, not a hard cap, and the group won't see it",
    );
    expect(out[0]?.text).not.toMatch(/tight|semester/);

    const facts = h.runtime.memberMemory.recall('mem_henry', G);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      category: 'budget',
      sourceLane: 'private',
      text: 'keep my share under €80 a day',
    });
    expect(facts[0]?.text).not.toMatch(/tight|semester/);
    expect(h.runtime.groupMemory.recall(G)).toHaveLength(groupMemBefore);
    expect(h.runtime.memberMemory.recall('mem_dean', G)).toEqual([]);

    // Later group turns: the figure and the reason are in no group prompt or group message.
    const asked = h.model.completions.length;
    const g1 = await h.say('h_dean', "@trav what's henry's daily budget");
    const g2 = await h.say('h_henry', '@trav where should the 6 of us eat tonight');
    for (const req of h.model.completions.slice(asked)) {
      if (req.systemPromptId === 'dm_chat_v1') continue;
      const all = `${req.system}\n${JSON.stringify(req.messages)}`.toLowerCase();
      for (const s of ['80 a day', 'tight', '€80']) expect(all).not.toContain(s);
    }
    for (const m of [...messages(g1), ...messages(g2)]) {
      expect(m.text.toLowerCase()).not.toContain('80 a day');
      expect(m.text.toLowerCase()).not.toContain('tight');
    }

    // Henry's own DM prompt does carry it (that's what it's for).
    await h.dm('h_henry', 'any food tips');
    const dmReq = h.model.completions.at(-1);
    expect(dmReq?.systemPromptId).toBe('dm_chat_v1');
    expect(dmReq?.system).toContain('keep my share under €80 a day');
    expect(dmReq?.system).not.toMatch(/tight|semester/);
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

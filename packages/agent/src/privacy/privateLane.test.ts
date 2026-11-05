/**
 * T-213: a member's DM wording never reaches the group lane (SAFETY §2.3,
 * C2/C7). The model is a live stand-in (it does what the T-184 live run did,
 * on purpose): in a DM it writes the member's words into group tools; in the
 * group it echoes its whole context back, or says the DM outright. Code, not
 * the prompt, has to stop each one. Every test here fails on the pre-T-213
 * loop (see tasks/done/T-213.md for the run).
 */
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@trav/core';
import { BARCELONA, BARCELONA_NOW } from '../compose.js';
import { createSimulatedClock } from '@trav/core';
import type {
  CompletionRequest,
  CompletionResponse,
  ModelClient,
  ToolCall,
} from '../model/client.js';
import { INTERPRET_PROMPT_ID } from '../interpret/schemas.js';
import { harness, offlineModel, type Harness } from '../runtime.testkit.js';
import type { TurnToolContext } from '../tools/index.js';
import { PRIVATE_REPLY_FALLBACK } from './guardSend.js';

const HENRY_DM = "can you keep my share under 80 a day? money's tight this semester";
/** Phrases of Henry's DM that must never show in the group lane (the fixture's mustNotAppearInGroup, plus more). */
const DM_PHRASES = ['80 a day', "money's tight", 'moneys tight', 'this semester', 'keep my share'];

type Turn = (req: CompletionRequest, round: number) => CompletionResponse;

function reply(text: string, calls: readonly Omit<ToolCall, 'id'>[] = []): CompletionResponse {
  return {
    text,
    toolCalls: calls.map((c, i) => ({ id: `toolu_${String(i)}`, ...c })),
    usage: { inputTokens: 0, outputTokens: 0 },
    source: 'script',
    scriptKey: 'test',
  };
}

function said(req: CompletionRequest): string {
  const first = req.messages[0]?.content;
  return typeof first === 'string' ? first.replace(/^[^:]*:\s*/u, '') : '';
}

/** Echo of everything the model was shown: if it holds DM text, so does the reply. */
function echo(req: CompletionRequest): string {
  return `${req.system}\n${JSON.stringify(req.messages)}`;
}

/**
 * A `mode: 'live'` stand-in. Interpretation hands every message to the chat
 * loop; `group` / `dm` answer the chat loop's rounds; anything else goes to
 * the offline client.
 */
function standIn(lanes: { group?: Turn; dm?: Turn }): {
  model: ModelClient;
  prompts: CompletionRequest[];
} {
  const inner = offlineModel(createSimulatedClock(BARCELONA_NOW));
  const prompts: CompletionRequest[] = [];
  const model: ModelClient = {
    mode: 'live',
    async complete(req) {
      prompts.push(structuredClone(req));
      if (req.systemPromptId === INTERPRET_PROMPT_ID) {
        return reply('', [{ name: 'pass_to_chat', input: { about: 'other' } }]);
      }
      const round = req.messages.filter((m) => m.role === 'assistant').length;
      if (req.systemPromptId.startsWith('group_chat') && lanes.group !== undefined)
        return lanes.group(req, round);
      if (req.systemPromptId.startsWith('dm_chat') && lanes.dm !== undefined)
        return lanes.dm(req, round);
      return inner.complete(req);
    },
    classify: (req) => inner.classify(req),
  };
  return { model, prompts };
}

/** What the T-184 live model did with Henry's DM: his own words into every group-visible tool. */
const leakyDm: Turn = (req, round) => {
  if (round > 0) return reply('ok, noted');
  const text = said(req);
  return reply('', [
    {
      name: 'log_expense',
      input: {
        description: text.slice(0, 80),
        amountMinor: 100,
        currency: 'EUR',
        split: { method: 'exclude', excluded: [] },
      },
    },
    { name: 'propose_booking', input: { query: text.slice(0, 80), requestText: text } },
    { name: 'set_attendance', input: { member: text.slice(0, 40), status: 'out' } },
  ]);
};

/** Reads every group tool, then says back all it saw. */
const echoGroup: Turn = (req, round) =>
  round === 0
    ? reply('', [
        { name: 'get_group_memory', input: {} },
        { name: 'get_balances', input: {} },
        { name: 'get_pending_proposals', input: {} },
        { name: 'get_roster', input: {} },
      ])
    : reply(echo(req));

function groupPrompts(prompts: readonly CompletionRequest[]): CompletionRequest[] {
  return prompts.filter((p) => p.systemPromptId.startsWith('group_chat'));
}

function lower(x: unknown): string {
  return JSON.stringify(x)
    .toLowerCase()
    .replace(/\\u2019/gu, "'");
}

function expectNoDmText(where: string, haystack: string): void {
  for (const p of DM_PHRASES) expect(haystack, `${where} carries "${p}"`).not.toContain(p);
}

function privateTextSuppressions(h: Harness): AuditEvent[] {
  return h
    .audit()
    .filter(
      (e) => e.type === 'content.suppressed' && e.payload['cause'] === 'private_text_in_group',
    );
}

function setup(lanes: { group?: Turn; dm?: Turn }) {
  const { model, prompts } = standIn(lanes);
  // `log` voice: the echo is deliberately not Trav's voice; what matters is where it goes.
  const h = harness({ model, runtime: { voice: 'log' } });
  return { h, prompts };
}

describe('T-213: DM text stays out of the group lane', () => {
  it('a DM-lane tool call carrying the DM wording is refused, so nothing of it reaches the GroupStore or the group', async () => {
    const { h } = setup({ dm: leakyDm, group: echoGroup });
    const before = h.runtime.stores.group.expenses.listByTrip(BARCELONA.tripId).length;
    await h.dm('h_henry', HENRY_DM);

    const expenses = h.runtime.stores.group.expenses.listByTrip(BARCELONA.tripId);
    expect(expenses).toHaveLength(before);
    // r2: propose_booking is not refused (its query resolves against
    // inventory and is never stored); whatever it set up carries no DM words.
    expectNoDmText('pending proposals', lower(h.pending()));
    expectNoDmText('the ledger', lower(expenses));
    expectNoDmText('the group transcript', lower(h.channel.groupTranscript()));
    // The DM itself still answers Henry, privately.
    const dmOut = h.channel.dmTranscript('h_henry').filter((e) => e.direction === 'outbound');
    expect(dmOut.length).toBeGreaterThan(0);
  });

  it('group-lane prompts never carry the DM wording, even with every group tool read and echoed', async () => {
    const { h, prompts } = setup({ dm: leakyDm, group: echoGroup });
    await h.dm('h_henry', HENRY_DM);
    await h.say('h_dean', '@trav quick one before tonight, anything i should know');
    await h.say('h_henry', '@trav i got everyone coffee, 13.20');

    const group = groupPrompts(prompts);
    expect(group.length).toBeGreaterThanOrEqual(4);
    for (const p of group) expectNoDmText(`group prompt ${p.systemPromptId}`, lower(p));
    expectNoDmText('the group transcript', lower(h.channel.groupTranscript()));
  });

  it('DM wording already in the GroupStore (an older write) is redacted from group prompts and tool results', async () => {
    const { h, prompts } = setup({ group: echoGroup });
    await h.dm('h_henry', HENRY_DM);
    // A row written past the DM-lane check (an older write, a future path):
    // the tool run directly, as if from the group lane.
    await h.runtime.tools.run(
      'log_expense',
      {
        description: HENRY_DM.slice(0, 80),
        amountMinor: 500,
        currency: 'EUR',
        split: { method: 'exclude', excluded: [] },
      },
      {
        groupId: BARCELONA.groupId,
        tripId: BARCELONA.tripId,
        senderMemberId: 'mem_henry',
        senderId: 'h_henry',
        lane: 'group',
        now: h.clock.now(),
        clock: h.clock,
        ids: h.ids,
        stores: h.runtime.stores,
        messageId: 'msg_legacy_1',
      } as TurnToolContext,
    );
    expect(lower(h.runtime.stores.group.expenses.listByTrip(BARCELONA.tripId))).toContain(
      '80 a day',
    );
    // And a group-memory row the same way (what get_group_memory returns).
    h.runtime.groupMemory.remember(BARCELONA.groupId, {
      category: 'other',
      text: HENRY_DM,
      aboutMemberIds: [],
      sourceMessageId: 'msg_legacy_2',
      sourceTripId: BARCELONA.tripId,
      now: h.clock.now(),
    });
    await h.say('h_dean', '@trav quick one before tonight, anything i should know');

    const group = groupPrompts(prompts);
    expect(group.length).toBeGreaterThanOrEqual(2);
    const toolResults = group.flatMap((p) =>
      p.messages.flatMap((m) =>
        typeof m.content === 'string'
          ? []
          : m.content.filter((b) => b.type === 'tool_result').map((b) => JSON.stringify(b)),
      ),
    );
    // The rows are still there, in the context and in get_group_memory's
    // result, with their DM wording redacted.
    expect(group.map((p) => p.system).join('\n')).toContain('[private]');
    expect(toolResults.join('\n')).toContain('[private]');
    for (const p of group) expectNoDmText(`group prompt ${p.systemPromptId}`, lower(p));
  });

  it("a group reply that says a member's DM is blocked by code and audited with ids only, owner-visible", async () => {
    const leak = `henry said ${HENRY_DM}`;
    const { h } = setup({ group: () => reply(leak) });
    await h.dm('h_henry', HENRY_DM);
    const turn = await h.say('h_chase', '@trav anything i should know about henry for tonight');

    expect(turn.outbound.map((o) => ('text' in o ? o.text : null))).toEqual([
      PRIVATE_REPLY_FALLBACK,
    ]);
    expectNoDmText('the group transcript', lower(h.channel.groupTranscript()));
    const sup = privateTextSuppressions(h);
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ visibility: 'owner', ownerId: 'mem_henry' });
    expect(Object.keys(sup[0]!.payload).sort()).toEqual([
      'cause',
      'detail',
      'lane',
      'messageDraftId',
    ]);
    expectNoDmText('the audit log', lower(h.audit()));
  });

  it("a member's private note is DM-only too: a group reply quoting it is blocked", async () => {
    const { h } = setup({ group: () => reply("noted, we'll keep henry's share under €80 a day") });
    h.runtime.memberMemory.remember('mem_henry', BARCELONA.groupId, {
      category: 'budget',
      text: "henry's share: under €80 a day",
      aboutMemberIds: ['mem_henry'],
      sourceMessageId: 'msg_private_note',
      sourceTripId: BARCELONA.tripId,
      now: h.clock.now(),
      sourceLane: 'private',
    });
    const turn = await h.say('h_chase', '@trav anything i should know for tonight');
    expect(turn.outbound.map((o) => ('text' in o ? o.text : null))).toEqual([
      PRIVATE_REPLY_FALLBACK,
    ]);
    expect(privateTextSuppressions(h)).toHaveLength(1);
  });

  it('wording said in the group thread is public: the same reply goes out once Henry says it there', async () => {
    const { h } = setup({
      group: () => reply("money's tight this semester, got it. i'll keep it cheap"),
    });
    await h.dm('h_henry', HENRY_DM);
    await h.say('h_henry', "honestly money's tight this semester lol");
    const turn = await h.say('h_henry', '@trav can we do something cheap tonight');
    expect(turn.outbound).toHaveLength(1);
    expect(privateTextSuppressions(h)).toEqual([]);
  });

  it('what Trav already said in the group is public: a DM repeating it does not hold back the next group reply', async () => {
    const line = 'razzmatazz tickets are still on sale for tonight';
    const { h } = setup({ group: () => reply(line) });
    const first = await h.say('h_dean', '@trav anything on tonight');
    expect(first.outbound).toHaveLength(1);
    await h.dm('h_henry', 'are razzmatazz tickets still on sale? my budget is tight');
    const again = await h.say('h_chase', '@trav remind me what is on tonight');
    expect(again.outbound).toHaveLength(1);
    expect(privateTextSuppressions(h)).toEqual([]);
    // The DM's own new wording is still DM-only.
    const leak = setup({ group: () => reply('henry says money is super tight this month') });
    await leak.h.dm(
      'h_henry',
      'are razzmatazz tickets still on sale? money is super tight this month',
    );
    const blocked = await leak.h.say('h_chase', '@trav anything about henry');
    expect(blocked.outbound.map((o) => ('text' in o ? o.text : null))).toEqual([
      PRIVATE_REPLY_FALLBACK,
    ]);
    expect(privateTextSuppressions(leak.h)).toHaveLength(1);
  });

  it('an ordinary group reply after a DM still goes out (no false positive on common words)', async () => {
    const { h } = setup({ group: () => reply('dinner at 9 works, i can keep a table for 6') });
    await h.dm('h_henry', HENRY_DM);
    await h.dm('h_arjun', "fyi i'm vegetarian, keep that in mind for dinners");
    const turn = await h.say('h_dean', '@trav what time is dinner tonight');
    expect(turn.outbound).toHaveLength(1);
    expect(privateTextSuppressions(h)).toEqual([]);
  });
});

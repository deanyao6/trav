/**
 * T-213 r2: the DM-text guard never costs the group a real message. Each test
 * here failed on the r1 code (reviewer flaws 1-4): a DM that shares an
 * everyday pair ("qr codes", "club tickets") with Trav's receipt dropped the
 * flagship's receipt; a guard-held proposal said "not all-ages"; a DM booking
 * of a named venue was refused; the family notice skipped the wrapped sender.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent, Outbound } from '@trav/core';
import { DEFAULT_AUTO_BUY_CAP_MINOR, createSimulatedClock, isReaction } from '@trav/core';
import { BARCELONA, BARCELONA_NOW, createSendPathSender } from '../compose.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ModelClient,
  ToolCall,
} from '../model/client.js';
import { INTERPRET_PROMPT_ID } from '../interpret/schemas.js';
import type { TurnSender } from '../loop.js';
import { UNDELIVERED_PROPOSAL_TEXT, UNSENT_PROPOSAL_TEXT } from '../loop.js';
import type { SendOutcome } from '../outbound/send.js';
import { RAZZMATAZZ_ASK, harness, offlineModel, type Harness } from '../runtime.testkit.js';
import { PRIVATE_REPLY_FALLBACK, PRIVATE_TEXT_CAUSE, guardGroupText } from './guardSend.js';
import { createLaneTextGuard } from './laneText.js';

const QR_DM = 'if we get tickets do the qr codes come to my phone?';
const CLUB_DM = 'are club tickets refundable until 10pm usually?';

function groupOut(h: Harness): { text: string; card?: string }[] {
  return h.channel
    .groupTranscript()
    .map((e) => e as { direction?: string; text?: string; card?: { type: string } })
    .filter((e) => e.direction === 'outbound')
    .map((e) => ({
      text: e.text ?? '',
      ...(e.card !== undefined ? { card: e.card.type } : {}),
    }));
}

function privateTextEvents(h: Harness): AuditEvent[] {
  return h
    .audit()
    .filter((e) => e.type === 'content.suppressed' && e.payload['cause'] === PRIVATE_TEXT_CAUSE);
}

function reply(text: string, calls: readonly Omit<ToolCall, 'id'>[] = []): CompletionResponse {
  return {
    text,
    toolCalls: calls.map((c, i) => ({ id: `toolu_${String(i)}`, ...c })),
    usage: { inputTokens: 0, outputTokens: 0 },
    source: 'script',
    scriptKey: 'test',
  };
}

type Turn = (req: CompletionRequest, round: number) => CompletionResponse;

/** A `mode: 'live'` stand-in for the chat loop; everything else is the offline client. */
function standIn(lanes: { group?: Turn; dm?: Turn }): ModelClient {
  const inner = offlineModel(createSimulatedClock(BARCELONA_NOW));
  return {
    mode: 'live',
    async complete(req) {
      if (req.systemPromptId === INTERPRET_PROMPT_ID)
        return reply('', [{ name: 'pass_to_chat', input: { about: 'other' } }]);
      const round = req.messages.filter((m) => m.role === 'assistant').length;
      if (req.systemPromptId.startsWith('group_chat') && lanes.group !== undefined)
        return lanes.group(req, round);
      if (req.systemPromptId.startsWith('dm_chat') && lanes.dm !== undefined)
        return lanes.dm(req, round);
      return inner.complete(req);
    },
    classify: (req) => inner.classify(req),
  };
}

describe('T-213 r2 #1: a DM never takes a code-rendered group message down', () => {
  async function flagship(dm?: { from: string; text: string }) {
    const h = harness({ autoBuyCapMinor: DEFAULT_AUTO_BUY_CAP_MINOR });
    if (dm !== undefined) await h.dm(dm.from, dm.text);
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    return { h, turn };
  }

  const baseline = async () => groupOut((await flagship()).h);

  for (const dm of [
    { from: 'h_chase', text: QR_DM },
    { from: 'h_piotr', text: CLUB_DM },
  ]) {
    it(`a DM ("${dm.text}") before the flagship: receipt and tab line still post, unchanged`, async () => {
      const without = await baseline();
      const { h, turn } = await flagship(dm);
      expect(
        turn.auditEventIds.some(
          (id) => h.audit().find((e) => e.id === id)?.type === 'booking.completed',
        ),
      ).toBe(true);
      const posted = groupOut(h);
      expect(posted.some((m) => m.card === 'receipt')).toBe(true);
      expect(posted).toEqual(without);
      expect(privateTextEvents(h)).toEqual([]);
    });
  }

  it('a model reply that shares an everyday pair with a DM still goes out', async () => {
    const h = harness({
      model: standIn({ group: () => reply("qr codes go to each person's own DMs, nobody else's") }),
    });
    await h.dm('h_chase', QR_DM);
    const turn = await h.say('h_dean', '@trav how do the tickets work');
    expect(turn.outbound).toHaveLength(1);
    expect(privateTextEvents(h)).toEqual([]);
  });

  it("a chat-logged expense whose description is a member's DM wording is redacted in its notice, never dropped", async () => {
    const h = harness();
    await h.dm('h_henry', "can you keep my share under 80 a day? money's tight this semester");
    // A row past the DM-lane check (an older write): logged from the group lane.
    await h.runtime.tools.run(
      'log_expense',
      {
        description: "money's tight dinner",
        amountMinor: 4000,
        currency: 'EUR',
        split: { method: 'exclude', excluded: [] },
      },
      {
        groupId: BARCELONA.groupId,
        tripId: BARCELONA.tripId,
        senderMemberId: 'mem_dean',
        senderId: 'h_dean',
        lane: 'group',
        now: h.clock.now(),
        clock: h.clock,
        ids: h.ids,
        stores: h.runtime.stores,
        messageId: 'msg_legacy_r2',
      } as never,
    );
    await h.say('h_dean', '@trav settle now');
    const all = JSON.stringify(groupOut(h)).toLowerCase();
    expect(all).not.toContain("money's tight");
    expect(all).not.toContain('moneys tight');
    const ev = privateTextEvents(h);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.payload['detail'] === 'redacted')).toBe(true);
    expect(ev[0]).toMatchObject({ visibility: 'owner', ownerId: 'mem_henry' });
  });
});

describe('T-213 r2 #2: a proposal held back for DM wording never says "not all-ages"', () => {
  it('gets the neutral "didn\'t go through" line, and the proposal is withdrawn', async () => {
    const via: { real?: TurnSender } = {};
    const holdProposals: TurnSender = async (outs, ctx) => {
      const held: SendOutcome[] = [];
      const rest: Outbound[] = [];
      for (const o of outs) {
        if (!isReaction(o) && o.card?.type === 'booking_proposal') {
          const payload = { cause: PRIVATE_TEXT_CAUSE, messageDraftId: o.id };
          held.push({
            outbound: o,
            sent: null,
            suppressed: true,
            degraded: false,
            suppressions: [{ cause: PRIVATE_TEXT_CAUSE, event: 'content.suppressed', payload }],
            violations: [],
          });
        } else rest.push(o);
      }
      return [...held, ...(rest.length > 0 ? await via.real!(rest, ctx) : [])];
    };
    const h = harness({ runtime: { sendTurn: holdProposals } });
    via.real = createSendPathSender(h.channel, h.runtime.stores, h.clock, { ids: h.ids });
    await h.say('h_dean', RAZZMATAZZ_ASK);
    const texts = groupOut(h).map((m) => m.text);
    expect(texts).toContain(UNSENT_PROPOSAL_TEXT);
    expect(texts).not.toContain(UNDELIVERED_PROPOSAL_TEXT);
    expect(h.pending()).toEqual([]);
  });
});

describe('T-213 r2 #3: a DM booking of a named venue still books', () => {
  it('"get me razzmatazz tickets for tonight" from a DM sets up the proposal', async () => {
    const ask = 'get me razzmatazz tickets for tonight';
    const h = harness({
      model: standIn({
        dm: (_req, round) =>
          round === 0
            ? reply('', [
                {
                  name: 'propose_booking',
                  input: { query: 'razzmatazz tickets', requestText: ask },
                },
              ])
            : reply(''),
      }),
    });
    await h.dm('h_chase', ask);
    expect(h.pending()).toHaveLength(1);
    expect(h.pending()[0]!.status).toBe('pending');
  });

  it('an expense description that repeats the DM is still refused', async () => {
    const dm = "log 40 for henry's secret birthday cake, don't tell him";
    const h = harness({
      model: standIn({
        dm: (_req, round) =>
          round === 0
            ? reply('', [
                {
                  name: 'log_expense',
                  input: {
                    description: "henry's secret birthday cake",
                    amountMinor: 4000,
                    currency: 'EUR',
                    split: { method: 'exclude', excluded: [] },
                  },
                },
              ])
            : reply(''),
      }),
    });
    const before = h.runtime.stores.group.expenses.listByTrip(BARCELONA.tripId).length;
    await h.dm('h_chase', dm);
    expect(h.runtime.stores.group.expenses.listByTrip(BARCELONA.tripId)).toHaveLength(before);
  });
});

describe('T-213 r2 review (Orchestrator): model replies are never silenced by everyday overlap', () => {
  for (const c of [
    {
      from: 'h_chase',
      dm: QR_DM,
      ask: '@trav how do the tickets work',
      out: "the qr codes go to each person's DMs, one each",
    },
    {
      from: 'h_piotr',
      dm: CLUB_DM,
      ask: '@trav are razzmatazz tickets refundable?',
      out: 'yep, refundable until 10pm tonight',
    },
  ]) {
    it(`"${c.out}" after the DM "${c.dm}" posts unchanged`, async () => {
      const h = harness({ model: standIn({ group: () => reply(c.out) }) });
      await h.dm(c.from, c.dm);
      await h.say('h_dean', c.ask);
      expect(groupOut(h).map((m) => m.text)).toContain(c.out);
      expect(privateTextEvents(h)).toEqual([]);
    });
  }

  it('a real leak in a model reply is replaced by the fallback, so the @trav still gets an answer', async () => {
    const h = harness({
      model: standIn({
        group: () => reply("sure. heads up, henry said money's tight this semester"),
      }),
    });
    await h.dm('h_henry', "can you keep my share under 80 a day? money's tight this semester");
    await h.say('h_dean', '@trav can we do a fancy dinner');
    const texts = groupOut(h).map((m) => m.text);
    expect(texts).toContain(PRIVATE_REPLY_FALLBACK);
    expect(JSON.stringify(texts)).not.toContain('tight this semester');
    const ev = privateTextEvents(h);
    expect(ev[0]).toMatchObject({ visibility: 'owner', ownerId: 'mem_henry' });
    expect(ev[0]!.payload['detail']).toBe('replaced');
  });

  it('a model reply never makes a DM phrase public; a code-rendered message does', async () => {
    const h = harness();
    const guard = createLaneTextGuard();
    guard.notePrivate(BARCELONA.groupId, 'mem_henry' as never, "money's tight this semester");
    const inner: TurnSender = async (outs) =>
      outs.map((o) => ({
        outbound: o,
        sent: { messageId: `sent_${o.id}` } as never,
        suppressed: false,
        degraded: false,
        suppressions: [],
        violations: [],
      }));
    const model = new Set(['d_model']);
    const send = guardGroupText(inner, guard, h.runtime.stores, {
      isModelText: (o) => model.has(o.id),
    });
    const ctx = { group: { groupId: BARCELONA.groupId }, trip: null } as never;
    const draft = (id: string): Outbound =>
      ({ id, to: { kind: 'group' }, text: "heads up, money's tight for some" }) as never;
    // Only a 2-word DM phrase: past `strict`, sent, but still private afterwards.
    await send([draft('d_model')], ctx);
    expect(guard.leaks(BARCELONA.groupId, "money's tight")).not.toEqual([]);
    await send([draft('d_code')], ctx);
    expect(guard.leaks(BARCELONA.groupId, "money's tight")).toEqual([]);
  });
});

describe('T-213 r2 #4: the family notice goes through the agent send path', () => {
  it('the runtime delegates to the agent (wrapped sender), not the bare one', async () => {
    const h = harness();
    const spy = vi.spyOn(h.runtime.agent, 'announceFamilyMode');
    await h.runtime.announceFamilyMode(BARCELONA.groupId);
    expect(spy).toHaveBeenCalledWith(BARCELONA.groupId);
  });
});

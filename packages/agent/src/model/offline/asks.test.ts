/**
 * T-081 / T-092: the offline ask responders. The booking responder only ever
 * emits `propose_booking` (never a purchase tool), only on a fresh chat turn
 * that offered it, and never carries the reason someone is out. The
 * multi-round flows answer only their own tool rounds.
 */
import { describe, expect, it } from 'vitest';
import type {
  CompletionRequest,
  CompletionResponse,
  FallbackResponder,
  ModelMessage,
} from '../client.js';
import {
  CANCEL_NOT_ALLOWED_TEXT,
  HEALTH_MEMORY_TEXT,
  NOTHING_PENDING_TEXT,
  OPTION_NUMBER_TEXT,
  RESTAURANT_TEXT,
  cancelResponder as rawCancel,
  cheaperResponder as rawCheaper,
  createBookingRequestResponder,
  honestGapsResponder as rawGaps,
  lodgingResponder as rawLodging,
  parseRememberAsk,
  parseStayAsk,
  rememberResponder as rawRemember,
} from './asks.js';
import { FIVE, RAZZMATAZZ_ASK, harness } from '../../runtime.testkit.js';
import { BARCELONA } from '../../compose.js';

/** Every responder here implements `complete`; this keeps the calls typed. */
function chat(r: FallbackResponder): {
  complete(req: CompletionRequest): CompletionResponse | undefined;
} {
  const complete = r.complete;
  if (complete === undefined) throw new Error(`${r.id} has no complete()`);
  return { complete: (req) => complete.call(r, req) };
}
const cancelResponder = chat(rawCancel);
const cheaperResponder = chat(rawCheaper);
const honestGapsResponder = chat(rawGaps);
const lodgingResponder = chat(rawLodging);
const rememberResponder = chat(rawRemember);

const CHAT_TOOLS = [
  'propose_booking',
  'get_pending_proposals',
  'cancel_proposal',
  'search_events',
  'search_lodging',
  'remember',
  'get_roster',
];
const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } });

function req(messages: readonly ModelMessage[], tools = CHAT_TOOLS): CompletionRequest {
  return {
    model: 'main',
    systemPromptId: 'group_chat_v1',
    system: 's',
    messages,
    tools: tools.map(tool),
  };
}
const ask = (text: string, tools?: string[]) => req([{ role: 'user', content: text }], tools);

/** The request after the responder's call came back with `result`. */
function after(
  first: CompletionRequest,
  call: { id: string; name: string; input: unknown },
  result: unknown,
): CompletionRequest {
  return req([
    ...first.messages,
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: call.id, content: JSON.stringify(result) }],
    },
  ]);
}

const book = chat(createBookingRequestResponder());

describe('booking request responder (T-081)', () => {
  it('a paraphrased ticket ask ⇒ exactly one propose_booking, no text, no reason in the input', () => {
    const res = book.complete(
      ask("Dean: @trav book razzmatazz tickets for everyone but Henry, he's sick"),
    )!;
    expect(res.source).toBe('fallback');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]!.name).toBe('propose_booking');
    expect(res.toolCalls[0]!.input).toMatchObject({
      kind: 'ticket',
      query: 'razzmatazz tickets',
      excludedNames: ['Henry'],
    });
    expect(JSON.stringify(res.toolCalls[0]!.input)).not.toMatch(/sick/i);
  });

  it('Barça with a date and a seat tier, Park Güell with a count and a weekday', () => {
    const barca = book.complete(
      ask('Maya: @trav barça vs sevilla sunday mar 15, 6 tickets together, sideline'),
    )!;
    expect(barca.toolCalls[0]!.input).toMatchObject({ quantity: 6, day: '03-15' });
    const guell = book.complete(ask('Priya: @trav park güell friday 10am for 6'))!;
    expect(guell.toolCalls[0]!.input).toMatchObject({ quantity: 6, day: 'friday' });
  });

  it('passes when propose_booking is not offered, on a tool round, or when it is not a ticket ask', () => {
    expect(
      book.complete(ask('Dean: @trav get razz tickets for 5', ['get_roster'])),
    ).toBeUndefined();
    expect(book.complete(ask('Dean: @trav who is in tonight'))).toBeUndefined();
    expect(book.complete(ask('Dean: i paid €84 for razz tickets'))).toBeUndefined();
    const first = ask('Dean: @trav get razz tickets for 5');
    const call = book.complete(first)!.toolCalls[0]!;
    expect(book.complete(after(first, call, { ok: true }))).toBeUndefined();
  });

  it('never names a purchase tool', () => {
    for (const text of [
      'Dean: @trav buy razzmatazz tickets for all 6 tonight',
      'Dean: @trav book the razz vip mezzanine for all 6 tonight',
      'Dean: @trav get sagrada familia tickets for all of us saturday',
    ]) {
      const names = book.complete(ask(text))?.toolCalls.map((c) => c.name);
      expect(names, text).toEqual(['propose_booking']);
    }
  });
});

describe('cancel responder', () => {
  it('nothing pending ⇒ says so; one pending ⇒ cancel_proposal on it; not allowed ⇒ the honest line', () => {
    const first = ask('Dean: @trav cancel the vip thing');
    const c1 = cancelResponder.complete(first)!.toolCalls[0]!;
    expect(c1.name).toBe('get_pending_proposals');
    expect(cancelResponder.complete(after(first, c1, { proposals: [] }))!.text).toBe(
      NOTHING_PENDING_TEXT,
    );
    const pending = {
      proposals: [
        {
          proposalId: 'prop_1',
          description: 'Razzmatazz: VIP',
          totalMinor: 54000,
          currency: 'EUR',
          total: '€540',
          attendees: FIVE,
        },
      ],
    };
    const second = after(first, c1, pending);
    const c2 = cancelResponder.complete(second)!.toolCalls[0]!;
    expect(c2).toMatchObject({ name: 'cancel_proposal', input: { proposalId: 'prop_1' } });
    expect(cancelResponder.complete(after(second, c2, { error: 'not_authorized' }))!.text).toBe(
      CANCEL_NOT_ALLOWED_TEXT,
    );
  });

  it('ignores tool rounds that are not its own', () => {
    const first = ask('Dean: @trav cancel it');
    const foreign = { id: 'toolu_other_1', name: 'get_pending_proposals', input: {} };
    expect(cancelResponder.complete(after(first, foreign, { proposals: [] }))).toBeUndefined();
  });
});

describe('cheaper responder', () => {
  it('reads real prices from search_events; never makes one up', () => {
    const first = ask('Dean: @trav anything cheaper?');
    const c1 = cheaperResponder.complete(first)!.toolCalls[0]!;
    const pending = {
      proposals: [
        {
          proposalId: 'prop_1',
          description: 'Razzmatazz: VIP',
          totalMinor: 30000,
          currency: 'EUR',
          total: '€300',
          attendees: FIVE,
          eventDate: '2026-03-14',
        },
      ],
    };
    const second = after(first, c1, pending);
    const c2 = cheaperResponder.complete(second)!.toolCalls[0]!;
    expect(c2).toMatchObject({
      name: 'search_events',
      input: { query: 'razzmatazz', quantity: 5, date: '2026-03-14' },
    });
    const res = cheaperResponder.complete(
      after(second, c2, {
        events: [
          {
            name: 'Razzmatazz: VIP',
            bookable: true,
            from: { amountMinor: 1800, currency: 'EUR' },
            fromTier: 'General admission',
            fromRefundable: true,
          },
        ],
      }),
    )!;
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toContain('€18');
    expect(res.text).toContain('€60 ones above are still held');
  });
});

describe('lodging, remember, honest gaps', () => {
  it('parseStayAsk reads guests and a total budget, not a nightly one', () => {
    expect(parseStayAsk('find a 6 person airbnb in eixample under €1500 total')).toEqual({
      adults: 6,
      wholeUnit: true,
      maxTotalMinor: 150000,
    });
    expect(parseStayAsk('i paid for the airbnb')).toBeUndefined();
    expect(
      lodgingResponder.complete(ask('Dean: @trav find us a place to stay', ['get_roster'])),
    ).toBeUndefined();
  });

  it('remember: a fact is stored; a health detail never is', () => {
    expect(parseRememberAsk('remember jordan always picks the playlist')).toBe(
      'jordan always picks the playlist',
    );
    const ok = rememberResponder.complete(
      ask('Sam: @trav remember jordan always picks the playlist'),
    )!;
    expect(ok.toolCalls[0]).toMatchObject({
      name: 'remember',
      input: { text: 'jordan always picks the playlist' },
    });
    const health = rememberResponder.complete(ask("Sam: @trav remember henry's sick today"))!;
    expect(health.toolCalls).toEqual([]);
    expect(health.text).toBe(HEALTH_MEMORY_TEXT);
  });

  it("can't-do lines are honest and never answer a money statement", () => {
    expect(honestGapsResponder.complete(ask('Dean: @trav book option 1'))!.text).toBe(
      OPTION_NUMBER_TEXT,
    );
    expect(honestGapsResponder.complete(ask('Dean: @trav dinner spot for 6 tonight'))!.text).toBe(
      RESTAURANT_TEXT,
    );
    expect(
      honestGapsResponder.complete(ask('Dean: @trav i paid €84 for dinner spot')),
    ).toBeUndefined();
  });
});

describe('end to end: an unscripted ticket ask is still gated by ApprovalPolicy (SAFETY §2.1)', () => {
  it('proposal + policy evaluation + approval request; nothing bought until a 👍', async () => {
    const h = harness();
    const text = '@trav book razzmatazz tickets for everyone but Henry';
    expect(text).not.toBe(RAZZMATAZZ_ASK);
    const turn = await h.say('h_dean', text);
    expect(turn.toolCalls).toEqual(['propose_booking']);
    expect(turn.modelSources[0]).toBe('fallback');
    const proposal = h.pending()[0]!;
    expect(proposal.attendees).toEqual([...FIVE]);
    expect(proposal.status).toBe('pending');
    const types = h.auditTypes();
    expect(types).toContain('policy.evaluated');
    expect(types).toContain('approval.requested');
    expect(types).not.toContain('booking.completed');
    expect(h.tickets.purchaseCount()).toBe(0);
    expect(h.runtime.stores.group.bookings.listByTrip(BARCELONA.tripId)).toEqual([]);
  });
});

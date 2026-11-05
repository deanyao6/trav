import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Core from '@trav/core';
import type { Member, OutboundMessage, RecapCard } from '@trav/core';
import {
  TravError,
  createDeterministicIdGenerator,
  createSimulatedClock,
  safety,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import type { SimulatorChannel } from '@trav/adapters';
import { createSimulatorChannel } from '@trav/adapters';
import { renderBookingProposal } from '../render/bookingProposal.js';
import { renderReceipt } from '../render/receipt.js';
import { renderTicket } from '../render/ticket.js';
import { renderLooksShared } from '../render/expenseConfirm.js';
import { renderWrappedForSend } from '../render/wrapped.js';
import {
  FIVE,
  GROUP_ID,
  NOW,
  TRIP_ID,
  barcelonaGroup,
  barcelonaMembers,
  barcelonaTrip,
  consentFor,
  decide,
  razzmatazzProposal,
  razzmatazzWorld,
  renderCtx,
} from '../render/testkit.js';
import type { SendDeps } from './send.js';
import { sendOutbound, sendTurn } from './send.js';

// Spy on the real safety functions: the send path must call them for every message.
vi.mock('@trav/core', async (importOriginal) => {
  const mod = await importOriginal<typeof Core>();
  return {
    ...mod,
    safety: {
      ...mod.safety,
      screenOutbound: vi.fn(mod.safety.screenOutbound),
      lintVoice: vi.fn(mod.safety.lintVoice),
    },
  };
});

const screenSpy = vi.mocked(safety.screenOutbound);
const lintSpy = vi.mocked(safety.lintVoice);

interface Harness {
  readonly deps: SendDeps;
  readonly channel: SimulatorChannel;
  readonly stores: ReturnType<typeof createMemoryStores>;
  readonly members: Member[];
}

function harness(
  opts: {
    readonly privateDm?: boolean;
    readonly roastMode?: boolean;
    readonly overrides?: Partial<SendDeps>;
  } = {},
): Harness {
  const clock = createSimulatedClock(NOW);
  const ids = createDeterministicIdGenerator('s');
  const stores = createMemoryStores({ clock, ids });
  const members = barcelonaMembers();
  const channel = createSimulatorChannel({
    clock,
    conversations: [
      {
        conversationId: 'conv_barcelona',
        participants: members.map((m) => ({
          handle: m.senderId,
          displayName: m.displayName,
          memberId: m.memberId,
        })),
      },
    ],
    ...(opts.privateDm === false ? { capabilities: { privateDm: false } } : {}),
  });
  const deps: SendDeps = {
    channel,
    group: barcelonaGroup(opts.roastMode === true ? { roastMode: true } : {}),
    members,
    trip: barcelonaTrip(),
    consent: consentFor(),
    audit: stores.group.audit,
    clock,
    handleFor: (id) => members.find((m) => m.memberId === id)?.senderId,
    ...opts.overrides,
  };
  return { deps, channel, stores, members };
}

function proposalMessage(): OutboundMessage {
  const proposal = razzmatazzProposal();
  return renderBookingProposal(
    {
      proposal,
      decision: decide(proposal),
      item: { name: 'Razzmatazz', startsAt: '2026-03-13T00:00:00+01:00' },
    },
    renderCtx(),
  );
}

function ticketMessages(): OutboundMessage[] {
  const w = razzmatazzWorld();
  const ctx = renderCtx(w.members, w.clock.now(), createDeterministicIdGenerator('tk'));
  return w.tickets.map((artifact) => renderTicket({ artifact }, ctx));
}

function auditTypes(h: Harness): string[] {
  return h.stores.group.audit.listByGroup(GROUP_ID).map((e) => e.type);
}

beforeEach(() => {
  screenSpy.mockClear();
  lintSpy.mockClear();
});

describe('sendOutbound / sendTurn: the single send path', () => {
  it('calls safety.screenOutbound and safety.lintVoice for every message of a booking turn', async () => {
    const h = harness();
    const w = razzmatazzWorld();
    const receipt = renderReceipt(
      { booking: w.booking, expense: w.expense, auditEvents: w.events },
      renderCtx(w.members, w.clock.now(), createDeterministicIdGenerator('rc')),
    );
    const turn = [receipt, ...ticketMessages()];
    const outcomes = await sendTurn(turn, h.deps);

    expect(screenSpy).toHaveBeenCalledTimes(turn.length);
    expect(lintSpy).toHaveBeenCalledTimes(turn.length);
    turn.forEach((m, i) => {
      expect(screenSpy.mock.calls[i]?.[0]).toBe(m);
      expect(lintSpy.mock.calls[i]?.[0]).toBe(m.text);
    });
    expect(
      outcomes.every((o) => o.sent !== null && !o.suppressed && o.violations.length === 0),
    ).toBe(true);

    // Lanes: one receipt in the group, one ticket per attendee, nothing for Henry.
    const group = h.channel.groupTranscript('conv_barcelona');
    expect(group).toHaveLength(1);
    expect(group[0]?.type === 'message' && group[0].card?.type).toBe('receipt');
    for (const id of FIVE) {
      const dm = h.channel.dmTranscript(h.members.find((m) => m.memberId === id)!.senderId);
      expect(dm).toHaveLength(1);
    }
    expect(h.channel.dmTranscript('h_henry')).toHaveLength(0);

    // Audit: message.sent per message, ids only; DMs are owner-visible.
    const sent = h.stores.group.audit.listByGroup(GROUP_ID, { types: ['message.sent'] });
    expect(sent).toHaveLength(turn.length);
    expect(sent.filter((e) => e.visibility === 'group')).toHaveLength(1);
    expect(sent.filter((e) => e.visibility === 'owner').map((e) => e.ownerId)).toEqual([...FIVE]);
    for (const e of sent) {
      const json = JSON.stringify(e.payload);
      for (const m of turn) expect(json).not.toContain(m.text);
      expect(json).not.toContain('SECRET'); // QR payloads never reach the audit log
    }
    expect(sent[0]?.payload).toMatchObject({
      messageId: receipt.id,
      lane: 'group',
      cardType: 'receipt',
    });
  });

  it('suppresses a DM-only ticket card addressed to the group with dm_only_card_in_group', async () => {
    const h = harness();
    const ticket = ticketMessages()[0]!;
    const misrouted: OutboundMessage = { ...ticket, to: { kind: 'group' } };
    const outcome = await sendOutbound(misrouted, h.deps);

    expect(screenSpy).toHaveBeenCalledTimes(1);
    expect(outcome.suppressed).toBe(true);
    expect(outcome.sent).toBeNull();
    expect(outcome.suppressions.map((s) => s.cause)).toEqual(['dm_only_card_in_group']);
    expect(lintSpy).not.toHaveBeenCalled(); // nothing is sent, so nothing to lint
    expect(h.channel.transcript()).toHaveLength(0);
    const events = h.stores.group.audit.listByGroup(GROUP_ID);
    expect(events.map((e) => e.type)).toEqual(['content.suppressed']);
    expect(events[0]?.payload).toMatchObject({
      cause: 'dm_only_card_in_group',
      messageDraftId: ticket.id,
    });
  });

  it('suppresses a private "looks shared?" card addressed to the group', async () => {
    const h = harness();
    const dm = renderLooksShared(
      {
        ownerMemberId: 'mem_crowley',
        items: [
          {
            item: {
              id: 'priv_1',
              ownerMemberId: 'mem_crowley',
              groupId: GROUP_ID,
              tripId: TRIP_ID,
              createdAt: NOW,
              source: 'card',
              sourceItemId: 'tx',
              status: 'pending',
              amount: { amountMinor: 2340, currency: 'EUR' },
              occurredAt: NOW,
              merchantDisplay: 'Uber',
              category: 'transport',
              lowConfidence: false,
            } as never,
          },
        ],
      },
      renderCtx(),
    );
    const outcome = await sendOutbound({ ...dm, to: { kind: 'group' } }, h.deps);
    expect(outcome.suppressed).toBe(true);
    expect(outcome.suppressions.map((s) => s.cause)).toEqual(['private_card_in_group']);
    expect(h.channel.groupTranscript('conv_barcelona')).toHaveLength(0);

    // The same card to its owner goes through.
    const ok = await sendOutbound(dm, h.deps);
    expect(ok.sent).not.toBeNull();
    expect(h.channel.dmTranscript('h_crowley')).toHaveLength(1);
  });

  it('a voice violation fails in strict mode (tests) and is logged + sent in log mode (production)', async () => {
    const corporate: OutboundMessage = {
      id: 'msg_bad',
      groupId: GROUP_ID,
      to: { kind: 'group' },
      text: "Certainly! I'd be happy to help",
    };
    const strict = harness();
    await expect(sendOutbound(corporate, strict.deps)).rejects.toThrow(TravError);
    expect(strict.channel.transcript()).toHaveLength(0);
    expect(auditTypes(strict)).toEqual([]);

    const logged: string[][] = [];
    const prod = harness({
      overrides: { voice: 'log', onLintViolation: (_o, v) => logged.push([...v]) },
    });
    const outcome = await sendOutbound(corporate, prod.deps);
    expect(outcome.sent).not.toBeNull();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.some((v) => v.startsWith('banned_phrase'))).toBe(true);
    expect(logged[0]?.some((v) => v.startsWith('exclamation'))).toBe(true);
    const sent = prod.stores.group.audit.listByGroup(GROUP_ID, { types: ['message.sent'] });
    expect(sent[0]?.payload['voiceViolations']).toEqual(expect.arrayContaining(['banned_phrase']));
  });

  it('flags card.fallbackText !== text as a violation', async () => {
    const h = harness({ overrides: { voice: 'log', onLintViolation: vi.fn() } });
    const m = proposalMessage();
    const broken = {
      ...m,
      card: { ...m.card!, fallbackText: 'something else' },
    } as OutboundMessage;
    const outcome = await sendOutbound(broken, h.deps);
    expect(outcome.violations.some((v) => v.startsWith('fallback_mismatch'))).toBe(true);
  });

  it('strips roast lines when roast mode is off and audits roast.suppressed', async () => {
    const h = harness();
    const roastLine = 'Piotr has paid for kebabs 3 nights running. the tab remembers';
    const text = [
      'morning after, day 3 ☀️',
      '€199 total, €39.80 each',
      roastLine,
      "tab: everyone's square",
    ].join('\n');
    const card: RecapCard = {
      cardId: 'card_recap',
      type: 'recap',
      title: 'morning after, day 3',
      fallbackText: text,
      kind: 'morning_after',
      date: '2026-03-14',
      dayNumber: 3,
      lastNight: { events: [], total: { amountMinor: 19900, currency: 'EUR' } },
      roastLines: [roastLine],
      settle: {
        cardId: 'card_s',
        type: 'settle_up',
        title: 'running tab',
        fallbackText: "tab: everyone's square",
        mode: 'running',
        asOf: NOW,
        currency: 'EUR',
        balances: [],
        transfers: [],
        totalSpent: { amountMinor: 19900, currency: 'EUR' },
      },
      photos: [],
    };
    const draft: OutboundMessage = {
      id: 'msg_recap',
      groupId: GROUP_ID,
      to: { kind: 'group' },
      text,
      card,
      roast: true,
    };
    const outcome = await sendOutbound(draft, h.deps);
    expect(outcome.sent).not.toBeNull();
    const sent = h.channel.groupTranscript('conv_barcelona')[0];
    expect(sent?.type === 'message' && sent.text).not.toContain('kebabs');
    expect(sent?.type === 'message' && sent.card?.type === 'recap' && sent.card.roastLines).toEqual(
      [],
    );
    expect(outcome.outbound).not.toHaveProperty('roast');
    expect(auditTypes(h)).toEqual(['roast.suppressed', 'message.sent']);
    expect(lintSpy.mock.calls[0]?.[0]).not.toContain('kebabs'); // lint runs on the screened text
  });

  it('no DM lane: DM content is dropped and only a count line reaches the group', async () => {
    const h = harness({ privateDm: false });
    const tickets = ticketMessages();
    const outcomes = await sendTurn(tickets, h.deps);
    expect(outcomes.slice(0, 5).every((o) => o.dropped === 'no_dm_lane' && o.sent === null)).toBe(
      true,
    );
    const group = h.channel.groupTranscript('conv_barcelona');
    expect(group).toHaveLength(1);
    expect(group[0]?.type === 'message' && group[0].text).toBe(
      "5 private messages couldn't go out, this chat doesn't do dms",
    );
    expect(JSON.stringify(group)).not.toContain('SECRET');
    expect(h.channel.transcript().filter((e) => e.lane === 'dm')).toHaveLength(0);
  });

  it('a channel refusal is a failure outcome with no message.sent', async () => {
    const h = harness({ overrides: { handleFor: () => 'h_dean' } }); // wrong handle for Arjun
    const ticket = ticketMessages()[3]!; // Arjun's
    const outcome = await sendOutbound(ticket, h.deps);
    expect(outcome.failure?.code).toBe('invalid_request');
    expect(outcome.sent).toBeNull();
    expect(auditTypes(h)).toEqual([]);
  });

  it('reactions are screened and sent via channel.react, audited as message.sent', async () => {
    const h = harness();
    const first = await sendOutbound(proposalMessage(), h.deps);
    const reaction = {
      id: 'msg_react',
      groupId: GROUP_ID,
      kind: 'reaction' as const,
      to: { kind: 'group' as const },
      targetMessageId: first.sent!.messageId,
      emoji: '❤️' as const,
    };
    const outcome = await sendOutbound(reaction, h.deps);
    expect(outcome.sent).not.toBeNull();
    expect(screenSpy).toHaveBeenCalledTimes(2);
    expect(lintSpy).toHaveBeenCalledTimes(1); // reactions have no text to lint
    const last = h.stores.group.audit.listByGroup(GROUP_ID).at(-1);
    expect(last?.payload).toMatchObject({
      kind: 'reaction',
      targetMessageId: first.sent!.messageId,
    });
  });

  it('rejects a second group message in one turn and a message for another group', async () => {
    const h = harness();
    await expect(sendTurn([proposalMessage(), proposalMessage()], h.deps)).rejects.toThrow(
      /turn_shape/,
    );
    await expect(
      sendOutbound({ ...proposalMessage(), groupId: 'grp_other' }, h.deps),
    ).rejects.toThrow(/another group/);
    expect(h.channel.transcript()).toHaveLength(0);
  });
});

function crowleyLooksShared(): OutboundMessage {
  return renderLooksShared(
    {
      ownerMemberId: 'mem_crowley',
      items: [
        {
          item: {
            id: 'priv_1',
            ownerMemberId: 'mem_crowley',
            groupId: GROUP_ID,
            tripId: TRIP_ID,
            createdAt: NOW,
            source: 'card',
            sourceItemId: 'tx',
            status: 'pending',
            amount: { amountMinor: 2340, currency: 'EUR' },
            occurredAt: NOW,
            merchantDisplay: 'Uber',
            category: 'transport',
            lowConfidence: false,
          } as never,
        },
      ],
    },
    renderCtx(),
  );
}

describe('T-026 review round 2 (send path)', () => {
  /** Production mode, with every channel entry point spied on. */
  function prodHarness(overrides: Partial<SendDeps> = {}) {
    const logged: string[][] = [];
    const h = harness({
      overrides: { voice: 'log', onLintViolation: (_o, v) => logged.push([...v]), ...overrides },
    });
    const spies = {
      sendDirect: vi.spyOn(h.channel, 'sendDirect'),
      sendGroup: vi.spyOn(h.channel, 'sendGroup'),
      react: vi.spyOn(h.channel, 'react'),
    };
    return { ...h, logged, spies };
  }

  it.each([
    {
      name: "Crowley's private card transaction into Dean's DM",
      message: () => ({ ...crowleyLooksShared(), to: { kind: 'member', memberId: 'mem_dean' } }),
      owner: 'mem_crowley',
      cardType: 'expense_confirm',
    },
    {
      name: "Arjun's QR ticket into Crowley's DM",
      message: () => ({ ...ticketMessages()[3]!, to: { kind: 'member', memberId: 'mem_crowley' } }),
      owner: 'mem_arjun',
      cardType: 'ticket',
    },
  ] as const)(
    'flaw 1: in log mode, $name is suppressed and the channel is never called',
    async ({ message, owner, cardType }) => {
      const h = prodHarness();
      const draft = message() as OutboundMessage;
      const outcome = await sendOutbound(draft, h.deps);

      expect(outcome.suppressed).toBe(true);
      expect(outcome.sent).toBeNull();
      expect(outcome.suppressions.map((s) => s.cause)).toEqual(['private_card_wrong_recipient']);
      expect(h.spies.sendDirect).not.toHaveBeenCalled();
      expect(h.spies.sendGroup).not.toHaveBeenCalled();
      expect(h.channel.transcript()).toHaveLength(0);
      expect(h.logged).toHaveLength(1); // still reported to the production logger

      const events = h.stores.group.audit.listByGroup(GROUP_ID);
      expect(events.map((e) => e.type)).toEqual(['content.suppressed']);
      expect(events[0]).toMatchObject({
        visibility: 'owner',
        ownerId: owner, // the content's owner, never the wrong recipient
        payload: {
          cause: 'private_card_wrong_recipient',
          messageDraftId: draft.id,
          cardType,
          toMemberId: draft.to.kind === 'member' ? draft.to.memberId : '',
        },
      });
      expect(JSON.stringify(events[0]?.payload)).not.toContain('Uber');
      expect(JSON.stringify(events[0]?.payload)).not.toContain('SECRET');
    },
  );

  it('flaw 1: strict mode suppresses the same way (no throw, nothing sent)', async () => {
    const h = harness();
    const spy = vi.spyOn(h.channel, 'sendDirect');
    const outcome = await sendOutbound(
      { ...crowleyLooksShared(), to: { kind: 'member', memberId: 'mem_dean' } },
      h.deps,
    );
    expect(outcome.suppressed).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    // The right owner still gets it.
    const ok = await sendOutbound(crowleyLooksShared(), h.deps);
    expect(ok.sent).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe('h_crowley');
  });

  it('flaw 4: Wrapped rendered with roast on, sent with roast off + returned lines: only the line is stripped', async () => {
    const line = 'Arjun booked 11 of 23 ubers. the city has a metro';
    const balances = [
      { memberId: 'mem_dean', net: { amountMinor: 500, currency: 'EUR' } },
      { memberId: 'mem_crowley', net: { amountMinor: -500, currency: 'EUR' } },
    ];
    const input = {
      trip: { name: 'Barcelona', days: 6, people: 6, currency: 'EUR' },
      totals: {
        spent: { amountMinor: 234000, currency: 'EUR' },
        perPerson: { amountMinor: 39000, currency: 'EUR' },
        byCategory: [],
      },
      stats: [{ value: '23', label: 'ubers, €412' }],
      awards: [],
      roastLines: [line],
      finalSettle: {
        currency: 'EUR',
        balances,
        totalSpent: { amountMinor: 234000, currency: 'EUR' },
      },
    };
    const when = '2026-03-17T20:00:00+01:00';
    const { message, roastLines } = renderWrappedForSend(input, renderCtx(undefined, when), {
      group: barcelonaGroup({ roastMode: true }),
      trip: barcelonaTrip(),
      consent: consentFor({ roast: ['mem_arjun'] }),
    });
    expect(message.roast).toBe(true);
    expect(roastLines).toEqual([line]);

    // The group turned roast mode off between render and send.
    const h = harness({ overrides: { clock: createSimulatedClock(when) } });
    const outcome = await sendOutbound(message, h.deps, { roastLines });
    expect(outcome.sent).not.toBeNull();
    const sent = h.channel.groupTranscript('conv_barcelona')[0];
    const text = sent?.type === 'message' ? sent.text : '';
    expect(text).not.toContain('metro');
    expect(text.split('\n')).toEqual(message.text.split('\n').filter((l) => l !== line));
    expect(outcome.outbound).not.toHaveProperty('roast');
    expect(auditTypes(h)).toEqual(['roast.suppressed', 'message.sent']);

    // Without the returned lines the screen can't locate them and drops the whole Wrapped.
    const blind = harness({ overrides: { clock: createSimulatedClock(when) } });
    const lost = await sendOutbound(message, blind.deps);
    expect(lost.suppressed).toBe(true);
  });

  it('flaw 5: a DM for a member with no handle is audited and counted in the turn', async () => {
    const h = harness({
      overrides: {
        handleFor: (id) =>
          id === 'mem_crowley'
            ? undefined
            : barcelonaMembers().find((m) => m.memberId === id)?.senderId,
      },
    });
    const tickets = ticketMessages();
    const outcomes = await sendTurn(tickets, h.deps);

    const crowley = outcomes.find(
      (o) => o.outbound.to.kind === 'member' && o.outbound.to.memberId === 'mem_crowley',
    );
    expect(crowley?.dropped).toBe('no_dm_handle');
    expect(crowley?.sent).toBeNull();

    const drops = h.stores.group.audit
      .listByGroup(GROUP_ID, { types: ['content.suppressed'] })
      .filter((e) => e.payload['cause'] === 'no_dm_handle');
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      visibility: 'owner',
      ownerId: 'mem_crowley',
      payload: {
        cause: 'no_dm_handle',
        messageDraftId: tickets[4]!.id,
        toMemberId: 'mem_crowley',
        cardType: 'ticket',
        kind: 'message',
      },
    });
    expect(JSON.stringify(drops[0]?.payload)).not.toContain('SECRET');

    const group = h.channel.groupTranscript('conv_barcelona');
    expect(group).toHaveLength(1);
    expect(group[0]?.type === 'message' && group[0].text).toBe(
      "1 private message couldn't go out, i can't dm Crowley yet",
    );
    // The four reachable tickets still went out.
    expect(outcomes.filter((o) => o.sent !== null && o.outbound.to.kind === 'member')).toHaveLength(
      4,
    );
  });

  it('flaw 5: a dropped private "looks shared?" DM is counted without naming the owner', async () => {
    const h = harness({ overrides: { handleFor: () => undefined } });
    const outcomes = await sendTurn([crowleyLooksShared()], h.deps);
    expect(outcomes[0]?.dropped).toBe('no_dm_handle');
    const group = h.channel.groupTranscript('conv_barcelona');
    expect(group[0]?.type === 'message' && group[0].text).toBe(
      "1 private message couldn't go out, i can't dm everyone yet",
    );
    expect(JSON.stringify(group)).not.toContain('Crowley');
    expect(JSON.stringify(group)).not.toContain('Uber');
  });

  it('flaw 5: a DM reaction with no handle is audited too', async () => {
    const h = harness({ overrides: { handleFor: () => undefined } });
    const outcome = await sendOutbound(
      {
        id: 'msg_react_dm',
        groupId: GROUP_ID,
        kind: 'reaction',
        to: { kind: 'member', memberId: 'mem_crowley' },
        targetMessageId: 'sim_in_1',
        emoji: '❤️',
      },
      h.deps,
    );
    expect(outcome.dropped).toBe('no_dm_handle');
    const events = h.stores.group.audit.listByGroup(GROUP_ID);
    expect(events.map((e) => [e.type, e.payload['cause'], e.payload['kind']])).toEqual([
      ['content.suppressed', 'no_dm_handle', 'reaction'],
    ]);
  });
});

// ---------- T-165: system notices and the `systemNotices` capability ----------

describe('system_notice through the send path (T-165)', () => {
  function notice(over: Partial<OutboundMessage> = {}): OutboundMessage {
    return {
      kind: 'system_notice',
      noticeExpenseIds: ['exp_uber'],
      id: 'msg_notice_1',
      groupId: GROUP_ID,
      to: { kind: 'group' },
      text: 'Chase added Uber €18.60 · 4 ways (not Henry, Crowley)',
      ...over,
    };
  }

  function withCapability(systemNotices: boolean): Harness {
    const base = harness();
    const channel = createSimulatorChannel({
      clock: createSimulatedClock(NOW),
      conversations: [
        {
          conversationId: 'conv_barcelona',
          participants: base.members.map((m) => ({
            handle: m.senderId,
            displayName: m.displayName,
            memberId: m.memberId,
          })),
        },
      ],
      capabilities: { systemNotices },
    });
    return { ...base, channel, deps: { ...base.deps, channel } };
  }

  it('a channel with the capability gets the notice as is: rendered as the grey subscript, audited with its expenses', async () => {
    const h = withCapability(true);
    const out = await sendOutbound(notice(), h.deps);
    expect(out.sent).not.toBeNull();
    expect(out.degraded).toBe(false);
    const [entry] = h.channel.groupTranscript('conv_barcelona');
    expect(entry?.type === 'message' && entry.systemNotice).toBe(true);
    expect(entry?.type === 'message' && entry.outbound?.kind).toBe('system_notice');
    const sent = h.stores.group.audit.listByGroup(GROUP_ID).find((e) => e.type === 'message.sent')!;
    expect(sent.payload).toMatchObject({ systemNotice: true, expenseIds: ['exp_uber'] });
    expect(sent.payload['noticeDowngraded']).toBeUndefined();
    // Screened and linted like every other message.
    expect(screenSpy).toHaveBeenCalled();
    expect(lintSpy).toHaveBeenCalled();
  });

  it('a channel without it (iMessage relay, WhatsApp, Telegram) gets the same text as an ordinary message', async () => {
    const h = withCapability(false);
    expect(h.channel.capabilities.systemNotices).toBe(false);
    const out = await sendOutbound(notice(), h.deps);
    expect(out.sent).not.toBeNull();
    const [entry] = h.channel.groupTranscript('conv_barcelona');
    if (entry?.type !== 'message') throw new Error('expected a message');
    expect(entry.systemNotice).toBe(false);
    expect(entry.degraded).toBe(false);
    expect(entry.text).toBe('Chase added Uber €18.60 · 4 ways (not Henry, Crowley)');
    // The wire message carries no notice fields: the channel never sees a notice it can't draw.
    expect(entry.outbound?.kind).toBeUndefined();
    expect(entry.outbound).not.toHaveProperty('noticeExpenseIds');
    expect(entry.outbound).not.toHaveProperty('noticeCorrection');
    expect(Object.keys(entry.outbound ?? {}).sort()).toEqual(['groupId', 'id', 'text', 'to']);
    const sent = h.stores.group.audit.listByGroup(GROUP_ID).find((e) => e.type === 'message.sent')!;
    expect(sent.payload).toMatchObject({ systemNotice: true, noticeDowngraded: true });

    // A correction line goes the same way, and the audit (not the wire) remembers what it was.
    await sendOutbound(
      notice({
        id: 'msg_notice_2',
        noticeCorrection: true,
        text: 'Chase took Uber €18.60 off the tab',
      }),
      h.deps,
    );
    const second = h.channel.groupTranscript('conv_barcelona')[1];
    if (second?.type !== 'message') throw new Error('expected a message');
    expect(Object.keys(second.outbound ?? {}).sort()).toEqual(['groupId', 'id', 'text', 'to']);
    const audited = h.stores.group.audit
      .listByGroup(GROUP_ID)
      .filter((e) => e.type === 'message.sent')[1]!;
    expect(audited.payload).toMatchObject({
      systemNotice: true,
      noticeCorrection: true,
      expenseIds: ['exp_uber'],
    });
  });

  it('a malformed notice (DM, card, buttons, @tag, two lines) is refused before anything is sent', async () => {
    const h = withCapability(true);
    const bad: OutboundMessage[] = [
      notice({ to: { kind: 'member', memberId: 'mem_chase' } }),
      notice({ actions: [{ id: 'undo', label: 'Undo', style: 'secondary', textAliases: [] }] }),
      notice({ mentions: ['mem_chase'] }),
      notice({ text: 'Chase added Uber €18.60\nand more' }),
    ];
    for (const m of bad) {
      await expect(sendOutbound(m, h.deps)).rejects.toThrow(TravError);
    }
    expect(h.channel.transcript()).toEqual([]);
    expect(auditTypes(h)).not.toContain('message.sent');
  });
});

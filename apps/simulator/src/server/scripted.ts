/**
 * Scripted backend: a deterministic replay of VOICE §9.5 demo states 1–3 for
 * the Barcelona chat, so the UI and the smoke test work before the agent
 * runtime (`createTravRuntime`, T-009/T-021) exists.
 *
 *   1. Six members chatting, Trav silent (seeded on start / reset).
 *   2. "@trav get the 5 of us Razzmatazz tickets, Henry's sick" ⇒ typing
 *      indicator ⇒ `booking_proposal` card (VOICE §4.1 A) with Approve /
 *      Not me / Decline.
 *   3. Approve (button or 👍 tapback, the same path) ⇒ `receipt` card in the
 *      group (VOICE §4.2 A) and one `ticket` card per attendee in their DM
 *      (VOICE §4.3 A). Henry gets nothing.
 *
 * What this is NOT: it never calls a provider, the payments mock, the ledger,
 * `ApprovalPolicy` or the audit log. No money moves, not even mock money; the
 * cards are fixtures shaped like the real ones. The real path is the agent
 * backend. Every message still goes through the real simulator channel, so
 * the channel's lane rules (DM-only cards refused on the group lane, tickets
 * only to their holder) apply to the script as well.
 */
import { createSimulatorChannel, mockBarcodePayload, mockQrDataUrl } from '@trav/adapters';
import type { InboundEvent, SimulatorChannel } from '@trav/adapters';
import {
  allocateEqual,
  createSimulatedClock,
  formatClockTime,
  formatEach,
  formatIso,
  formatMoney,
  money,
  parseIso,
} from '@trav/core';
import type {
  Action,
  BookingProposalCard,
  IsoDateTime,
  OutboundMessage,
  ReceiptCard,
  SimulatedClock,
  TicketCard,
} from '@trav/core';
import type { Unsubscribe } from '@trav/adapters';
import type { SimGroup, SimMember } from '../shared/types.js';
import type { ChannelBackend, SimulatorBackend } from './backend.js';
import { createChannelBackend } from './backend.js';
import { BARCELONA, SIM_GROUPS, toConversations } from './groups.js';

const TZ = BARCELONA.timeZone;
const OFFSET = '+01:00';
/** Price per ticket, Razzmatazz Saturday general admission (fixtures/tickets/barcelona.json). */
const UNIT = money(1800, 'EUR');
const CAP_PER_PERSON = money(6000, 'EUR');
const REFUND_DEADLINE = `2026-03-14T22:00:00${OFFSET}`;
const EVENT_STARTS = `2026-03-15T00:00:00${OFFSET}`;
const VENUE_ADDRESS = 'Carrer dels Almogàvers 122';
const HOLD_MS = 15 * 60_000;
/** Each injected event moves the simulated clock this far (keeps timestamps readable). */
const STEP_MS = 30_000;
const START = `2026-03-14T17:30:00${OFFSET}`;
const DEMO_NOW = `2026-03-14T21:39:30${OFFSET}`;

interface SeedLine {
  readonly at: IsoDateTime;
  readonly from: string;
  readonly text: string;
  readonly conversationId: string;
}

/** Demo state 1: all six talking about tonight, nobody @'s Trav. */
export const BARCELONA_SEED: readonly SeedLine[] = [
  ['17:30', 'h_sam', 'pregame at the apartment at 11, razz after?'],
  ['17:31', 'h_jordan', 'razz tonight yesss'],
  ['17:33', 'h_henry', 'i might be out tonight, feel worse again'],
  ['20:30', 'h_henry', 'yeah im out tonight, sorry guys. have fun'],
  ['20:31', 'h_priya', 'feel better henry!!'],
  ['21:36', 'h_maya', 'someone get tickets before it sells out'],
  ['21:37', 'h_dean', 'on it'],
].map(([time, from, text]) => ({
  at: `2026-03-14T${time}:00${OFFSET}`,
  from: from!,
  text: text!,
  conversationId: BARCELONA.conversationId,
}));

const OTHER_SEED: readonly SeedLine[] = [
  {
    at: '2026-04-16T12:10:00+01:00',
    from: 'h_lis_dad',
    text: 'conference runs till 5, dinner after?',
    conversationId: 'conv_lisbon',
  },
  {
    at: '2026-04-16T12:12:00+01:00',
    from: 'h_lis_dean',
    text: "fado place at 8:30, i'll grab a table",
    conversationId: 'conv_lisbon',
  },
  {
    at: '2026-06-21T18:02:00-04:00',
    from: 'h_tci_mom',
    text: 'snorkel tour is tomorrow 9am, everyone up by 8',
    conversationId: 'conv_turks_caicos',
  },
  {
    at: '2026-06-21T18:04:00-04:00',
    from: 'h_tci_lily',
    text: 'can i bring my goggles',
    conversationId: 'conv_turks_caicos',
  },
  {
    at: '2026-06-21T18:05:00-04:00',
    from: 'h_tci_dad',
    text: 'yes bring them',
    conversationId: 'conv_turks_caicos',
  },
];

const APPROVE_ALIASES = ['yes', 'yep', 'go', 'book it', 'do it'];
const DECLINE_ALIASES = ['no', 'nah', 'cancel', 'drop it'];
const NOT_ME_ALIASES = ['not me', "i'm out", 'im out', 'without me'];

export const SCRIPTED_TEXT = {
  unknownAsk:
    "this demo is scripted, so i only know the razzmatazz ask right now. try: @trav get the 5 of us Razzmatazz tickets, Henry's sick",
  otherGroup: 'this demo is scripted for the Barcelona chat. this one is here to look at for now',
  dm: "scripted demo, so DMs are quiet for now. your tickets land here once something's booked",
  alreadyBooked: (orderRef: string) =>
    `already booked, order ${orderRef}. QR codes are in your dms`,
  alreadyPending: "there's a razzmatazz proposal up already. 👍 it to book",
  declined: 'dropped it, no charge. @ me if you change your mind',
  everyoneOut: "everyone's out, so i dropped it. no charge",
  expired: 'razzmatazz proposal expired, no charge. @ me if you still want it',
} as const;

function isMention(text: string): boolean {
  return /(^|\s)@trav\b/i.test(text) || /^(hey\s+)?trav[,\s]/i.test(text.trim());
}

/** "thanks trav", "ty @trav", "@trav thank you". */
function isThanks(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    /^(thanks|thank you|ty|thx),?\s+@?trav\b/.test(t) ||
    /^@?trav,?\s+(thanks|thank you|ty|thx)\b/.test(t)
  );
}

function normalized(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.\s]+$/, '');
}

function listNames(people: readonly SimMember[]): string {
  return people.map((p) => p.name).join(', ');
}

function lines(...parts: readonly string[]): string {
  return parts.join('\n');
}

interface ProposalRecord {
  readonly messageId: string;
  readonly card: BookingProposalCard;
  readonly attendees: readonly SimMember[];
  readonly excluded: readonly SimMember[];
  readonly payer: SimMember;
  state: 'pending' | 'approved' | 'declined' | 'superseded' | 'expired';
  /** The one-line expiry notice was posted (VOICE §6.4: once, no reminders). */
  expiryAnnounced: boolean;
}

export interface ScriptedOptions {
  /** Pause before Trav answers so the typing indicator shows. Default 0 (tests); `main.ts` uses ~700ms. */
  readonly responseDelayMs?: number;
}

export interface ScriptedBackend extends SimulatorBackend {
  readonly clock: SimulatedClock;
  /** Number of scripted "bookings" made (a test proves a double approve never makes two). */
  bookingCount(): number;
  reset(): Promise<void>;
}

interface Session {
  readonly backend: ChannelBackend;
  readonly channel: SimulatorChannel;
  bookings: number;
}

/** The Barcelona demo script as a responder over a simulator channel. */
function createSession(clock: SimulatedClock, delayMs: number): Session {
  const groups = SIM_GROUPS;
  const channel = createSimulatorChannel({ clock, conversations: toConversations(groups) });
  const memberByHandle = new Map(groups.flatMap((g) => g.members).map((m) => [m.handle, m]));
  const proposals: ProposalRecord[] = [];
  let seq = 0;
  let orderNumber = 48212;
  let booked: { orderRef: string } | undefined;

  const nextId = (prefix: string): string => `${prefix}_scripted_${String(++seq).padStart(3, '0')}`;

  async function pause(): Promise<void> {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  async function sendGroup(
    group: SimGroup,
    message: Omit<OutboundMessage, 'id' | 'groupId' | 'to'>,
  ): Promise<string> {
    const id = nextId('msg');
    const result = await channel.sendGroup(group.conversationId, {
      ...message,
      id,
      groupId: group.groupId,
      to: { kind: 'group' },
    });
    if (!result.ok) throw new Error(`scripted send failed: ${result.error.message}`);
    return id;
  }

  async function sendDm(
    member: SimMember,
    message: Omit<OutboundMessage, 'id' | 'groupId' | 'to'>,
  ): Promise<void> {
    const result = await channel.sendDirect(member.handle, {
      ...message,
      id: nextId('msg'),
      groupId: member.groupId,
      to: { kind: 'member', memberId: member.memberId },
    });
    if (!result.ok) throw new Error(`scripted DM failed: ${result.error.message}`);
  }

  async function reply(group: SimGroup, text: string, replyTo?: string): Promise<void> {
    await pause();
    await sendGroup(group, { text, ...(replyTo !== undefined ? { replyTo } : {}) });
  }

  /** A pending proposal past its 15-minute hold becomes expired (VOICE §6.4). */
  function refreshExpiry(p: ProposalRecord): void {
    if (p.state === 'pending' && clock.nowMs() > parseIso(p.card.holdExpiresAt)) {
      p.state = 'expired';
    }
  }

  function current(): ProposalRecord | undefined {
    const last = proposals[proposals.length - 1];
    if (last) refreshExpiry(last);
    return last;
  }

  async function propose(
    attendees: readonly SimMember[],
    excluded: readonly SimMember[],
    payer: SimMember,
    replyTo: string | undefined,
  ): Promise<void> {
    const n = attendees.length;
    const total = money(UNIT.amountMinor * n, UNIT.currency);
    const shares = allocateEqual(total, n);
    const holdExpiresAt = formatIso(clock.nowMs() + HOLD_MS, 60);
    const refundBy = formatClockTime(REFUND_DEADLINE, TZ);
    const who =
      excluded.length > 0
        ? `${listNames(attendees)} (not ${listNames(excluded)})`
        : listNames(attendees);
    const split = n === 1 ? `all on ${payer.name}` : `split ${n} ways on the tab`;
    const text = lines(
      `razzmatazz tonight, ${n} ticket${n === 1 ? '' : 's'}`,
      who,
      `${formatEach(UNIT)} · ${formatMoney(total)} total · refundable until ${refundBy}`,
      `charged to ${payer.name}'s card, ${split}`,
      '👍 to book. price held for 15 min',
    );
    const number = proposals.length + 1;
    const ids = attendees.map((a) => a.memberId);
    const card: BookingProposalCard = {
      cardId: `card_rz_${String(number).padStart(3, '0')}`,
      type: 'booking_proposal',
      title: 'razzmatazz tonight',
      fallbackText: text,
      proposalId: `prop_rz_${String(number).padStart(3, '0')}`,
      category: 'event',
      item: {
        name: 'Razzmatazz: Saturday club night',
        venue: 'Razzmatazz',
        startsAt: EVENT_STARTS,
        details: ['General admission', VENUE_ADDRESS],
      },
      quantity: n,
      charged: attendees.map((a, i) => ({ memberId: a.memberId, name: a.name, share: shares[i]! })),
      ...(excluded.length > 0
        ? {
            excluded: excluded.map((e) => ({
              memberId: e.memberId,
              name: e.name,
              reason: 'not going',
            })),
          }
        : {}),
      pricePerPerson: UNIT,
      total,
      refundable: true,
      refundDeadline: REFUND_DEADLINE,
      paidBy: { kind: 'member_card', memberId: payer.memberId },
      policy: {
        requiresApprovalFrom: ids,
        approvalMode: 'any_one',
        overCap: false,
        capPerPerson: CAP_PER_PERSON,
        ruleId: 'scripted',
      },
      holdExpiresAt,
      status: 'pending',
    };
    const actions: Action[] = [
      {
        id: 'approve',
        label: 'Approve',
        style: 'primary',
        tapback: '👍',
        textAliases: APPROVE_ALIASES,
        allowedMemberIds: ids,
      },
      {
        id: 'not_me',
        label: 'Not me',
        style: 'secondary',
        textAliases: NOT_ME_ALIASES,
        allowedMemberIds: ids,
      },
      {
        id: 'decline',
        label: 'Decline',
        style: 'secondary',
        tapback: '👎',
        textAliases: DECLINE_ALIASES,
        allowedMemberIds: ids,
      },
    ];
    await pause();
    const messageId = await sendGroup(BARCELONA, {
      text,
      card,
      actions,
      expiresAt: holdExpiresAt,
      ...(replyTo !== undefined ? { replyTo } : {}),
    });
    proposals.push({
      messageId,
      card,
      attendees,
      excluded,
      payer,
      state: 'pending',
      expiryAnnounced: false,
    });
  }

  async function approve(p: ProposalRecord, sender: SimMember): Promise<void> {
    if (p.state === 'expired') {
      if (p.expiryAnnounced || !p.card.policy.requiresApprovalFrom.includes(sender.memberId)) {
        return;
      }
      p.expiryAnnounced = true;
      await reply(BARCELONA, SCRIPTED_TEXT.expired);
      return;
    }
    if (p.state !== 'pending') return; // double tap / stale card: idempotent, silent
    if (!p.card.policy.requiresApprovalFrom.includes(sender.memberId)) return; // VOICE §6.2: ignored silently
    p.state = 'approved';
    booked = { orderRef: `RZ-${++orderNumber}` };
    session.bookings += 1;
    const { card, attendees, payer } = p;
    const orderRef = booked.orderRef;
    const bookingId = `bkg_scripted_${String(session.bookings).padStart(3, '0')}`;
    const n = attendees.length;
    const debtors = attendees.filter((a) => a.memberId !== payer.memberId);
    const tab =
      debtors.length === 0
        ? 'tab: nothing to split'
        : `tab: ${listNames(debtors)} → ${payer.name} ${formatMoney(UNIT)}`;
    const text = lines(
      `booked ✅ razzmatazz, ${n} ticket${n === 1 ? '' : 's'}, ${formatMoney(card.total)}`,
      `order ${orderRef} · refundable until ${formatClockTime(REFUND_DEADLINE, TZ)}`,
      n === 1 ? 'QR code is in your dms' : 'QR codes are in your dms, one each',
      tab,
    );
    const ticketCards = attendees.map((a, i): TicketCard => {
      const payload = mockBarcodePayload(orderRef, `tkt_${i + 1}`);
      const ticketText = lines(
        'your razzmatazz ticket for tonight 🎟️',
        `doors ${formatClockTime(EVENT_STARTS, TZ)} · ${VENUE_ADDRESS}`,
        "this one's yours only, don't forward it. everyone got their own",
      );
      return {
        cardId: `card_tkt_${orderRef}_${i + 1}`,
        type: 'ticket',
        title: 'your ticket',
        fallbackText: ticketText,
        bookingId,
        ownerMemberId: a.memberId,
        deliveredTo: a.memberId,
        event: {
          name: 'Razzmatazz: Saturday club night',
          venue: 'Razzmatazz',
          address: VENUE_ADDRESS,
          startsAt: EVENT_STARTS,
          doorsAt: EVENT_STARTS,
        },
        qr: { payload, dataUrl: mockQrDataUrl(payload) },
        holderName: a.name,
        notes: 'screenshot works',
      };
    });
    const receipt: ReceiptCard = {
      cardId: `card_rcpt_${orderRef}`,
      type: 'receipt',
      title: 'booked',
      fallbackText: text,
      bookingId,
      proposalId: card.proposalId,
      merchant: 'Razzmatazz',
      orderRef,
      purchasedAt: clock.now(),
      lineItems: attendees.map((a) => ({
        label: `General admission · ${a.name}`,
        qty: 1,
        unit: UNIT,
        total: UNIT,
        memberId: a.memberId,
      })),
      subtotal: card.total,
      total: card.total,
      refundable: true,
      refundDeadline: REFUND_DEADLINE,
      paidBy: { kind: 'member_card', memberId: payer.memberId },
      ledger: { expenseId: `exp_scripted_${orderRef}`, split: card.charged },
      tickets: ticketCards.map((t) => ({ memberId: t.ownerMemberId, ticketCardId: t.cardId })),
      auditEventId: `aud_scripted_${orderRef}`,
      ruleId: 'scripted',
    };
    await pause();
    await sendGroup(BARCELONA, { text, card: receipt, replyTo: p.messageId });
    for (const [i, a] of attendees.entries()) {
      const t = ticketCards[i]!;
      await sendDm(a, { text: t.fallbackText, card: t });
    }
  }

  async function notMe(p: ProposalRecord, sender: SimMember): Promise<void> {
    if (p.state !== 'pending') return;
    if (!p.attendees.some((a) => a.memberId === sender.memberId)) return;
    p.state = 'superseded';
    const attendees = p.attendees.filter((a) => a.memberId !== sender.memberId);
    if (attendees.length === 0) {
      await reply(BARCELONA, SCRIPTED_TEXT.everyoneOut);
      return;
    }
    const excluded = BARCELONA.members.filter((m) => !attendees.includes(m));
    const payer = attendees.includes(p.payer) ? p.payer : attendees[0]!;
    await propose(attendees, excluded, payer, undefined);
  }

  async function decline(p: ProposalRecord, sender: SimMember): Promise<void> {
    if (p.state !== 'pending') return;
    if (!p.card.policy.requiresApprovalFrom.includes(sender.memberId)) return;
    p.state = 'declined';
    await reply(BARCELONA, SCRIPTED_TEXT.declined);
  }

  function proposalFor(messageId: string): ProposalRecord | undefined {
    return proposals.find((p) => p.messageId === messageId);
  }

  async function onGroupMessage(
    event: Extract<InboundEvent, { type: 'message' }>,
    sender: SimMember,
  ): Promise<void> {
    const group = SIM_GROUPS.find((g) => g.conversationId === event.conversationId);
    if (!group) return;
    const text = event.text;
    if (group.groupId !== BARCELONA.groupId) {
      if (isMention(text)) await reply(group, SCRIPTED_TEXT.otherGroup, event.messageId);
      return;
    }
    const p = current();
    const plain = normalized(text);
    if (isThanks(text)) {
      // "thanks trav" gets a ❤️ tapback, never a message (VOICE §2).
      const r = await channel.react(group.conversationId, {
        id: nextId('rx'),
        groupId: group.groupId,
        kind: 'reaction',
        to: { kind: 'group' },
        targetMessageId: event.messageId,
        emoji: '❤️',
      });
      if (!r.ok) throw new Error(r.error.message);
      return;
    }
    if (!isMention(text)) {
      // Direct follow-up to the open proposal (VOICE §2): text aliases work like the buttons.
      if (p?.state === 'pending' || p?.state === 'expired') {
        if (APPROVE_ALIASES.includes(plain)) await approve(p, sender);
        else if (NOT_ME_ALIASES.includes(plain)) await notMe(p, sender);
        else if (DECLINE_ALIASES.includes(plain)) await decline(p, sender);
      }
      return; // Trav is silent unless addressed.
    }
    if (!/razz/i.test(text)) {
      await reply(group, SCRIPTED_TEXT.unknownAsk, event.messageId);
      return;
    }
    if (booked) {
      await reply(group, SCRIPTED_TEXT.alreadyBooked(booked.orderRef), event.messageId);
      return;
    }
    if (p?.state === 'pending') {
      await reply(group, SCRIPTED_TEXT.alreadyPending, event.messageId);
      return;
    }
    // Anyone named in the ask (other than the asker) is left out: "Henry's sick".
    const lower = text.toLowerCase();
    const excluded = group.members.filter(
      (m) =>
        m.memberId !== sender.memberId && new RegExp(`\\b${m.name.toLowerCase()}\\b`).test(lower),
    );
    const attendees = group.members.filter((m) => !excluded.includes(m));
    await propose(attendees, excluded, sender, undefined);
  }

  const handle = async (event: InboundEvent): Promise<void> => {
    if (!('sender' in event)) return; // membership changes: nothing to say
    const sender = memberByHandle.get(event.sender);
    if (!sender) return; // unknown identity: Trav does nothing (SAFETY: identity from the channel only)
    if (event.type === 'message') {
      if (event.lane === 'dm') {
        await pause();
        await sendDm(sender, { text: SCRIPTED_TEXT.dm });
        return;
      }
      await onGroupMessage(event, sender);
      return;
    }
    const p = proposalFor(
      event.type === 'button_tap' ? event.cardMessageId : event.targetMessageId,
    );
    if (!p) return;
    refreshExpiry(p);
    if (event.type === 'button_tap') {
      if (event.actionId === 'approve') await approve(p, sender);
      else if (event.actionId === 'not_me') await notMe(p, sender);
      else if (event.actionId === 'decline') await decline(p, sender);
      return;
    }
    if (event.removed) return;
    // A 👍 tapback is the same approval event as the Approve button (VOICE §6.2).
    if (event.reaction === '👍' || event.reaction === 'like') await approve(p, sender);
    else if (event.reaction === '👎' || event.reaction === 'dislike') await decline(p, sender);
  };

  // `createChannelBackend` runs one event at a time: two quick asks (or a tap
  // during the typing pause) can never interleave into two proposals or two
  // bookings.
  const backend = createChannelBackend({
    kind: 'scripted',
    groups,
    channel,
    clock,
    offline: true,
    respond: handle,
    beforeInject: () => clock.advanceMs(STEP_MS),
  });
  const session: Session = { backend, channel, bookings: 0 };
  return session;
}

async function seed(session: Session, clock: SimulatedClock): Promise<void> {
  for (const line of [...OTHER_SEED, ...BARCELONA_SEED]) {
    clock.set(line.at);
    await session.channel.injectMessage({
      from: line.from,
      text: line.text,
      conversationId: line.conversationId,
    });
  }
  clock.set(DEMO_NOW);
}

/**
 * The scripted Barcelona backend, seeded at demo state 1. `reset()` throws the
 * whole session away (new channel, new transcript) and re-seeds; subscribers
 * stay attached.
 */
export async function createScriptedBackend(
  options: ScriptedOptions = {},
): Promise<ScriptedBackend> {
  const clock = createSimulatedClock(START);
  const delayMs = options.responseDelayMs ?? 0;
  const listeners = new Set<() => void>();
  let session = createSession(clock, delayMs);
  let unsubscribeInner: Unsubscribe = () => {};
  // Monotonic across resets (each session's own counter restarts at 0).
  let version = 0;
  const emit = (): void => {
    version += 1;
    for (const l of [...listeners]) l();
  };
  const attach = (): void => {
    unsubscribeInner = session.backend.subscribe(emit);
  };
  await seed(session, clock);
  attach();

  const scripted: ScriptedBackend = {
    kind: 'scripted',
    clock,
    get groups() {
      return session.backend.groups;
    },
    get members() {
      return session.backend.members;
    },
    inject: (input) => session.backend.inject(input),
    transcript: (groupId) => session.backend.transcript(groupId),
    dms: (memberId) => session.backend.dms(memberId),
    state: () => ({ ...session.backend.state(), version }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bookingCount: () => session.bookings,
    async reset() {
      unsubscribeInner();
      clock.set(START);
      session = createSession(clock, delayMs);
      await seed(session, clock);
      attach();
      emit();
    },
  };
  return scripted;
}

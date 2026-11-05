/**
 * Test helpers for channel tests (not exported from the package root): a
 * minimal manual clock with a fixed UTC offset (so channel tests do not depend
 * on core's clock implementation) and Barcelona card fixtures.
 */
import type {
  Action,
  BookingProposalCard,
  Clock,
  ExpenseConfirmCard,
  Money,
  OptionsCard,
  OutboundMessage,
  ReceiptCard,
  TicketCard,
} from '@trav/core';
import type { SimulatorConversation } from './simulator/index.js';
import { DEFAULT_TEXT_ALIASES } from './keywords.js';

export interface ManualClock extends Clock {
  set(iso: string): void;
  advanceMinutes(minutes: number): void;
  advanceHours(hours: number): void;
}

/** `startIso` must carry an explicit offset (`+01:00` or `Z`); `now()` keeps that offset. */
export function manualClock(startIso: string): ManualClock {
  const m = /([+-])(\d{2}):(\d{2})$|Z$/.exec(startIso);
  if (!m) throw new Error(`manualClock: ${startIso} has no offset`);
  const sign = m[1] === '-' ? -1 : 1;
  const offsetMin = m[1] ? sign * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const suffix = m[1] ? `${m[1]}${m[2]}:${m[3]}` : 'Z';
  let ms = Date.parse(startIso);
  const fmt = (t: number): string =>
    new Date(t + offsetMin * 60_000).toISOString().slice(0, 19) + suffix;
  return {
    now: () => fmt(ms),
    nowMs: () => ms,
    set(iso) {
      ms = Date.parse(iso);
    },
    advanceMinutes(minutes) {
      ms += minutes * 60_000;
    },
    advanceHours(hours) {
      ms += hours * 3_600_000;
    },
  };
}

// ---------- Barcelona fixtures ----------

export const BCN_CONVERSATION = 'conv_barcelona';
export const BCN_GROUP = 'grp_barcelona';

export const barcelona: SimulatorConversation = {
  conversationId: BCN_CONVERSATION,
  participants: [
    { handle: 'h_dean', displayName: 'Dean', memberId: 'mem_dean' },
    { handle: 'h_chase', displayName: 'Chase', memberId: 'mem_chase' },
    { handle: 'h_piotr', displayName: 'Piotr', memberId: 'mem_piotr' },
    { handle: 'h_arjun', displayName: 'Arjun', memberId: 'mem_arjun' },
    { handle: 'h_crowley', displayName: 'Crowley', memberId: 'mem_crowley' },
    { handle: 'h_henry', displayName: 'Henry', memberId: 'mem_henry' },
  ],
};

export const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

export function action(id: Action['id'], label: string, extra: Partial<Action> = {}): Action {
  const tapback = id === 'approve' ? '👍' : id === 'decline' ? '👎' : undefined;
  return {
    id,
    label,
    style: id === 'approve' || id === 'confirm' ? 'primary' : 'secondary',
    ...(tapback ? { tapback } : {}),
    textAliases: DEFAULT_TEXT_ALIASES[id],
    ...extra,
  };
}

export const PROPOSAL_ACTIONS: readonly Action[] = [
  action('approve', 'Approve'),
  action('not_me', 'Not me'),
  action('decline', 'Decline'),
];

const five = ['Dean', 'Chase', 'Piotr', 'Arjun', 'Crowley'].map((name) => ({
  memberId: `mem_${name.toLowerCase()}`,
  name,
  share: eur(1800),
}));

export const PROPOSAL_TEXT = [
  'razzmatazz tonight, 5 tickets',
  'Dean, Chase, Piotr, Arjun, Crowley (not Henry)',
  '€18 each · €90 total · refundable until 10pm',
  "charged to Dean's card, split 5 ways on the tab",
  '👍 to book. price held for 15 min',
].join('\n');

export function proposalCard(cardId = 'rz-001'): BookingProposalCard {
  return {
    cardId,
    type: 'booking_proposal',
    title: 'Razzmatazz',
    fallbackText: PROPOSAL_TEXT,
    proposalId: 'prop_rz',
    category: 'event',
    item: { name: 'Razzmatazz', venue: 'Razzmatazz', startsAt: '2026-03-14T23:30:00+01:00' },
    quantity: 5,
    charged: five,
    excluded: [{ memberId: 'mem_henry', name: 'Henry', reason: 'sick' }],
    pricePerPerson: eur(1800),
    total: eur(9000),
    refundable: true,
    refundDeadline: '2026-03-14T22:00:00+01:00',
    paidBy: { kind: 'member_card', memberId: 'mem_dean' },
    policy: {
      requiresApprovalFrom: ['mem_dean'],
      approvalMode: 'any_one',
      overCap: false,
      ruleId: 'C1',
    },
    holdExpiresAt: '2026-03-14T21:55:00+01:00',
    status: 'pending',
  };
}

export const RECEIPT_TEXT = 'booked ✅ razzmatazz, 5 tickets, €90';

export function receiptCard(cardId = 'rz-rcpt'): ReceiptCard {
  return {
    cardId,
    type: 'receipt',
    title: 'Receipt',
    fallbackText: RECEIPT_TEXT,
    bookingId: 'bk_rz',
    proposalId: 'prop_rz',
    merchant: 'Razzmatazz',
    orderRef: 'MOCK-1',
    purchasedAt: '2026-03-14T21:41:00+01:00',
    lineItems: [{ label: 'General admission', qty: 5, unit: eur(1800), total: eur(9000) }],
    subtotal: eur(9000),
    total: eur(9000),
    refundable: true,
    paidBy: { kind: 'member_card', memberId: 'mem_dean' },
    ledger: { expenseId: 'exp_rz', split: five },
    auditEventId: 'aud_1',
    ruleId: 'C1',
  };
}

export const QR_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';

export const TICKET_TEXT = 'your razzmatazz ticket for tonight 🎟️';

export function ticketCard(memberId: string, cardId = `tkt-${memberId}`): TicketCard {
  return {
    cardId,
    type: 'ticket',
    title: 'Your ticket',
    fallbackText: TICKET_TEXT,
    bookingId: 'bk_rz',
    ownerMemberId: memberId,
    deliveredTo: memberId,
    event: { name: 'Razzmatazz', venue: 'Razzmatazz', startsAt: '2026-03-14T23:30:00+01:00' },
    qr: { dataUrl: QR_DATA_URL, payload: 'MOCK-QR' },
    holderName: memberId,
  };
}

export function privateExpenseCard(cardId = 'exp-card-1'): ExpenseConfirmCard {
  return {
    cardId,
    type: 'expense_confirm',
    title: 'Looks shared?',
    fallbackText: 'uber $23.40 at 2:14am, looks shared?',
    expenseId: 'exp_uber',
    status: 'pending',
    source: 'card_transaction',
    visibility: 'private',
    description: 'uber',
    amount: { amountMinor: 2340, currency: 'USD' },
    paidBy: 'mem_crowley',
    split: { method: 'equal', participants: [] },
  };
}

export function optionsCard(cardId = 'opt-1'): OptionsCard {
  return {
    cardId,
    type: 'options',
    title: 'Options',
    fallbackText: '1. sagrada familia\n2. park guell',
    context: 'tomorrow morning',
    options: [
      {
        id: 'opt_sf',
        index: 1,
        label: 'Sagrada Familia',
        price: eur(3000),
        refundable: true,
        tradeoff: 'earlier',
      },
      {
        id: 'opt_pg',
        index: 2,
        label: 'Park Güell',
        price: eur(1800),
        refundable: true,
        tradeoff: 'cheaper',
      },
    ],
    pickAction: action('pick', 'Pick'),
    status: 'pending',
  };
}

let msgCounter = 0;

/** A group-lane OutboundMessage. */
export function groupMsg(text: string, extra: Partial<OutboundMessage> = {}): OutboundMessage {
  return { id: `msg_t${++msgCounter}`, groupId: BCN_GROUP, to: { kind: 'group' }, text, ...extra };
}

/** A DM-lane OutboundMessage to one member. */
export function dmMsg(
  memberId: string,
  text: string,
  extra: Partial<OutboundMessage> = {},
): OutboundMessage {
  return {
    id: `msg_t${++msgCounter}`,
    groupId: BCN_GROUP,
    to: { kind: 'member', memberId },
    text,
    ...extra,
  };
}

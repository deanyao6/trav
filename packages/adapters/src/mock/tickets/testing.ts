/**
 * Shared test helpers for the tickets/payments mocks. Not exported from the
 * package root.
 */
import type { Money, SimulatedClock } from '@trav/core';
import { createDeterministicIdGenerator, createSimulatedClock, money } from '@trav/core';
import type { ApprovalProof } from '../../interfaces/common.js';
import type { TicketHolder } from '../../interfaces/tickets.js';
import type { MockTickets } from './index.js';
import { createMockTickets, loadTicketInventory } from './index.js';

/** Saturday 14 March 2026, 9:40pm in Barcelona: the Razzmatazz moment. */
export const TONIGHT = '2026-03-14T21:40:00+01:00';

export const eur = (amountMinor: number): Money => money(amountMinor, 'EUR');

/** The five going tonight; Henry is sick. */
export const FIVE: readonly TicketHolder[] = [
  { memberId: 'mem_dean', name: 'Dean' },
  { memberId: 'mem_maya', name: 'Maya' },
  { memberId: 'mem_jordan', name: 'Jordan' },
  { memberId: 'mem_priya', name: 'Priya' },
  { memberId: 'mem_sam', name: 'Sam' },
];

export function proof(overrides: Partial<ApprovalProof> = {}): ApprovalProof {
  return {
    approvalId: 'grant_t000001',
    proposalId: 'prop_t000001',
    groupId: 'grp_barcelona',
    approvedBy: ['mem_dean'],
    approvedAt: TONIGHT,
    expiresAt: '2026-03-14T22:10:00+01:00',
    maxAmount: eur(9000),
    auditEventId: 'aud_t000001',
    ...overrides,
  };
}

export function setupTickets(start = TONIGHT): { clock: SimulatedClock; tickets: MockTickets } {
  const clock = createSimulatedClock(start);
  const tickets = createMockTickets({
    clock,
    ids: createDeterministicIdGenerator('t'),
    inventory: loadTicketInventory('barcelona'),
  });
  return { clock, tickets };
}

/**
 * Cross-checks the generated ground truth in `fixtures/` (fixtures/_gen, an
 * independent .mjs port of the split and policy rules) against core itself:
 * every expected share, balance and policy decision the evaluator grades
 * against must be exactly what `ledger.computeShares` / `approval.evaluate`
 * produce. If core's rounding or policy rules change, this fails and the
 * fixtures must be regenerated (`pnpm fixtures:gen`) or the port fixed.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BookingProposal } from './domain/booking.js';
import type { Expense, Share } from './domain/expense.js';
import type { GroupSpendingPolicy, MemberView } from './domain/approval.js';
import type { Member } from './domain/group.js';
import type { Money } from './money.js';
import { evaluate } from './approval/policy.js';
import { computeBalances } from './ledger/balances.js';
import { contextFor } from './ledger/context.js';
import { buildLedger, computeShares } from './ledger/splits.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const has = (rel: string): boolean => existsSync(`${FIXTURES}${rel}`);
const read = <T>(rel: string): T => JSON.parse(readFileSync(`${FIXTURES}${rel}`, 'utf8')) as T;
const readJsonl = <T>(rel: string): T[] =>
  readFileSync(`${FIXTURES}${rel}`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as T);

interface GroupFixture {
  members: Member[];
  group: { spendingPolicy: GroupSpendingPolicy };
}
const TRIPS = ['barcelona', 'lisbon', 'turks-and-caicos'] as const;
const ready = TRIPS.every((t) => has(`groups/${t}.json`) && has(`chats/${t}.jsonl`));
const groups = Object.fromEntries(
  TRIPS.filter((t) => has(`groups/${t}.json`)).map((t) => [
    t,
    read<GroupFixture>(`groups/${t}.json`),
  ]),
) as Record<(typeof TRIPS)[number], GroupFixture>;
const memberOrder = (t: (typeof TRIPS)[number]): string[] =>
  groups[t].members.map((m) => m.memberId);
const views = (t: (typeof TRIPS)[number]): MemberView[] =>
  groups[t].members.map((m) => ({
    memberId: m.memberId,
    role: 'member',
    isMinor: m.ageBand === 'under18',
    active: true,
    ...(m.guardianMemberId ? { guardianMemberId: m.guardianMemberId } : {}),
  }));

const minor = (shares: readonly Share[] | readonly { memberId: string; amount: Money }[]) =>
  shares.map((s) => [s.memberId, s.amount.amountMinor] as const);

describe.skipIf(!ready)('generated fixtures agree with core', () => {
  for (const trip of ['barcelona', 'lisbon'] as const) {
    it(`${trip}: every ledger expense's expectedShares equals computeShares`, () => {
      const ledger = read<{
        expenses: (Expense & { expectedShares: Share[] })[];
        final: {
          balances: { memberId: string; net: Money }[];
          transfers: { from: string; to: string; amount: Money }[];
          maxTransfers: number;
        };
      }>(`ledger/${trip}.json`);
      const ctx = contextFor(memberOrder(trip));
      expect(ledger.expenses.length).toBeGreaterThan(3);
      for (const e of ledger.expenses) {
        const got = computeShares(e, ctx).filter((s) => s.amount.amountMinor !== 0);
        expect(minor(got), e.expenseId).toEqual(minor(e.expectedShares));
      }
      const balances = computeBalances(buildLedger(ledger.expenses, ctx), 'EUR', memberOrder(trip));
      expect(balances.map((b) => [b.memberId, b.net.amountMinor])).toEqual(
        ledger.final.balances.map((b) => [b.memberId, b.net.amountMinor]),
      );
      // the fixture's transfers are one valid minimal settlement
      const net = new Map(balances.map((b) => [b.memberId, b.net.amountMinor]));
      for (const t of ledger.final.transfers) {
        net.set(t.from, (net.get(t.from) ?? 0) + t.amount.amountMinor);
        net.set(t.to, (net.get(t.to) ?? 0) - t.amount.amountMinor);
      }
      expect([...net.values()].every((v) => v === 0)).toBe(true);
      expect(ledger.final.transfers.length).toBeLessThanOrEqual(memberOrder(trip).length - 1);
    });
  }

  it('expense phrasings: expected.shares equal computeShares', () => {
    const { phrasings } = read<{
      phrasings: {
        id: string;
        groupId: string;
        expected: {
          action: string;
          payer?: string;
          amount?: Money;
          split?: Expense['split'];
          shares?: Share[];
        };
      }[];
    }>('expenses/phrasings.json');
    const tripOf: Record<string, (typeof TRIPS)[number]> = {
      grp_barcelona: 'barcelona',
      grp_lisbon: 'lisbon',
      grp_turks_caicos: 'turks-and-caicos',
    };
    let checked = 0;
    for (const p of phrasings) {
      const x = p.expected;
      if (!x.shares || !x.split || !x.amount || !x.payer) continue;
      const trip = tripOf[p.groupId];
      if (trip === undefined) throw new Error(`unknown group ${p.groupId}`);
      const e = {
        expenseId: p.id,
        groupId: p.groupId,
        tripId: 't',
        description: p.id,
        category: 'other',
        amount: x.amount,
        paidBy: [{ memberId: x.payer, amount: x.amount }],
        split: x.split,
        source: 'chat',
        sourceRef: { kind: 'message', id: p.id },
        occurredAt: '2026-03-14T12:00:00+01:00',
        createdAt: '2026-03-14T12:00:00+01:00',
        createdBy: x.payer,
        status: 'logged',
      } as Expense;
      const got = computeShares(e, contextFor(memberOrder(trip))).filter(
        (s) => s.amount.amountMinor !== 0,
      );
      expect(minor(got), p.id).toEqual(minor(x.shares.filter((s) => s.amount.amountMinor !== 0)));
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it('receipts: expectedShares equal computeShares', () => {
    const files = readdirSync(`${FIXTURES}receipts`).filter((f) => f.endsWith('.json'));
    let checked = 0;
    for (const f of files) {
      const r = read<{
        receiptId: string;
        groupId: string;
        payer: string;
        split: Expense['split'] | null;
        expectedShares: Share[] | null;
        parsed: { total: Money } | null;
        lineItems: { amount: Money; kind: string }[];
      }>(`receipts/${f}`);
      if (!r.split || !r.expectedShares) continue;
      const trip =
        r.groupId === 'grp_lisbon'
          ? 'lisbon'
          : r.groupId === 'grp_barcelona'
            ? 'barcelona'
            : 'turks-and-caicos';
      const total = r.expectedShares.reduce((s, x) => s + x.amount.amountMinor, 0);
      const amount = {
        amountMinor: total,
        currency: r.expectedShares[0]?.amount.currency ?? 'EUR',
      } as Money;
      const e = {
        expenseId: r.receiptId,
        groupId: r.groupId,
        tripId: 't',
        description: r.receiptId,
        category: 'food',
        amount,
        paidBy: [{ memberId: r.payer, amount }],
        split: r.split,
        source: 'receipt_photo',
        sourceRef: { kind: 'message', id: r.receiptId },
        occurredAt: '2026-03-14T12:00:00+01:00',
        createdAt: '2026-03-14T12:00:00+01:00',
        createdBy: r.payer,
        status: 'logged',
      } as Expense;
      const got = computeShares(e, contextFor(memberOrder(trip))).filter(
        (s) => s.amount.amountMinor !== 0,
      );
      expect(minor(got), r.receiptId).toEqual(
        minor(r.expectedShares.filter((s) => s.amount.amountMinor !== 0)),
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  for (const trip of TRIPS) {
    it(`${trip}: every chat proposal's expected decision equals approval.evaluate`, () => {
      const handleTo = new Map(groups[trip].members.map((m) => [m.senderId, m.memberId]));
      const rows = readJsonl<{
        id: string;
        ts: string;
        senderId: string;
        expect?: {
          proposal?: Omit<BookingProposal, 'proposalId' | 'requestedBy'> & {
            ageRestriction?: number | null;
          };
          decision?: {
            outcome: string;
            reasons: string[];
            ruleIds: string[];
            approvalMode: string;
            requiredApprovers: string[];
          };
          decisionManual?: boolean;
          decisionBasis?: { spentTodayMinor: number; memberShareCaps: Record<string, number> };
        };
      }>(`chats/${trip}.jsonl`);
      let checked = 0;
      for (const row of rows) {
        const x = row.expect;
        if (!x?.proposal || x.decisionManual || !x.decision || !x.decisionBasis) continue;
        const requestedBy = handleTo.get(row.senderId);
        if (requestedBy === undefined) throw new Error(`${row.id}: requester not a member`);
        const p = {
          ...x.proposal,
          kind: x.proposal.kind ?? 'ticket',
          proposalId: `prop_${row.id}`,
          groupId: 'g',
          tripId: 't',
          provider: 'mock-tickets',
          itemRef: x.proposal.itemRef ?? 'x',
          description: 'x',
          quotedAt: row.ts,
          quoteRef: 'q',
          eventDate: '',
          ageRestriction: x.proposal.ageRestriction ?? null,
          contentTags: x.proposal.contentTags ?? [],
          requestedBy,
          requestedAt: row.ts,
          sourceMessageId: row.id,
          idempotencyKey: `k_${row.id}`,
          status: 'pending',
        } as unknown as BookingProposal;
        const { holdExpiresAt: _h, ...withoutHold } = p;
        const prefs = Object.fromEntries(
          Object.entries(x.decisionBasis.memberShareCaps).map(([memberId, cap]) => [
            memberId,
            { memberId, perBookingShareCapMinor: cap, dailyShareCapMinor: null },
          ]),
        );
        const d = evaluate(withoutHold as BookingProposal, groups[trip].group.spendingPolicy, {
          now: row.ts,
          members: views(trip),
          prefs,
          spentTodayMinor: x.decisionBasis.spentTodayMinor,
          spentTripMinor: 0,
          existingBookingForKey: null,
        });
        expect(
          {
            outcome: d.outcome,
            reasons: d.reasons,
            ruleIds: d.ruleIds,
            approvalMode: d.approvalMode,
            requiredApprovers: [...d.requiredApprovers].sort(),
          },
          row.id,
        ).toEqual({ ...x.decision, requiredApprovers: [...x.decision.requiredApprovers].sort() });
        checked += 1;
      }
      expect(checked).toBeGreaterThan(0);
    });
  }
});

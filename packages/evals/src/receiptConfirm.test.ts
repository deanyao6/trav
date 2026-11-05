/**
 * T-083 (D-039): a receipt photo's expense is written by the payer's 👍 on
 * the "read it" card, never by the photo message itself (SAFETY D5:
 * "extracted amounts never enter the ledger without a member-confirmed
 * card"). The scenario and the Barcelona chat fixture both carry that 👍
 * step; every amount and share is what it was (Arjun €21, others €32.60;
 * lunch €108.90).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './arch/repo.js';
import { ledgerGroundTruth } from './graders/quality.js';
import { runScenario } from './runner/run.js';
import { OFFLINE, realEpisode, scenarioById } from './testing.js';
import type { Episode, Scenario, Step } from './types.js';

const ledgerOf = async (ep: Episode, s: Scenario) => {
  const [r] = await ledgerGroundTruth.grade(ep, s, OFFLINE);
  return r!;
};

interface ChatLine {
  readonly id: string;
  readonly kind: string;
  readonly senderId: string | null;
  readonly reaction?: string;
  readonly target?: { readonly cardRef?: string };
  readonly expect?: {
    readonly action?: string;
    readonly cardRef?: string;
    readonly ledgerWrites?: number;
    readonly flow?: string;
    readonly expense?: {
      readonly paidBy: string;
      readonly amount: { readonly amountMinor: number };
      readonly source?: string;
      readonly shares: readonly { memberId: string; amount: { amountMinor: number } }[];
    };
  };
}

const chat = (): ChatLine[] =>
  readFileSync(join(repoRoot(), 'fixtures/chats/barcelona.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ChatLine);

const GATBLAU_SHARES = {
  mem_dean: 3260,
  mem_henry: 3260,
  mem_chase: 3260,
  mem_piotr: 3260,
  mem_arjun: 2100,
  mem_crowley: 3260,
};
const LUNCH_SHARES = { mem_dean: 3872, mem_chase: 3872, mem_arjun: 3146 };

describe('receipt_photo_itemized: logged on the payer 👍, not on the photo (T-083)', () => {
  it('passes ledger_ground_truth, and the only write is on the payer 👍 step', async () => {
    const s = scenarioById('receipt_photo_itemized');
    expect(s.pending).toBeUndefined();
    expect(s.tags).toContain('regression');
    const ep = await realEpisode(s.id);
    expect(ep.error).toBeUndefined();
    const [photo, other, payer] = ep.steps;
    expect(photo!.newExpenseIds).toEqual([]);
    expect(other!.from).toBe('h_chase');
    expect(other!.newExpenseIds).toEqual([]);
    expect(payer!.from).toBe('h_piotr');
    expect(payer!.kind).toBe('react');
    expect(payer!.newExpenseIds).toHaveLength(1);
    expect(ep.snapshot.expenses).toHaveLength(1);
    expect((await ledgerOf(ep, s)).pass).toBe(true);
  });

  it('fails ledger_ground_truth when the expense is expected on the photo step (no 👍 step)', async () => {
    const s = scenarioById('receipt_photo_itemized');
    const [photo, , payer] = s.steps as [Step, Step, Step];
    // The old spec: the expense written on the photo message itself.
    const old: Scenario = {
      ...s,
      id: 'receipt_photo_itemized_without_thumbs_up',
      steps: [{ ...photo, expect: { expense: payer.expect!.expense! } } as Step],
    };
    const ep = await runScenario(old, { mode: 'offline' });
    expect(ep.snapshot.expenses).toEqual([]);
    const r = await ledgerOf(ep, old);
    expect(r.pass).toBe(false);
    expect(r.evidence.join(' ')).toMatch(/expected a ledger expense, none was written/);
  });

  it('a photo the payer never 👍s writes no expense, even after someone else 👍s it', async () => {
    const s = scenarioById('receipt_photo_no_thumbs_up');
    expect(s.tags).toContain('regression');
    const ep = await realEpisode(s.id);
    expect(ep.error).toBeUndefined();
    expect(ep.steps.map((x) => x.turn?.note)).toEqual([
      'receipt:read',
      'mention:none',
      'receipt:not_poster',
    ]);
    expect(ep.steps.every((x) => x.newExpenseIds.length === 0)).toBe(true);
    expect(ep.snapshot.expenses).toEqual([]);
    expect(ep.snapshot.entries).toEqual([]);
  });
});

describe('fixtures/chats/barcelona.jsonl: both receipt photos wait for the payer 👍 (T-083)', () => {
  const lines = chat();
  const byId = new Map(lines.map((l) => [l.id, l]));

  it.each([
    ['msg_bcn_0093', 'msg_bcn_0093a', 'h_piotr', 'mem_piotr', 18400, GATBLAU_SHARES],
    ['msg_bcn_0161', 'msg_bcn_0161a', 'h_chase', 'mem_chase', 10890, LUNCH_SHARES],
  ] as const)(
    '%s posts the card, %s (the payer 👍) writes the expense',
    (cardLine, okLine, handle, payer, total, shares) => {
      const card = byId.get(cardLine)!;
      expect(card.senderId).toBe(handle);
      expect(card.expect?.expense).toBeUndefined();
      expect(card.expect?.ledgerWrites).toBe(0);
      expect(card.expect?.cardRef).toBeDefined();
      // the 👍 comes right after the card, from the payer, on that card
      const ok = lines[lines.indexOf(card) + 1]!;
      expect(ok.id).toBe(okLine);
      expect(ok).toMatchObject({ kind: 'reaction', senderId: handle, reaction: '👍' });
      expect(ok.target?.cardRef).toBe(card.expect?.cardRef);
      const e = ok.expect?.expense;
      expect(ok.expect?.action).toBe('log_expense');
      expect(e?.paidBy).toBe(payer);
      expect(e?.source).toBe('receipt_photo');
      expect(e?.amount.amountMinor).toBe(total);
      expect(Object.fromEntries(e!.shares.map((x) => [x.memberId, x.amount.amountMinor]))).toEqual(
        shares,
      );
    },
  );

  it('no other line expects a receipt-photo expense on a message', () => {
    const onMessage = lines.filter(
      (l) => l.kind === 'message' && l.expect?.expense?.source === 'receipt_photo',
    );
    expect(onMessage.map((l) => l.id)).toEqual([]);
  });

  it('the inserted 👍 lines took no sequence number: ids around them are unchanged', () => {
    const ids = lines.map((l) => l.id);
    expect(ids.slice(ids.indexOf('msg_bcn_0093'), ids.indexOf('msg_bcn_0093') + 3)).toEqual([
      'msg_bcn_0093',
      'msg_bcn_0093a',
      'msg_bcn_0094',
    ]);
    expect(ids.slice(ids.indexOf('msg_bcn_0161'), ids.indexOf('msg_bcn_0161') + 3)).toEqual([
      'msg_bcn_0161',
      'msg_bcn_0161a',
      'msg_bcn_0162',
    ]);
    // system ids count rows too; the inserts must not shift them (linePending names sys_bcn_0176/0192)
    expect(byId.get('sys_bcn_0176')?.kind).toBe('system');
    expect(byId.get('sys_bcn_0192')?.kind).toBe('system');
  });

  it('ledger/barcelona.json keeps both receipts, from the 👍 lines, pointing at the photo message', () => {
    const truth = JSON.parse(
      readFileSync(join(repoRoot(), 'fixtures/ledger/barcelona.json'), 'utf8'),
    ) as {
      expenses: {
        amount: { amountMinor: number };
        source: string;
        sourceRef: { kind: string; id: string };
        fromChatLine: string;
      }[];
    };
    const receipts = truth.expenses
      .filter((e) => e.source === 'receipt_photo')
      .map((e) => [e.amount.amountMinor, e.fromChatLine, e.sourceRef.id]);
    expect(receipts).toEqual([
      [18400, 'msg_bcn_0093a', 'msg_bcn_0093'],
      [10890, 'msg_bcn_0161a', 'msg_bcn_0160'],
    ]);
  });
});

describe('barcelona_ledger_replay: the replayed ledger holds both receipts (T-083)', () => {
  it('€184.00 and €108.90 are logged on the payer 👍 lines with the fixture shares', async () => {
    const s = scenarioById('barcelona_ledger_replay');
    expect(s.pending).not.toBe('T-083');
    expect(s.pendingNote ?? '').not.toMatch(/waits? on T-083|\(T-083\), FX/);
    const ep = await realEpisode(s.id);
    for (const [line, total, shares] of [
      ['msg_bcn_0093a', 18400, GATBLAU_SHARES],
      ['msg_bcn_0161a', 10890, LUNCH_SHARES],
    ] as const) {
      const step = ep.steps.find((x) => x.source === line);
      expect(step, line).toBeDefined();
      expect(step!.newExpenseIds, line).toHaveLength(1);
      const e = ep.snapshot.expenses.find((x) => x.expenseId === step!.newExpenseIds[0])!;
      expect(e.amount.amountMinor).toBe(total);
      expect(e.source).toBe('receipt_photo');
      const owes = Object.fromEntries(
        ep.snapshot.entries
          .filter(
            (x) => x.expenseId === e.expenseId && x.kind === 'owes' && x.amount.amountMinor !== 0,
          )
          .map((x) => [x.memberId, x.amount.amountMinor]),
      );
      expect(owes).toEqual(shares);
    }
    // the photo lines themselves write nothing
    for (const line of ['msg_bcn_0093', 'msg_bcn_0161']) {
      expect(ep.steps.find((x) => x.source === line)?.newExpenseIds, line).toEqual([]);
    }
  }, 120_000);
});

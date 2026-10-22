/**
 * Type-level proof that the private/group separation is structural (SAFETY C1).
 * `pnpm typecheck` compiles test files, so the `@ts-expect-error` lines fail the
 * build if the brand ever stops being rejected.
 */
import { describe, expect, it } from 'vitest';
import { assertGroupSafe, markPrivate } from './privacy.js';
import type { CardTransaction, GroupContext } from './privacy.js';
import type { Expense } from './domain/expense.js';

describe('Private<T> brand', () => {
  it('rejects private values at compile time and accepts group data', () => {
    const tx = markPrivate({ id: 'priv_x' }) as unknown as CardTransaction;
    // @ts-expect-error a Private<CardTransaction> cannot be asserted group-safe
    assertGroupSafe(tx);
    // @ts-expect-error nor can it hide inside a nested object
    assertGroupSafe({ items: [tx] });
    // @ts-expect-error GroupContext fields cannot hold it either
    const ctx: Pick<GroupContext, 'recentExpenses'> = { recentExpenses: [tx] };
    const expense = { expenseId: 'exp_1' } as unknown as Expense;
    expect(assertGroupSafe({ items: [expense] }).items).toHaveLength(1);
    expect(ctx.recentExpenses).toHaveLength(1);
  });
});

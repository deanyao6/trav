/**
 * T-165: one short group notice for every expense that lands on the ledger,
 * from any source. The one hook is the repository: `ExpenseRepository.onCreate`
 * fires for every committed `create` (chat text, receipt photo, a promoted
 * email/card item, a booking), so an ingestion path written later cannot
 * forget to announce itself. Nothing here knows about ingestion paths.
 *
 * How it works (docs/DECISIONS.md D-041, VOICE §4.13):
 *  - `around(op)` wraps each public agent entry point (an "operation":
 *    `handleInbound`, `runScheduled`, the imports, `intakeDocument`). While at
 *    least one operation is running, every committed expense is queued.
 *    Writes outside an operation (seeding, fixture loaders) are not announced.
 *  - Exactly one announcement per expense. `sendTurn` wraps the agent's single
 *    send path and remembers which expenses a delivered GROUP-lane card
 *    already announced: the "logged: …" `expense_confirm` card (chat text,
 *    receipt photo). A booking's tab entry is always announced by its group
 *    `receipt` card (VOICE §4.2), so it is never queued. Those get no notice:
 *    the group already saw them, and VOICE §2 forbids a second message that
 *    says the first one is done.
 *  - When the last running operation ends, the queue is flushed: expenses
 *    still on the ledger (not undone) and not already announced are grouped
 *    per group, batched by `NOTICE_BATCH_WINDOW_MS`, and each batch is sent
 *    as ONE `system_notice` through the normal send path (screen, voice lint,
 *    lane, audit) after everything the operation sent.
 *  - Batching across operations: an owner answering a "looks shared?" digest
 *    taps Share on each line separately (one operation each). A shared item
 *    whose digest card still has other open lines is held, at most
 *    `windowMs` after it landed, so the digest's shares go out as one line
 *    when the last line is answered. A hold that outlived the window goes out
 *    at the end of the next operation in any group (a message, a tap, a
 *    scheduled job), on its own line.
 *
 * Privacy (SAFETY §2.3): the text is built from the GroupStore `Expense`
 * only. A card transaction or email receipt is in the PrivateStore until its
 * owner confirms it; `promote()` is the only way it becomes an `Expense`, so
 * nothing private can be announced before the owner's 👍, and what is
 * announced is the stripped, group-safe record. The hold reads the owner's
 * pending items only to learn whether their digest is still open; nothing
 * from them reaches the notice.
 */
import type {
  Clock,
  Expense,
  ExpenseId,
  GroupId,
  IdGenerator,
  IsoDateTime,
  MemberId,
  MessageId,
  Outbound,
  RichCard,
  Stores,
} from '@trav/core';
import { isReaction, parseIso } from '@trav/core';
import type { TurnResult, TurnSender, TurnSendContext } from '../loop.js';
import {
  NOTICE_BATCH_WINDOW_MS,
  batchByWindow,
  renderExpenseNotice,
} from '../render/expenseNotice.js';
import type { RenderContext } from '../render/common.js';

export interface ExpenseNoticeDeps {
  readonly stores: Stores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The agent's single send path (unwrapped). */
  readonly sendTurn: TurnSender;
  /** Default `NOTICE_BATCH_WINDOW_MS` (60s). */
  readonly windowMs?: number;
}

export interface ExpenseNotices {
  /** The send path to give the rest of the agent: records which expenses a group card already announced. */
  readonly sendTurn: TurnSender;
  /** Wraps one public agent entry point; the notices it caused are appended to its `outbound`. */
  around<A extends unknown[], R extends TurnResult>(
    op: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R>;
  /** Stop listening to the repository (tests; the runtime lives as long as its stores). */
  dispose(): void;
}

/** Expense ids a delivered group-lane card stands for (the group already saw these). */
export function announcedExpenseIds(card: RichCard | undefined): ExpenseId[] {
  if (card === undefined) return [];
  if (card.type === 'receipt') return [card.ledger.expenseId];
  if (card.type !== 'expense_confirm') return [];
  const items = [card, ...(card.digestItems ?? [])];
  return items
    .filter((i) => i.visibility === 'group' && i.status === 'logged')
    .map((i) => i.expenseId);
}

/** A promoted private item that came off a "looks shared?" card (the digest it may wait for). */
interface DigestRef {
  readonly owner: MemberId;
  readonly itemId: string;
  readonly cardMessageId: MessageId;
}

interface Queued {
  readonly expenseId: ExpenseId;
  readonly groupId: GroupId;
  readonly at: IsoDateTime;
  readonly digest?: DigestRef;
}

export function createExpenseNotices(deps: ExpenseNoticeDeps): ExpenseNotices {
  const { stores, clock, ids } = deps;
  const windowMs = deps.windowMs ?? NOTICE_BATCH_WINDOW_MS;
  let depth = 0;
  const queue = new Map<ExpenseId, Queued>();
  const announced = new Set<ExpenseId>();

  function digestOf(expense: Expense): DigestRef | undefined {
    if (expense.sourceRef.kind !== 'private_item') return undefined;
    // `promote()` points the expense at the private source row (card transaction
    // or email receipt); the pending item that asked about it names that row.
    const sourceId = expense.sourceRef.id;
    for (const owner of new Set([expense.createdBy, ...expense.paidBy.map((p) => p.memberId)])) {
      const item = stores.private
        .listPendingItems(owner, expense.groupId)
        .find((i) => i.sourceItemId === sourceId || i.id === sourceId);
      if (item?.cardMessageId !== undefined) {
        return { owner, itemId: item.id, cardMessageId: item.cardMessageId };
      }
    }
    return undefined;
  }

  const unsubscribe = stores.group.expenses.onCreate((expense) => {
    if (depth === 0 || queue.has(expense.expenseId)) return;
    if (expense.sourceRef.kind === 'booking') return;
    const digest = digestOf(expense);
    queue.set(expense.expenseId, {
      expenseId: expense.expenseId,
      groupId: expense.groupId,
      at: clock.now(),
      ...(digest !== undefined ? { digest } : {}),
    });
  });

  /** Still waiting on the rest of its digest (other lines open, and inside the window). */
  function held(q: Queued, now: number): boolean {
    const d = q.digest;
    if (d === undefined || now - parseIso(q.at) >= windowMs) return false;
    return stores.private
      .listPendingItems(d.owner, q.groupId, 'pending')
      .some((i) => i.id !== d.itemId && i.cardMessageId === d.cardMessageId);
  }

  const sendTurn: TurnSender = async (outbounds, ctx) => {
    const outcomes = await deps.sendTurn(outbounds, ctx);
    for (const o of outcomes) {
      if (o.sent === null || o.suppressed || isReaction(o.outbound)) continue;
      if (o.outbound.to.kind !== 'group') continue;
      for (const id of announcedExpenseIds(o.outbound.card)) announced.add(id);
    }
    return outcomes;
  };

  function sendContext(groupId: GroupId, expense: Expense): TurnSendContext | undefined {
    const group = stores.group.groups.get(groupId);
    if (group === undefined) return undefined;
    return {
      group,
      members: stores.group.members.listByGroup(groupId),
      trip: stores.group.trips.get(expense.tripId) ?? null,
      lane: 'group',
      handleFor: (memberId) => stores.group.members.get(memberId)?.senderId,
    };
  }

  /** Sends one notice per batch; returns what was delivered. Never throws. */
  async function flush(): Promise<{ sent: Outbound[]; failed: number }> {
    const now = parseIso(clock.now());
    const skip = new Set(announced);
    announced.clear();
    const due: Queued[] = [];
    for (const q of [...queue.values()]) {
      if (skip.has(q.expenseId)) {
        queue.delete(q.expenseId);
        continue;
      }
      if (held(q, now)) continue;
      queue.delete(q.expenseId);
      due.push(q);
    }
    const sent: Outbound[] = [];
    let failed = 0;
    const byGroup = new Map<GroupId, { q: Queued; expense: Expense }[]>();
    for (const q of due) {
      const expense = stores.group.expenses.get(q.expenseId);
      // Undone (or never really written) before it went out: nothing to announce.
      if (expense === undefined || expense.status !== 'logged') continue;
      const list = byGroup.get(q.groupId) ?? [];
      list.push({ q, expense });
      byGroup.set(q.groupId, list);
    }
    for (const [groupId, list] of byGroup) {
      const batches = batchByWindow(
        list.map((x) => ({ at: x.q.at, expense: x.expense })),
        windowMs,
      );
      for (const batch of batches) {
        const first = batch[0]!.expense;
        const ctx = sendContext(groupId, first);
        if (ctx === undefined) {
          failed++;
          continue;
        }
        try {
          const rctx: RenderContext = {
            groupId,
            members: ctx.members,
            timeZone: ctx.trip?.timeZone ?? 'UTC',
            now: clock.now(),
            ids,
          };
          const notice = renderExpenseNotice({ expenses: batch.map((b) => b.expense) }, rctx);
          const outcomes = await deps.sendTurn([notice], ctx);
          for (const o of outcomes) {
            if (o.sent !== null && !o.suppressed) sent.push(o.outbound);
            else failed++;
          }
        } catch {
          // A notice must never fail the operation that already committed and replied.
          failed++;
        }
      }
    }
    return { sent, failed };
  }

  function around<A extends unknown[], R extends TurnResult>(
    op: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      depth++;
      let result: R | undefined;
      let thrown = false;
      let error: unknown;
      try {
        result = await op(...args);
      } catch (e) {
        thrown = true;
        error = e;
      } finally {
        depth--;
      }
      // Overlapping operations: the last one to finish sends the notices for all of them.
      const notices = depth === 0 ? await flush() : { sent: [], failed: 0 };
      if (thrown) throw error;
      const r = result!;
      if (notices.sent.length === 0 && notices.failed === 0) return r;
      return {
        ...r,
        outbound: [...r.outbound, ...notices.sent],
        silent: r.silent && notices.sent.length === 0,
        note: notices.failed > 0 ? `${r.note} · notice_failed:${String(notices.failed)}` : r.note,
      };
    };
  }

  return {
    sendTurn,
    around,
    dispose: unsubscribe,
  };
}

/**
 * T-165: one short group notice for every expense that lands on the ledger,
 * from any source. The one hook is the repository: `ExpenseRepository.onCreate`
 * fires for every committed `create` (chat text, receipt photo, a promoted
 * email/card item, a booking), so an ingestion path written later cannot
 * forget to announce itself. Nothing here knows about ingestion paths.
 *
 * How it works (docs/DECISIONS.md D-041, VOICE §4.13):
 *  - `around(op)` wraps each public agent entry point (an "operation":
 *    `handleInbound`, `runScheduled`, the imports, `intakeDocument`) and runs
 *    it in its own `AsyncLocalStorage` context. An expense committed inside an
 *    operation is queued and its group marked as touched by that operation.
 *    Writes outside every operation (seeding, fixture loaders) are never
 *    announced.
 *  - Exactly one announcement per expense. `sendTurn` wraps the agent's single
 *    send path: a delivered GROUP-lane card that carries an expense (the
 *    "logged: …" `expense_confirm` card for chat text and receipt photos, a
 *    booking's `receipt` card) takes that expense off the queue. The group
 *    already saw it, and VOICE §2 forbids a second message that says the first
 *    one is done.
 *  - When an operation ends, every group it touched (and every group with
 *    queued items) is flushed, unless another running operation touched that
 *    group too: that one flushes it when it ends (per-group, so an operation
 *    in another chat never delays this one). Due expenses still on the ledger
 *    are batched by `NOTICE_BATCH_WINDOW_MS` and each batch is sent as ONE
 *    `system_notice` through the normal send path (screen, voice lint, lane,
 *    audit), after everything the operation sent.
 *  - Holds. A shared item whose "looks shared?" digest card still has other
 *    open lines waits for them (a digest answered tap by tap gives one line,
 *    sent after its last answer). A booking's tab entry waits for its receipt
 *    card (it can come a turn later, on the after-charge failure path). Each
 *    hold ends at the latest `windowMs` after the expense landed, through an
 *    `expense_notice` scheduled job (`runScheduled` → `release`), so a quiet
 *    chat still gets its line. The job carries the expense id, so it can
 *    announce an expense this process no longer has queued (the audit log
 *    says whether it was announced already).
 *  - Undo. An expense a notice announced that is then undone (repository
 *    `onUndo`) gets one correction line, "Crowley took Uber €23.40 off the
 *    tab". One undone before its notice went out is simply never announced.
 *
 * Privacy (SAFETY §2.3): the text is built from the GroupStore `Expense`
 * only. A card transaction or email receipt is in the PrivateStore until its
 * owner confirms it; `promote()` is the only way it becomes an `Expense`, so
 * nothing private can be announced before the owner's 👍, and what is
 * announced is the stripped, group-safe record (a raw card descriptor never
 * reaches it: `groupSafeChargeName`). The hold reads the owner's pending items
 * only to learn whether their digest is still open; nothing from them reaches
 * the notice.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
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
  ScheduledJob,
  Scheduler,
  Stores,
} from '@trav/core';
import { addMinutes, isReaction, parseIso } from '@trav/core';
import type { TurnResult, TurnSender, TurnSendContext } from '../loop.js';
import {
  NOTICE_BATCH_WINDOW_MS,
  batchByWindow,
  renderExpenseCorrection,
  renderExpenseNotice,
} from '../render/expenseNotice.js';
import type { RenderContext } from '../render/common.js';

export interface ExpenseNoticeDeps {
  readonly stores: Stores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The agent's single send path (unwrapped). */
  readonly sendTurn: TurnSender;
  /**
   * Where a hold's end is scheduled (`expense_notice` jobs). Without one (unit
   * tests), a hold past its window goes out at the end of the next operation.
   */
  readonly scheduler?: Scheduler;
  /** Default `NOTICE_BATCH_WINDOW_MS` (60s). */
  readonly windowMs?: number;
}

export interface ExpenseNotices {
  /** The send path to give the rest of the agent: a delivered group card takes its expenses off the queue. */
  readonly sendTurn: TurnSender;
  /** Wraps one public agent entry point; the notices it caused are appended to its `outbound`. */
  around<A extends unknown[], R extends TurnResult>(
    op: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R>;
  /**
   * An `expense_notice` job came due (call from inside `runScheduled`): its
   * expenses' holds end now; they go out when the operation ends.
   */
  release(job: ScheduledJob): void;
  /** Stop listening to the repository (tests; the runtime lives as long as its stores). */
  dispose(): void;
}

export const EXPENSE_NOTICE_JOB = 'expense_notice' as const;

export function noticeJobId(expenseId: ExpenseId): string {
  return `${EXPENSE_NOTICE_JOB}:${expenseId}`;
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
  /** A booking's tab entry: its receipt card is the announcement, if it is delivered in time. */
  readonly awaitReceipt?: true;
  scheduled: boolean;
}

interface Correction {
  readonly expenseId: ExpenseId;
  readonly groupId: GroupId;
  readonly at: IsoDateTime;
}

/** One running operation. */
interface OpContext {
  readonly touched: Set<GroupId>;
  /** Expenses whose hold a due `expense_notice` job ended. */
  readonly released: Set<ExpenseId>;
}

export function createExpenseNotices(deps: ExpenseNoticeDeps): ExpenseNotices {
  const { stores, clock, ids } = deps;
  const windowMs = deps.windowMs ?? NOTICE_BATCH_WINDOW_MS;
  const als = new AsyncLocalStorage<OpContext>();
  const running = new Set<OpContext>();
  const queue = new Map<ExpenseId, Queued>();
  const corrections = new Map<ExpenseId, Correction>();

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

  /** Did a delivered notice (not a correction) already announce this expense? From the audit log. */
  function announcedByNotice(groupId: GroupId, expenseId: ExpenseId): boolean {
    return stores.group.audit.listByGroup(groupId).some((e) => {
      if (e.type !== 'message.sent' || e.payload['systemNotice'] !== true) return false;
      if (e.payload['noticeCorrection'] === true) return false;
      const listed = e.payload['expenseIds'];
      return Array.isArray(listed) && listed.includes(expenseId);
    });
  }

  function enqueue(expense: Expense, at: IsoDateTime): void {
    const digest = digestOf(expense);
    queue.set(expense.expenseId, {
      expenseId: expense.expenseId,
      groupId: expense.groupId,
      at,
      ...(digest !== undefined ? { digest } : {}),
      ...(expense.sourceRef.kind === 'booking' ? { awaitReceipt: true as const } : {}),
      scheduled: false,
    });
  }

  const offCreate = stores.group.expenses.onCreate((expense) => {
    const op = als.getStore();
    if (op === undefined || queue.has(expense.expenseId)) return;
    op.touched.add(expense.groupId);
    enqueue(expense, clock.now());
  });

  const offUndo = stores.group.expenses.onUndo((expense) => {
    const op = als.getStore();
    if (op === undefined) return;
    const queued = queue.get(expense.expenseId);
    if (queued !== undefined) {
      // Never announced: nothing to take back.
      queue.delete(expense.expenseId);
      if (queued.scheduled) deps.scheduler?.cancel(noticeJobId(expense.expenseId));
      return;
    }
    if (!announcedByNotice(expense.groupId, expense.expenseId)) return;
    op.touched.add(expense.groupId);
    corrections.set(expense.expenseId, {
      expenseId: expense.expenseId,
      groupId: expense.groupId,
      at: clock.now(),
    });
  });

  function dequeue(id: ExpenseId): void {
    const q = queue.get(id);
    if (q === undefined) return;
    queue.delete(id);
    if (q.scheduled) deps.scheduler?.cancel(noticeJobId(id));
  }

  const sendTurn: TurnSender = async (outbounds, ctx) => {
    const outcomes = await deps.sendTurn(outbounds, ctx);
    for (const o of outcomes) {
      if (o.sent === null || o.suppressed || isReaction(o.outbound)) continue;
      if (o.outbound.to.kind !== 'group') continue;
      for (const id of announcedExpenseIds(o.outbound.card)) dequeue(id);
    }
    return outcomes;
  };

  /** Still waiting (a booking's receipt, the rest of a digest), and its window has not ended. */
  function held(q: Queued, op: OpContext, now: number): boolean {
    if (op.released.has(q.expenseId)) return false;
    // Without a scheduler there is no job to end the hold: the window does.
    if (deps.scheduler === undefined && now - parseIso(q.at) >= windowMs) return false;
    if (q.awaitReceipt === true) return true;
    const d = q.digest;
    if (d === undefined) return false;
    return stores.private
      .listPendingItems(d.owner, q.groupId, 'pending')
      .some((i) => i.id !== d.itemId && i.cardMessageId === d.cardMessageId);
  }

  function scheduleEnd(q: Queued): void {
    if (q.scheduled || deps.scheduler === undefined) return;
    const expense = stores.group.expenses.get(q.expenseId);
    deps.scheduler.schedule({
      jobId: noticeJobId(q.expenseId),
      groupId: q.groupId,
      tripId: expense?.tripId ?? null,
      kind: EXPENSE_NOTICE_JOB,
      runAt: addMinutes(q.at, windowMs / 60_000),
      payload: { expenseIds: q.expenseId },
    });
    q.scheduled = true;
  }

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

  type Batch = { readonly at: IsoDateTime; readonly expense: Expense };

  /** Sends one line per batch through the normal send path. Never throws. */
  async function sendBatches(
    groupId: GroupId,
    items: readonly Batch[],
    render: (expenses: readonly Expense[], rctx: RenderContext) => Outbound,
    out: { sent: Outbound[]; failed: number },
  ): Promise<void> {
    for (const batch of batchByWindow(items, windowMs)) {
      const ctx = sendContext(groupId, batch[0]!.expense);
      if (ctx === undefined) {
        out.failed++;
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
        const outcomes = await deps.sendTurn(
          [
            render(
              batch.map((b) => b.expense),
              rctx,
            ),
          ],
          ctx,
        );
        for (const o of outcomes) {
          if (o.sent !== null && !o.suppressed) out.sent.push(o.outbound);
          else out.failed++;
        }
      } catch {
        // A notice must never fail the operation that already committed and replied.
        out.failed++;
      }
    }
  }

  /** Flushes the groups this operation may flush; returns what was delivered. Never throws. */
  async function flush(op: OpContext): Promise<{ sent: Outbound[]; failed: number }> {
    const now = parseIso(clock.now());
    const busy = new Set<GroupId>();
    for (const other of running) for (const g of other.touched) busy.add(g);
    const groups = new Set<GroupId>(op.touched);
    for (const q of queue.values()) groups.add(q.groupId);
    for (const c of corrections.values()) groups.add(c.groupId);

    const out = { sent: [] as Outbound[], failed: 0 };
    for (const groupId of groups) {
      // Another running operation is still writing this group's tab: it flushes when it ends.
      if (busy.has(groupId)) continue;
      const due: Batch[] = [];
      for (const q of [...queue.values()]) {
        if (q.groupId !== groupId) continue;
        if (held(q, op, now)) {
          scheduleEnd(q);
          continue;
        }
        dequeue(q.expenseId);
        const expense = stores.group.expenses.get(q.expenseId);
        // Undone (or never really written) before it went out: nothing to announce.
        if (expense === undefined || expense.status !== 'logged') continue;
        due.push({ at: q.at, expense });
      }
      const undone: Batch[] = [];
      for (const c of [...corrections.values()]) {
        if (c.groupId !== groupId) continue;
        corrections.delete(c.expenseId);
        const expense = stores.group.expenses.get(c.expenseId);
        if (expense === undefined || expense.status !== 'undone') continue;
        undone.push({ at: c.at, expense });
      }
      await sendBatches(groupId, due, (e, r) => renderExpenseNotice({ expenses: e }, r), out);
      await sendBatches(groupId, undone, (e, r) => renderExpenseCorrection(e, r), out);
    }
    return out;
  }

  function release(job: ScheduledJob): void {
    const op = als.getStore();
    if (op === undefined) return;
    const raw = job.payload['expenseIds'];
    const list = typeof raw === 'string' ? raw.split(',').filter((s) => s !== '') : [];
    for (const id of list) {
      op.released.add(id);
      op.touched.add(job.groupId);
      if (queue.has(id)) continue;
      // Not queued here (another process, a restart): announce it once if it never was.
      const expense = stores.group.expenses.get(id);
      if (expense === undefined || expense.status !== 'logged') continue;
      if (expense.sourceRef.kind !== 'private_item') continue;
      if (announcedByNotice(expense.groupId, id)) continue;
      enqueue(expense, expense.createdAt);
    }
  }

  function around<A extends unknown[], R extends TurnResult>(
    op: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      const ctx: OpContext = { touched: new Set(), released: new Set() };
      running.add(ctx);
      let result: R | undefined;
      let thrown = false;
      let error: unknown;
      try {
        result = await als.run(ctx, () => op(...args));
      } catch (e) {
        thrown = true;
        error = e;
      } finally {
        running.delete(ctx);
      }
      const notices = await flush(ctx);
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
    release,
    dispose: () => {
      offCreate();
      offUndo();
    },
  };
}

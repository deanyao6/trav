/**
 * Expense from chat text, end to end (T-010; VOICE §4.4, §4.11).
 *
 * The loop hands this flow a member's own words in the group thread once the
 * message is addressed to Trav (quoted and forwarded lines are already gone:
 * `splitQuoted`, SAFETY §2.4). In order:
 *
 *  1. A pending question from Trav to this member (≤ 15 min old) is answered
 *     first: "84", "euros", "me maya and sam" fill the missing facts
 *     (`mergeAnswer`). Still incomplete ⇒ Trav waits silently (it never asks
 *     the same thing twice). "nvm" drops it with a 👍.
 *  2. `parseExpenseText` (deterministic) settles the message, or
 *  3. when it cannot (`unsure`), one zero-tool JSON extraction call
 *     (`expense_text_v1`, scripted in `fixtures/scripts/expenses.json` for
 *     offline mode) produces drafts that go through the same checks. If that
 *     is unsure too, the flow declines and the chat loop takes the message.
 *
 * Confirm vs auto-log (the rule implemented, VOICE §4.4): a statement whose
 * payer, amount, currency and who's-in are all clear is LOGGED IMMEDIATELY and
 * the posted card is the confirmation ("logged: €84 dinner on Dean, 5 ways (not
 * Henry) → €16.80 each / 👎 to undo or tell me what to change"). A 👍 on it is
 * a no-op; 👎, the Undo button or "undo" reverses it through the loop's undo
 * path for the rest of the trip. When any money fact is missing, Trav asks
 * exactly ONE question (VOICE §4.11) and writes nothing until it is answered.
 * Money facts are never assumed; the trip currency is the stated default for a
 * bare number (it is set at trip creation, VOICE §3.4).
 *
 * Ledger writes: one `Expense` per stated expense, `source: 'chat'`,
 * `occurredAt` = the time of the statement, `sourceRef = message:<id>` for a
 * single expense and `message:<id>#1`, `#2`… when one message states several
 * (`ExpenseRepository.create` rejects a duplicate `sourceRef`, which is also
 * what makes a replayed message a no-op: "already got that one"). Each write
 * appends `ledger.entry_created`. Several expenses post as ONE message whose
 * card carries every expense in `digestItems`; one 👎 undoes them all.
 */
import type {
  Clock,
  Expense,
  ExpenseConfirmCard,
  Group,
  IdGenerator,
  IsoDateTime,
  Member,
  MessageId,
  Outbound,
  OutboundMessage,
  Stores,
  Trip,
} from '@trav/core';
import { formatMoney, ledger, parseIso } from '@trav/core';
import { buildGroupContext, sanitizeInline } from '../context/groupContext.js';
import type { ModelClient, ResponseSource } from '../model/client.js';
import {
  EXPENSE_TEXT_PROMPT_ID,
  EXPENSE_TEXT_SCHEMA,
  expenseTextSystemPrompt,
} from '../prompts/expenseText.js';
import { renderExpenseLogged } from '../render/expenseConfirm.js';
import type { RenderContext } from '../render/common.js';
import {
  askedFacts,
  draftsFromModelJson,
  evaluateDrafts,
  mergeAnswer,
  parseExpenseText,
  type DraftsEvaluation,
  type ExpenseDraft,
  type ExpenseTextContext,
  type MissingFact,
  type ParsedExpense,
} from './expenseText.js';

/** How long Trav's one question stays answerable. */
export const EXPENSE_QUESTION_TTL_MS = 15 * 60 * 1000;
/** More than this many expenses in one message is not something to log blind. */
export const MAX_EXPENSES_PER_MESSAGE = 4;

const DROP_WORDS =
  /^\s*(?:nvm|never ?mind|forget it|scratch that|don'?t log (?:it|that)|leave it|cancel(?: that)?)\s*[.!]*\s*$/i;

export interface ChatExpenseDeps {
  readonly stores: Stores;
  readonly model: ModelClient;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface ChatExpenseInput {
  readonly group: Group;
  /** Every member of the group, in group order (renderers name people from this). */
  readonly members: readonly Member[];
  readonly trip: Trip;
  /** The sender, already identity-resolved from the channel (SAFETY §2.5). */
  readonly me: Member;
  readonly messageId: MessageId;
  /** The sender's own words, quoted/forwarded lines removed. */
  readonly text: string;
  /** When the statement was made (the inbound message's time). */
  readonly at: IsoDateTime;
}

export interface ChatExpenseOutcome {
  /** Zero (waiting for the rest of an answer) or one group message / reaction. */
  readonly drafts: readonly Outbound[];
  readonly note: string;
  readonly modelSources: readonly ResponseSource[];
}

export interface ChatExpenseFlow {
  /** `undefined` ⇒ not an expense this flow can settle; the chat loop takes it. */
  handle(input: ChatExpenseInput): Promise<ChatExpenseOutcome | undefined>;
  /** Drops any pending question (tests, group reset). */
  reset(): void;
}

interface PendingQuestion {
  readonly drafts: readonly ExpenseDraft[];
  readonly missing: readonly (readonly MissingFact[])[];
  /** Every fact a question has covered so far; none is ever asked again. */
  readonly asked: readonly MissingFact[];
  readonly askedAt: IsoDateTime;
  /** The statement's message id and time: the expense's `sourceRef` and `occurredAt`. */
  readonly messageId: MessageId;
  readonly at: IsoDateTime;
  readonly tripId: string;
}

export function createChatExpenseFlow(deps: ChatExpenseDeps): ChatExpenseFlow {
  const { stores, model, ids, clock } = deps;
  const pending = new Map<string, PendingQuestion>();
  const keyOf = (input: ChatExpenseInput): string => `${input.group.groupId}:${input.me.memberId}`;

  function parseContext(input: ChatExpenseInput): ExpenseTextContext {
    // Who's on the trip and tonight's rosters come from the group context, the
    // same object the chat prompt is built from (no private data in it).
    const gc = buildGroupContext(
      { group: stores.group, privateCounts: stores.private, clock },
      input.group.groupId,
      input.trip.tripId,
    );
    const active = gc.members.filter(
      (m) => m.active && m.leftAt === undefined && m.role !== 'guest',
    );
    return {
      senderMemberId: input.me.memberId,
      members: active.map((m) => ({ memberId: m.memberId, displayName: m.displayName })),
      tripCurrency: gc.trip?.currency ?? null,
      familyTab: gc.trip?.familyTab === true,
      rosters: gc.rosters.map((r) => {
        const a = gc.activities.find((x) => x.activityId === r.activityId);
        return {
          activityId: r.activityId,
          name: a?.name ?? '',
          ...(a?.venue !== undefined ? { venue: a.venue } : {}),
          ...(a?.startsAt !== undefined ? { startsAt: a.startsAt } : {}),
          inMemberIds: r.inMemberIds,
        };
      }),
      now: clock.now(),
    };
  }

  function reaction(input: ChatExpenseInput, emoji: '👍'): Outbound {
    return {
      id: ids.next('msg'),
      groupId: input.group.groupId,
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: input.messageId,
      emoji,
    };
  }

  function question(input: ChatExpenseInput, text: string): OutboundMessage {
    return { id: ids.next('msg'), groupId: input.group.groupId, to: { kind: 'group' }, text };
  }

  /** Writes the expenses (idempotent per sub-id) and renders the one confirmation message. */
  function log(
    input: ChatExpenseInput,
    ctx: ExpenseTextContext,
    expenses: readonly ParsedExpense[],
    source: { readonly messageId: MessageId; readonly at: IsoDateTime },
  ): { readonly drafts: readonly Outbound[]; readonly note: string } {
    const now = clock.now();
    const order = ctx.members.map((m) => m.memberId);
    const splitContext: ledger.SplitContext = { memberOrder: order, participantsUniverse: order };
    const rctx: RenderContext = {
      groupId: input.group.groupId,
      members: input.members,
      timeZone: input.trip.timeZone,
      now,
      ids,
    };
    const repo = stores.group.expenses;
    const subId = (i: number): string =>
      expenses.length === 1 ? source.messageId : `${source.messageId}#${String(i + 1)}`;

    const logged: Expense[] = [];
    const already: Expense[] = [];
    expenses.forEach((p, i) => {
      const sourceRef = { kind: 'message' as const, id: subId(i) };
      const prior = repo.getBySourceRef(sourceRef);
      if (prior !== undefined) {
        already.push(prior);
        return;
      }
      const expense: Expense = {
        expenseId: ids.next('exp'),
        groupId: input.group.groupId,
        tripId: input.trip.tripId,
        description: p.description,
        category: p.category,
        amount: p.amount,
        paidBy: [{ memberId: p.payer, amount: p.amount }],
        split: p.split,
        source: 'chat',
        sourceRef,
        occurredAt: source.at,
        createdAt: now,
        createdBy: input.me.memberId,
        status: 'logged',
      };
      const shares = ledger.computeShares(expense, splitContext);
      repo.create(expense, ledger.buildLedgerEntries(expense, splitContext));
      stores.group.audit.append({
        groupId: input.group.groupId,
        tripId: input.trip.tripId,
        type: 'ledger.entry_created',
        actor: { kind: 'member', id: input.me.memberId },
        visibility: 'group',
        payload: {
          expenseId: expense.expenseId,
          splitMethod: expense.split.method,
          participants: shares.filter((s) => s.amount.amountMinor !== 0).map((s) => s.memberId),
          amounts: shares.map((s) => ({ memberId: s.memberId, amountMinor: s.amount.amountMinor })),
          sourceMessageId: source.messageId,
          sourceRef: sourceRef.id,
        },
      });
      logged.push(expense);
    });

    if (logged.length === 0) {
      const first = already[0]!;
      return {
        drafts: [
          question(
            input,
            `already got that one: ${formatMoney(first.amount)} ${sanitizeInline(first.description, 40).toLowerCase()}`,
          ),
        ],
        note: 'expense:already_logged',
      };
    }
    const rendered = logged.map((expense) => renderExpenseLogged({ expense, splitContext }, rctx));
    if (rendered.length === 1) return { drafts: [rendered[0]!], note: 'expense:logged' };

    // Several from one message: one post (VOICE §2 batching), one 👎 for all of them.
    const lines = rendered.map((m) => m.text.split('\n')[0]!);
    lines.push(`👎 to undo ${rendered.length === 2 ? 'both' : `all ${String(rendered.length)}`}`);
    const text = lines.join('\n');
    const head = rendered[0]!;
    const card: ExpenseConfirmCard = {
      ...head.card,
      cardId: ids.next('card'),
      title: `${String(rendered.length)} expenses`,
      fallbackText: text,
      digestItems: rendered.map((m) => m.card),
    };
    return {
      drafts: [
        { ...head, text, card, ...(head.actions !== undefined ? { actions: head.actions } : {}) },
      ],
      note: `expense:logged:${String(rendered.length)}`,
    };
  }

  async function extract(
    input: ChatExpenseInput,
    ctx: ExpenseTextContext,
    sources: ResponseSource[],
  ): Promise<ExpenseDraft[] | undefined> {
    const res = await model.complete({
      model: 'main',
      systemPromptId: EXPENSE_TEXT_PROMPT_ID,
      system: expenseTextSystemPrompt({
        memberNames: ctx.members.map((m) => sanitizeInline(m.displayName, 40)),
        senderName: sanitizeInline(input.me.displayName, 40),
        tripCurrency: ctx.tripCurrency,
      }),
      messages: [
        {
          role: 'user',
          content: `${sanitizeInline(input.me.displayName, 40)}: ${sanitizeInline(input.text, 600)}`,
        },
      ],
      tools: [],
      jsonSchema: EXPENSE_TEXT_SCHEMA,
      maxTokens: 600,
    });
    sources.push(res.source);
    if (res.source === 'fallback') return undefined;
    return draftsFromModelJson(res.json, ctx);
  }

  function act(
    input: ChatExpenseInput,
    ctx: ExpenseTextContext,
    drafts: readonly ExpenseDraft[],
    ev: DraftsEvaluation,
    source: { readonly messageId: MessageId; readonly at: IsoDateTime },
    sources: readonly ResponseSource[],
    via: string,
    prevAsked: readonly MissingFact[] = [],
  ): ChatExpenseOutcome | undefined {
    if (ev.kind === 'unsure') return undefined;
    if (ev.kind === 'ready') {
      if (ev.expenses.length > MAX_EXPENSES_PER_MESSAGE) return undefined;
      pending.delete(keyOf(input));
      const out = log(input, ctx, ev.expenses, source);
      return { drafts: out.drafts, note: `${out.note}${via}`, modelSources: sources };
    }
    pending.set(keyOf(input), {
      drafts,
      missing: ev.missing,
      asked: [...new Set([...prevAsked, ...askedFacts(ev.missing)])],
      askedAt: clock.now(),
      messageId: source.messageId,
      at: source.at,
      tripId: input.trip.tripId,
    });
    return {
      drafts: [question(input, ev.question)],
      note: `expense:clarify:${[...new Set(ev.missing.flat())].sort().join('+')}${via}`,
      modelSources: sources,
    };
  }

  async function handle(input: ChatExpenseInput): Promise<ChatExpenseOutcome | undefined> {
    const ctx = parseContext(input);
    if (ctx.members.length === 0 || !ctx.members.some((m) => m.memberId === input.me.memberId)) {
      return undefined;
    }
    const key = keyOf(input);
    const sources: ResponseSource[] = [];

    // 1. the answer to Trav's one question
    const open = pending.get(key);
    if (open !== undefined) {
      const fresh =
        open.tripId === input.trip.tripId &&
        parseIso(clock.now()) - parseIso(open.askedAt) <= EXPENSE_QUESTION_TTL_MS;
      if (!fresh) pending.delete(key);
      else if (DROP_WORDS.test(input.text.replace(/@trav\b/gi, ''))) {
        pending.delete(key);
        return { drafts: [reaction(input, '👍')], note: 'expense:dropped', modelSources: [] };
      } else {
        // Only what the question asked about can be answered.
        const askedNow = open.missing.map((m) => m.filter((f) => open.asked.includes(f)));
        const merged = mergeAnswer(open.drafts, askedNow, input.text, ctx);
        if (merged !== undefined) {
          const ev = evaluateDrafts(merged, ctx);
          if (ev.kind === 'clarify' && ev.missing.flat().some((f) => open.asked.includes(f))) {
            // Still missing something already asked about: wait, never ask twice.
            pending.set(key, { ...open, drafts: merged, missing: ev.missing });
            return { drafts: [], note: 'expense:waiting', modelSources: [] };
          }
          if (ev.kind === 'unsure') {
            pending.delete(key);
            return undefined;
          }
          // ready, or a fact not asked yet (who's in, once the payer is known)
          return act(input, ctx, merged, ev, open, sources, ':answer', open.asked);
        }
      }
    }

    // 2. the parser
    const source = { messageId: input.messageId, at: input.at };
    const parsed = parseExpenseText(input.text, ctx);
    if (parsed.kind === 'none') return undefined;
    if (parsed.kind === 'no_log') {
      return { drafts: [reaction(input, '👍')], note: 'expense:no_log', modelSources: [] };
    }
    if (parsed.kind === 'drafts') {
      const ev = evaluateDrafts(parsed.drafts, ctx);
      if (ev.kind !== 'unsure') return act(input, ctx, parsed.drafts, ev, source, sources, '');
    }

    // 3. the extraction call, for what the parser could not settle
    const drafts = await extract(input, ctx, sources);
    if (drafts === undefined) return undefined;
    return act(input, ctx, drafts, evaluateDrafts(drafts, ctx), source, sources, ':model');
  }

  return {
    handle,
    reset: () => {
      pending.clear();
    },
  };
}

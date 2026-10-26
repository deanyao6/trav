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
 *     the same thing twice). "nvm" drops it with a 👍. The question stays
 *     answerable past the loop's 2-minute reply window: the loop hands an
 *     unaddressed short reply here with `answerOnly` while `awaiting()` is
 *     true. One open question per member: a statement logged on its own
 *     leaves it open, and a statement that needs a second question is
 *     acknowledged with a 👍 and queued; its question rides as the last line
 *     of the post that settles the first (or replaces the 👍 on "nvm").
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
 * a no-op; 👎, the Undo button or "undo" from the payer or whoever logged it
 * reverses it through the loop's undo path for the rest of the trip. When any money fact is missing, Trav asks
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
import { formatMoney, isReaction, ledger, parseIso } from '@trav/core';
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
/** An unaddressed reply to an open question is taken only when it is this short ("84", "me maya and sam"). */
export const ANSWER_ONLY_MAX_WORDS = 8;
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
  /**
   * `undefined` ⇒ not an expense this flow can settle; the chat loop takes it.
   * `answerOnly`: the message was not addressed to Trav; only a short reply to
   * this member's open question is taken (r1 #7), nothing is parsed fresh.
   */
  handle(
    input: ChatExpenseInput,
    opts?: { readonly answerOnly?: boolean },
  ): Promise<ChatExpenseOutcome | undefined>;
  /** True while Trav's question to this member is open (≤ `EXPENSE_QUESTION_TTL_MS`). */
  awaiting(groupId: string, memberId: string): boolean;
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
  /** Statements that need a question while another is open (r1 #8), oldest first. */
  const queued = new Map<
    string,
    (Omit<PendingQuestion, 'asked' | 'askedAt'> & { readonly question: string })[]
  >();
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

  /** The next queued statement becomes the open question; its question text, if any. */
  function promoteQueued(key: string): string | undefined {
    const q = queued.get(key)?.shift();
    if (q === undefined) return undefined;
    pending.set(key, {
      drafts: q.drafts,
      missing: q.missing,
      asked: askedFacts(q.missing),
      askedAt: clock.now(),
      messageId: q.messageId,
      at: q.at,
      tripId: q.tripId,
    });
    return q.question;
  }

  /** Appends the next question as the last line of a logged message (one post per turn, VOICE §2). */
  function withQuestion(drafts: readonly Outbound[], q: string): readonly Outbound[] {
    const [first, ...rest] = drafts;
    if (first === undefined || isReaction(first)) return drafts;
    const text = `${first.text}\n${q}`;
    const card = first.card === undefined ? undefined : { ...first.card, fallbackText: text };
    return [{ ...first, text, ...(card !== undefined ? { card } : {}) }, ...rest];
  }

  function isOpen(key: string, tripId: string): boolean {
    const open = pending.get(key);
    return (
      open !== undefined &&
      open.tripId === tripId &&
      parseIso(clock.now()) - parseIso(open.askedAt) <= EXPENSE_QUESTION_TTL_MS
    );
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
    fromAnswer = false,
  ): ChatExpenseOutcome | undefined {
    if (ev.kind === 'unsure') return undefined;
    const key = keyOf(input);
    if (ev.kind === 'ready') {
      if (ev.expenses.length > MAX_EXPENSES_PER_MESSAGE) return undefined;
      const out = log(input, ctx, ev.expenses, source);
      // Only the answered question closes (r1 #8); a statement logged on its
      // own leaves an open question alone.
      if (fromAnswer) {
        pending.delete(key);
        const next = promoteQueued(key);
        if (next !== undefined) {
          return {
            drafts: withQuestion(out.drafts, next),
            note: `${out.note}${via}:next_question`,
            modelSources: sources,
          };
        }
      }
      return { drafts: out.drafts, note: `${out.note}${via}`, modelSources: sources };
    }
    const entry = {
      drafts,
      missing: ev.missing,
      messageId: source.messageId,
      at: source.at,
      tripId: input.trip.tripId,
    };
    // A second question while one is open waits its turn (r1 #8): one open
    // question per member, the new statement is acknowledged with a 👍 and
    // asked about once the first is settled.
    if (!fromAnswer && isOpen(key, input.trip.tripId)) {
      const list = queued.get(key) ?? [];
      list.push({ ...entry, question: ev.question });
      queued.set(key, list);
      return { drafts: [reaction(input, '👍')], note: 'expense:queued', modelSources: sources };
    }
    pending.set(key, {
      ...entry,
      asked: [...new Set([...prevAsked, ...askedFacts(ev.missing)])],
      askedAt: clock.now(),
    });
    return {
      drafts: [question(input, ev.question)],
      note: `expense:clarify:${[...new Set(ev.missing.flat())].sort().join('+')}${via}`,
      modelSources: sources,
    };
  }

  async function handle(
    input: ChatExpenseInput,
    opts: { readonly answerOnly?: boolean } = {},
  ): Promise<ChatExpenseOutcome | undefined> {
    const ctx = parseContext(input);
    if (ctx.members.length === 0 || !ctx.members.some((m) => m.memberId === input.me.memberId)) {
      return undefined;
    }
    const key = keyOf(input);
    const sources: ResponseSource[] = [];
    if (opts.answerOnly === true) {
      // unaddressed (after the 2-minute window): only a short reply to the open question
      if (!isOpen(key, input.trip.tripId)) return undefined;
      if (input.text.trim().split(/\s+/).length > ANSWER_ONLY_MAX_WORDS) return undefined;
    }

    // 1. the answer to Trav's one question
    const open = pending.get(key);
    if (open !== undefined) {
      const fresh = isOpen(key, input.trip.tripId);
      if (!fresh) {
        pending.delete(key);
        queued.delete(key);
      } else if (DROP_WORDS.test(input.text.replace(/@trav\b/gi, ''))) {
        pending.delete(key);
        const next = promoteQueued(key);
        return {
          drafts: [next !== undefined ? question(input, next) : reaction(input, '👍')],
          note: next !== undefined ? 'expense:dropped:next_question' : 'expense:dropped',
          modelSources: [],
        };
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
            const next = promoteQueued(key);
            return next === undefined
              ? undefined
              : {
                  drafts: [question(input, next)],
                  note: 'expense:next_question',
                  modelSources: [],
                };
          }
          // ready, or a fact not asked yet (who's in, once the payer is known)
          return act(input, ctx, merged, ev, open, sources, ':answer', open.asked, true);
        }
      }
    }
    if (opts.answerOnly === true) return undefined;

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
    awaiting: (groupId, memberId) => {
      const key = `${groupId}:${memberId}`;
      const open = pending.get(key);
      return open !== undefined && isOpen(key, open.tripId);
    },
    reset: () => {
      pending.clear();
      queued.clear();
    },
  };
}

/**
 * Offline responders for the chat asks the scripts don't cover (T-081,
 * T-092). Deterministic, keyed on what was asked, never on who asked, and
 * they only ever reach money through the tools the request offered:
 *
 *  - ticket asks ⇒ `propose_booking` (a proposal and a card; the purchase is
 *    still `ApprovalPolicy` + a 👍 away, SAFETY §2.1). Never a purchase.
 *  - "anything cheaper" ⇒ `get_pending_proposals` ⇒ `search_events` ⇒ one
 *    line from those results (real prices only).
 *  - "cancel the vip thing" ⇒ `get_pending_proposals` ⇒ `cancel_proposal`.
 *  - a place to stay ⇒ `search_lodging` (round 2 is a script when one
 *    matches, else a line from the results; stays aren't bookable yet).
 *  - "remember …" ⇒ `remember` (never health details).
 *  - asks Trav can't do yet (restaurants, tables, a numbered option, a
 *    personal cap) ⇒ one honest line that says so (VOICE §1 "honest about
 *    what it can't do"), with no made-up numbers.
 *
 * Multi-round flows find their own earlier calls by tool-use id prefix, so a
 * tool result from anything else is never theirs to answer. Each returns
 * `undefined` to pass.
 */
import { formatMoney, money } from '@trav/core';
import type { CurrencyCode } from '@trav/core';
import { loadAllTicketInventories } from '@trav/adapters';
import type {
  CompletionRequest,
  CompletionResponse,
  FallbackResponder,
  ModelMessage,
  ToolCall,
} from '../client.js';
import {
  foldText,
  parseBookingRequest,
  splitSender,
  venueIndexFrom,
  type VenueIndex,
} from '../../booking/request.js';
import { deriveScriptKey } from './scripts.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

// ---------- the honest lines (VOICE §1, §4.10, §4.12) ----------

export const OPTION_NUMBER_TEXT =
  "i can't book a numbered option from the chat yet, so nothing's booked. grab it on the site and tell me what it cost, i'll put it on the tab";
export const RESTAURANT_TEXT =
  "i can't look up restaurants yet, so no pick from me. after you eat, tell me what it cost and who was in and i'll split it";
export const TABLE_TEXT =
  "i can't book tables yet, so reserve it with the place. after, tell me the bill and who was in";
export const SHARE_CAP_TEXT =
  "i can't hold a personal cap yet. anything over the group's per-person cap already needs your own 👍 before i book it";
export const ONE_TOO_TEXT =
  'which one? @ me with the name and "for me", and i\'ll price a ticket just for you';
export const EXPENSE_RESTATE_TEXT =
  "nothing's logged yet, i need the total. say it in one line: what it was, how much, and who was in";
export const HEALTH_MEMORY_TEXT = "i'll leave that one out, i don't keep notes on health stuff";
export const NOTHING_PENDING_TEXT =
  "nothing's waiting on a 👍 right now, so there's nothing to drop";
export const NOTHING_PENDING_CHEAPER_TEXT =
  "nothing's waiting on a 👍 right now. tell me what you want and i'll find the cheapest";
export const CANCEL_NOT_ALLOWED_TEXT =
  'only whoever asked for it, or a trip lead, can drop that one. a 👎 on the card from someone going works too';
export const CANCEL_GONE_TEXT = "that one's not waiting anymore, so there's nothing to drop";

// ---------- request plumbing ----------

function response(req: CompletionRequest, text: string, toolCalls: ToolCall[]): CompletionResponse {
  return {
    text,
    toolCalls,
    usage: ZERO_USAGE,
    source: 'fallback',
    scriptKey: deriveScriptKey(req),
  };
}

function offered(req: CompletionRequest, name: string): boolean {
  return req.tools.some((t) => t.name === name);
}

/** A chat-loop turn (tools offered, no JSON extraction): the only requests these answer. */
function chatTurn(req: CompletionRequest): boolean {
  return req.jsonSchema === undefined && req.tools.length > 0;
}

function lastMessage(req: CompletionRequest): ModelMessage | undefined {
  return req.messages[req.messages.length - 1];
}

function isToolResults(msg: ModelMessage | undefined): boolean {
  return (
    msg !== undefined &&
    msg.role === 'user' &&
    typeof msg.content !== 'string' &&
    msg.content.length > 0 &&
    msg.content.every((b) => b.type === 'tool_result')
  );
}

/** The member's own words (first user message), split into sender and text. */
function theAsk(
  req: CompletionRequest,
): { readonly sender?: string; readonly text: string } | undefined {
  const first = req.messages[0];
  if (first?.role !== 'user' || typeof first.content !== 'string') return undefined;
  return splitSender(first.content);
}

/** A fresh ask (one plain user message, no tool rounds yet). */
function freshAsk(
  req: CompletionRequest,
): { readonly sender?: string; readonly text: string } | undefined {
  if (!chatTurn(req) || req.messages.length !== 1) return undefined;
  return theAsk(req);
}

/** Every tool call this flow made so far, with its parsed result, oldest first. */
function rounds(
  req: CompletionRequest,
  prefix: string,
): { readonly id: string; readonly name: string; readonly result: unknown }[] {
  const results = new Map<string, string>();
  for (const m of req.messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'tool_result') results.set(b.toolUseId, b.content);
  }
  const out: { id: string; name: string; result: unknown }[] = [];
  for (const m of req.messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_use' || !b.id.startsWith(prefix)) continue;
      const raw = results.get(b.id);
      let result: unknown;
      try {
        result = raw === undefined ? undefined : JSON.parse(raw);
      } catch {
        result = undefined;
      }
      out.push({ id: b.id, name: b.name, result });
    }
  }
  return out;
}

/** The tool-result turn that answers this flow's latest call, or undefined. */
function myLatestRound(
  req: CompletionRequest,
  prefix: string,
):
  | { readonly name: string; readonly result: unknown; readonly all: ReturnType<typeof rounds> }
  | undefined {
  if (!chatTurn(req) || !isToolResults(lastMessage(req))) return undefined;
  const all = rounds(req, prefix);
  const latest = all.at(-1);
  if (latest === undefined) return undefined;
  const last = lastMessage(req)!;
  const answered =
    typeof last.content !== 'string' &&
    last.content.some((b) => b.type === 'tool_result' && b.toolUseId === latest.id);
  return answered ? { name: latest.name, result: latest.result, all } : undefined;
}

function call(
  req: CompletionRequest,
  prefix: string,
  step: number,
  name: string,
  input: unknown,
): ToolCall {
  return { id: `${prefix}${step}_${deriveScriptKey(req).slice(0, 12)}`, name, input };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fmt(amountMinor: number, currency: string): string {
  return formatMoney(money(amountMinor, currency as CurrencyCode));
}

/** "Razzmatazz: Saturday club night" ⇒ "razzmatazz". */
function shortName(name: string): string {
  return (name.split(/[:·|]/)[0] ?? name).trim().toLowerCase();
}

// ---------- ticket asks (T-081) ----------

let cachedIndex: VenueIndex | undefined;
/** Venue names and aliases from every bundled ticket inventory (the service searches the trip's own city). */
export function bundledVenueIndex(): VenueIndex {
  cachedIndex ??= venueIndexFrom(loadAllTicketInventories());
  return cachedIndex;
}

/**
 * "<get/grab/book> <venue or alias> tickets for <N / the N of us / all N>
 * [, <name>'s out]" and its looser shapes (`booking/request.ts`) ⇒ one
 * `propose_booking`. The proposal service resolves the night, the tier, who
 * is in and the price; `ApprovalPolicy` decides who must 👍.
 */
export function createBookingRequestResponder(
  index: () => VenueIndex = bundledVenueIndex,
): FallbackResponder {
  return {
    id: 'booking_request_v1',
    complete(req) {
      if (!offered(req, 'propose_booking')) return undefined;
      const ask = freshAsk(req);
      if (ask === undefined) return undefined;
      const r = parseBookingRequest(ask.text, index(), ask.sender);
      if (r === undefined) return undefined;
      const input = {
        kind: r.kind,
        query: r.query,
        ...(r.quantity !== undefined ? { quantity: r.quantity } : {}),
        ...(r.excludedNames.length > 0 ? { excludedNames: r.excludedNames } : {}),
        ...(r.attendeeNames !== undefined ? { attendeeNames: r.attendeeNames } : {}),
        ...(r.day !== undefined ? { day: r.day } : {}),
        ...(r.tier !== undefined ? { tier: r.tier } : {}),
        // No `requestText`: the member's words can carry a reason ("Henry's
        // sick") and the tool input must not (SAFETY privacy, T-081).
      };
      return response(req, '', [call(req, 'toolu_offline_book_', 1, 'propose_booking', input)]);
    },
  };
}

// ---------- "anything cheaper" ----------

const CHEAPER_RE =
  /^(?:(?:ok|so|hmm|wait|yo)\s+)?(?:is there\s+)?(?:anything|something|any|options?|got anything)\s+cheaper\b|\bcheaper (?:ones?|seats?|tickets?|options?)\b|^cheaper\b/;

interface PendingSummary {
  readonly proposalId: string;
  readonly description: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly total: string;
  readonly attendees: readonly unknown[];
  readonly eventDate?: string;
}

function pendingFrom(result: unknown): PendingSummary[] | undefined {
  if (!isRecord(result) || !Array.isArray(result['proposals'])) return undefined;
  return (result['proposals'] as unknown[]).filter(
    (p): p is PendingSummary =>
      isRecord(p) &&
      typeof p['proposalId'] === 'string' &&
      typeof p['description'] === 'string' &&
      typeof p['totalMinor'] === 'number' &&
      typeof p['currency'] === 'string' &&
      Array.isArray(p['attendees']),
  );
}

function whichOneText(list: readonly PendingSummary[], verb: string): string {
  const shown = list
    .slice(0, 2)
    .map((p, i) => `${i + 1}. ${shortName(p.description)} · ${p.total}`);
  return ['which one?', ...shown, `say the name and i'll ${verb}`].join('\n');
}

export const cheaperResponder: FallbackResponder = {
  id: 'cheaper_v1',
  complete(req) {
    const prefix = 'toolu_offline_cheaper_';
    const ask = freshAsk(req);
    if (ask !== undefined) {
      if (
        !CHEAPER_RE.test(
          foldText(ask.text)
            .replace(/[?!.]+$/, '')
            .trim(),
        )
      )
        return undefined;
      if (!offered(req, 'get_pending_proposals') || !offered(req, 'search_events'))
        return undefined;
      return response(req, '', [call(req, prefix, 1, 'get_pending_proposals', {})]);
    }
    const round = myLatestRound(req, prefix);
    if (round === undefined) return undefined;
    if (round.name === 'get_pending_proposals') {
      const pending = pendingFrom(round.result) ?? [];
      if (pending.length === 0) return response(req, NOTHING_PENDING_CHEAPER_TEXT, []);
      if (pending.length > 1) return response(req, whichOneText(pending, 'look'), []);
      const p = pending[0]!;
      const input = {
        query: shortName(p.description),
        quantity: Math.max(1, p.attendees.length),
        ...(p.eventDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(p.eventDate)
          ? { date: p.eventDate }
          : {}),
      };
      return response(req, '', [call(req, prefix, 2, 'search_events', input)]);
    }
    if (round.name === 'search_events') {
      const first = round.all.find((x) => x.name === 'get_pending_proposals');
      const p = pendingFrom(first?.result)?.[0];
      if (p === undefined || !isRecord(round.result) || !Array.isArray(round.result['events'])) {
        return response(req, NOTHING_PENDING_CHEAPER_TEXT, []);
      }
      const n = Math.max(1, p.attendees.length);
      const each = Math.round(p.totalMinor / n);
      const held = `the ${fmt(each, p.currency)} ones above are still held. 👍 there to keep them`;
      const events = (round.result['events'] as unknown[]).filter(isRecord).flatMap((e) => {
        const from = e['from'];
        if (e['bookable'] !== true || !isRecord(from)) return [];
        if (typeof from['amountMinor'] !== 'number' || from['currency'] !== p.currency) return [];
        if (typeof e['name'] !== 'string') return [];
        return [
          {
            name: e['name'],
            amountMinor: from['amountMinor'],
            tier: typeof e['fromTier'] === 'string' ? e['fromTier'] : undefined,
            refundable: e['fromRefundable'] === true,
          },
        ];
      });
      const cheaper = events
        .filter((e) => e.amountMinor < each)
        .sort((a, b) => a.amountMinor - b.amountMinor);
      const same = cheaper.find((e) => e.name === p.description);
      const what = shortName(p.description);
      const refund = (r: boolean): string => (r ? 'refundable' : 'non-refundable');
      if (same !== undefined) {
        const tier = same.tier === undefined ? '' : `, ${same.tier}`;
        return response(
          req,
          `cheapest i can book for ${what} is ${fmt(same.amountMinor, p.currency)} each${tier}, ${refund(same.refundable)}\n${held}`,
          [],
        );
      }
      const other = cheaper[0];
      if (other !== undefined) {
        return response(
          req,
          `nothing cheaper for ${what}. ${shortName(other.name)} is ${fmt(other.amountMinor, p.currency)} each that night, ${refund(other.refundable)}\n${held}`,
          [],
        );
      }
      return response(req, `that's already the cheapest i can book for ${what}\n${held}`, []);
    }
    return undefined;
  },
};

// ---------- "cancel the vip thing" ----------

const CANCEL_ASK = /^(?:(?:ok|actually|yeah|nah|pls|please)\s+)*(?:cancel|drop|scrap|kill)\b/;

export const cancelResponder: FallbackResponder = {
  id: 'cancel_proposal_v1',
  complete(req) {
    const prefix = 'toolu_offline_cancel_';
    const ask = freshAsk(req);
    if (ask !== undefined) {
      if (!CANCEL_ASK.test(foldText(ask.text))) return undefined;
      if (!offered(req, 'get_pending_proposals') || !offered(req, 'cancel_proposal'))
        return undefined;
      return response(req, '', [call(req, prefix, 1, 'get_pending_proposals', {})]);
    }
    const round = myLatestRound(req, prefix);
    if (round === undefined) return undefined;
    if (round.name === 'get_pending_proposals') {
      const pending = pendingFrom(round.result) ?? [];
      if (pending.length === 0) return response(req, NOTHING_PENDING_TEXT, []);
      let pick = pending.length === 1 ? pending[0] : undefined;
      if (pick === undefined) {
        const words = foldText(theAsk(req)?.text ?? '')
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length >= 4);
        const hits = pending.filter((p) => words.some((w) => foldText(p.description).includes(w)));
        pick = hits.length === 1 ? hits[0] : undefined;
      }
      if (pick === undefined) return response(req, whichOneText(pending, 'drop it'), []);
      return response(req, '', [
        call(req, prefix, 2, 'cancel_proposal', { proposalId: pick.proposalId }),
      ]);
    }
    if (round.name === 'cancel_proposal') {
      // A success is terminal in the loop and never reaches here; this is the error path.
      const code = isRecord(round.result) ? round.result['error'] : undefined;
      return response(
        req,
        code === 'not_authorized' ? CANCEL_NOT_ALLOWED_TEXT : CANCEL_GONE_TEXT,
        [],
      );
    }
    return undefined;
  },
};

// ---------- a place to stay ----------

const STAY_RE =
  /\b(?:airbnb|apartment|apt|flat|villa|house|hotel|hostel|place to stay|somewhere to stay|a place|a stay)\b/;
const FIND_RE = /\b(?:find|get|book|need|look(?:ing)? for|search|grab)\b/;
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function count(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = /^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s];
  return n !== undefined && n >= 1 && n <= 30 ? n : undefined;
}

/** "find a 6 person airbnb … under €1500 total" ⇒ search_lodging input, or undefined. */
export function parseStayAsk(text: string): Record<string, unknown> | undefined {
  const t = foldText(text);
  if (!STAY_RE.test(t) || !FIND_RE.test(t)) return undefined;
  if (/\b(?:paid|bought|spent|covered|log)\b/.test(t)) return undefined;
  const N = String.raw`(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)`;
  const adults =
    count(new RegExp(String.raw`\b${N}[ -](?:person|people|bed|guests?)\b`).exec(t)?.[1]) ??
    count(new RegExp(String.raw`\bsleeps\s+${N}\b`).exec(t)?.[1]) ??
    count(new RegExp(String.raw`\bfor\s+(?:the\s+)?${N}\b(?!\s*nights?)`).exec(t)?.[1]) ??
    count(new RegExp(String.raw`\b${N}\s+of\s+us\b`).exec(t)?.[1]);
  const budget =
    /\b(?:under|below|max|less than|up to)\s*[€$£]?\s?(\d{2,6})(?:[.,]\d{2})?\b(?!\s*(?:a|per|\/)\s*night)/.exec(
      t,
    );
  return {
    ...(adults !== undefined ? { adults } : {}),
    wholeUnit: true,
    ...(budget !== null ? { maxTotalMinor: Number(budget[1]) * 100 } : {}),
  };
}

interface Stay {
  readonly name: string;
  readonly area: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly refundable: boolean;
  readonly refundableUntil: string | null;
}

export const lodgingResponder: FallbackResponder = {
  id: 'lodging_search_v1',
  complete(req) {
    const prefix = 'toolu_offline_stay_';
    const ask = freshAsk(req);
    if (ask !== undefined) {
      if (!offered(req, 'search_lodging')) return undefined;
      const input = parseStayAsk(ask.text);
      if (input === undefined) return undefined;
      return response(req, '', [call(req, prefix, 1, 'search_lodging', input)]);
    }
    const round = myLatestRound(req, prefix);
    if (round?.name !== 'search_lodging') return undefined;
    const raw =
      isRecord(round.result) && Array.isArray(round.result['stays']) ? round.result['stays'] : [];
    const stays = (raw as unknown[]).filter(
      (s): s is Stay =>
        isRecord(s) &&
        typeof s['name'] === 'string' &&
        typeof s['totalMinor'] === 'number' &&
        typeof s['currency'] === 'string' &&
        typeof s['refundable'] === 'boolean',
    );
    const tail =
      "nothing's booked. stays aren't bookable from the chat yet, book it on the site and tell me the total";
    const best = stays[0];
    if (best === undefined) {
      return response(
        req,
        "nothing fits that for the trip dates. raise the budget or try another area, nothing's booked",
        [],
      );
    }
    const refund = best.refundable
      ? best.refundableUntil === null
        ? 'refundable'
        : `free cancel until ${best.refundableUntil.slice(0, 10)}`
      : 'non-refundable';
    const lines = [
      `best fit: ${best.name}`,
      `${fmt(best.totalMinor, best.currency)} for the trip · ${refund}`,
    ];
    const cheaperLocked = stays.find((s) => !s.refundable && s.totalMinor < best.totalMinor);
    if (best.refundable && cheaperLocked !== undefined) {
      lines.push(
        `there's a ${fmt(cheaperLocked.totalMinor, cheaperLocked.currency)} one but it's non-refundable`,
      );
    }
    lines.push(tail);
    return response(req, lines.join('\n'), []);
  },
};

// ---------- "remember …" ----------

const HEALTH_RE =
  /\b(?:sick|ill|illness|hospital|meds?|medication|pregnan\w*|therapy|therapist|depress\w*|anxiety|allerg\w*|diabet\w*|injur\w*|hungover|surgery|doctor|diagnos\w*)\b/;

/** "remember jordan always picks …", "fyi i'm vegetarian, keep that in mind" ⇒ the fact, or undefined. */
export function parseRememberAsk(text: string): string | undefined {
  const t = text.replace(/\s+/g, ' ').trim();
  const lead = /^(?:pls |please )?(?:remember|note|don'?t forget)(?: that)?[,:]?\s+(.{3,})$/i.exec(
    t,
  );
  const tail =
    /^(?:fyi[,:]?\s+)?(.{3,}?)[,.;]?\s+(?:keep (?:that|this|it) in mind|remember (?:that|this)|note (?:that|this))\b.*$/i.exec(
      t,
    );
  const fact = (lead?.[1] ?? tail?.[1])?.replace(/[\s.!]+$/u, '').trim();
  if (fact === undefined || fact.length < 3 || fact.length > 240) return undefined;
  return fact.toLowerCase();
}

export const rememberResponder: FallbackResponder = {
  id: 'remember_v1',
  complete(req) {
    if (!offered(req, 'remember')) return undefined;
    const ask = freshAsk(req);
    if (ask === undefined) return undefined;
    const fact = parseRememberAsk(ask.text);
    if (fact === undefined) return undefined;
    if (HEALTH_RE.test(foldText(fact))) return response(req, HEALTH_MEMORY_TEXT, []);
    return response(req, '', [call(req, 'toolu_offline_remember_', 1, 'remember', { text: fact })]);
  },
};

// ---------- what Trav can't do yet ----------

const OPTION_RE =
  /^(?:(?:ok|yeah|lets|let's)\s+)?(?:book|get|grab|do|go with|take|pick)\s+(?:option|opt|#|number)\s*(?:\d|one|two|three)\b/;
const TABLE_RE =
  /\b(?:book|reserve|get|grab|make)\b.*\b(?:a )?(?:table|reservation|rez)\b|\breservation for\b/;
const RESTAURANT_RE =
  /\b(?:dinner|lunch|brunch|breakfast|food|restaurant|tapas|eat|eats)\b.*\b(?:spot|place|rec|recs|recommendations?|suggestions?|ideas?|somewhere)\b|\bwhere (?:should|do|can|could) we eat\b|\bsomewhere to eat\b|\brestaurant recs?\b/;
const SHARE_CAP_RE =
  /\b(?:keep|cap|limit|hold)\s+my\s+(?:share|spend(?:ing)?|budget|part)\b|\bmy\s+(?:share|spend(?:ing)?|budget)\b.*\b(?:under|below|max|at most|less than)\b/;
const ONE_TOO_RE =
  /\b(?:can|could|may) i (?:get|grab|have) one\b|\b(?:get|grab) me one\b|\bone (?:more )?for me\b/;
const PAID_NO_AMOUNT_RE =
  /\b(?:i paid|i got (?:it|this|the bill)|my treat|on me|i covered it|i picked up the bill)\b/;
/** Money statements belong to the expense flow; never answer them with a can't-do line. */
const SPEND_RE = /[€$£]\s?\d|\b(?:i paid|paid for|i covered|i bought|i got everyone)\b/;

export const honestGapsResponder: FallbackResponder = {
  id: 'honest_gaps_v1',
  complete(req) {
    const ask = freshAsk(req);
    if (ask === undefined) return undefined;
    const t = foldText(ask.text)
      .replace(/[?!.]+$/, '')
      .trim();
    if (OPTION_RE.test(t)) return response(req, OPTION_NUMBER_TEXT, []);
    // "dinner, i paid, Priya didn't drink": the expense flow found no amount.
    // Nothing is logged; ask for the whole thing in one line (VOICE §4.11).
    if (PAID_NO_AMOUNT_RE.test(t) && !/\d/.test(t)) return response(req, EXPENSE_RESTATE_TEXT, []);
    if (SPEND_RE.test(t)) return undefined;
    if (SHARE_CAP_RE.test(t)) return response(req, SHARE_CAP_TEXT, []);
    if (TABLE_RE.test(t)) return response(req, TABLE_TEXT, []);
    if (RESTAURANT_RE.test(t)) return response(req, RESTAURANT_TEXT, []);
    if (ONE_TOO_RE.test(t)) return response(req, ONE_TOO_TEXT, []);
    return undefined;
  },
};

/**
 * In chain order. Multi-round flows must come before `tool_result_ack_v1`
 * (which ends any tool round it sees); fresh-ask responders don't care.
 */
export function travAskResponders(): readonly FallbackResponder[] {
  return [
    cancelResponder,
    cheaperResponder,
    lodgingResponder,
    createBookingRequestResponder(),
    rememberResponder,
    honestGapsResponder,
  ];
}

/**
 * Offline responders for the chat asks the scripts don't cover (T-081,
 * T-092). Deterministic, keyed on what was asked, never on who asked, and
 * they only ever reach money through the tools the request offered:
 *
 *  - ticket asks ⇒ `propose_booking` (a proposal and a card; the purchase is
 *    still `ApprovalPolicy` + a 👍 away, SAFETY §2.1). Never a purchase.
 *  - "anything cheaper" ⇒ `get_pending_proposals` ⇒ `search_events` ⇒ the
 *    same event's cheaper tiers with their trade-off (T-133), from those
 *    results only (real prices; never a new proposal).
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
  CATEGORY_WORDS,
  foldText,
  parseBookingRequest,
  parseVenueQuestion,
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
/** "anything cheaper" with only a stay or a flight waiting (T-133): those aren't re-searched. */
export const CHEAPER_TICKETS_ONLY_TEXT =
  "i can only look for cheaper tickets from the chat right now. what's above is still waiting on its 👍";
/** "anything cheaper for sagrada" when nothing like that is waiting (T-133 r1 #1). */
export const NOTHING_LIKE_THAT_CHEAPER_TEXT =
  "nothing like that is waiting on a 👍. ask me for it by name and i'll price it";
export const CANCEL_NOT_ALLOWED_TEXT =
  'only whoever asked for it, or a trip lead, can drop that one. a 👎 on the card from someone going works too';
export const CANCEL_GONE_TEXT = "that one's not waiting anymore, so there's nothing to drop";
export const NOTHING_LIKE_THAT_TEXT =
  "nothing like that is waiting on a 👍, so i didn't drop anything";
export const VENUE_OFFER_TEXT = "want me to grab them? tell me who's in";
/** A price question about an adults-only venue in a family group (T-148 r1 #3, VOICE §8). */
export const VENUE_NOT_ALL_AGES_TEXT =
  "that one's not all-ages, so i won't price it in this chat. ask me about something all-ages and i'll look it up";
export const VENUE_NOT_BOOKABLE_TEXT =
  "i can't book that one from the chat on the trip dates, so nothing's booked";

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

// ---------- "how much is the snorkel tour" (T-148 #8) ----------

/**
 * A price or info question about a named venue ⇒ `search_events` ⇒ the real
 * price, refundability and minimum age from the results, then an offer to
 * book it. Never a proposal: the member asks for that themselves.
 */
export function createVenueQuestionResponder(
  index: () => VenueIndex = bundledVenueIndex,
): FallbackResponder {
  return {
    id: 'venue_question_v1',
    complete(req) {
      const prefix = 'toolu_offline_venueq_';
      const ask = freshAsk(req);
      if (ask !== undefined) {
        if (!offered(req, 'search_events')) return undefined;
        const q = parseVenueQuestion(ask.text, index());
        if (q === undefined) return undefined;
        const input = {
          query: q.query,
          ...(q.quantity !== undefined ? { quantity: q.quantity } : {}),
        };
        return response(req, '', [call(req, prefix, 1, 'search_events', input)]);
      }
      const round = myLatestRound(req, prefix);
      if (round?.name !== 'search_events') return undefined;
      const raw =
        isRecord(round.result) && Array.isArray(round.result['events'])
          ? round.result['events']
          : [];
      const hit = (raw as unknown[]).filter(isRecord).find((e) => {
        const from = e['from'];
        return (
          e['bookable'] === true &&
          typeof e['name'] === 'string' &&
          isRecord(from) &&
          typeof from['amountMinor'] === 'number' &&
          typeof from['currency'] === 'string'
        );
      });
      if (hit === undefined) return response(req, VENUE_NOT_BOOKABLE_TEXT, []);
      // A family group never sees an adults-only venue named or priced (its
      // name alone trips the screen, and the reply would be silence): one
      // all-ages line that names neither the venue nor the minor (T-148 r1 #3).
      const family = isRecord(round.result) && round.result['familyMode'] === true;
      if (family && hit['adultsOnly'] === true) return response(req, VENUE_NOT_ALL_AGES_TEXT, []);
      const from = hit['from'] as { amountMinor: number; currency: string };
      // All-ages wording (T-148 r1 #3, VOICE §8): "18+"/"21+" would get the
      // whole reply dropped by a family group's screen; under 18 the real age.
      const minAge = hit['minimumAge'];
      const age =
        typeof minAge !== 'number'
          ? ''
          : minAge < 18
            ? `, ${String(minAge)} and up`
            : ', not all-ages';
      const refund = hit['fromRefundable'] === true ? 'refundable' : 'non-refundable';
      return response(
        req,
        `${shortName(hit['name'] as string)} is ${fmt(from.amountMinor, from.currency)} each, ${refund}${age}\n${VENUE_OFFER_TEXT}`,
        [],
      );
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
  readonly tier?: string;
  readonly kind?: string;
  readonly itemRef?: string;
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
    .map(
      (p, i) =>
        `${i + 1}. ${shortName(p.description)}${p.tier !== undefined && p.tier.length > 0 ? ` ${p.tier.toLowerCase()}` : ''} · ${p.total}`,
    );
  return ['which one?', ...shown, `say the name and i'll ${verb}`].join('\n');
}

/** Words in a "cheaper" ask that name no proposal ("anything cheaper for us all"). */
const CHEAPER_FILLER = new Set([
  'cheaper',
  'anything',
  'something',
  'any',
  'got',
  'there',
  'than',
  'seat',
  'seats',
  'option',
  'options',
  'one',
  'ones',
  'everyone',
  'everybody',
  'group',
  'guys',
  'people',
  'first',
  'second',
  'third',
  'number',
]);

function namedWords(text: string): string[] {
  return foldText(text)
    .split(/[^a-z0-9]+/)
    .filter(
      (w) =>
        w.length >= 3 && !CANCEL_FILLER.has(w) && !CANCEL_WHEN.has(w) && !CHEAPER_FILLER.has(w),
    );
}

/** The last line of the which-one question, the part the reply-window parser keys on. */
const CHEAPER_WHICH_TAIL = "reply with the number or the name and i'll look for cheaper";

/**
 * "which one?" for "anything cheaper" (T-133 r1 #1): numbered, and its
 * answer is something this responder reads back, a number or a name inside
 * the reply window, or "@trav anything cheaper for <name>" any time.
 */
function cheaperWhichText(list: readonly PendingSummary[]): string {
  // Two numbered at most: the question stays inside the 4-line reply cap (a name answers any).
  const shown = list.slice(0, 2).map((p, i) => `${i + 1}. ${pendingLabel(p)} · ${p.total}`);
  return ['which one?', ...shown, CHEAPER_WHICH_TAIL].join('\n');
}

function pendingLabel(p: PendingSummary): string {
  const tier = p.tier !== undefined && p.tier.length > 0 ? ` ${p.tier.toLowerCase()}` : '';
  return `${shortName(p.description)}${tier}`;
}

/**
 * Trav's last line in the group transcript the prompt carries, when it is
 * this flow's which-one question: its numbered labels by number. Members'
 * lines are prefixed with their own name, so only Trav's own text can match.
 */
function lastWhichQuestion(req: CompletionRequest): Map<number, string> | undefined {
  const lines = req.system.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'recent messages in the group:');
  if (start < 0) return undefined;
  const travLines = lines.slice(start + 1).filter((l) => l.startsWith('- trav: '));
  const last = travLines.at(-1);
  if (last === undefined) return undefined;
  const text = last.slice('- trav: '.length);
  if (!text.startsWith('which one?') || !text.includes(CHEAPER_WHICH_TAIL)) return undefined;
  const labels = new Map<number, string>();
  for (const m of text.matchAll(/(?:^|\s)([1-3])\. (.+?) · /g)) labels.set(Number(m[1]), m[2]!);
  return labels;
}

const ORDINALS: Readonly<Record<string, number>> = {
  '1': 1,
  '2': 2,
  '3': 3,
  one: 1,
  two: 2,
  three: 3,
  first: 1,
  second: 2,
  third: 3,
};

/**
 * A reply to the which-one question ("2", "the second one", "razzmatazz"):
 * the words that pick the proposal, or undefined when the line isn't one
 * (anything that names nothing from the question is left to other flows).
 */
function whichReplyWords(text: string, labels: ReadonlyMap<number, string>): string[] | undefined {
  const t = foldText(text)
    .replace(/[?!.]+$/, '')
    .trim();
  const n =
    /^(?:(?:the|number|option|#)\s*)*(\d|one|two|three|first|second|third)(?:\s+one)?$/.exec(
      t,
    )?.[1];
  if (n !== undefined) {
    const label = labels.get(ORDINALS[n] ?? 0);
    return label === undefined ? undefined : namedWords(label);
  }
  const words = namedWords(t);
  if (words.length === 0 || t.split(/\s+/).length > 5) return undefined;
  const shown = [...labels.values()].flatMap((l) => namedWords(l));
  return words.some((w) => namesWord(w, shown)) ? words : undefined;
}

/** The words that name which pending proposal the member means ([] = none named). */
function cheaperSelector(req: CompletionRequest, text: string): string[] {
  const folded = foldText(text);
  const m = CHEAPER_RE.exec(folded.replace(/[?!.]+$/, '').trim());
  if (m !== null) return namedWords(folded.replace(m[0], ' '));
  const labels = lastWhichQuestion(req);
  return labels === undefined ? [] : (whichReplyWords(text, labels) ?? []);
}

export const cheaperResponder: FallbackResponder = {
  id: 'cheaper_v1',
  complete(req) {
    const prefix = 'toolu_offline_cheaper_';
    const ask = freshAsk(req);
    if (ask !== undefined) {
      const asked = CHEAPER_RE.test(
        foldText(ask.text)
          .replace(/[?!.]+$/, '')
          .trim(),
      );
      const labels = asked ? undefined : lastWhichQuestion(req);
      const replied = labels !== undefined && whichReplyWords(ask.text, labels) !== undefined;
      if (!asked && !replied) return undefined;
      if (!offered(req, 'get_pending_proposals') || !offered(req, 'search_events'))
        return undefined;
      return response(req, '', [call(req, prefix, 1, 'get_pending_proposals', {})]);
    }
    const round = myLatestRound(req, prefix);
    if (round === undefined) return undefined;
    if (round.name === 'get_pending_proposals') {
      const pending = pendingFrom(round.result) ?? [];
      if (pending.length === 0) return response(req, NOTHING_PENDING_CHEAPER_TEXT, []);
      const tickets = ticketsOnly(pending);
      if (tickets.length === 0) return response(req, CHEAPER_TICKETS_ONLY_TEXT, []);
      const p = pickPending(req, tickets);
      if (typeof p === 'string') return response(req, p, []);
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
      const p = pickPending(req, ticketsOnly(pendingFrom(first?.result) ?? []));
      if (
        typeof p === 'string' ||
        !isRecord(round.result) ||
        !Array.isArray(round.result['events'])
      ) {
        return response(req, NOTHING_PENDING_CHEAPER_TEXT, []);
      }
      const familyMode = round.result['familyMode'] === true;
      return response(req, cheaperText(p, round.result['events'] as unknown[], familyMode), []);
    }
    return undefined;
  },
};

/**
 * Which pending ticket proposal the ask means: the one its words name (or the
 * which-one reply names), the only one when nothing is named; otherwise the
 * line to send instead (a numbered which-one, or "nothing like that").
 */
function pickPending(
  req: CompletionRequest,
  tickets: readonly PendingSummary[],
): PendingSummary | string {
  if (tickets.length === 0) return NOTHING_PENDING_CHEAPER_TEXT;
  const words = cheaperSelector(req, theAsk(req)?.text ?? '');
  const hits = words.length === 0 ? [...tickets] : cheaperMatches(words, tickets);
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) return NOTHING_LIKE_THAT_CHEAPER_TEXT;
  return cheaperWhichText(hits);
}

const termWords = (t: string): string[] => t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

/**
 * Does the member's word `w` name something with these (folded) words? It
 * starts one of them ("razz"), or it's a venue alias from the bundled ticket
 * inventories whose venue has one of them ("barca" ⇒ "barcelona").
 */
function namesWord(w: string, hay: readonly string[]): boolean {
  if (hay.some((h) => h.startsWith(w))) return true;
  const index = bundledVenueIndex();
  return index.venues
    .filter((v) => v.terms.some((t) => !index.generic.has(t) && termWords(t).includes(w)))
    .some((v) =>
      v.terms.some((t) => namedWords(t).some((a) => !CATEGORY_WORDS.has(a) && hay.includes(a))),
    );
}

/**
 * The pending proposals the named words point at: like `cancelMatches`, each
 * word scores when it starts a word of the description or tier, or when it's
 * an alias the bundled ticket inventories give that venue ("barça" names
 * "FC Barcelona vs Sevilla FC"). Best score wins; a tie stays a tie.
 */
function cheaperMatches(
  named: readonly string[],
  pending: readonly PendingSummary[],
): PendingSummary[] {
  const scored = pending.map((p) => {
    const hay = foldText(`${p.description} ${p.tier ?? ''}`).split(/[^a-z0-9]+/);
    return { p, score: named.filter((w) => namesWord(w, hay)).length };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  if (best === 0) return [];
  return scored.filter((s) => s.score === best).map((s) => s.p);
}

/** Ticket proposals only: a stay or a flight is never re-searched as an event. */
function ticketsOnly(list: readonly PendingSummary[]): PendingSummary[] {
  return list.filter((p) => p.kind === undefined || p.kind === 'ticket');
}

interface CheaperTier {
  readonly offerId?: string;
  readonly tier?: string;
  readonly seat?: string;
  readonly amountMinor: number;
  readonly refundable: boolean;
}

interface CheaperEvent {
  readonly name: string;
  readonly adultsOnly: boolean;
  readonly tiers: readonly CheaperTier[];
}

/** The `search_events` results this line reads; an event without `tiers` falls back to its cheapest offer. */
function cheaperEvents(raw: readonly unknown[], currency: string): CheaperEvent[] {
  return raw.filter(isRecord).flatMap((e): CheaperEvent[] => {
    if (e['bookable'] !== true || typeof e['name'] !== 'string') return [];
    const listed = Array.isArray(e['tiers']) ? (e['tiers'] as unknown[]).filter(isRecord) : [];
    const tiers: CheaperTier[] = listed.flatMap((t): CheaperTier[] =>
      typeof t['amountMinor'] === 'number' && t['currency'] === currency
        ? [
            {
              ...(typeof t['offerId'] === 'string' ? { offerId: t['offerId'] } : {}),
              ...(typeof t['tier'] === 'string' && t['tier'].length > 0 ? { tier: t['tier'] } : {}),
              ...(typeof t['seat'] === 'string' && t['seat'].length > 0 ? { seat: t['seat'] } : {}),
              amountMinor: t['amountMinor'],
              refundable: t['refundable'] === true,
            },
          ]
        : [],
    );
    const from = e['from'];
    if (
      tiers.length === 0 &&
      isRecord(from) &&
      typeof from['amountMinor'] === 'number' &&
      from['currency'] === currency
    ) {
      tiers.push({
        ...(typeof e['fromTier'] === 'string' && e['fromTier'].length > 0
          ? { tier: e['fromTier'] }
          : {}),
        ...(typeof e['fromSeat'] === 'string' && e['fromSeat'].length > 0
          ? { seat: e['fromSeat'] }
          : {}),
        amountMinor: from['amountMinor'],
        refundable: e['fromRefundable'] === true,
      });
    }
    if (tiers.length === 0) return [];
    return [
      {
        name: e['name'],
        adultsOnly: e['adultsOnly'] === true,
        tiers: [...tiers].sort((a, b) => a.amountMinor - b.amountMinor),
      },
    ];
  });
}

/** "behind the goal (Gol Nord)", "Gol Nord", or "behind the goal"; '' when neither is known. */
function seatLabel(t: Pick<CheaperTier, 'tier' | 'seat'>): string {
  if (t.seat !== undefined && t.tier !== undefined) {
    return foldText(t.seat) === foldText(t.tier) ? t.seat : `${t.seat} (${t.tier})`;
  }
  return t.seat ?? t.tier ?? '';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "2026-03-15" ⇒ "mar 15" (the request parser reads it as that night); undefined otherwise. */
function monthDay(date: string | undefined): string | undefined {
  const m = date === undefined ? null : /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return undefined;
  const month = MONTHS[Number(m[1]) - 1];
  return month === undefined ? undefined : `${month} ${String(Number(m[2]))}`;
}

/** Tier-name words a re-ask can't pick a tier by (mirrors the request parser's noise words). */
const TIER_NAME_NOISE = new Set([
  'general',
  'admission',
  'entry',
  'slot',
  'ticket',
  'tickets',
  'line',
  'zone',
  'show',
  'and',
  'the',
  'with',
]);

/**
 * What a member can say to get this tier proposed ("behind the goal",
 * "fast-line presale"): its seat words, else its tier name when that has a
 * word the request parser picks a tier by. Undefined for "General admission".
 */
function tierHandle(t: CheaperTier): string | undefined {
  if (t.seat !== undefined) return t.seat;
  if (t.tier === undefined) return undefined;
  const words = foldText(t.tier)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/\d/.test(w) && !TIER_NAME_NOISE.has(w));
  return words.length > 0 ? t.tier.toLowerCase() : undefined;
}

/**
 * "anything cheaper" for one pending ticket proposal (T-133, VOICE §4.10 C):
 * the same event's cheapest cheaper tier first, with its trade-off (where
 * the seats are, refundability) and how to switch; else the cheapest other event
 * that night (never an adults-only one in a family group); else "already the
 * cheapest". Prices come only from the search results. The pending proposal
 * is never touched: the last line says it's still on its card.
 *
 * Switching is a new ask: a different tier is a different proposal (its own
 * card and 👍s), so the next step quotes the ask that proposes it (event,
 * seat or tier name, headcount, night), and only when the request parser
 * picks the tier by that name (or a plain re-ask would pick it anyway).
 */
function cheaperText(
  p: PendingSummary,
  rawEvents: readonly unknown[],
  familyMode: boolean,
): string {
  const n = Math.max(1, p.attendees.length);
  const each = Math.round(p.totalMinor / n);
  const what = shortName(p.description);
  const refund = (r: boolean): string => (r ? 'refundable' : 'non-refundable');
  const line = (t: CheaperTier): string =>
    [`${fmt(t.amountMinor, p.currency)} each`, seatLabel(t), refund(t.refundable)]
      .filter((x) => x.length > 0)
      .join(' · ');
  const events = cheaperEvents(rawEvents, p.currency);
  // The pending event: the one listing the held offer, else the one with its name.
  const same =
    (p.itemRef !== undefined
      ? events.find((e) => e.tiers.some((t) => t.offerId === p.itemRef))
      : undefined) ?? events.find((e) => e.name === p.description);
  // Seat words for the held tier come from the search (it knows the event's category).
  const heldSeat =
    p.itemRef === undefined ? undefined : same?.tiers.find((t) => t.offerId === p.itemRef)?.seat;
  const heldPrice = `${fmt(each, p.currency)}${heldSeat !== undefined ? ` ${heldSeat}` : ''}`;
  const held = `the ${heldPrice} ones are still on the card above. 👍 on that card to book them`;
  // The cheapest cheaper tier of the same event (never the held one): one
  // option, its trade-off and how to switch fit the 4-line reply (VOICE §3.1).
  const cheaper = (same?.tiers ?? []).find(
    (t) => t.amountMinor < each && (p.itemRef === undefined || t.offerId !== p.itemRef),
  );
  if (cheaper !== undefined) {
    // What a plain re-ask picks: refundable first, then cheapest (`rankOffers`).
    const defaultPick = [...(same?.tiers ?? [])].sort((a, b) =>
      a.refundable !== b.refundable ? (a.refundable ? -1 : 1) : a.amountMinor - b.amountMinor,
    )[0];
    const handle = tierHandle(cheaper);
    const night = monthDay(p.eventDate);
    // The exact ask that proposes this tier, or none when no ask would pick it.
    const reAsk =
      handle !== undefined || cheaper === defaultPick
        ? `@trav ${what}${handle !== undefined ? ` ${handle}` : ''} tickets for ${String(n)}${night !== undefined ? ` ${night}` : ''}`
        : undefined;
    const next =
      reAsk === undefined ? [] : [`want those instead? say "${reAsk}" and i'll put up a new card`];
    const named = `cheaper for ${what}: ${line(cheaper)}`;
    const short = `cheaper: ${line(cheaper)}`;
    const candidates = [
      [named, ...next, held],
      [short, ...next, held],
      [named, held],
      [short, held],
    ];
    // A plain reply is 279 characters at most (VOICE §3.1): the first that fits.
    const fits = candidates.find((c) => c.join('\n').length <= 279);
    return (fits ?? candidates.at(-1)!).join('\n');
  }
  const other = events
    .filter((e) => e !== same && !(familyMode && e.adultsOnly))
    .map((e) => ({ name: e.name, t: e.tiers[0]! }))
    .filter((x) => x.t.amountMinor < each)
    .sort((a, b) => a.t.amountMinor - b.t.amountMinor)[0];
  if (other !== undefined) {
    return `nothing cheaper for ${what}. ${shortName(other.name)} is ${fmt(other.t.amountMinor, p.currency)} each that night, ${refund(other.t.refundable)}\n${held}`;
  }
  return `that's already the cheapest i can book for ${what}\n${held}`;
}

// ---------- "cancel the vip thing" ----------

const CANCEL_ASK = /^(?:(?:ok|actually|yeah|nah|pls|please)\s+)*(?:cancel|drop|scrap|kill)\b/;

/** Words that name no proposal ("cancel the thing", "drop it pls"). */
const CANCEL_FILLER = new Set([
  'the',
  'that',
  'this',
  'those',
  'these',
  'our',
  'my',
  'thing',
  'things',
  'one',
  'ones',
  'it',
  'booking',
  'proposal',
  'request',
  'order',
  'card',
  'ticket',
  'tickets',
  'tix',
  'please',
  'pls',
  'plz',
  'for',
  'now',
  'all',
  'just',
  'actually',
]);

/** Day and time words name a night, not a proposal ("cancel the razz tickets for tonight"). */
const CANCEL_WHEN = new Set([
  'tonight',
  'tonite',
  'today',
  'tomorrow',
  'tmrw',
  'asap',
  'anymore',
  'later',
  'morning',
  'afternoon',
  'evening',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sun',
  'mon',
  'tue',
  'tues',
  'wed',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
]);

/**
 * What "cancel …" names, up to the first clause break: "cancel the vip
 * thing, way too much" ⇒ ["vip"]. Words of 3+ letters that aren't filler or
 * day/time words (T-148 #4).
 */
export function cancelTarget(text: string): string[] {
  const t = foldText(text);
  const m = /\b(?:cancel|drop|scrap|kill)\b([^,.;!?]*)/.exec(t);
  if (m === null) return [];
  return m[1]!
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !CANCEL_FILLER.has(w) && !CANCEL_WHEN.has(w));
}

/**
 * The pending proposals "cancel …" names (T-148 #4): each scores the named
 * words its description or tier starts a word with (member names don't
 * count: "for lily" names a person, not a proposal). The best score wins;
 * a tie is "which one?"; no word matching anything is "nothing like that".
 * Nothing named (all filler) ⇒ every pending proposal.
 */
export function cancelMatches(
  named: readonly string[],
  pending: readonly PendingSummary[],
): PendingSummary[] {
  const people = new Set(
    pending.flatMap((p) =>
      p.attendees.flatMap((a) =>
        isRecord(a) && typeof a['name'] === 'string' ? [foldText(a['name'])] : [],
      ),
    ),
  );
  const words = named.filter((w) => !people.has(w));
  if (words.length === 0) return [...pending];
  const scored = pending.map((p) => {
    const hay = foldText(`${p.description} ${p.tier ?? ''}`).split(/[^a-z0-9]+/);
    return { p, score: words.filter((w) => hay.some((h) => h.startsWith(w))).length };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  return best === 0 ? [] : scored.filter((s) => s.score === best).map((s) => s.p);
}

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
      // "cancel the vip thing" names something: only a proposal that matches
      // it is dropped, never whichever one happens to be pending (r1 #6).
      const hits = cancelMatches(cancelTarget(theAsk(req)?.text ?? ''), pending);
      if (hits.length === 0) return response(req, NOTHING_LIKE_THAT_TEXT, []);
      const pick = hits.length === 1 ? hits[0] : undefined;
      if (pick === undefined) return response(req, whichOneText(hits, 'drop it'), []);
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

/** Health details are never remembered (SAFETY privacy; T-081 r1 #7 widened the list). */
const HEALTH_RE =
  /\b(?:sick|sickness|ill|illness|unwell|hospital\w*|meds?|medicin\w*|medication|prescription|pills?|pregnan\w*|therapy|therapist|psychiatr\w*|depress\w*|anxiety|panic attacks?|adhd|autis\w*|bipolar|allerg\w*|epipen|inhaler|asthma\w*|diabet\w*|insulin|injur\w*|hungover|hangover|surgery|doctor|dr|clinic|er|urgent care|diagnos\w*|migraines?|headaches?|covid\w*|flu|fever\w*|a cold|cough\w*|nause\w*|vomit\w*|puk\w*|threw up|throw(?:ing)? up|food poisoning|stomach\w*|concuss\w*|seizures?|epilep\w*|sprain\w*|fractur\w*|broken (?:arm|leg|wrist|ankle|foot|hand|rib)|stitches|infection|antibiotics?|rash|blood pressure|heart condition|cancer|chemo|cramps?|disab\w*|wheelchair|sober|rehab)\b/;

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
    createVenueQuestionResponder(),
    rememberResponder,
    honestGapsResponder,
  ];
}

/**
 * Venue suggestions shaped by spending tier (T-167, D-045). Rules, never the
 * model: "@trav where should we eat tonight", "any good bars", "dinner spot
 * for 6, under 30 a head", "things to do this afternoon".
 *
 * Who the suggestions are for: the roster (members not out tonight) in the
 * group, the asker alone in a DM. Their tiers are inferred from signals
 * (`signals.ts`) and blended, leaning to the most budget-conscious
 * (`tiers.blendTiers`). The price level to aim at is, in order:
 * 1. what the ask itself says ("cheap", "somewhere nice", "under €30 a head");
 * 2. the vibe the group (or, in a DM, the member) already gave for that day,
 *    kept in memory;
 * 3. the blend, when it is known;
 * 4. otherwise one question, "fancy or casual tonight?", whose answer is
 *    remembered for the day. Asked once per thread per day: a later ask with
 *    no answer gets the middle of the range instead of the same question.
 *
 * Soft, never a gate: nothing here books, holds, refuses or touches the
 * approval policy. A budget orders the list and marks what is over it.
 *
 * Privacy (SAFETY §2.3): group text never names a tier for anyone, never a
 * member's private figure, never a dietary note. A member's own figure is
 * mentioned only in their own DM ("over your €80 a day").
 */
import {
  addDays,
  formatMoney,
  localDate,
  localHour,
  money,
  parseIso,
  safety,
  tiers,
} from '@trav/core';
import type {
  Group,
  GroupId,
  IsoDate,
  IsoDateTime,
  Member,
  MemberId,
  MemberMemoryFact,
  MessageId,
  SpendingTier,
  Stores,
  Trip,
} from '@trav/core';
import type { Venue, VenueCategory, VenuesAdapter } from '@trav/adapters';
import type { GroupMemory, MemberMemory } from '../memory/index.js';
import { resolveActivity, rosterMembers, stripTravPrefix } from '../roster/index.js';
import { collectTierSignals, ownBudget } from './signals.js';
import type { GroupLine, TravelFact } from './signals.js';

// ---------- the ask ----------

export type SuggestWhen = 'tonight' | 'today' | 'tomorrow';

export interface SuggestAsk {
  readonly category: VenueCategory;
  /** The meal word the ask used, for the header ("lunch ideas"). */
  readonly meal?: 'dinner' | 'lunch' | 'brunch' | 'breakfast';
  readonly when?: SuggestWhen;
  /** What the ask says about price ("cheap eats", "somewhere nice"). */
  readonly statedTier?: SpendingTier;
  /** A per-person figure the ask says ("under 30 a head"), trip currency minor units. */
  readonly perPersonBudgetMinor?: number;
}

function fold(s: string): string {
  return tiers.foldTierText(s);
}

/** Booking, logging or paying: someone else's flow, never a suggestion ask. */
const NOT_A_SUGGESTION =
  /\b(?:book|booking|reserve|buy|order|get us|get me|grab us|grab me|hold|paid|pay|spent|owe|owes|split|cost me|covered|charge|charged|refund|cancel|remember|add|log|put)\b/;
/** The ask wants ideas, not a fact: "where", "ideas", "any good", "recommend", "spot". */
const SUGGEST_INTENT =
  /\b(?:things to do|something to do|stuff to do|where (?:should|can|do|could|to|would)|where's good|wheres good|ideas?|recs?|recommend\w*|suggest\w*|suggestions?|options?|any (?:good|decent|nice|cheap|chill|fun|cool)|(?:food|dinner|lunch|brunch|bar|drinks?) tips|know (?:a|any)|what(?:'s| is) good|whats good|somewhere|someplace|spots?|places?|what (?:should|can|could) we do|anything (?:fun|good) to do|looking for|(?:cheap|good|great|decent|nice|budget) eats)\b/;
const RESTAURANT =
  /\b(?:eat|eats|food|dinner|lunch|brunch|breakfast|restaurants?|tapas|bite|meal|supper)\b/;
const BAR = /\b(?:drinks?|bars?|cocktails?|pub|pubs|wine bar|vermut|vermouth|beers?)\b/;
const ACTIVITY =
  /\b(?:things to do|something to do|stuff to do|what (?:should|can|could) we do|activit(?:y|ies)|anything (?:fun|good) to do|sightseeing|do (?:this|today|tomorrow|tonight))\b/;
/** Clubs are tickets (the booking flow and the minors screen), not a place list. */
const CLUB = /\b(?:clubs?|clubbing|nightclub|party|rave|razz|razzmatazz)\b/;

const PER_PERSON_RE =
  /\b(?:under|below|less than|max|at most|up to|no more than|around|about)\s*([€$£])?\s?(\d{1,4})(?:[.,](\d{1,2}))?\s*(?:([€$£])|euros?|eur|dollars?|bucks|pounds?|quid)?\s*(a head|each|pp|per person|a person|per head|a pop|per)?\b/;

/**
 * A suggestion ask, or undefined. The whole message is read (after "@trav"),
 * and anything that books, logs, pays or remembers is not one.
 */
export function parseSuggestAsk(text: string): SuggestAsk | undefined {
  const t = fold(stripTravPrefix(text)).replace(/@trav\b/g, ' ');
  if (t.length === 0 || t.length > 200) return undefined;
  if (NOT_A_SUGGESTION.test(t) || CLUB.test(t)) return undefined;
  if (!SUGGEST_INTENT.test(t)) return undefined;
  const category: VenueCategory | undefined = ACTIVITY.test(t)
    ? 'activity'
    : BAR.test(t) && !/\b(?:dinner|lunch|food|eat)\b/.test(t)
      ? 'bar'
      : RESTAURANT.test(t)
        ? 'restaurant'
        : undefined;
  if (category === undefined) return undefined;
  const meal = /\bdinner|supper\b/.test(t)
    ? 'dinner'
    : /\blunch\b/.test(t)
      ? 'lunch'
      : /\bbrunch\b/.test(t)
        ? 'brunch'
        : /\bbreakfast\b/.test(t)
          ? 'breakfast'
          : undefined;
  const when: SuggestWhen | undefined = /\btomorrow\b/.test(t)
    ? 'tomorrow'
    : /\btonight|this evening\b/.test(t)
      ? 'tonight'
      : /\btoday|this (?:afternoon|morning)\b/.test(t)
        ? 'today'
        : undefined;
  let perPersonBudgetMinor: number | undefined;
  const m = PER_PERSON_RE.exec(t);
  if (m !== null) {
    const marked =
      m[1] !== undefined || m[4] !== undefined || /euro|eur|dollar|buck|pound|quid/.test(m[0]);
    const perHead = m[5] !== undefined && m[5] !== 'per';
    if (marked || perHead) {
      perPersonBudgetMinor =
        Number(m[2]) * 100 + (m[3] === undefined ? 0 : Number(m[3].padEnd(2, '0')));
    }
  }
  const statedTier = tiers.statedTier(t);
  return {
    category,
    ...(meal !== undefined ? { meal } : {}),
    ...(when !== undefined ? { when } : {}),
    ...(statedTier !== undefined ? { statedTier } : {}),
    ...(perPersonBudgetMinor !== undefined && perPersonBudgetMinor > 0
      ? { perPersonBudgetMinor }
      : {}),
  };
}

// ---------- the text ----------

export const VIBE_QUESTION_TONIGHT = 'fancy or casual tonight?';
export const VIBE_QUESTION_TODAY = 'fancy or casual today?';
export const VIBE_QUESTION_TOMORROW = 'fancy or casual tomorrow?';

const VIBE_ACK: Readonly<Record<SpendingTier, string>> = {
  budget: 'casual it is',
  mid: 'somewhere in between it is',
  high: 'fancy it is',
};

function nounFor(ask: SuggestAsk, when: SuggestWhen): string {
  if (ask.category === 'bar') return 'drinks';
  if (ask.category === 'activity') return 'things to do';
  if (ask.meal !== undefined) return ask.meal;
  return when === 'tonight' ? 'dinner' : 'food';
}

/** "dinner ideas for tonight:" · "drinks tonight:" · "things to do tomorrow:" */
export function headerFor(ask: SuggestAsk, when: SuggestWhen): string {
  if (ask.category === 'bar') return `drinks ${when}:`;
  if (ask.category === 'activity') return `things to do ${when}:`;
  return `${nounFor(ask, when)} ideas for ${when}:`;
}

function priceText(p: Venue): string {
  return p.perPersonMinor === 0
    ? 'free'
    : `${formatMoney(money(p.perPersonMinor, p.currency))} each`;
}

export interface SuggestionLine {
  readonly place: Venue;
  readonly stepUp: boolean;
  /** "over €30" (the ask's figure) or "over your €80 a day" (own DM). */
  readonly overNote?: string;
}

export const SUGGEST_MAX_CHARS = 279;

/**
 * Header plus one line per place, cut to fit one bubble (VOICE §3.1, §3.3).
 * Each line opens on the place's kind, lowercase ("tapas · Taverna Cal Nen,
 * Barceloneta · €14 each"), so no line starts on a capitalized word.
 */
export function renderSuggestions(header: string, lines: readonly SuggestionLine[]): string {
  const tail = (l: SuggestionLine): string[] => [
    priceText(l.place),
    ...(l.overNote !== undefined ? [l.overNote] : []),
    ...(l.stepUp ? ['a step up'] : []),
  ];
  const full = (l: SuggestionLine): string =>
    [l.place.kind, `${l.place.name}, ${l.place.area}`, ...tail(l)].join(' · ');
  const short = (l: SuggestionLine): string => [l.place.kind, l.place.name, ...tail(l)].join(' · ');
  for (const fmt of [full, short]) {
    for (let n = lines.length; n >= 1; n -= 1) {
      const text = [header, ...lines.slice(0, n).map(fmt)].join('\n');
      if (text.length <= SUGGEST_MAX_CHARS) return text;
    }
  }
  return [header, ...lines.slice(0, 1).map(short)].join('\n').slice(0, SUGGEST_MAX_CHARS);
}

// ---------- the flow ----------

export interface SuggestFlowDeps {
  readonly stores: Stores;
  readonly places?: VenuesAdapter;
  readonly groupMemory: GroupMemory;
  readonly memberMemory: MemberMemory;
  /** Structured travel facts (a flight's cabin, a stay) beyond what the stores hold. */
  readonly travelFacts?: (groupId: GroupId) => readonly TravelFact[];
}

export interface SuggestTurnInput {
  readonly group: Group;
  readonly trip: Trip;
  readonly members: readonly Member[];
  readonly me: Member;
  readonly lane: 'group' | 'dm';
  readonly messageId: MessageId;
  readonly now: IsoDateTime;
  /** Members' own recent group-thread lines (stated wants: "keep it cheap"). */
  readonly groupLines: readonly GroupLine[];
}

export interface SuggestOutcome {
  readonly text: string;
  /** `suggest:places` · `suggest:question` · `suggest:answered` */
  readonly note: string;
  readonly target?: SpendingTier;
}

/** How long Trav's "fancy or casual?" stays answerable. */
export const VIBE_QUESTION_TTL_MS = 30 * 60_000;
/** Answer ids and asked days kept (oldest dropped first); far more than a trip holds. */
const ANSWERED_KEEP = 500;

interface PendingVibe {
  readonly ask: SuggestAsk;
  readonly when: SuggestWhen;
  readonly date: IsoDate;
  readonly askedAt: IsoDateTime;
  messageId?: MessageId;
}

export interface SuggestFlow {
  /** A suggestion ask: places, or the one question. Undefined ⇒ no catalog for the city (the model's). */
  ask(input: SuggestTurnInput, ask: SuggestAsk): Promise<SuggestOutcome | undefined>;
  /** The open question's answer ("casual", "fancy pls"), else undefined. */
  answer(
    input: SuggestTurnInput,
    text: string,
    opts: { readonly addressed: boolean; readonly replyToMessageId?: MessageId },
  ): Promise<SuggestOutcome | undefined>;
  /** Trav's question went out as this message (quote-replies bind to it). */
  noteQuestionSent(input: SuggestTurnInput, messageId: MessageId): void;
  /** True when this lane has an open "fancy or casual?" question. */
  pending(input: Pick<SuggestTurnInput, 'group' | 'lane' | 'me' | 'now'>): boolean;
}

function whenFor(ask: SuggestAsk, now: IsoDateTime, tz: string): SuggestWhen {
  if (ask.when !== undefined) return ask.when;
  if (ask.category === 'bar') return 'tonight';
  if (ask.meal === 'dinner') return 'tonight';
  if (ask.meal !== undefined) return 'today';
  return localHour(now, tz) >= 16 ? 'tonight' : 'today';
}

function dateFor(when: SuggestWhen, now: IsoDateTime, tz: string): IsoDate {
  const today = localDate(now, tz);
  return when === 'tomorrow' ? addDays(today, 1) : today;
}

function questionText(when: SuggestWhen): string {
  return when === 'tonight'
    ? VIBE_QUESTION_TONIGHT
    : when === 'tomorrow'
      ? VIBE_QUESTION_TOMORROW
      : VIBE_QUESTION_TODAY;
}

/** Dietary words in a fact: what the list must respect (never said). */
function dietaryNeeds(texts: readonly string[]): { veg: boolean; noSeafood: boolean } {
  const t = texts.map(fold).join('\n');
  return {
    veg: /\b(?:vegetarian|vegan|veggie|plant[- ]based|no meat|doesn'?t eat meat)\b/.test(t),
    noSeafood: /\b(?:shellfish|seafood|fish|prawns?|shrimp|crustaceans?)\b/.test(t),
  };
}

const SEAFOOD_KIND = /\b(?:seafood|fish|paella|arr[oò]s|arrossos|marisc)\b/i;

export function createSuggestFlow(deps: SuggestFlowDeps): SuggestFlow {
  const { stores } = deps;
  const open = new Map<string, PendingVibe>();
  /**
   * Messages that answered "fancy or casual?": that answer is for one day and
   * lives in memory under that date, so the same words never also count as a
   * standing preference in the tier (it would leak "casual tonight" into
   * tomorrow's list).
   */
  const answeredIds = new Set<string>();
  /** `lane key|date` the question was already asked for (asked once per day per thread). */
  const askedOn = new Set<string>();
  const keyOf = (groupId: GroupId, lane: 'group' | 'dm', memberId: MemberId): string =>
    lane === 'group' ? `${groupId}:group` : `${groupId}:dm:${memberId}`;

  function liveQuestion(key: string, now: IsoDateTime): PendingVibe | undefined {
    const q = open.get(key);
    if (q === undefined) return undefined;
    if (parseIso(now) - parseIso(q.askedAt) > VIBE_QUESTION_TTL_MS) {
      open.delete(key);
      return undefined;
    }
    return q;
  }

  /** Who the list is for: the asker in a DM; else the roster minus anyone out tonight. */
  function going(input: SuggestTurnInput, when: SuggestWhen): Member[] {
    if (input.lane === 'dm') return [input.me];
    const roster = rosterMembers(input.members);
    const activities = stores.group.trips.listActivities(input.trip.tripId);
    const night = resolveActivity(
      activities,
      input.trip.timeZone,
      input.now,
      undefined,
      when === 'tomorrow' ? 'tomorrow' : 'tonight',
    );
    if (night === undefined) return roster;
    const out = new Set(
      stores.group.trips
        .listAttendance(night.activityId)
        .filter((a) => a.status === 'out')
        .map((a) => a.memberId),
    );
    const left = roster.filter((m) => !out.has(m.memberId));
    return left.length > 0 ? left : roster;
  }

  function privateFacts(input: SuggestTurnInput, memberId: MemberId): readonly MemberMemoryFact[] {
    return deps.memberMemory.recall(memberId, input.group.groupId);
  }

  /** The vibe already given for that date: the group's (and in a DM, the member's own). */
  function vibeFor(input: SuggestTurnInput, date: IsoDate): SpendingTier | undefined {
    const facts: { text: string; learnedAt: string }[] = [
      ...deps.groupMemory.recall(input.group.groupId),
      ...(input.lane === 'dm' ? privateFacts(input, input.me.memberId) : []),
    ];
    let best: { tier: SpendingTier; at: string } | undefined;
    for (const f of facts) {
      const v = tiers.parseVibeFact(f.text);
      if (v === undefined || v.localDate !== date) continue;
      if (best === undefined || f.learnedAt >= best.at) best = { tier: v.tier, at: f.learnedAt };
    }
    return best?.tier;
  }

  function blendFor(input: SuggestTurnInput, people: readonly Member[]): tiers.TierBlend {
    const signals = collectTierSignals({
      trip: input.trip,
      members: people,
      groupFacts: deps.groupMemory.recall(input.group.groupId),
      activities: stores.group.trips.listActivities(input.trip.tripId),
      bookings: stores.group.bookings.listByTrip(input.trip.tripId),
      expenses: stores.group.expenses.listByTrip(input.trip.tripId),
      entries: stores.group.expenses.listEntries(input.trip.tripId),
      travel: deps.travelFacts?.(input.group.groupId) ?? [],
      groupLines: input.groupLines.filter(
        (l) => l.messageId === undefined || !answeredIds.has(l.messageId),
      ),
      privateFacts: (id) => privateFacts(input, id),
    });
    return tiers.blendTiers(people.map((p) => tiers.inferTier(signals.get(p.memberId) ?? [])));
  }

  async function catalog(
    input: SuggestTurnInput,
    category: VenueCategory,
  ): Promise<readonly Venue[] | undefined> {
    if (deps.places === undefined) return undefined;
    const res = await deps.places.search({ city: input.trip.city, category });
    return res.ok ? res.value : undefined;
  }

  async function placesText(
    input: SuggestTurnInput,
    ask: SuggestAsk,
    when: SuggestWhen,
    people: readonly Member[],
    target: SpendingTier,
    stretch: SpendingTier | undefined,
    headerPrefix: string | undefined,
  ): Promise<string | undefined> {
    // Minors (SAFETY §2.7): nothing adults-only with anyone under 18 (or of
    // unknown age) along. A bar ask with a minor going gets food instead.
    const kidsAlong = people.filter((m) => safety.isMinor(m, input.now));
    const cautious = kidsAlong.length > 0 || people.some((m) => safety.isAgeUnknown(m));
    let category = ask.category;
    let lead = headerPrefix;
    if (category === 'bar' && cautious) {
      category = 'restaurant';
      const names = kidsAlong.map((m) => m.displayName);
      lead =
        names.length > 0
          ? `no bars with ${names.join(', ')} along, so food instead`
          : 'no bars on this one, so food instead';
    }
    const all = await catalog(input, category);
    if (all === undefined || all.length === 0) return undefined;
    // Dietary notes (group and each person's own) shape the list, never the text.
    const notes = [
      ...deps.groupMemory
        .recall(input.group.groupId)
        .filter((f) => f.category === 'dietary')
        .map((f) => f.text),
      ...people.flatMap((m) =>
        privateFacts(input, m.memberId)
          .filter((f) => f.category === 'dietary')
          .map((f) => f.text),
      ),
    ];
    const need = dietaryNeeds(notes);
    let pool = all.filter((p) => !(cautious && p.adultsOnly));
    if (category === 'restaurant') {
      const fit = pool.filter(
        (p) =>
          (!need.veg || p.tags.includes('vegetarian_options') || p.tags.includes('vegetarian')) &&
          !(need.noSeafood && SEAFOOD_KIND.test(p.kind)),
      );
      if (fit.length >= 2) pool = fit;
    }
    if (pool.length === 0) return undefined;

    // A figure: the ask's (said in this thread), else in a DM the member's own.
    // Only compared in one currency: a catalog priced otherwise gets no figure.
    const sameCurrency = pool.every((p) => p.currency === input.trip.currency);
    let figure: number | undefined = sameCurrency ? ask.perPersonBudgetMinor : undefined;
    let overNote: string | undefined =
      figure !== undefined ? `over ${formatMoney(money(figure, input.trip.currency))}` : undefined;
    if (figure === undefined && sameCurrency && input.lane === 'dm') {
      const own = ownBudget(privateFacts(input, input.me.memberId), input.trip.currency);
      if (
        own !== undefined &&
        own.currency === input.trip.currency &&
        (own.figure.period === 'day' || own.figure.period === 'night')
      ) {
        figure = own.amountMinor;
        overNote = `over your ${formatMoney(money(own.amountMinor, own.currency))} a ${own.figure.period}`;
      }
    }
    const ranked = tiers.rankPlaces(pool, {
      target,
      ...(stretch !== undefined ? { stretch } : {}),
      ...(figure !== undefined ? { perPersonBudgetMinor: figure } : {}),
    });
    const allOver = figure !== undefined && ranked.every((r) => r.overBudget);
    let header: string;
    if (allOver && ask.perPersonBudgetMinor !== undefined) {
      header = `nothing under ${formatMoney(money(figure!, input.trip.currency))} a head ${when}. closest:`;
    } else if (lead !== undefined) {
      header = `${lead}:`;
    } else {
      header = headerFor({ ...ask, category }, when);
    }
    const lines: SuggestionLine[] = ranked.map((r) => ({
      place: r.place,
      stepUp: r.stepUp,
      ...(r.overBudget && overNote !== undefined && !allOver ? { overNote } : {}),
    }));
    return renderSuggestions(header, lines);
  }

  async function ask(input: SuggestTurnInput, a: SuggestAsk): Promise<SuggestOutcome | undefined> {
    const tz = input.trip.timeZone;
    const when = whenFor(a, input.now, tz);
    const date = dateFor(when, input.now, tz);
    // No catalog for this city: not ours to answer.
    const has = await catalog(input, a.category === 'bar' ? 'bar' : a.category);
    if (has === undefined || has.length === 0) return undefined;
    const people = going(input, when);
    const key = keyOf(input.group.groupId, input.lane, input.me.memberId);

    let target: SpendingTier | undefined;
    let stretch: SpendingTier | undefined;
    if (a.statedTier !== undefined) target = a.statedTier;
    else if (a.perPersonBudgetMinor !== undefined)
      target = tiers.tierForPerPerson(a.perPersonBudgetMinor);
    else {
      target = vibeFor(input, date);
      if (target === undefined) {
        const blend = blendFor(input, people);
        if (blend.status === 'known') {
          target = blend.target;
          stretch = blend.stretch;
        } else if (liveQuestion(key, input.now) !== undefined || askedOn.has(`${key}|${date}`)) {
          // Asked once already for that day and nobody answered: never the
          // same question twice (VOICE §4.11), the middle of the range instead.
          target = 'mid';
        } else {
          askedOn.add(`${key}|${date}`);
          if (askedOn.size > ANSWERED_KEEP) askedOn.delete(askedOn.values().next().value!);
          open.set(key, { ask: a, when, date, askedAt: input.now });
          return { text: questionText(when), note: 'suggest:question' };
        }
      }
    }
    const text = await placesText(input, a, when, people, target!, stretch, undefined);
    if (text === undefined) return undefined;
    return { text, note: 'suggest:places', target: target! };
  }

  async function answer(
    input: SuggestTurnInput,
    text: string,
    opts: { readonly addressed: boolean; readonly replyToMessageId?: MessageId },
  ): Promise<SuggestOutcome | undefined> {
    const key = keyOf(input.group.groupId, input.lane, input.me.memberId);
    const q = liveQuestion(key, input.now);
    if (q === undefined) return undefined;
    const quoted = opts.replyToMessageId !== undefined && opts.replyToMessageId === q.messageId;
    if (opts.replyToMessageId !== undefined && !quoted) return undefined;
    if (!quoted && !opts.addressed) return undefined;
    const tier = tiers.vibeAnswer(text);
    if (tier === undefined) return undefined;
    open.delete(key);
    answeredIds.add(input.messageId);
    if (answeredIds.size > ANSWERED_KEEP) {
      answeredIds.delete(answeredIds.values().next().value!);
    }
    // Remembered for that day: the group's in the group thread, the member's own in a DM.
    const fact = tiers.formatVibeFact(tier, q.date);
    const memo = {
      category: 'logistics' as const,
      text: fact,
      aboutMemberIds: [],
      sourceMessageId: input.messageId,
      sourceTripId: input.trip.tripId,
      now: input.now,
    };
    if (input.lane === 'group') deps.groupMemory.remember(input.group.groupId, memo);
    else
      deps.memberMemory.remember(input.me.memberId, input.group.groupId, {
        ...memo,
        aboutMemberIds: [input.me.memberId],
        sourceLane: 'private',
      });
    const people = going(input, q.when);
    const out = await placesText(input, q.ask, q.when, people, tier, undefined, undefined);
    const body = out ?? `${VIBE_ACK[tier]}`;
    const textOut = out === undefined ? body : `${VIBE_ACK[tier]}. ${out.charAt(0)}${out.slice(1)}`;
    return {
      text: textOut.length <= SUGGEST_MAX_CHARS ? textOut : (out ?? body),
      note: 'suggest:answered',
      target: tier,
    };
  }

  return {
    ask,
    answer,
    noteQuestionSent(input, messageId) {
      const q = open.get(keyOf(input.group.groupId, input.lane, input.me.memberId));
      if (q !== undefined) q.messageId = messageId;
    },
    pending(input) {
      return (
        liveQuestion(keyOf(input.group.groupId, input.lane, input.me.memberId), input.now) !==
        undefined
      );
    },
  };
}

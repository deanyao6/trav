/**
 * "Who had what?" (T-011), the deterministic half: a member's words about a
 * receipt → claim operations → the T-003 itemized split.
 *
 * The poster's caption ("dinner, i paid, Arjun didn't drink") and any later
 * answer ("dean and i split the paella, arjun had the burrata, the cava was
 * the 3 of us") are parsed clause by clause into `ClaimOp`s. Each op names
 * members (by name, "i/me/mine", "everyone", "the 3 of us", "he/she" for the
 * last person named) and lines (`matchLines`: "drinks", "the wine", "the
 * paella"). Anything that names a person or a line Trav can't place becomes
 * one question instead of a guess (VOICE §4.11). These words are the
 * member's own chat, never document text; only line labels (already
 * sanitized) come from the receipt.
 *
 * `buildSplit` turns the accumulated state into an itemized `SplitSpec`:
 * a claimed line goes to its claimants, an unclaimed one to everyone at the
 * table who may have had it ("didn't drink" keeps a member off the drink
 * lines, "only had water" off everything but the water), and tax, service and
 * tip stay unclaimed so core allocates them pro-rata to item subtotals.
 */
import type { LineItem, MemberId, SplitSpec } from '@trav/core';
import { isDrinkLine, matchLines, normalizeWords } from './receiptLines.js';

export interface ClaimMember {
  readonly memberId: MemberId;
  readonly displayName: string;
}

export interface ClaimContext {
  /** Active, non-guest members in group order. */
  readonly members: readonly ClaimMember[];
  /** Who wrote the words ("i", "me", "mine"). */
  readonly senderId: MemberId;
  readonly lines: readonly LineItem[];
  /** Who's at the table right now (for "everyone", "the 3 of us"). */
  readonly table: readonly MemberId[];
}

export type PeopleRef =
  | { readonly kind: 'members'; readonly ids: readonly MemberId[] }
  | { readonly kind: 'table' }
  | { readonly kind: 'count'; readonly n: number };

export type ClaimOp =
  | { readonly op: 'payer'; readonly memberId: MemberId }
  | { readonly op: 'exclude'; readonly memberIds: readonly MemberId[] }
  | { readonly op: 'include'; readonly memberIds: readonly MemberId[] }
  | { readonly op: 'claim'; readonly lineIds: readonly string[]; readonly people: PeopleRef }
  | { readonly op: 'only'; readonly memberIds: readonly MemberId[]; readonly lineIds: readonly string[] }
  | { readonly op: 'no_drinks'; readonly memberIds: readonly MemberId[] }
  | { readonly op: 'rest'; readonly people: PeopleRef }
  | { readonly op: 'even' };

export type ClaimParse =
  | {
      readonly kind: 'ops';
      readonly ops: readonly ClaimOp[];
      /** Clauses that meant nothing to Trav and named nobody ("dinner", "lol"). */
      readonly noise: number;
      /** "dinner" / "lunch" / "drinks" when the words say what it was. */
      readonly occasion?: string;
    }
  | { readonly kind: 'question'; readonly question: string };

/** Ops that say something about lines (as opposed to who paid or who was there). */
export function hasItemInfo(ops: readonly ClaimOp[]): boolean {
  return ops.some(
    (o) =>
      o.op === 'claim' ||
      // "Crowley only had water" with no water line is an exclusion, not a claim
      (o.op === 'only' && o.lineIds.length > 0) ||
      o.op === 'no_drinks' ||
      o.op === 'rest' ||
      o.op === 'even',
  );
}

// ---------- people ----------

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

const ME = /^(?:i|me|myself|mine|my|my own)$/;
const TABLE = /^(?:everyone|everybody|all of us|all|the table|the whole table|the group|us all|we all|the lot of us|all of them|everyone there)$/;
const COUNT = /^(?:the |all )?(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten) of us$/;
const PRONOUN = /^(?:he|she|they|him|her|them)$/;

type PeopleResult = { readonly ok: true; readonly ref: PeopleRef } | { readonly ok: false; readonly what: string };

function firstName(name: string): string {
  return normalizeWords(name).split(' ')[0] ?? '';
}

function resolvePeople(
  raw: string,
  ctx: ClaimContext,
  lastSubject: readonly MemberId[] | undefined,
): PeopleResult {
  const s = raw
    .trim()
    .replace(/^(?:for|by|with|between|among)\s+/, '')
    .replace(/\s+(?:too|as well|both|each|together)$/, '')
    .trim();
  if (TABLE.test(s)) return { ok: true, ref: { kind: 'table' } };
  const count = COUNT.exec(s);
  if (count !== null) {
    const n = NUMBER_WORDS[count[1]!] ?? Number(count[1]);
    return n >= 1 ? { ok: true, ref: { kind: 'count', n } } : { ok: false, what: raw.trim() };
  }
  const parts = s
    .split(/\s*(?:,|&|\+|\band\b|\bplus\b)\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { ok: false, what: raw.trim() };
  const ids: MemberId[] = [];
  for (const p0 of parts) {
    const p = p0.replace(/'s$/, '').replace(/^(?:the|my|our)\s+/, '');
    if (ME.test(p)) {
      ids.push(ctx.senderId);
      continue;
    }
    if (PRONOUN.test(p) && lastSubject !== undefined && lastSubject.length > 0) {
      ids.push(...lastSubject);
      continue;
    }
    const norm = normalizeWords(p);
    const hit = ctx.members.filter(
      (m) => normalizeWords(m.displayName) === norm || firstName(m.displayName) === norm,
    );
    if (hit.length !== 1) return { ok: false, what: p0 };
    ids.push(hit[0]!.memberId);
  }
  return { ok: true, ref: { kind: 'members', ids: [...new Set(ids)] } };
}

/** Members a ref names right now (`undefined` for "the N of us" that doesn't fit). */
function membersOf(
  ref: PeopleRef,
  table: readonly MemberId[],
  named: readonly MemberId[],
): readonly MemberId[] | undefined {
  if (ref.kind === 'members') return ref.ids;
  if (ref.kind === 'table') return table;
  if (table.length === ref.n) return table;
  if (named.length === ref.n) return named;
  return undefined;
}

// ---------- clauses ----------

const FILLER = /^(?:and|also|plus|oh|ok|okay|so|then|btw|um|hey|yeah|lol)\s+/;
const OCCASION = /\b(dinner|lunch|breakfast|brunch|drinks|groceries|coffee|snacks|tapas)\b/;

/** Lowercase, curly quotes straight, "@trav" gone, "X's paying" → "X is paying" (possessive at the end stays). */
function prepare(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/@trav\b|^\s*(?:hey\s+)?trav\b[,:]?/gi, ' ')
    .toLowerCase()
    .replace(/(\w)'s(?=\s+\S)/g, '$1 is')
    .replace(/\s+/g, ' ')
    .trim();
}

type Clause =
  | { readonly kind: 'ops'; readonly ops: readonly ClaimOp[]; readonly subject?: readonly MemberId[] }
  | { readonly kind: 'question'; readonly question: string }
  | { readonly kind: 'noise' }
  | { readonly kind: 'unknown' };

const EVEN =
  /^(?:just )?(?:split (?:it |everything |the whole thing |the bill )?(?:evenly|equally|even)|(?:an )?even split|split it|split evenly|split it all|split everything|evenly)$/;
const PAYER = [
  /^(.+?) paid(?: for (?:it|this|that|dinner|lunch|breakfast|brunch|drinks|everything|all of it|the (?:bill|check|meal|lot|whole thing)))?$/,
  /^paid by (.+)$/,
  /^(?:it is |it was )?on (.+)$/,
  /^(.+?) (?:got|covered|picked up) (?:it|this|the (?:bill|check|tab))$/,
];
const EXCLUDE = [
  /^(.+?) (?:is |was |are |were )?(?:paying|paid|pays|covering|covered|got|getting) (?:for )?(?:his|her|their|my) own(?: (?:stuff|food|meal|bit|part|share|thing))?$/,
  /^(.+?) (?:wasn't|was not|isn't|is not|weren't|were not|wasnt|isnt) (?:there|here|in|with us|at (?:dinner|lunch|breakfast|the table)|eating|having anything|on this one|in on (?:this|it|this one))$/,
  /^(.+?) (?:didn't|did not|didnt) (?:come|eat|eat anything|have anything|order anything|join)$/,
  /^(.+?) (?:is|was) out$/,
  /^(?:split (?:it )?)?(?:with |between |among )?(?:everyone|everybody|all of us) (?:but|except|minus|apart from|other than) (.+)$/,
  /^(?:not|without|except|minus|excluding|leave out|leave) (.+?)(?: out)?$/,
];
const INCLUDE = /^(.+?) (?:was|were|is) (?:there|in|with us)(?: too| as well)?$/;
const NO_DRINKS = [
  /^(.+?) (?:didn't|did not|didnt|don't|doesn't|wasn't|was not|isn't|is not|never) (?:drink|drinking|have (?:a |any )?drinks?|have any alcohol|drink anything|drinking tonight)$/,
  /^(?:no (?:drinks|alcohol) for|drinks without|drinks not) (.+)$/,
];
const ONLY = /^(.+?) (?:only|just) (?:had|got|ordered|ate|drank) (.+)$/;
const REST = [
  /^(?:everything else|the rest|rest|all the rest|everything else is|the rest is|everything else was|the rest was)\s+(?:was |is )?(?:split |shared )?(?:between |with |among |for |by |on )?(.+)$/,
  /^split the rest (?:between|with|among) (.+)$/,
];
const SPLIT_ITEM = /^split (?:the )?(.+?) (?:between|with|among) (.+)$/;
const SUBJECT_SPLIT = /^(.+?) (?:split|shared|share|splitting|sharing|went halves on|went halfs on) (.+?)(?: between (?:us|them|the two of us))?$/;
const HAD = /^(.+?) (?:had|got|ordered|ate|drank|took|grabbed) (.+)$/;
const WAS = /^(.+?) (?:was for|were for|is for|are for|was|were|is|are|for|on) (.+)$/;
const REST_WORDS = /^(?:everything|everything else|it all|all of it|the rest|rest|the lot)$/;

function itemOps(
  itemPhrase: string,
  people: PeopleResult,
  ctx: ClaimContext,
): Clause {
  if (!people.ok) return { kind: 'question', question: whoQuestion(people.what) };
  const phrase = itemPhrase.trim();
  if (REST_WORDS.test(phrase)) return { kind: 'ops', ops: [{ op: 'rest', people: people.ref }] };
  const m = matchLines(phrase, ctx.lines);
  if (m.kind === 'none') return { kind: 'question', question: whichLineQuestion(phrase, ctx.lines) };
  if (m.kind === 'ambiguous') return { kind: 'question', question: ambiguousQuestion(phrase, m.lineIds, ctx.lines) };
  return { kind: 'ops', ops: [{ op: 'claim', lineIds: m.lineIds, people: people.ref }] };
}

function subjectOf(p: PeopleResult): readonly MemberId[] | undefined {
  return p.ok && p.ref.kind === 'members' ? p.ref.ids : undefined;
}

function parseClause(c: string, ctx: ClaimContext, last: readonly MemberId[] | undefined): Clause {
  const people = (s: string): PeopleResult => resolvePeople(s, ctx, last);
  const ids = (p: PeopleResult): readonly MemberId[] | undefined =>
    p.ok && p.ref.kind === 'members' ? p.ref.ids : undefined;

  if (EVEN.test(c)) return { kind: 'ops', ops: [{ op: 'even' }] };
  for (const re of NO_DRINKS) {
    const m = re.exec(c);
    if (m !== null) {
      const p = people(m[1]!);
      const who = ids(p);
      if (who === undefined) return { kind: 'question', question: whoQuestion(m[1]!) };
      return { kind: 'ops', ops: [{ op: 'no_drinks', memberIds: who }], subject: who };
    }
  }
  for (const re of EXCLUDE) {
    const m = re.exec(c);
    if (m !== null) {
      const p = people(m[1]!);
      const who = ids(p);
      if (who === undefined) {
        if (p.ok) break; // "everyone wasn't there" is not an exclusion
        return { kind: 'question', question: whoQuestion(m[1]!) };
      }
      return { kind: 'ops', ops: [{ op: 'exclude', memberIds: who }], subject: who };
    }
  }
  for (const re of PAYER) {
    const m = re.exec(c);
    if (m !== null) {
      const p = people(m[1]!);
      const who = ids(p);
      if (who !== undefined && who.length === 1)
        return { kind: 'ops', ops: [{ op: 'payer', memberId: who[0]! }], subject: who };
      if (!p.ok && re !== PAYER[2]) return { kind: 'question', question: whoQuestion(m[1]!) };
    }
  }
  {
    const m = INCLUDE.exec(c);
    if (m !== null) {
      const who = ids(people(m[1]!));
      if (who !== undefined) return { kind: 'ops', ops: [{ op: 'include', memberIds: who }], subject: who };
    }
  }
  {
    const m = ONLY.exec(c);
    if (m !== null) {
      const p = people(m[1]!);
      const who = ids(p);
      if (who === undefined) return { kind: 'question', question: whoQuestion(m[1]!) };
      const lm = matchLines(m[2]!, ctx.lines);
      // "Crowley only had water" with no water on the receipt: Crowley had nothing on it.
      const lineIds = lm.kind === 'lines' ? lm.lineIds : [];
      if (lm.kind === 'ambiguous') return { kind: 'ops', ops: [{ op: 'only', memberIds: who, lineIds: lm.lineIds }], subject: who };
      return { kind: 'ops', ops: [{ op: 'only', memberIds: who, lineIds }], subject: who };
    }
  }
  for (const re of REST) {
    const m = re.exec(c);
    if (m !== null) {
      const p = people(m[1]!);
      if (!p.ok) return { kind: 'question', question: whoQuestion(m[1]!) };
      return { kind: 'ops', ops: [{ op: 'rest', people: p.ref }] };
    }
  }
  {
    const m = SPLIT_ITEM.exec(c);
    if (m !== null) return itemOps(m[1]!, people(m[2]!), ctx);
  }
  {
    const m = SUBJECT_SPLIT.exec(c);
    if (m !== null) {
      const p = people(m[1]!);
      const out = itemOps(m[2]!, p, ctx);
      return out.kind === 'ops' ? { ...out, ...(subjectOf(p) !== undefined ? { subject: subjectOf(p)! } : {}) } : out;
    }
  }
  {
    const m = HAD.exec(c);
    if (m !== null) {
      const p = people(m[1]!);
      const out = itemOps(m[2]!, p, ctx);
      return out.kind === 'ops' ? { ...out, ...(subjectOf(p) !== undefined ? { subject: subjectOf(p)! } : {}) } : out;
    }
  }
  {
    const m = WAS.exec(c);
    if (m !== null) {
      const subject = m[1]!.trim();
      const rest = m[2]!.trim();
      // "the wine was mine", "the cava was the 3 of us", "the burrata was arjun's", "the wine was shared"
      const p = /^(?:shared|for (?:the )?table)$/.test(rest) ? ({ ok: true, ref: { kind: 'table' } } as const) : people(rest);
      return itemOps(subject, p, ctx);
    }
  }
  return { kind: 'unknown' };
}

/** A clause that names nobody and no line is chatter ("dinner", "here's the receipt"). */
function namesSomething(c: string, ctx: ClaimContext): boolean {
  const words = normalizeWords(c).split(' ');
  if (words.some((w) => w === 'i' || w === 'me' || w === 'my' || w === 'mine')) return true;
  if (ctx.members.some((m) => words.includes(firstName(m.displayName)))) return true;
  return matchLines(c, ctx.lines).kind !== 'none' && words.length > 1;
}

function parseOne(
  c: string,
  ctx: ClaimContext,
  last: readonly MemberId[] | undefined,
): Clause {
  const direct = parseClause(c, ctx, last);
  if (direct.kind === 'ops') return direct;
  // "dean and i split the paella and arjun had the burrata": try each " and " split
  const ands = [...c.matchAll(/ and /g)].map((m) => m.index);
  for (const at of ands) {
    const left = parseClause(c.slice(0, at).trim(), ctx, last);
    if (left.kind !== 'ops') continue;
    const right = parseOne(c.slice(at + 5).trim(), ctx, left.subject ?? last);
    if (right.kind === 'ops')
      return {
        kind: 'ops',
        ops: [...left.ops, ...right.ops],
        ...(right.subject !== undefined || left.subject !== undefined
          ? { subject: right.subject ?? left.subject! }
          : {}),
      };
  }
  return direct;
}

/**
 * A member's words → claim ops, or the one question Trav needs answered.
 * Clauses that name nobody and no line are counted as `noise`.
 */
export function parseClaims(text: string, ctx: ClaimContext): ClaimParse {
  const prepared = prepare(text);
  const occasion = OCCASION.exec(prepared)?.[1];
  const clauses = prepared
    .split(/\s*(?:[,;.!?\n]+|\bthen\b)\s*/)
    .map((c) => {
      let x = c.trim().replace(/["']+$/, '').replace(/^["']+/, '');
      while (FILLER.test(x)) x = x.replace(FILLER, '');
      return x.trim();
    })
    .filter((c) => c.length > 0);
  const ops: ClaimOp[] = [];
  let noise = 0;
  let last: readonly MemberId[] | undefined;
  for (const c of clauses) {
    const r = parseOne(c, ctx, last);
    if (r.kind === 'ops') {
      ops.push(...r.ops);
      if (r.subject !== undefined) last = r.subject;
      continue;
    }
    if (r.kind === 'question') return r;
    if (namesSomething(c, ctx)) return { kind: 'question', question: GENERIC_QUESTION };
    noise += 1;
  }
  return { kind: 'ops', ops, noise, ...(occasion !== undefined ? { occasion } : {}) };
}

// ---------- questions (VOICE §4.11: one question, the last line) ----------

export const GENERIC_QUESTION =
  'didn\'t catch that one. who had what? like "arjun had the burrata, the wine was mine"';

function quoted(s: string): string {
  const t = s.replace(/["\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 30 ? `${t.slice(0, 30).trim()}…` : t;
}

function whoQuestion(what: string): string {
  return `who's "${quoted(what)}"? name them and i'll fix the split`;
}

function labelsOf(ids: readonly string[], lines: readonly LineItem[]): string[] {
  return ids.map((id) => lines.find((l) => l.lineId === id)?.label ?? id);
}

function whichLineQuestion(phrase: string, lines: readonly LineItem[]): string {
  const items = lines.filter((l) => l.kind === 'item').map((l) => l.label);
  const shown = items.slice(0, 4).join(', ');
  const more = items.length > 4 ? ', …' : '';
  return `which line is "${quoted(phrase)}"? i've got ${shown}${more}`;
}

function ambiguousQuestion(phrase: string, ids: readonly string[], lines: readonly LineItem[]): string {
  const ls = labelsOf(ids, lines).slice(0, 3);
  return `"${quoted(phrase)}" could be ${ls.join(' or ')}. which one?`;
}

// ---------- state → split ----------

export interface ClaimState {
  readonly payer: MemberId;
  /** Who's in by default (the plan's roster, else everyone), minus exclusions. */
  readonly table: readonly MemberId[];
  readonly excluded: readonly MemberId[];
  /** Explicit claims per line id. */
  readonly claims: Readonly<Record<string, readonly MemberId[]>>;
  /** Per-member restriction: only these lines, or no alcoholic lines. */
  readonly allowed: Readonly<Record<string, readonly string[] | 'no_drinks'>>;
  /** "everything else was dean and me". */
  readonly rest?: readonly MemberId[];
  /** True once any words said something about lines (claims, "didn't drink", "split evenly"). */
  readonly itemInfo: boolean;
}

export function initialClaimState(payer: MemberId, table: readonly MemberId[]): ClaimState {
  return { payer, table: [...table], excluded: [], claims: {}, allowed: {}, itemInfo: false };
}

function without<T>(xs: readonly T[], drop: readonly T[]): T[] {
  return xs.filter((x) => !drop.includes(x));
}

function inOrder(ids: Iterable<MemberId>, order: readonly MemberId[]): MemberId[] {
  const set = new Set(ids);
  return order.filter((id) => set.has(id));
}

/** Named members in a message (for "the 3 of us" when the table doesn't fit). */
function namedIn(ops: readonly ClaimOp[]): MemberId[] {
  const out: MemberId[] = [];
  for (const o of ops) {
    if (o.op === 'claim' && o.people.kind === 'members') out.push(...o.people.ids);
    if (o.op === 'rest' && o.people.kind === 'members') out.push(...o.people.ids);
    if (o.op === 'only' || o.op === 'no_drinks' || o.op === 'include') out.push(...o.memberIds);
  }
  return [...new Set(out)];
}

export type ApplyResult =
  | { readonly kind: 'state'; readonly state: ClaimState }
  | { readonly kind: 'question'; readonly question: string };

/** Applies one message's ops, in order, to the receipt's claim state. */
export function applyClaims(
  state: ClaimState,
  ops: readonly ClaimOp[],
  order: readonly MemberId[],
): ApplyResult {
  let s: ClaimState = state;
  const named = namedIn(ops);
  const resolve = (ref: PeopleRef): readonly MemberId[] | undefined =>
    membersOf(ref, s.table, inOrder(named, order));
  for (const o of ops) {
    switch (o.op) {
      case 'payer':
        s = { ...s, payer: o.memberId };
        break;
      case 'exclude': {
        const claims: Record<string, readonly MemberId[]> = {};
        for (const [k, v] of Object.entries(s.claims)) claims[k] = without(v, o.memberIds);
        s = {
          ...s,
          table: without(s.table, o.memberIds),
          excluded: [...new Set([...s.excluded, ...o.memberIds])],
          claims,
          ...(s.rest !== undefined ? { rest: without(s.rest, o.memberIds) } : {}),
        };
        break;
      }
      case 'include': {
        // "crowley was there" undoes "crowley only had water" (a line-less `only`) too
        const allowed = Object.fromEntries(
          Object.entries(s.allowed).filter(([m]) => !o.memberIds.includes(m)),
        );
        s = {
          ...s,
          allowed,
          table: inOrder([...s.table, ...o.memberIds], order),
          excluded: without(s.excluded, o.memberIds),
        };
        break;
      }
      case 'claim': {
        const who = resolve(o.people);
        if (who === undefined || who.length === 0)
          return { kind: 'question', question: countQuestion(o.people) };
        const claims = { ...s.claims };
        for (const id of o.lineIds) claims[id] = inOrder(who, order);
        s = { ...s, claims, excluded: without(s.excluded, who), itemInfo: true };
        break;
      }
      case 'only': {
        const allowed = { ...s.allowed };
        for (const m of o.memberIds) allowed[m] = o.lineIds;
        s = { ...s, allowed, itemInfo: s.itemInfo || o.lineIds.length > 0 };
        if (o.lineIds.length === 0) {
          s = {
            ...s,
            table: without(s.table, o.memberIds),
            excluded: [...new Set([...s.excluded, ...o.memberIds])],
          };
        }
        break;
      }
      case 'no_drinks': {
        const allowed = { ...s.allowed };
        for (const m of o.memberIds) allowed[m] = 'no_drinks';
        s = { ...s, allowed, itemInfo: true };
        break;
      }
      case 'rest': {
        const who = resolve(o.people);
        if (who === undefined || who.length === 0)
          return { kind: 'question', question: countQuestion(o.people) };
        s = { ...s, rest: inOrder(who, order), excluded: without(s.excluded, who), itemInfo: true };
        break;
      }
      case 'even': {
        const { rest: _rest, ...base } = s;
        void _rest;
        s = { ...base, claims: {}, allowed: {}, itemInfo: true };
        break;
      }
    }
  }
  return { kind: 'state', state: s };
}

function countQuestion(ref: PeopleRef): string {
  return ref.kind === 'count'
    ? `which ${String(ref.n)}? name them and i'll fix the split`
    : 'who was in on that one?';
}

export interface BuiltSplit {
  readonly split: Extract<SplitSpec, { method: 'itemized' }>;
  /** Who's in, group order. */
  readonly participants: readonly MemberId[];
}

/**
 * The itemized split for the current state. `undefined` when nobody is left
 * (every member excluded): Trav asks who's in instead.
 */
export function buildSplit(
  state: ClaimState,
  lines: readonly LineItem[],
  order: readonly MemberId[],
): BuiltSplit | undefined {
  const claimants = Object.entries(state.claims)
    .filter(([id]) => lines.some((l) => l.lineId === id))
    .flatMap(([, v]) => v);
  const participants = inOrder(
    [...state.table, ...claimants, ...(state.rest ?? [])].filter(
      (id) => !state.excluded.includes(id) || claimants.includes(id),
    ),
    order,
  );
  if (participants.length === 0) return undefined;
  const may = (m: MemberId, line: LineItem): boolean => {
    const a = state.allowed[m];
    if (a === undefined) return true;
    if (a === 'no_drinks') return !isDrinkLine(line.label);
    return a.includes(line.lineId);
  };
  const lineItems: LineItem[] = lines.map((line) => {
    if (line.kind !== 'item') return { ...line, claimedBy: [] };
    const explicit = state.claims[line.lineId];
    if (explicit !== undefined && explicit.length > 0) {
      return { ...line, claimedBy: inOrder(explicit.filter((m) => participants.includes(m)), order) };
    }
    const base = state.rest !== undefined && state.rest.length > 0 ? state.rest : participants;
    let who = base.filter((m) => participants.includes(m) && may(m, line));
    if (who.length === 0) who = base.filter((m) => participants.includes(m));
    if (who.length === 0) who = participants;
    const all = who.length === participants.length;
    return { ...line, claimedBy: all ? [] : inOrder(who, order) };
  });
  // Someone who may have nothing on the receipt is not in the split at all.
  const eaters = new Set<MemberId>();
  for (const l of lineItems) {
    if (l.kind !== 'item') continue;
    for (const m of l.claimedBy.length > 0 ? l.claimedBy : participants) eaters.add(m);
  }
  // (When anyone is dropped here, no line is unclaimed: an unclaimed line
  // would have made every participant an eater.)
  const finalParticipants = participants.filter((m) => eaters.has(m));
  if (finalParticipants.length === 0) return undefined;
  return {
    split: { method: 'itemized', participants: finalParticipants, lineItems },
    participants: finalParticipants,
  };
}

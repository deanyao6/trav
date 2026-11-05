/**
 * T-182: when an ask is clear enough to buy on (T-168 auto-buy). A positive
 * grammar, decided in code: only a narrow canonical imperative ask passes.
 * Everything else, however close, is `eligible: false`, and the caller shows
 * the one-tap confirm card with the party and the price instead. Missing an
 * auto-buy costs one tap; a wrong one costs money.
 *
 * The grammar, over the folded text (D-042):
 *
 *   msg     := ADDR lead* ASK (sep* clause)* sep*
 *   ADDR    := "@trav" [,:]  |  [hey|yo] "trav" (","|":")      (at the start)
 *   lead    := pls | please | plz
 *   ASK     := VERB OBJPARTY TICKETS when?
 *            | VERB TICKETS when? (for FORPARTY)? when?
 *   OBJPARTY:= GROUP [EXCEPT] | [the|all] N of us        (no names: T-173 r2 #3)
 *   VERB    := get | grab | book | buy | snag | reserve | purchase
 *   TICKETS := [the] [N] VENUE [tickets|ticket|tix]
 *            | [the] [N] (tickets|ticket|tix) (for|to|at) VENUE
 *   party   := GROUP [EXCEPT] | [the|all] N of us | NAMES
 *   FORPARTY:= party | N
 *   GROUP   := us [all] | all of us | everyone | everybody | the [whole] group
 *   EXCEPT  := (except [for] | but [not] | minus | without | excluding | bar) NAMES
 *   NAMES   := NAME ((, | and | & | , and) NAME)*       NAME := a member, or me/myself
 *   clause  := OUT | EXCEPT | TAIL
 *   OUT     := [since|because|cause|cuz|as] NAME ('s|is) OUTSTATE [tonight|today]
 *            | NAME (can't|cannot) (come|make it|go|join) [tonight]
 *            | NAME (isn't|is not|'s not|won't) (coming|make it|joining) [tonight]
 *   TAIL    := thanks | thank you [trav] | thx | ty | pls | please | lol | haha
 *            | cheers | asap | when you get a (sec|second|chance|minute) | when you can
 *            | a whitelisted emoji (🙏 🎉 🔥 🙌 👍 ✅ …)
 *
 * Then the party must resolve cleanly against the roster: every name a
 * member, nobody both in and out, a stated count equal to the people it
 * names, at least one person going. And the offline ask reader
 * (`parseBookingRequest`) must read the same party: two readers that
 * disagree mean nobody is sure, so no auto-buy.
 *
 * Not decided here: the price cap, refundability, minors, idempotency. Those
 * stay with `ApprovalPolicy` and the proposal service; this predicate only
 * says the words were an unambiguous ask.
 */
import { stripInvisible } from '../untrusted.js';
import { foldText, parseBookingRequest, type BookingRequest, type VenueIndex } from './request.js';

export interface AutoBuyInput {
  /** The member's message, raw. */
  readonly text: string;
  readonly index: VenueIndex;
  /** The asking member's display name. */
  readonly sender: string;
  /** Every member's display name, the sender included. */
  readonly roster: readonly string[];
  /** Members already out tonight (the group's roster state), if any. */
  readonly alreadyOut?: readonly string[];
}

export type AutoBuyRejection =
  | 'empty'
  | 'too_long'
  | 'not_addressed'
  | 'sender_not_member'
  | 'question'
  | 'quoted'
  | 'character'
  | 'emoji'
  | 'grammar'
  | 'venue'
  | 'unknown_name'
  | 'party'
  | 'count_mismatch'
  | 'reader_disagrees';

export type AutoBuyVerdict =
  | {
      readonly eligible: true;
      /** The offline reader's request, which agrees with the grammar. */
      readonly request: BookingRequest;
      /** Display names of who is going, the sender first when they are. */
      readonly attendees: readonly string[];
      /** Display names said to be out in the message. */
      readonly excluded: readonly string[];
      readonly quantity: number;
    }
  | { readonly eligible: false; readonly reason: AutoBuyRejection };

/** Longest message the grammar reads; anything longer is a conversation, not an ask. */
export const AUTO_BUY_MAX_LENGTH = 200;

const VERBS: ReadonlySet<string> = new Set([
  'get',
  'grab',
  'book',
  'buy',
  'snag',
  'reserve',
  'purchase',
]);
const TICKET_WORDS: ReadonlySet<string> = new Set(['tickets', 'ticket', 'tix']);
const LEADS: ReadonlySet<string> = new Set(['pls', 'please', 'plz']);
const NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const WEEKDAYS: ReadonlySet<string> = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

/** Tails that add nothing to the ask. Each is a whole word sequence. */
const TAILS: readonly (readonly string[])[] = [
  ['thank', 'you', 'trav'],
  ['thanks', 'trav'],
  ['thank', 'you'],
  ['thanks'],
  ['thx'],
  ['ty'],
  ['tysm'],
  ['pls'],
  ['please'],
  ['plz'],
  ['lol'],
  ['haha'],
  ['cheers'],
  ['asap'],
  ['when', 'you', 'get', 'a', 'sec'],
  ['when', 'you', 'get', 'a', 'second'],
  ['when', 'you', 'get', 'a', 'chance'],
  ['when', 'you', 'get', 'a', 'minute'],
  ['when', 'u', 'get', 'a', 'sec'],
  ['when', 'u', 'get', 'a', 'chance'],
  ['when', 'you', 'can'],
  ['when', 'u', 'can'],
];

/**
 * Emoji that are only warmth. Laughing, winking, eye-roll, thinking,
 * grimacing and the like can mean "not really", so they are not here.
 */
const TAIL_EMOJI: ReadonlySet<string> = new Set([
  '🙏',
  '🎉',
  '🔥',
  '🙌',
  '👍',
  '✅',
  '😊',
  '😁',
  '🥳',
  '❤',
  '💯',
  '🤘',
  '✨',
  '💃',
  '🕺',
  '🎟',
  '🪩',
]);

/** Out-states after "<name>'s" / "<name> is". Each is a whole word sequence. */
const OUT_STATES: readonly (readonly string[])[] = [
  ['out', 'sick'],
  ['home', 'sick'],
  ['not', 'coming'],
  ['not', 'feeling', 'well'],
  ['not', 'well'],
  ['under', 'the', 'weather'],
  ['staying', 'in'],
  ['staying', 'home'],
  ['feeling', 'sick'],
  ['feeling', 'rough'],
  ['sick'],
  ['ill'],
  ['unwell'],
  ['hungover'],
  ['out'],
];
const OUT_LEADS: ReadonlySet<string> = new Set(['since', 'because', 'cause', 'cuz', 'coz', 'as']);

type Token =
  | { readonly kind: 'word'; readonly w: string }
  | { readonly kind: 'sep'; readonly ch: string }
  | { readonly kind: 'emoji'; readonly e: string };

/** Words after a name that make it the subject of a new clause, not a list item. */
const CLAUSE_AFTER_NAME: ReadonlySet<string> = new Set([
  "'s",
  'is',
  "isn't",
  'isnt',
  "can't",
  'cant',
  'cannot',
  "won't",
  'wont',
]);

/** Splits the folded text into words, separators and emoji, or a rejection. */
function tokenize(s: string): Token[] | AutoBuyRejection {
  const out: Token[] = [];
  let i = 0;
  const chars = [...s];
  while (i < chars.length) {
    const ch = chars[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[a-z0-9]/.test(ch)) {
      let w = '';
      while (i < chars.length && /[a-z0-9']/.test(chars[i]!)) w += chars[i++]!;
      // "henry's" is the name and a "'s"; any other apostrophe stays in the word ("can't").
      const poss = /^([a-z]+)'s$/.exec(w);
      if (poss !== null) {
        out.push({ kind: 'word', w: poss[1]! }, { kind: 'word', w: "'s" });
      } else {
        if (w.startsWith("'") || w.endsWith("'")) return 'character';
        out.push({ kind: 'word', w });
      }
      continue;
    }
    if (/[,.;!:()\-–—]/.test(ch)) {
      out.push({ kind: 'sep', ch });
      i++;
      continue;
    }
    if (ch === '&') {
      out.push({ kind: 'word', w: 'and' });
      i++;
      continue;
    }
    if (ch === '@') {
      // "@henry": a mention is the name. Only at a word's start.
      i++;
      continue;
    }
    if (ch === '?') return 'question';
    if (/["“”«»>`*_~|]/.test(ch)) return 'quoted';
    if (/\p{Extended_Pictographic}/u.test(ch)) {
      out.push({ kind: 'emoji', e: ch });
      i++;
      continue;
    }
    // Skin tones and variation selectors ride on the emoji before them.
    if (
      /\p{Emoji_Modifier}/u.test(ch) ||
      ch.codePointAt(0) === 0xfe0f ||
      ch.codePointAt(0) === 0xfe0e
    ) {
      i++;
      continue;
    }
    // A price ("€30"), a slash, a plus, a hashtag: outside the grammar.
    return 'character';
  }
  return out;
}

interface Party {
  readonly kind: 'group' | 'count' | 'names';
  readonly count?: number;
  /** Folded member keys, for `names`. */
  readonly names: readonly string[];
  /** Folded member keys excluded inside the party ("everyone except henry"). */
  readonly except: readonly string[];
}

interface Parse {
  readonly party?: Party;
  readonly ticketCount?: number;
  readonly out: readonly string[];
  readonly except: readonly string[];
}

/** Member lookup: folded full name (as words) and unique first name ⇒ display name. */
interface Roster {
  readonly byKey: ReadonlyMap<string, string>;
  /** Longest name in words. */
  readonly maxWords: number;
}

function rosterOf(names: readonly string[]): Roster {
  const byKey = new Map<string, string>();
  const firsts = new Map<string, number>();
  for (const n of names) {
    const f = foldText(n).trim().split(/\s+/)[0];
    if (f !== undefined && f.length > 0) firsts.set(f, (firsts.get(f) ?? 0) + 1);
  }
  let maxWords = 1;
  for (const n of names) {
    const words = foldText(n).trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    byKey.set(words.join(' '), n);
    maxWords = Math.max(maxWords, words.length);
    if (firsts.get(words[0]!) === 1 && !byKey.has(words[0]!)) byKey.set(words[0]!, n);
  }
  return { byKey, maxWords };
}

class Parser {
  i = 0;
  constructor(
    readonly toks: readonly Token[],
    readonly roster: Roster,
    readonly senderKey: string,
    readonly index: VenueIndex,
  ) {}

  word(offset = 0): string | undefined {
    const t = this.toks[this.i + offset];
    return t?.kind === 'word' ? t.w : undefined;
  }
  /** Consumes the exact word sequence, or nothing. */
  take(...ws: readonly string[]): boolean {
    for (let k = 0; k < ws.length; k++) if (this.word(k) !== ws[k]) return false;
    this.i += ws.length;
    return true;
  }
  takeAny(seqs: readonly (readonly string[])[]): boolean {
    for (const s of seqs) if (this.take(...s)) return true;
    return false;
  }
  count(): number | undefined {
    const w = this.word();
    if (w === undefined) return undefined;
    const n = /^\d{1,2}$/.test(w) ? Number(w) : NUMBERS[w];
    if (n === undefined || n < 1) return undefined;
    this.i++;
    return n;
  }

  /** A member (folded key of their display name), "me"/"myself" (the sender), or nothing. */
  name(): string | undefined {
    const w = this.word();
    if (w === 'me' || w === 'myself') {
      this.i++;
      return this.senderKey;
    }
    for (let k = this.roster.maxWords; k >= 1; k--) {
      const ws: string[] = [];
      for (let j = 0; j < k; j++) {
        const x = this.word(j);
        if (x === undefined) break;
        ws.push(x);
      }
      if (ws.length !== k) continue;
      const display = this.roster.byKey.get(ws.join(' '));
      if (display !== undefined) {
        this.i += k;
        return foldText(display).trim();
      }
    }
    return undefined;
  }

  /** NAME ((, | and | , and) NAME)*. A comma continues the list only into another name. */
  names(): string[] | undefined {
    const first = this.name();
    if (first === undefined) return undefined;
    const out = [first];
    for (;;) {
      const save = this.i;
      const sepTok = this.toks[this.i];
      let joined = false;
      // Only a comma continues a list; ".", ";", "-" and brackets end it.
      if (sepTok?.kind === 'sep' && sepTok.ch === ',') {
        this.i++;
        joined = true;
      }
      if (this.word() === 'and') {
        this.i++;
        joined = true;
      }
      if (!joined) break;
      const n = this.name();
      // "for me and chase, henry's sick": that name starts a clause, the list ended.
      const next = this.word();
      if (n === undefined || (next !== undefined && CLAUSE_AFTER_NAME.has(next))) {
        this.i = save;
        break;
      }
      out.push(n);
    }
    return out;
  }

  group(): boolean {
    return (
      this.take('all', 'of', 'us') ||
      this.take('us', 'all') ||
      this.take('us') ||
      this.take('everyone') ||
      this.take('everybody') ||
      this.take('the', 'whole', 'group') ||
      this.take('the', 'group')
    );
  }

  except(): string[] | undefined {
    const save = this.i;
    if (
      this.take('except', 'for') ||
      this.take('except') ||
      this.take('but', 'not') ||
      this.take('but') ||
      this.take('minus') ||
      this.take('without') ||
      this.take('excluding') ||
      this.take('bar')
    ) {
      const ns = this.names();
      if (ns !== undefined) return ns;
    }
    this.i = save;
    return undefined;
  }

  /** "the 5 of us", "all 5 of us", "5 of us". */
  countOfUs(): number | undefined {
    const save = this.i;
    if (!this.take('the')) this.take('all');
    const n = this.count();
    if (n !== undefined && this.take('of', 'us')) return n;
    this.i = save;
    return undefined;
  }

  party(): Party | undefined {
    const n = this.countOfUs();
    if (n !== undefined) return { kind: 'count', count: n, names: [], except: [] };
    const save = this.i;
    if (this.group()) {
      return { kind: 'group', names: [], except: this.except() ?? [] };
    }
    this.i = save;
    const ns = this.names();
    if (ns !== undefined) return { kind: 'names', names: ns, except: [] };
    return undefined;
  }

  /** One non-generic term of exactly one venue at the cursor, longest first. */
  venue(): boolean {
    let best = 0;
    let keys = new Set<string>();
    for (const v of this.index.venues) {
      for (const term of v.terms) {
        if (this.index.generic.has(term) || !/^[a-z0-9' ]+$/.test(term)) continue;
        const ws = term.split(' ').filter(Boolean);
        if (ws.length === 0 || ws.length < best) continue;
        let ok = true;
        for (let k = 0; k < ws.length; k++) {
          if (this.word(k) !== ws[k]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (ws.length > best) {
          best = ws.length;
          keys = new Set([v.key]);
        } else {
          keys.add(v.key);
        }
      }
    }
    if (best === 0 || keys.size !== 1) return false;
    this.i += best;
    return true;
  }

  /** TICKETS; returns the count inside it (or null for none), undefined when it doesn't parse. */
  tickets(): number | null | undefined {
    const save = this.i;
    this.take('the');
    const n = this.count() ?? null;
    if (this.venue()) {
      const w = this.word();
      if (w !== undefined && TICKET_WORDS.has(w)) this.i++;
      return n;
    }
    const w = this.word();
    if (w !== undefined && TICKET_WORDS.has(w)) {
      this.i++;
      if (this.take('for') || this.take('to') || this.take('at')) {
        this.take('the');
        if (this.venue()) return n;
      }
    }
    this.i = save;
    return undefined;
  }

  when(): void {
    if (this.take('for', 'tonight') || this.take('tonight') || this.take('tonite')) return;
    if (this.take('tomorrow', 'night') || this.take('tomorrow') || this.take('today')) return;
    const save = this.i;
    if (!this.take('this')) this.take('on');
    const w = this.word();
    if (w !== undefined && WEEKDAYS.has(w)) {
      this.i++;
      this.take('night');
      return;
    }
    this.i = save;
  }

  ask(): Parse | undefined {
    const verb = this.word();
    if (verb === undefined || !VERBS.has(verb)) return undefined;
    this.i++;
    // VERB party TICKETS: "get the 5 of us razz tickets", "get us razz tickets". Names
    // in this slot ("get chase and me razz tickets") are not in the grammar: it is
    // the reader's weakest path (T-173 r2 #3), so they get the card.
    const save = this.i;
    const party = this.party();
    if (party !== undefined && party.kind !== 'names') {
      const n = this.tickets();
      if (n !== undefined) {
        this.when();
        return { party, ...(n !== null ? { ticketCount: n } : {}), out: [], except: [] };
      }
    }
    this.i = save;
    // VERB TICKETS [for FORPARTY]: "get razz tickets for everyone except henry", "book 5 razz tickets".
    const n = this.tickets();
    if (n === undefined) return undefined;
    this.when();
    let forParty: Party | undefined;
    if (this.take('for')) {
      forParty = this.party();
      if (forParty === undefined) {
        const c = this.count();
        if (c === undefined) return undefined;
        forParty = { kind: 'count', count: c, names: [], except: [] };
      }
      this.when();
    }
    return {
      ...(forParty !== undefined ? { party: forParty } : {}),
      ...(n !== null ? { ticketCount: n } : {}),
      out: [],
      except: [],
    };
  }

  /** OUT clause: the member said to be out, or undefined (cursor unchanged). */
  outClause(): string | undefined {
    const save = this.i;
    const w0 = this.word();
    if (w0 !== undefined && OUT_LEADS.has(w0)) this.i++;
    const who = this.name();
    if (who !== undefined && who !== this.senderKey) {
      const after = this.i;
      if ((this.take("'s") || this.take('is')) && this.takeAny(OUT_STATES)) {
        if (!this.take('tonight')) this.take('today');
        return who;
      }
      this.i = after;
      if (
        (this.take("can't") || this.take('cant') || this.take('cannot')) &&
        (this.take('make', 'it') || this.take('come') || this.take('go') || this.take('join'))
      ) {
        this.take('tonight');
        return who;
      }
      this.i = after;
      if (
        (this.take("isn't") ||
          this.take('isnt') ||
          this.take('is', 'not') ||
          this.take("'s", 'not') ||
          this.take("won't") ||
          this.take('wont')) &&
        (this.take('coming') || this.take('make', 'it') || this.take('joining'))
      ) {
        this.take('tonight');
        return who;
      }
    }
    this.i = save;
    return undefined;
  }

  /** ", except henry" / ", not henry" as its own clause. */
  exceptClause(): string[] | undefined {
    const save = this.i;
    if (this.take('not') || this.take('no')) {
      const ns = this.names();
      if (ns !== undefined) return ns;
      this.i = save;
      return undefined;
    }
    return this.except();
  }

  atEnd(): boolean {
    return this.i >= this.toks.length;
  }
}

/** The address at the start: "@trav", "@trav,", "trav,", "hey trav:". Returns the tokens after it. */
function addressed(s: string): string | undefined {
  const m = /^\s*(?:@trav\b\s*[,:]?|(?:(?:hey|yo|hi)\s+)?trav\s*[,:])\s*/.exec(s);
  if (m === null) return undefined;
  const rest = s.slice(m[0].length);
  // Trav named again later is another message folded in ("… @trav jk").
  if (/@trav\b|\btrav\b/.test(rest.replace(/\b(?:thanks|thank you) trav\b/g, ' ')))
    return undefined;
  return rest;
}

/**
 * Is this message an ask clear enough to buy on, with no confirm card
 * (T-168)? See the module comment for the grammar. Pure.
 */
export function autoBuyVerdict(input: AutoBuyInput): AutoBuyVerdict {
  const no = (reason: AutoBuyRejection): AutoBuyVerdict => ({ eligible: false, reason });
  const raw = stripInvisible(input.text)
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (raw.length === 0) return no('empty');
  if (raw.length > AUTO_BUY_MAX_LENGTH) return no('too_long');
  if (/[\r\n]/.test(raw)) return no('quoted');
  const roster = rosterOf(input.roster);
  const senderKey = foldText(input.sender).trim();
  if (senderKey.length === 0 || roster.byKey.get(senderKey) === undefined) {
    return no('sender_not_member');
  }
  const folded = foldText(raw).replace(/[ʼ`´]/g, "'");
  const body = addressed(folded);
  if (body === undefined) return no('not_addressed');
  const toks = tokenize(body);
  if (typeof toks === 'string') return no(toks);

  const p = new Parser(toks, roster, senderKey, input.index);
  while (p.word() !== undefined && LEADS.has(p.word()!)) p.i++;
  const ask = p.ask();
  if (ask === undefined) {
    // Tell a venue problem apart from the rest, for the audit trail.
    return no(p.toks.some((t) => t.kind === 'emoji' && !TAIL_EMOJI.has(t.e)) ? 'emoji' : 'grammar');
  }
  const out: string[] = [];
  const except = [...(ask.party?.except ?? [])];
  for (;;) {
    let moved = false;
    while (!p.atEnd()) {
      const t = p.toks[p.i]!;
      if (t.kind === 'sep') {
        p.i++;
        moved = true;
        continue;
      }
      if (t.kind === 'emoji') {
        if (!TAIL_EMOJI.has(t.e)) return no('emoji');
        p.i++;
        moved = true;
        continue;
      }
      break;
    }
    if (p.atEnd()) break;
    if (p.takeAny(TAILS)) continue;
    // A clause about who's out needs its own separator before it.
    const prev = p.toks[p.i - 1];
    if (moved || prev?.kind === 'sep') {
      const who = p.outClause();
      if (who !== undefined) {
        out.push(who);
        continue;
      }
      const ex = p.exceptClause();
      if (ex !== undefined) {
        except.push(...ex);
        continue;
      }
    }
    return no('grammar');
  }

  // ---- the party, resolved ----
  const display = (key: string): string => roster.byKey.get(key) ?? key;
  const fold = (n: string): string => foldText(n).trim();
  const already = new Set((input.alreadyOut ?? []).map(fold));
  const everyone = input.roster.map(fold).filter((k) => !already.has(k));
  const excludedKeys = [...new Set([...out, ...except])];
  const party = ask.party;
  let attendees: string[];
  if (party === undefined || party.kind === 'group' || party.kind === 'count') {
    attendees = everyone.filter((k) => !excludedKeys.includes(k));
  } else {
    attendees = [...new Set(party.names)];
    // Someone both named as going and said to be out (or already out): nobody is sure.
    if (attendees.some((k) => excludedKeys.includes(k) || already.has(k))) return no('party');
  }
  if (attendees.length === 0) return no('party');
  const counts = [ask.ticketCount, party?.count].filter((c): c is number => c !== undefined);
  if (counts.some((c) => c !== attendees.length)) return no('count_mismatch');
  // A bare "get razz tickets", with no party and no count: who is going is the roster's
  // guess, not the member's words. That gets the card.
  if (party === undefined && counts.length === 0) return no('party');

  // ---- the offline reader must agree ----
  const request = parseBookingRequest(input.text, input.index, input.sender, {
    roster: input.roster,
  });
  if (request === undefined) return no('reader_disagrees');
  const readOut = new Set(request.excludedNames.map(fold));
  const wantOut = new Set(excludedKeys);
  if (readOut.size !== wantOut.size || [...wantOut].some((k) => !readOut.has(k))) {
    return no('reader_disagrees');
  }
  if (request.quantity !== undefined && request.quantity !== attendees.length) {
    return no('reader_disagrees');
  }
  if (request.attendeeNames !== undefined) {
    const named = new Set(request.attendeeNames.map(fold));
    if (named.size !== attendees.length || attendees.some((k) => !named.has(k))) {
      return no('reader_disagrees');
    }
  } else if (party?.kind === 'names') {
    return no('reader_disagrees');
  }
  if (request.tier !== undefined || request.time !== undefined) return no('reader_disagrees');

  // Sender first when they are going.
  const ordered = [
    ...attendees.filter((k) => k === senderKey),
    ...attendees.filter((k) => k !== senderKey),
  ];
  return {
    eligible: true,
    request,
    attendees: ordered.map(display),
    excluded: excludedKeys.map(display),
    quantity: attendees.length,
  };
}

/** `autoBuyVerdict(input).eligible`: the T-168 gate. False for anything outside the grammar. */
export function autoBuyEligible(input: AutoBuyInput): boolean {
  return autoBuyVerdict(input).eligible;
}

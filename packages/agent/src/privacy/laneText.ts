/**
 * T-213: DM text never reaches the group lane (SAFETY §2.3, C2/C7), enforced
 * by code rather than by the prompt.
 *
 * What a member says to Trav in their private thread is theirs. The live eval
 * (T-184) showed a model can carry it across anyway: a DM-lane tool call that
 * writes the member's own words into the GroupStore (an expense description,
 * a booking query) puts them in every later group prompt and in the group
 * notice. This module is the one place that knows which wording is DM-only, and
 * the loop uses it at three points:
 *
 *  1. DM-lane writes: a tool call from a private thread whose free text the
 *     GroupStore keeps verbatim (an expense description) is refused when it
 *     carries DM-only wording (`loop.ts`, `DM_STORED_TEXT`).
 *  2. Group-lane prompts: the chat loop's dynamic context and every tool
 *     result are redacted before the model sees them (`redact`).
 *  3. Group outbound (`guardSend.ts`): a model-written reply is suppressed on
 *     a `strict` hit; a code-rendered message has its member-written fields
 *     redacted and still goes out. Both audited as `content.suppressed`
 *     (`private_text_in_group`, ids only, visible to the DM's owner).
 *
 * "DM-only wording" is a phrase from a member's DM (or a private member-memory
 * fact) that nobody has said in the group thread: two adjacent content words
 * ("money's tight") or three words with at least two content words ("80 a
 * day", "keep my share"). Function words alone never match, so "can you" or
 * "for the" never block anything. Anything said in the group thread is public
 * and never matches (SAFETY §2.3: a fact said in the group may be repeated
 * there), and so are search results (provider inventory) and Trav's own sent
 * group messages. Single words and paraphrase are out of reach of any text
 * check; the structural guarantees are (1) and (2): DM wording never enters
 * the GroupStore, and group prompts never show it.
 *
 * Pure apart from the in-memory corpus. Private texts are kept per group, the
 * newest `MAX_PRIVATE_TEXTS` only, and are never logged, audited or returned:
 * callers get spans and owner ids, never the matched words.
 */
import type { GroupId, MemberId } from '@trav/core';
import { stripInvisible } from '../untrusted.js';

/** Function words: a phrase made only of these is never DM-only. */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an the and or but if so of to in on at by for from with without into onto about as than then ' +
    'until till before after during between through around near since per via ' +
    'is am are was were be been being do does did doing done have has had having will would shall should ' +
    'can could may might must i me my mine myself you your yours yourself we us our ours he him his she ' +
    'her hers they them their theirs it its this that these those there here what which who whom whose ' +
    'when where why how all any some no not nor only own same too very just also up down out off over ' +
    'under again once each few more most other such both s t im ive id ill youre youve youd youll were ' +
    'weve wed well theyre theyve hes shes its thats whats theres dont doesnt didnt cant couldnt wont ' +
    'wouldnt isnt arent wasnt werent hasnt havent hadnt shouldnt lets get got go going gonna wanna ok ' +
    'okay yes yeah yep no nope lol haha pls please thanks thx hey hi hello oh like really now get'
  ).split(/\s+/u),
);

export const MAX_PRIVATE_TEXTS = 400;

export interface Token {
  readonly norm: string;
  readonly start: number;
  readonly end: number;
}

/** Word tokens with their offsets in `text`; each folded to lowercase ASCII-ish ("Barça" → "barca", "money's" → "moneys"). */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}]+(?:['’ʼ][\p{L}\p{N}]+)*/gu;
  for (const m of text.matchAll(re)) {
    const norm = m[0]
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .replace(/['’ʼ]/gu, '')
      .toLowerCase();
    if (norm.length === 0) continue;
    out.push({ norm, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const isContent = (t: string): boolean => !STOPWORDS.has(t);

/** Every phrase key a token run yields: content bigrams and 3-grams with ≥ 2 content words. */
function phraseWindows(
  tokens: readonly Token[],
): { key: string; from: number; to: number; strong: boolean }[] {
  const out: { key: string; from: number; to: number; strong: boolean }[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const a = tokens[i]!.norm;
    const b = tokens[i + 1]?.norm;
    if (b === undefined) break;
    if (isContent(a) && isContent(b))
      out.push({ key: `${a} ${b}`, from: i, to: i + 1, strong: false });
    const c = tokens[i + 2]?.norm;
    const content = c === undefined ? 0 : [a, b, c].filter(isContent).length;
    if (c !== undefined && content >= 2) {
      out.push({ key: `${a} ${b} ${c}`, from: i, to: i + 2, strong: content === 3 });
    }
  }
  return out;
}

export interface PrivateSpan {
  /** Offsets in the checked text. */
  readonly start: number;
  readonly end: number;
  /** Whose DM (or private note) the phrase came from. */
  readonly ownerIds: readonly MemberId[];
}

interface GroupCorpus {
  /** Phrase key → owners whose DM text has it. */
  readonly privateKeys: Map<string, Set<MemberId>>;
  /** Insertion order, for the cap. */
  readonly texts: { readonly ownerId: MemberId; readonly keys: readonly string[] }[];
  readonly publicKeys: Set<string>;
}

export interface LaneTextGuard {
  /** A member's own words in their private thread (or a private note about them). */
  notePrivate(groupId: GroupId, ownerId: MemberId, text: string): void;
  /** Anything said in the group thread: public from then on. */
  notePublic(groupId: GroupId, text: string): void;
  /**
   * DM-only phrases in `text`, merged into spans. Empty when clean. `strict`
   * (model-written group text) needs three content words in a row or a run
   * of 4+ DM words: an everyday overlap a DM happens to share ("the qr
   * codes", "refundable until 10pm") is not a leak.
   */
  leaks(groupId: GroupId, text: string, mode?: MatchMode): readonly PrivateSpan[];
  /** `text` with every DM-only span replaced by `[private]`. */
  redact(groupId: GroupId, text: string, mode?: MatchMode): string;
  /** Every string inside `value` redacted (objects and arrays copied). */
  redactDeep<T>(groupId: GroupId, value: T): T;
  /** Drop a member's private texts (they left, or asked Trav to forget them). */
  forgetMember(groupId: GroupId, ownerId: MemberId): void;
  /** T-170: drop everything noted for a group (Trav left it and its data was deleted). */
  forgetGroup(groupId: GroupId): void;
}

export const REDACTED = '[private]';

/** `phrase`: content pairs and 3-word phrases (DM writes, prompts, member fields). `strict`: 3-word phrases only. */
export type MatchMode = 'phrase' | 'strict';

export interface LaneTextGuardOptions {
  /**
   * Extra private texts read at check time, e.g. private member-memory facts
   * from the PrivateStore. Called per check; never cached here.
   */
  readonly extraPrivate?: (
    groupId: GroupId,
  ) => readonly { readonly ownerId: MemberId; readonly text: string }[];
}

export function createLaneTextGuard(opts: LaneTextGuardOptions = {}): LaneTextGuard {
  const groups = new Map<GroupId, GroupCorpus>();
  const corpus = (groupId: GroupId): GroupCorpus => {
    let c = groups.get(groupId);
    if (c === undefined) {
      c = { privateKeys: new Map(), texts: [], publicKeys: new Set() };
      groups.set(groupId, c);
    }
    return c;
  };
  const clean = (text: string): string => stripInvisible(text.normalize('NFKC'));

  const unlink = (c: GroupCorpus, ownerId: MemberId, keys: readonly string[]): void => {
    for (const k of keys) {
      const owners = c.privateKeys.get(k);
      if (owners === undefined) continue;
      // Another kept text of the same owner may still carry this key.
      const stillHeld = c.texts.some((t) => t.ownerId === ownerId && t.keys.includes(k));
      if (!stillHeld) owners.delete(ownerId);
      if (owners.size === 0) c.privateKeys.delete(k);
    }
  };

  function spansIn(groupId: GroupId, text: string, mode: MatchMode = 'phrase'): PrivateSpan[] {
    const c = groups.get(groupId);
    const extra = opts.extraPrivate?.(groupId) ?? [];
    if ((c === undefined || c.privateKeys.size === 0) && extra.length === 0) return [];
    const extraKeys = new Map<string, Set<MemberId>>();
    for (const e of extra) {
      for (const w of phraseWindows(tokenize(clean(e.text)))) {
        const set = extraKeys.get(w.key) ?? new Set<MemberId>();
        set.add(e.ownerId);
        extraKeys.set(w.key, set);
      }
    }
    const tokens = tokenize(text);
    const hits: { from: number; to: number; strong: boolean; owners: Set<MemberId> }[] = [];
    for (const w of phraseWindows(tokens)) {
      if (mode === 'strict' && w.to - w.from < 2) continue;
      if (c?.publicKeys.has(w.key) === true) continue;
      const owners = new Set<MemberId>([
        ...(c?.privateKeys.get(w.key) ?? []),
        ...(extraKeys.get(w.key) ?? []),
      ]);
      if (owners.size > 0) hits.push({ from: w.from, to: w.to, strong: w.strong, owners });
    }
    hits.sort((a, b) => a.from - b.from || a.to - b.to);
    const merged: { from: number; to: number; strong: boolean; owners: Set<MemberId> }[] = [];
    for (const h of hits) {
      const last = merged.at(-1);
      if (last !== undefined && h.from <= last.to + 1) {
        last.to = Math.max(last.to, h.to);
        last.strong ||= h.strong;
        for (const o of h.owners) last.owners.add(o);
      } else merged.push({ from: h.from, to: h.to, strong: h.strong, owners: new Set(h.owners) });
    }
    // `strict`: a lone 3-word window with a function word in it ("the qr
    // codes", "refundable until 10pm") is everyday overlap, not a leak. A hit
    // needs three content words in a row or a run of 4+ DM words.
    const kept = mode === 'strict' ? merged.filter((m) => m.strong || m.to - m.from >= 3) : merged;
    return kept.map((m) => ({
      start: tokens[m.from]!.start,
      end: tokens[m.to]!.end,
      ownerIds: [...m.owners].sort(),
    }));
  }

  function redact(groupId: GroupId, text: string, mode: MatchMode = 'phrase'): string {
    const spans = spansIn(groupId, text, mode);
    if (spans.length === 0) return text;
    let out = '';
    let at = 0;
    for (const s of spans) {
      out += text.slice(at, s.start) + REDACTED;
      at = s.end;
    }
    return out + text.slice(at);
  }

  function redactDeep<T>(groupId: GroupId, value: T, depth = 0): T {
    if (typeof value === 'string') return redact(groupId, value) as T;
    if (depth > 12 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map((v: unknown) => redactDeep(groupId, v, depth + 1)) as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(groupId, v, depth + 1);
    }
    return out as T;
  }

  return {
    notePrivate(groupId, ownerId, text) {
      const keys = [...new Set(phraseWindows(tokenize(clean(text))).map((w) => w.key))];
      if (keys.length === 0) return;
      const c = corpus(groupId);
      c.texts.push({ ownerId, keys });
      for (const k of keys) {
        const set = c.privateKeys.get(k) ?? new Set<MemberId>();
        set.add(ownerId);
        c.privateKeys.set(k, set);
      }
      while (c.texts.length > MAX_PRIVATE_TEXTS) {
        const old = c.texts.shift()!;
        unlink(c, old.ownerId, old.keys);
      }
    },
    notePublic(groupId, text) {
      const c = corpus(groupId);
      for (const w of phraseWindows(tokenize(clean(text)))) c.publicKeys.add(w.key);
    },
    leaks: (groupId, text, mode) => spansIn(groupId, clean(text), mode),
    redact,
    redactDeep: (groupId, value) => redactDeep(groupId, value),
    forgetMember(groupId, ownerId) {
      const c = groups.get(groupId);
      if (c === undefined) return;
      const mine = c.texts.filter((t) => t.ownerId === ownerId);
      for (let i = c.texts.length - 1; i >= 0; i -= 1) {
        if (c.texts[i]!.ownerId === ownerId) c.texts.splice(i, 1);
      }
      for (const t of mine) unlink(c, ownerId, t.keys);
    },
    forgetGroup(groupId) {
      groups.delete(groupId);
    },
  };
}

/** Every string leaf of a value (tool inputs, card fields), for a leak check. */
export function stringLeaves(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (depth > 12 || value === null || typeof value !== 'object') return [];
  const vals = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return vals.flatMap((v: unknown) => stringLeaves(v, depth + 1));
}

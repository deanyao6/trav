/**
 * Balance asks routed before the model (T-091, T-085, T-101): "@trav settle
 * now", "settle up", "who owes who", "what do i owe", "who's paid for what so
 * far", "how much have we spent so far". Like the T-017 settings intercepts
 * these are rules, never a scripted turn keyed on who sent them, so they work
 * for any member in any group, in the group thread and in a DM.
 *
 * The match is on the whole message (after "@trav" and filler), so a longer
 * ask that merely mentions money ("how much does the club cost", "who owes
 * who, and book dinner") still goes to the model.
 *
 * The personal answer (`myPositionText`) shows only the asker's own
 * transfers, from the group ledger only: nothing pending in anyone's private
 * lane is ever on it (SAFETY §2.3), and a minor is never a debtor or creditor
 * (VOICE §8).
 */
import type { Member, MemberId } from '@trav/core';
import { formatMoney, money } from '@trav/core';
import type { BalancesResult } from '../tools/ledger.js';

export type BalanceAskKind =
  /** The whole group squares up: the settle_up card in the group. */
  | 'settle'
  /** The asker's own position. */
  | 'mine'
  /** The running tab: total so far and who owes whom. */
  | 'tab';

const SETTLE: readonly RegExp[] = [
  // settle now / settle up / settle up now / let's settle up / can we square up today
  /^(?:(?:can|could|shall) (?:we|you) |let'?s |lets |time to |ok |okay )?(?:settle|square)(?: (?:us |everyone |everybody )?up)?(?: (?:now|today|tonight|the tab|everything))?$/,
  // who owes who / who owes whom / who owes what / who owes who what
  /^who owes (?:who|whom|what|who what|whom what|what to whom|what to who)(?: (?:now|so far|right now))?$/,
];

const MINE: readonly RegExp[] = [
  // how much do i owe / what do i owe (anyone) (so far)
  /^(?:how much|what) do i owe(?: (?:anyone|anybody|people|everyone|everybody|in total|total))?(?: (?:so far|right now|now|atm))?$/,
  /^do i owe (?:anyone|anybody|anything|money)(?: (?:so far|right now|now))?$/,
  // how much am i owed / who owes me
  /^(?:how much|what) am i owed(?: (?:so far|right now|now))?$/,
  /^(?:does )?(?:anyone|anybody) owe me(?: (?:anything|money))?$/,
  /^who owes me(?: (?:money|anything))?(?: (?:so far|right now|now))?$/,
  // what's my balance / where do i stand / am i square. Never "my share" or
  // "my total": with tickets on the table that is the ticket share, not the
  // ledger, so it stays the model's (it reads the proposal).
  /^what(?:'s| is) my (?:balance|position|tab)(?: (?:so far|right now|now|at))?$/,
  /^where do i stand(?: (?:money wise|moneywise|on money|on the tab))?$/,
  /^am i (?:square|even|all square|settled|settled up)$/,
];

const TAB: readonly RegExp[] = [
  // who's paid for what (so far)
  /^who(?:'s| has| is)? paid (?:for )?what(?: (?:so far|right now|now))?$/,
  // how much have we spent (so far) / how much did we spend
  /^how much (?:have we|has everyone|has the group|did we) (?:spent|spend)(?: (?:so far|in total|total|on this trip|on the trip))?(?: (?:so far))?$/,
  /^how much(?: have| has)? (?:we|everyone|the group) spent(?: (?:so far|in total))?$/,
  // what's the tab / the running tab / balances. Never "the total" or "the
  // damage": next to a proposal or a receipt that is the booking's price.
  /^what(?:'s| is) the (?:running )?(?:tab|balance|balances)(?: (?:so far|right now|now|at|looking like))?$/,
  /^(?:show (?:me |us )?)?(?:the )?(?:running tab|balances|tab so far)$/,
];

/**
 * The ask's kind, or undefined when the message is anything else. Pure: the
 * text is lowercased, "@trav"/"trav," and trailing punctuation are dropped.
 */
export function parseBalanceAsk(text: string): BalanceAskKind | undefined {
  const t = normalize(text);
  if (t.length === 0 || t.length > 80) return undefined;
  if (SETTLE.some((re) => re.test(t))) return 'settle';
  if (MINE.some((re) => re.test(t))) return 'mine';
  if (TAB.some((re) => re.test(t))) return 'tab';
  return undefined;
}

function normalize(text: string): string {
  let t = text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
  // Leading address: "@trav", "trav,", "hey trav", "yo @trav:".
  t = t.replace(/^(?:(?:hey|hi|yo|ok|okay|so) )?@?trav\b[\s,:;.!-]*/, '');
  // Trailing address and politeness: "settle up trav", "who owes who pls".
  for (let i = 0; i < 3; i += 1) {
    t = t
      .replace(/[\s?!.,;:]+$/, '')
      .replace(/\s+(?:@?trav|please|pls|plz)$/, '')
      .trim();
  }
  // Leading politeness: "pls settle up", "can you tell me who owes who".
  t = t.replace(/^(?:please |pls |plz )/, '');
  t = t.replace(/^(?:can|could) you (?:tell me |show me |check )/, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** What a personal answer needs about the asker. */
export interface MyPositionInput {
  readonly balances: BalancesResult;
  readonly me: Member;
  /** Every member of the group (names and guardians). */
  readonly members: readonly Member[];
  /** `safety.isMinor(me, now)`, decided by the caller. */
  readonly meIsMinor: boolean;
  /** A DM "who owes who": point at the group list (adults, split tab only). */
  readonly groupListHint?: boolean;
  /**
   * Where the answer goes. In a DM the guardian question is not asked (the
   * leads answer it in the group); the asker hears why there's no split yet.
   */
  readonly lane?: 'group' | 'dm';
}

/** A balance ask with no trip on: one line, never the generic fallback. */
export const NO_TRIP_BALANCE_TEXT = 'nothing on the tab yet, no trip set up';

function joinNames(names: readonly string[], joiner: 'or' | 'and'): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names.at(-1)!}`;
}

/** The last line of a DM "who owes who": the whole list belongs in the group. */
export const GROUP_LIST_HINT_TEXT = 'everyone\'s transfers go in the group: "@trav settle now"';

/**
 * The asker's own position, VOICE §3.4 money (debtor first, "you"), and the
 * trip total for context. Other members appear only as the other side of the
 * asker's own transfers.
 */
export function myPositionText(input: MyPositionInput): string {
  const { balances: b, me, members, meIsMinor } = input;
  const name = (id: MemberId): string => members.find((m) => m.memberId === id)?.displayName ?? id;
  const fmt = (minor: number): string => formatMoney(money(minor, b.currency));

  if (meIsMinor) {
    const guardian = me.guardianMemberId;
    if (b.mode === 'family_tab') return "you don't owe anything. it's all on the family tab";
    return guardian !== undefined && members.some((m) => m.memberId === guardian)
      ? `you don't owe anyone, under-18s never do. your share's on ${name(guardian)}'s tab`
      : "you don't owe anyone, under-18s never do";
  }
  // A minor with money and no guardian: the leads' question, never a guess (VOICE §8).
  // In a DM that is a personal line; the question itself stays in the group.
  if (b.needsGuardian !== undefined) {
    if (input.lane !== 'dm') return b.text;
    const minors = joinNames(b.needsGuardian.minors.map(name), 'and');
    const leads = joinNames(b.needsGuardian.askMemberIds.map(name), 'or');
    return leads.length === 0
      ? `can't split yet, someone has to say who's covering ${minors}`
      : `can't split yet, ${leads} has to say who's covering ${minors}`;
  }
  if (b.mode === 'family_tab') return b.text;

  const total = `${fmt(b.totalSpentMinor)} on the tab so far`;
  const owe = b.transfers.filter((t) => t.from === me.memberId);
  const owed = b.transfers.filter((t) => t.to === me.memberId);
  const lines: string[] = [];
  if (owe.length === 1) {
    lines.push(`you owe ${name(owe[0]!.to)} ${fmt(owe[0]!.amountMinor)}`);
  } else if (owe.length > 1) {
    const sum = owe.reduce((s, t) => s + t.amountMinor, 0);
    lines.push(
      `you owe ${fmt(sum)}: ${owe.map((t) => `${name(t.to)} ${fmt(t.amountMinor)}`).join(' · ')}`,
    );
  }
  if (owed.length === 1) {
    lines.push(`${name(owed[0]!.from)} owes you ${fmt(owed[0]!.amountMinor)}`);
  } else if (owed.length > 1) {
    const sum = owed.reduce((s, t) => s + t.amountMinor, 0);
    lines.push(
      `you're owed ${fmt(sum)}: ${owed.map((t) => `${name(t.from)} ${fmt(t.amountMinor)}`).join(' · ')}`,
    );
  }
  if (lines.length === 0) lines.push("you're square, nothing to pay");
  lines.push(total);
  const mine = b.folded.filter((f) => f.guardian === me.memberId).map((f) => f.name);
  if (mine.length > 0) {
    lines.push(
      `${mine.length === 1 ? `${mine[0]!}'s share is` : `${mine.join(' and ')}'s shares are`} in yours`,
    );
  }
  if (input.groupListHint === true && b.transfers.length > 0) lines.push(GROUP_LIST_HINT_TEXT);
  return lines.join('\n');
}

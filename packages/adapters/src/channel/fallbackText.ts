/**
 * Capability fallback for instruction text (T-069). Trav's messages say how
 * to answer them: "👍 to book", "tap Sent when you've paid". On a channel
 * that cannot do what the line asks (an MMS group has no tapbacks; no relay
 * has buttons), the channel adapter rewrites only those instructions into a
 * text reply the keyword matcher already accepts (VOICE §6.2: a reply that is
 * exactly "yes" approves), so a member is never told to do something their
 * phone cannot:
 *
 *   👍 to book. price held for 15 min       → reply "yes" to book. price held for 15 min
 *   👍 from each of you to book              → each of you reply "yes" to book
 *   need a 👍 from @Dean on this one         → need a "yes" from @Dean on this one
 *   👎 to undo or tell me what to change     → reply "undo" or tell me what to change
 *   tap Sent when you've paid                → reply "sent" when you've paid
 *   not booked. 👍 the card or reply "yes"   → not booked. reply "yes"
 *
 * The reply word comes from the message's own actions (`Action.tapback` →
 * its first text alias; a button label → that label when it is an alias,
 * else the first alias), with VOICE §6.2 defaults when the message carries
 * none. An emoji that is not an instruction ("booked ✅", a decorative 👍)
 * is left alone: MMS shows emoji in text fine.
 *
 * Pure. The envelope (`OutboundMessage.text`, `card.fallbackText`) is never
 * changed; only what goes over the wire. Agent-side wording that already
 * fits the channel passes through untouched.
 */
import type { Action, ActionId, OutboundMessage } from '@trav/core';
import type { ChannelCapabilities } from '../interfaces/channel.js';
import { DEFAULT_TEXT_ALIASES } from './keywords.js';
import { isAnswerCard } from './types.js';

type Tapback = '👍' | '👎';

/** Button labels Trav uses (agent `render/common.ts`), for text that names a button the message doesn't carry. */
const KNOWN_LABELS: Readonly<Record<string, ActionId>> = {
  Approve: 'approve',
  Decline: 'decline',
  'Not me': 'not_me',
  'Share it': 'confirm',
  'Keep private': 'keep_private',
  Undo: 'undo',
  Paid: 'paid',
  Sent: 'sent',
  'Got it': 'got_it',
};

const DEFAULT_EMOJI_WORD: Readonly<Record<Tapback, string>> = { '👍': 'yes', '👎': 'no' };

/** A tapback emoji with optional skin tone / variation selector. */
const E = String.raw`(👍|👎)(?:\p{Emoji_Modifier}|\u{FE0E}|\u{FE0F})*`;

function isEmojiAlias(alias: string): boolean {
  return !/\p{L}|\p{N}/u.test(alias);
}

function wordAliases(aliases: readonly string[]): string[] {
  return aliases.filter((a) => a.trim().length > 0 && !isEmojiAlias(a));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the text would be rewritten on a channel with these capabilities. */
export function needsTextFallback(
  caps: Pick<ChannelCapabilities, 'buttons' | 'reactions'>,
): boolean {
  return !caps.buttons || !caps.reactions;
}

/**
 * The text to put on the wire for `message` on a channel with `caps`. Returns
 * `message.text` unchanged when the channel can do everything the text asks.
 */
export function textForChannel(
  message: Pick<OutboundMessage, 'text' | 'actions' | 'card'>,
  caps: Pick<ChannelCapabilities, 'buttons' | 'reactions'>,
): string {
  if (!needsTextFallback(caps)) return message.text;
  const actions = message.actions ?? [];
  // Only a message that asks for an answer carries an answer instruction.
  // Anything else (a recap, a reply, a notice) goes out exactly as written.
  if (actions.length === 0 && !(message.card !== undefined && isAnswerCard(message.card))) {
    return message.text;
  }
  const { masked, restore } = maskQuotes(message.text);
  let text = masked;
  if (!caps.buttons) text = rewriteButtonInstructions(text, actions, caps.reactions);
  if (!caps.reactions) text = rewriteTapbackInstructions(text, actions);
  return restore(text);
}

/**
 * Quoted text (`"…"`, `“…”`, a line starting with `>`) is someone's words, a
 * member's or Trav's own example reply; it is never rewritten.
 */
function maskQuotes(text: string): { masked: string; restore: (s: string) => string } {
  const spans: string[] = [];
  const masked = text.replace(/"[^"\n]*"|“[^”\n]*”|^>.*$/gmu, (span) => {
    spans.push(span);
    // Private-use code points: never in Trav's text, and no rule matches them.
    return `${String(spans.length - 1)}`;
  });
  return {
    masked,
    restore: (s) => s.replace(/(\d+)/gu, (_whole, i: string) => spans[Number(i)] ?? ''),
  };
}

// ---------- buttons ----------

function replyWordForLabel(label: string, actions: readonly Action[]): string | undefined {
  const own = actions.find((a) => a.label === label);
  const id = own?.id ?? KNOWN_LABELS[label];
  if (id === undefined) return undefined;
  const aliases = wordAliases(own?.textAliases ?? DEFAULT_TEXT_ALIASES[id]);
  const lower = label.toLowerCase();
  if (aliases.includes(lower)) return lower;
  return aliases[0] ?? lower;
}

/** "tap Sent", "taps Got it or 👍", "tap Share it or Keep private" → reply "…". */
function rewriteButtonInstructions(
  text: string,
  actions: readonly Action[],
  reactions: boolean,
): string {
  const labels = new Set<string>([...Object.keys(KNOWN_LABELS), ...actions.map((a) => a.label)]);
  const alt = [...labels]
    .filter((l) => l.length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  if (alt.length === 0) return text;
  const re = new RegExp(
    String.raw`\b(tap|taps|Tap|Taps) (${alt})(?: or (${alt}))?(?: or ${E})?(?![\p{L}])`,
    'gu',
  );
  return text.replace(
    re,
    (whole, verb: string, l1: string, l2: string | undefined, emoji: string | undefined) => {
      const w1 = replyWordForLabel(l1, actions);
      if (w1 === undefined) return whole;
      const w2 = l2 !== undefined ? replyWordForLabel(l2, actions) : undefined;
      const lowerVerb = verb.toLowerCase();
      let reply = lowerVerb === 'taps' ? 'replies' : 'reply';
      if (verb[0] === 'T') reply = reply[0]!.toUpperCase() + reply.slice(1);
      let out = `${reply} "${w1}"`;
      if (w2 !== undefined) out += ` or "${w2}"`;
      // A channel with tapbacks keeps the "or 👍"; without them it is the same answer.
      if (emoji !== undefined && reactions) out += ` or ${emoji}`;
      return out;
    },
  );
}

// ---------- tapbacks ----------

function replyWordForEmoji(emoji: Tapback, actions: readonly Action[]): string {
  const action = actions.find((a) => a.tapback === emoji);
  const word = action !== undefined ? wordAliases(action.textAliases)[0] : undefined;
  return word ?? DEFAULT_EMOJI_WORD[emoji];
}

function rewriteTapbackInstructions(text: string, actions: readonly Action[]): string {
  const word = (emoji: string): string => replyWordForEmoji(emoji as Tapback, actions);
  const rules: readonly [RegExp, (m: RegExpExecArray) => string][] = [
    // "👍 the card or reply "yes" to book it" → "reply "yes" to book it"
    [new RegExp(String.raw`${E} the card or (?=reply\b)`, 'gu'), () => ''],
    // The looks-shared digest: "👍 each one you want on the tab:" → pick by number.
    [new RegExp(String.raw`${E} each one you want`, 'gu'), () => 'reply with the numbers you want'],
    // "👍 from each of you to book" → "each of you reply "yes" to book"
    [
      new RegExp(String.raw`${E} from ([^.\n·]+?) to `, 'gu'),
      (m) => {
        const who = m[2]!;
        const sep = /^(each|one|all|both|any|every)\b/i.test(who) ? ' ' : ', ';
        return `${who}${sep}reply "${word(m[1]!)}" to `;
      },
    ],
    // "👎 to undo or ..." → "reply "undo" or ..."; "👍 to book" → "reply "yes" to book"
    [
      new RegExp(String.raw`${E} to (\S+)`, 'gu'),
      (m) => {
        const w = word(m[1]!);
        const next = m[2]!;
        if (next.toLowerCase().replace(/[^\p{L}]+$/u, '') === w) {
          return `reply "${w}"${next.slice(w.length)}`;
        }
        return `reply "${w}" to ${next}`;
      },
    ],
    // "need a 👍 from" → "need a "yes" from"; "your 👍 clears it" → "your "yes" clears it"
    [
      new RegExp(String.raw`\b(a|your|their|his|her|the) ${E}(?!')`, 'giu'),
      (m) => `${m[1]!} "${word(m[2]!)}"`,
    ],
    // "👍 yes · 👎 just me": the word is already there
    [
      new RegExp(String.raw`${E} (\p{L}[\p{L} ']*?)(?=$|[\s]*[·,.;:!?\n])`, 'gmu'),
      (m) => {
        const w = word(m[1]!);
        const rest = m[2]!;
        if (rest.toLowerCase() === w) return `reply "${w}"`;
        if (/^(when|once|if|only|unless|and|or)\b/i.test(rest)) return `reply "${w}" ${rest}`;
        return `reply "${w}" for ${rest}`;
      },
    ],
    // "👍 when it lands", "👍 each one you want on the tab:"
    [
      new RegExp(String.raw`${E} (?=\p{L})`, 'gu'),
      (m) => {
        const after = m.input.slice(m.index + m[0].length);
        const w = word(m[1]!);
        return /^(when|once|if|only|unless)\b/i.test(after) ? `reply "${w}" ` : `reply "${w}" for `;
      },
    ],
    // "before you 👍", "all 6 of you have to 👍"
    [
      new RegExp(String.raw`\b(you|to|they|we|i|'ll) ${E}(?![\p{L}'])`, 'giu'),
      (m) => `${m[1]!} reply "${word(m[2]!)}"`,
    ],
  ];
  let out = text;
  for (const [re, fn] of rules) {
    out = out.replace(re, (...args: unknown[]) => {
      // Rebuild a RegExpExecArray-like view: [match, ...groups], index, input.
      const groupsEnd = args.findIndex((a) => typeof a === 'number');
      const parts = args.slice(0, groupsEnd) as string[];
      const m = Object.assign([...parts], {
        index: args[groupsEnd] as number,
        input: args[groupsEnd + 1] as string,
      }) as unknown as RegExpExecArray;
      return fn(m);
    });
  }
  return out;
}

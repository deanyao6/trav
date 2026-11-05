/**
 * Rule parser for settings and consent commands (T-017; SAFETY §2.6, §2.8;
 * VOICE §7.2). Pure and deterministic: no model call, so every command works
 * the same with `TRAV_OFFLINE=1`. The parser only says what was asked; who
 * may do it is decided by `settings/flow.ts`.
 *
 * Whole-message commands only ("@trav photos on", "trav, stop roasting me"):
 * a sentence that merely contains a command word ("lol stop roasting him")
 * is not a command, so nothing here fires on ordinary chat.
 */
import type { ConsentFlag } from '@trav/core';

/** Spending-policy fields a lead can change from chat (integer minor units). */
export type CapSetting =
  | 'perPersonAutoCapMinor'
  | 'dailyGroupCapMinor'
  | 'tripGroupCapMinor'
  | 'hardMaxPerBookingMinor'
  | 'autoApproveCapMinor';

export type SettingChange =
  | {
      readonly setting: CapSetting;
      /** Decimal string ("80", "80.50"), or null for "off" (trip cap only). */
      readonly amount: string | null;
      /** Currency the member typed (symbol or code), if any. */
      readonly currency?: string;
    }
  | { readonly setting: 'tripCurrency'; readonly currency: string }
  | { readonly setting: 'replyMode'; readonly quiet: boolean };

export type ConsentSubject = { readonly kind: 'self' } | { readonly kind: 'named'; readonly name: string };

export type SettingsCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'roast_mode'; readonly on: boolean }
  | {
      readonly kind: 'consent';
      readonly flag: ConsentFlag;
      readonly on: boolean;
      readonly subject: ConsentSubject;
    }
  | { readonly kind: 'adults_confirmed' }
  | { readonly kind: 'set'; readonly change: SettingChange }
  /** "set the per-person cap to lots": a settings edit we could not read. */
  | {
      readonly kind: 'set_unreadable';
      readonly setting: CapSetting | 'tripCurrency' | 'replyMode';
      /** "turn off the per-person cap": only the trip cap can be off. */
      readonly offNotAllowed?: true;
    };

const AT_TRAV = /(^|[^\w@])@trav(?![\w-])\s*[,:]?/giu;
const LEADING_TRAV = /^\s*(?:(?:hey|hi|yo|ok|okay)\s+)?trav\b\s*[,:]?\s*/iu;

/**
 * Lowercased command text: `@trav` tokens and a leading "trav," removed,
 * curly quotes straightened, whitespace collapsed, trailing punctuation and
 * a trailing "please"/"thanks" dropped.
 */
export function commandText(text: string): string {
  let t = text
    .replace(/[‘’]/gu, "'")
    .replace(AT_TRAV, '$1 ')
    .replace(/\s+/gu, ' ')
    .trim();
  t = t.replace(LEADING_TRAV, '');
  t = t
    .toLowerCase()
    // "same, roast me", "ok roast crowley for the ubers", "me too, photos on": a
    // leading agreement word before the command is not part of it.
    .replace(/^(?:(?:same|me too|ok|okay|yeah|yep|alright|and|also)(?:\s*[,:]\s*|\s+))+(?=\S)/u, '')
    .replace(/^(?:can you|could you|pls|please)\s+/u, '')
    .replace(/[\s.!?,;:)]+$/u, '')
    .replace(/\s+(?:please|pls|thanks|thx|ty)$/u, '')
    .replace(/[\s.!?,;:)]+$/u, '')
    .trim();
  return t;
}

const ON = String.raw`(on|off)`;

const CAP_NAMES: readonly { readonly re: string; readonly setting: CapSetting }[] = [
  { re: String.raw`per[- ]?person(?: cap| limit| max)?`, setting: 'perPersonAutoCapMinor' },
  { re: String.raw`daily(?: group)?(?: cap| limit| max)|day cap`, setting: 'dailyGroupCapMinor' },
  { re: String.raw`trip(?: group)?(?: cap| limit| max)|trip budget cap`, setting: 'tripGroupCapMinor' },
  {
    re: String.raw`per[- ]?booking(?: cap| limit| max)?|booking (?:cap|limit|max)|max per booking`,
    setting: 'hardMaxPerBookingMinor',
  },
  { re: String.raw`auto[- ]?approve(?: cap| limit)?`, setting: 'autoApproveCapMinor' },
];

const SET_VERB = String.raw`(?:(?:set|change|make|put|move|raise|lower|bump|drop)\s+)?(?:the\s+|our\s+|my\s+)?`;

const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  euro: 'EUR',
  euros: 'EUR',
  dollar: 'USD',
  dollars: 'USD',
  pound: 'GBP',
  pounds: 'GBP',
  '€': 'EUR',
  '$': 'USD',
  '£': 'GBP',
};

/** "€80", "80", "80.50 eur", "$1,200" → decimal + typed currency. Undefined if unreadable. */
export function parseAmount(raw: string): { amount: string; currency?: string } | undefined {
  const m = /^([€$£])?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*([a-z]{3}|euros?|dollars?|pounds?)?$/u.exec(
    raw.trim(),
  );
  if (m === null) return undefined;
  const whole = m[2]!.replace(/,/g, '');
  const amount = m[3] !== undefined ? `${whole}.${m[3]}` : whole;
  const sym = m[1];
  const word = m[4];
  const currency =
    sym !== undefined
      ? CURRENCY_WORDS[sym]
      : word !== undefined
        ? (CURRENCY_WORDS[word] ?? word.toUpperCase())
        : undefined;
  return currency !== undefined ? { amount, currency } : { amount };
}

function capChange(setting: CapSetting, value: string): SettingsCommand {
  if (/^(?:off|none|no cap|nothing|unlimited)$/u.test(value)) {
    return setting === 'tripGroupCapMinor'
      ? { kind: 'set', change: { setting, amount: null } }
      : { kind: 'set_unreadable', setting, offNotAllowed: true };
  }
  const parsed = parseAmount(value);
  if (parsed === undefined) return { kind: 'set_unreadable', setting };
  return {
    kind: 'set',
    change: {
      setting,
      amount: parsed.amount,
      ...(parsed.currency !== undefined ? { currency: parsed.currency } : {}),
    },
  };
}

const ROAST_OFF = new RegExp(
  String.raw`^(?:(?:turn\s+)?roast(?:ing)? mode off|turn off roast(?:ing)? mode|roast(?:ing)? mode:? off|roasts? off|chill|stop roasting(?: us| everyone| people| please)?|no more roasts?|enough roasts?)$`,
  'u',
);
const ROAST_ON = new RegExp(
  String.raw`^(?:(?:turn\s+)?roast(?:ing)? mode on|turn on roast(?:ing)? mode|roast(?:ing)? mode:? on|enable roast(?:ing)? mode)$`,
  'u',
);
const ROAST_ME_OFF = new RegExp(
  String.raw`^(?:stop roasting me|don'?t roast me|no roasts? for me|leave me out(?: of (?:the )?roast(?:s|ing)?| of it)?|count me out of (?:the )?roasts?|opt me out of (?:the )?roasts?)$`,
  'u',
);
/** "roast me i can take it", "roast me too lol": opting in, with chatter after it but no topic. */
const ROAST_ME_TAIL = String.raw`(?:[\s,.!]+(?:too|as well|i can take it|bring it(?: on)?|go ahead|do your worst|lol|lmao|haha|pls|please))*`;
const ROAST_ME_ON = new RegExp(
  String.raw`^(?:(?:you can )?roast me|i'?m (?:in|down) for (?:the )?roasts?|opt me in(?:to)? (?:the )?roasts?)${ROAST_ME_TAIL}$`,
  'u',
);

const FLAG_WORDS: readonly { readonly re: string; readonly flag: ConsentFlag }[] = [
  { re: String.raw`photos?|pictures?|pics`, flag: 'photos' },
  { re: String.raw`card import|card imports|card sync|card`, flag: 'cardImport' },
  { re: String.raw`email import|email imports|email receipts|email`, flag: 'emailImport' },
  {
    re: String.raw`memory across trips|memory|remember(?:ing)? me(?: across trips)?`,
    flag: 'memoryAcrossTrips',
  },
];

function consentToggle(t: string): SettingsCommand | undefined {
  for (const { re, flag } of FLAG_WORDS) {
    // "photos on", "my photos off", "card import on for me too", "turn on card import"
    const a = new RegExp(
      String.raw`^(?:turn\s+)?(?:my\s+)?(?:${re})\s+${ON}(?:\s+for me(?: too| as well)?)?(?:\s+(?:too|as well))?$`,
      'u',
    ).exec(t);
    if (a !== null) return { kind: 'consent', flag, on: a[1] === 'on', subject: { kind: 'self' } };
    const b = new RegExp(String.raw`^turn\s+${ON}\s+(?:my\s+)?(?:${re})(?:\s+for me)?$`, 'u').exec(
      t,
    );
    if (b !== null) return { kind: 'consent', flag, on: b[1] === 'on', subject: { kind: 'self' } };
    // "lily's photos on" (a guardian for a minor; owner-only otherwise)
    const c = new RegExp(String.raw`^([\p{L}][\p{L}'-]{0,30})'s\s+(?:${re})\s+${ON}$`, 'u').exec(t);
    if (c !== null && c[1] !== 'my') {
      return { kind: 'consent', flag, on: c[2] === 'on', subject: { kind: 'named', name: c[1]! } };
    }
  }
  // "you can import my card for trip things", "you can look at my card for
  // trip stuff", "go ahead and read my email receipts": the owner saying yes
  // to an import in their own words. Only "my": nobody opts in for someone else.
  const grant =
    /^(?:you can|you may|feel free to|go ahead and|i'?m ok with you|i'?m fine with you)\s+(?:import|look at|read|check|use|scan|sync|go through|see)(?:ing)?\s+my\s+(card|cards|card transactions|credit card|debit card|email|emails|email receipts|inbox|receipts in my email)(?:\s+for\s+[\p{L}\s']{1,30})?$/u.exec(
      t,
    );
  if (grant !== null) {
    const flag: ConsentFlag = /card/u.test(grant[1]!) ? 'cardImport' : 'emailImport';
    return { kind: 'consent', flag, on: true, subject: { kind: 'self' } };
  }
  if (/^remember me (?:across|after|between) trips$|^keep my memory(?: across trips)?$/u.test(t)) {
    return { kind: 'consent', flag: 'memoryAcrossTrips', on: true, subject: { kind: 'self' } };
  }
  if (/^(?:forget me after (?:the|this) trip|don'?t remember me after (?:the|this) trip)$/u.test(t)) {
    return { kind: 'consent', flag: 'memoryAcrossTrips', on: false, subject: { kind: 'self' } };
  }
  return undefined;
}

/** The settings/consent command a whole message is, or undefined for anything else. */
export function parseSettingsCommand(text: string): SettingsCommand | undefined {
  const t = commandText(text);
  if (t.length === 0 || t.length > 80) return undefined;

  if (/^(?:show (?:me )?(?:the |our |my )?settings|(?:the |our |my )?settings|what are (?:the |our |my )?settings)$/u.test(t)) {
    return { kind: 'show' };
  }
  if (ROAST_ME_OFF.test(t)) {
    return { kind: 'consent', flag: 'roast', on: false, subject: { kind: 'self' } };
  }
  if (ROAST_ME_ON.test(t)) {
    return { kind: 'consent', flag: 'roast', on: true, subject: { kind: 'self' } };
  }
  if (ROAST_OFF.test(t)) return { kind: 'roast_mode', on: false };
  if (ROAST_ON.test(t)) return { kind: 'roast_mode', on: true };
  if (
    /^(?:yes[, ]+)?(?:we'?re all|we are all|everyone(?:'s| is)|everybody(?:'s| is)|all of us are) (?:18\+?|over 18|18 or over|adults?)$/u.test(
      t,
    )
  ) {
    return { kind: 'adults_confirmed' };
  }

  const consent = consentToggle(t);
  if (consent !== undefined) return consent;

  for (const { re, setting } of CAP_NAMES) {
    const m = new RegExp(String.raw`^${SET_VERB}(?:${re})\s+(?:to|at|=|is)\s+(.+)$`, 'u').exec(t);
    if (m !== null) return capChange(setting, m[1]!.trim());
    const off = new RegExp(String.raw`^(?:turn off|remove|drop|no)\s+(?:the\s+)?(?:${re})$`, 'u').exec(
      t,
    );
    if (off !== null) return capChange(setting, 'off');
  }

  const cur = new RegExp(
    String.raw`^${SET_VERB}(?:trip\s+)?currency\s+(?:to\s+|=\s*|is\s+)?(.+)$`,
    'u',
  ).exec(t);
  if (cur !== null) {
    const raw = cur[1]!.trim();
    const code = CURRENCY_WORDS[raw] ?? (/^[a-z]{3}$/u.test(raw) ? raw.toUpperCase() : undefined);
    return code !== undefined
      ? { kind: 'set', change: { setting: 'tripCurrency', currency: code } }
      : { kind: 'set_unreadable', setting: 'tripCurrency' };
  }

  const reply = new RegExp(String.raw`^${SET_VERB}(?:reply|replies) mode\s+(?:to\s+|=\s*)?(.+)$`, 'u').exec(
    t,
  );
  if (reply !== null) {
    const v = reply[1]!.trim();
    if (/^(?:quiet|quieter|quiet mode|minimal|on)$/u.test(v)) {
      return { kind: 'set', change: { setting: 'replyMode', quiet: true } };
    }
    if (/^(?:normal|default|regular|off|chatty)$/u.test(v)) {
      return { kind: 'set', change: { setting: 'replyMode', quiet: false } };
    }
    return { kind: 'set_unreadable', setting: 'replyMode' };
  }
  return undefined;
}

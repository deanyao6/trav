/**
 * Every line the settings, consent and roast-request flows say (VOICE §4.12,
 * §7.2, §7.5, §8). Refusals carry no emoji and no exclamation marks, state the
 * rule once and stop. Roast mode is opt-in per member (SAFETY §2.6: consent
 * defaults false), so the "roast mode on" line says how to opt in rather
 * than VOICE §7.2's opt-out wording.
 */

// ---------- roast mode (VOICE §7.2) ----------

export const ROAST_ON_TEXT =
  "roast mode on. i only roast the tab, and only people who say '@trav roast me'. 'roast mode off' ends it";
export const ROAST_OFF_TEXT = 'off';
export const ROAST_ALREADY_ON_TEXT = 'roast mode is already on';
export const ROAST_ALREADY_OFF_TEXT = 'roast mode is already off';
export const ROAST_LEAD_ONLY_TEXT = 'roast mode is a lead call. ask one of them';
/** VOICE §4.12 B. */
export const ROAST_MINOR_TEXT =
  'roast mode stays off for this group, someone here is under 18. the tab stays honest either way';
/** VOICE §7.2: age unknown and not confirmed. */
export const ROAST_AGE_QUESTION_TEXT = "to turn roast mode on i need to know everyone's 18+. are they?";
export const ROAST_AGE_DECLINED_TEXT = 'roast mode stays off then';
export const ROAST_TRIP_OVER_TEXT = "the trip's over, so roast mode stays off";
/** A roast request while someone's age is still unknown (a member joined after roast mode went on). */
export const ROAST_AGE_UNCONFIRMED_REQUEST_TEXT =
  "roasts wait until everyone's confirmed 18+. a lead can say '@trav everyone's 18+'";

// ---------- roast consent (SAFETY §2.6 `roast`) ----------

export const ROAST_ME_ON_TEXT = "noted. you're fair game, receipts only";
export const ROAST_ME_ON_MODE_OFF_TEXT = "noted. you're fair game, receipts only, once a lead turns roast mode on";
export const ROAST_ME_ALREADY_TEXT = "you're already in";
/** A minor can never opt in (VOICE §7.5 "Minor. One word."). */
export const NOPE_TEXT = 'nope';

// ---------- roast requests (VOICE §7.5 must-refuse) ----------

/** §4.12 A: appearance, body, clothes. */
export const REFUSE_BODY_TEXT = 'i only roast the receipts';
/** §7.5 Henry: hangovers. */
export const REFUSE_HANGOVER_TEXT = "i don't do hangovers, only receipts";
/** Health, illness, sleep. */
export const REFUSE_HEALTH_TEXT = "i don't do health stuff, only receipts";
/** §7.5 Sam: romance (and anything else personal). */
export const REFUSE_PERSONAL_TEXT = 'not touching that';
/** §7.5 Jordan: financial hardship. */
export const REFUSE_HARDSHIP_TEXT = 'nah';
/** §7.5: anyone who opted out. */
export const REFUSE_OPTED_OUT_TEXT =
  "they asked me to leave them out of it, so i'm leaving them out of it";
export const REFUSE_LEFT_TEXT = "they're not in the chat anymore, so no";
export const REFUSE_MODE_OFF_TEXT = "roast mode is off. a lead can turn it on with '@trav roast mode on'";
export const REFUSE_DAILY_TEXT = "that's today's roast. more tomorrow";
export const REFUSE_DM_TEXT = 'i only roast in the group chat, and only the tab';
export const NOTHING_TO_ROAST_TEXT = 'nothing on the tab to work with yet. give it a night';

/** §7.5 the host: someone outside the chat. */
export function refuseOutsiderText(pronoun: 'she' | 'he' | 'they'): string {
  const who = pronoun === 'she' ? "she's" : pronoun === 'he' ? "he's" : "they're";
  return `${who} not in the chat, so no`;
}

export function notOptedInText(name: string): string {
  return `${name} hasn't opted in. '@trav roast me' is how`;
}

// ---------- privacy (VOICE §4.12 D) ----------

export function privateDataRefusalText(name: string): string {
  return `that's ${name}'s, not mine to share. anything ${name} confirms as shared shows up on the tab`;
}

// ---------- family mode (VOICE §4.12 C, §8) ----------

function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/**
 * VOICE §8: shown once in the group when family mode kicks in. Pronouns are
 * "their": Trav does not guess anyone's gender.
 */
export function familyModeOnText(
  minorNames: readonly string[],
  guardianNames: readonly string[],
): string {
  // "all-ages plans" rather than VOICE §8's "no nightlife": in a family group
  // the outbound screen's keyword backstop suppresses any line naming nightlife,
  // its own notice included.
  if (minorNames.length === 0) return 'family mode is on: all-ages plans only, no roasts';
  const who =
    minorNames.length === 1 ? `${minorNames[0]!}'s` : `${nameList(minorNames)} are`;
  const tickets =
    guardianNames.length === 1
      ? `, their tickets go to ${guardianNames[0]!}`
      : guardianNames.length > 1
        ? `, their tickets go to ${nameList(guardianNames)}`
        : '';
  return `family mode is on since ${who} on the trip: all-ages plans only, no roasts${tickets}`;
}

export function keepMinorOffText(minorNames: readonly string[]): string {
  const who = minorNames.length === 1 ? minorNames[0]! : 'the kids';
  return `if the adults want something later, @ me separately and i'll keep ${who} off that plan`;
}

// ---------- consent flags (SAFETY §2.6) ----------

export const PHOTOS_ON_TEXT = 'your photos can show up in recaps now 📸';
export const PHOTOS_OFF_TEXT = 'your photos are out of recaps from now on';
export const CARD_IMPORT_ON_TEXT =
  "card import on. charges that look shared come to you first, nothing reaches the group until you say so";
export const CARD_IMPORT_OFF_TEXT = 'card import off';
export const EMAIL_IMPORT_ON_TEXT =
  "email import on. receipts that look shared come to you first, nothing reaches the group until you say so";
export const EMAIL_IMPORT_OFF_TEXT = 'email import off';
export const MEMORY_ON_TEXT = "i'll keep what you told me after this trip too";
export const MEMORY_OFF_TEXT = 'what you told me goes when the trip ends';
export const IMPORT_MINOR_TEXT = 'card and email import stay off for anyone under 18';
export const ALREADY_ON_TEXT = 'already on';
export const ALREADY_OFF_TEXT = 'already off';

export function droppedPendingText(base: string, dropped: number): string {
  if (dropped === 0) return base;
  return `${base}. the ${String(dropped)} waiting for you ${dropped === 1 ? 'is' : 'are'} gone`;
}

export function guardianCallText(guardianName: string, minorName: string): string {
  return `that one's ${guardianName}'s call. ${guardianName} can say '@trav ${minorName}'s photos on'`;
}

export function minorPhotosText(minorName: string, on: boolean): string {
  return on
    ? `${minorName}'s photos can show up in recaps now 📸`
    : `${minorName}'s photos are out of recaps from now on`;
}

export function ownerOnlyText(name: string): string {
  return `only ${name} can change that one`;
}

// ---------- group settings ----------

export const ADULTS_CONFIRMED_TEXT = 'noted, everyone here is 18+';
export const ADULTS_HAS_MINOR_TEXT = "can't mark that, someone here is under 18";
export const LEAD_ONLY_TEXT = "that's a lead call. ask one of them";
export const MINOR_SETTINGS_TEXT = "that's for the adults on the trip";
export const CONFIRM_DECLINED_TEXT = 'ok, left it as is';
export const ALREADY_SET_TEXT = 'already set that way';
export const NO_TRIP_TEXT = 'no trip running right now, so there is nothing to change that on';
export const UNREADABLE_CAP_TEXT = "didn't catch the amount. try '@trav set the per-person cap to €80'";
export const UNREADABLE_CURRENCY_TEXT = "didn't catch the currency. try '@trav set trip currency to USD'";
export const UNREADABLE_REPLY_MODE_TEXT = "reply mode is 'quiet' or 'normal'";
export const ONLY_TRIP_CAP_OFF_TEXT = 'only the trip cap can be turned off. the others need a number';

export function currencyLockedText(current: string): string {
  return `the tab already has ${current} on it, so the trip currency stays ${current}`;
}

export function capCurrencyText(current: string): string {
  return `caps are in ${current}, so give me the amount in ${current}`;
}

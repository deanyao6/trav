/**
 * T-170 (D-055): Trav's contact card. Members save it so the relay line shows
 * up as "Trav" (which is also how "Trav, split dinner" is read as an @trav,
 * T-187), then add that contact to the group chat. vCard 3.0 (RFC 2426),
 * CRLF line endings, text values escaped. Pure: no network, no secrets; the
 * line is the public address members text, never an API key.
 */

/** The one-line "how to add Trav" (docs/DEPLOY_IMESSAGE.md quotes it). */
export const HOW_TO_ADD_TRAV =
  'save the Trav contact card, add Trav to your group chat like any friend, then say "@trav hi"; Trav DMs anyone new once to set them up.';

export const DEFAULT_CONTACT_NAME = 'Trav';

/** The NOTE on the card: what Trav is, and that it reads the group. */
export const CONTACT_NOTE =
  'your group\'s travel agent: plans, bookings and the tab. add me to the group chat and say "@trav" to start. i can read the group chat, and only reply when someone @\'s me.';

export interface ContactCardInput {
  /** The relay line members text: E.164 (`+15555550100`) or an Apple ID email. */
  readonly line: string;
  /** What members should save it as (TRAV_RELAY_CONTACT_NAME); default "Trav". */
  readonly contactName?: string;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@,;:]+@[^\s@,;:]+\.[^\s@,;:]+$/;

/** RFC 2426 §4: backslash, comma, semicolon and newline are escaped in text values. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r?\n/g, '\\n');
}

export function travContactCard(input: ContactCardInput): string {
  const line = input.line.trim();
  const isPhone = E164.test(line);
  const isEmail = !isPhone && EMAIL.test(line);
  if (!isPhone && !isEmail) {
    throw new Error('travContactCard: line must be an E.164 number or an Apple ID email');
  }
  const name = (input.contactName ?? DEFAULT_CONTACT_NAME).trim();
  if (name.length === 0 || name.length > 40 || /[\r\n]/.test(name)) {
    throw new Error('travContactCard: contactName must be one short line');
  }
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:;${escapeText(name)};;;`,
    `FN:${escapeText(name)}`,
    isPhone ? `TEL;TYPE=CELL:${line}` : `EMAIL;TYPE=INTERNET:${line.toLowerCase()}`,
    `NOTE:${escapeText(CONTACT_NOTE)}`,
    'END:VCARD',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

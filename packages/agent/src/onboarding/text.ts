/**
 * T-170 (D-055): what Trav says while setting up a newcomer and on "@trav
 * leave" (VOICE §1: lowercase, short, no exclamation marks, at most one
 * emoji). Setup lines go to the newcomer's DM only; nothing here that names
 * an age or a payment app is ever addressed to the group.
 */
import { PROFILE_ASK_LINES } from '../settle/profiles.js';

/** The consent line: Trav reads the whole group thread (T-069 `seesAllGroupMessages`). */
export const READS_GROUP_LINE =
  "heads up, i can read everything in the group chat, not just messages to me. i only reply when someone @'s me";

/** The group's name as words only (no emoji or symbols: VOICE §1 rule 4), at most 40 characters. */
function plainGroupName(groupName: string): string {
  return [
    ...groupName
      .replace(/[^\p{L}\p{N}\s'&.-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, 40)
    .join('')
    .trim();
}

export function helloLines(groupName: string, hint: string | undefined): string[] {
  const plain = plainGroupName(groupName);
  const name = plain.length > 0 ? `"${plain}"` : 'your group chat';
  return [
    `hey, i'm Trav. i handle plans, bookings and the tab in ${name}.`,
    READS_GROUP_LINE,
    hint === undefined
      ? 'what should i call you?'
      : `are you ${hint}? yes, or tell me what to call you`,
  ];
}

export const NAME_AGAIN_TEXT = 'just a first name is fine';
export const NAME_ASK_TEXT = 'what should i call you then?';

export function nameTakenText(name: string): string {
  return `there's already a ${name} in the group. what should i call you so nobody gets mixed up? a last initial works`;
}

export function ageAskText(name: string): string {
  return `nice to meet you, ${name}. are you 18 or over? yes or no. it stays between us, it only changes what i suggest`;
}

export const AGE_AGAIN_TEXT = 'just a yes or no: are you 18 or over?';

export function doneText(name: string): string {
  return `you're set, ${name}. @ me in the group any time`;
}

/** The setup's last line plus T-166's one payment-apps ask, as one DM. */
export function doneWithAppsAskText(name: string): string {
  return [`you're set, ${name}. ${PROFILE_ASK_LINES[0]!}`, ...PROFILE_ASK_LINES.slice(1)].join(
    '\n',
  );
}

export function renamedText(name: string): string {
  return `got it, ${name} from now on`;
}

// ---------- "@trav leave" ----------

export const LEAVE_LEAD_ONLY_TEXT =
  "that one's for a lead, since it deletes the whole group's tab and plans. ask them to say '@trav leave'";

export function leaveConfirmText(unsettled: boolean): string {
  return [
    `that deletes this group's tab, plans and everything i remember about it, for everyone, then i leave. it can't be undone.${unsettled ? " the tab isn't settled yet." : ''}`,
    'reply "delete it" in the next 10 min to go ahead',
  ].join('\n');
}

export const LEAVE_CANCELLED_TEXT = "ok, i'm staying. nothing deleted";

/** The goodbye, sent before the delete runs (the group row is gone after it). */
export function leaveGoodbyeText(canLeave: boolean): string {
  return canLeave
    ? "deleting this group's data now, then i'm out. bye"
    : "deleting this group's data now. remove me from the chat to finish. bye";
}

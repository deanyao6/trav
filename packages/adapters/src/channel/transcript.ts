/**
 * Transcript printer in the VOICE §9.4 CLI format:
 *
 *   [9:40 pm] Dean: @trav get the 5 of us Razzmatazz tickets, Henry's sick
 *   [9:40 pm] trav: razzmatazz tonight, 5 tickets
 *                   ...
 *                   [card: booking_proposal rz-001 · approve/not_me/decline]
 *   [9:41 pm] Dean 👍 (approve rz-001)
 *   [9:41 pm] trav → Arjun (private): your razzmatazz ticket for tonight 🎟️
 *                   [card: ticket tkt-arjun · qr: data:image/png;base64,iVBORw0KGgoAAAANSUhE...]
 *
 * Continuation lines align under the first character of the text after
 * `[time] trav: `. Private (DM-lane) messages are marked `→ Name (private)`.
 * Pass `channel.groupTranscript()` to print exactly what the group sees.
 */
import type { RichCard, TimeZone } from '@trav/core';
import type { TranscriptEntry, TranscriptMessage } from './simulator/index.js';
import { stripEmojiVariants } from './keywords.js';

export interface PrintTranscriptOptions {
  /** Print times in this IANA zone. Default: the wall time in each entry's own ISO offset. */
  readonly timeZone?: TimeZone;
}

/** QR data URLs print their first 40 characters (VOICE §9.4). */
export const QR_PREVIEW_CHARS = 40;

/** `2026-03-14T21:40:00+01:00` → `9:40 pm`. */
export function formatTranscriptTime(iso: string, timeZone?: TimeZone): string {
  let hour: number;
  let minute: number;
  if (timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(Date.parse(iso));
    hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
    minute = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
  } else {
    const m = /T(\d{2}):(\d{2})/.exec(iso);
    if (!m) throw new Error(`formatTranscriptTime: not ISO-8601: ${iso}`);
    hour = Number(m[1]);
    minute = Number(m[2]);
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`formatTranscriptTime: cannot read time from ${iso}`);
  }
  const period = hour < 12 ? 'am' : 'pm';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${period}`;
}

/** `[card: type id · actions]`, the QR preview for tickets, or undefined if nothing to show. */
export function cardLine(entry: TranscriptMessage): string | undefined {
  if (entry.renderedAsCard) return `[card: text ${entry.messageId}]`;
  const card = entry.card;
  if (!card) return undefined;
  const details: string[] = [];
  const actionIds: string[] = entry.actions.map((a) => a.id);
  // Pick buttons exist only where buttons render (a degraded entry dropped them).
  if (card.type === 'options' && card.options.length > 0 && !entry.degraded) {
    actionIds.push(`${card.pickAction.id}:${card.options.map((o) => o.index).join('/')}`);
  }
  if (actionIds.length > 0) details.push(actionIds.join('/'));
  const qr = qrPreview(card);
  if (qr) details.push(`qr: ${qr}`);
  return `[card: ${card.type} ${card.cardId}${details.length > 0 ? ` · ${details.join(' · ')}` : ''}]`;
}

function qrPreview(card: RichCard): string | undefined {
  if (card.type !== 'ticket') return undefined;
  const url = card.qr.dataUrl;
  return url.length > QR_PREVIEW_CHARS ? `${url.slice(0, QR_PREVIEW_CHARS)}...` : url;
}

function block(header: string, indentWidth: number, lines: readonly string[]): string[] {
  const indent = ' '.repeat(indentWidth);
  const [first = '', ...rest] = lines;
  return [`${header}${first}`.trimEnd(), ...rest.map((l) => `${indent}${l}`.trimEnd())];
}

/** "(approve rz-001)" for a reaction on a card whose action uses that tapback. */
function reactionMeaning(target: TranscriptMessage | undefined, reaction: string): string {
  if (!target?.card) return '';
  const strip = stripEmojiVariants;
  const actions = target.outbound?.actions ?? target.actions;
  const action = actions.find(
    (a) => a.tapback !== undefined && strip(a.tapback) === strip(reaction),
  );
  return action ? ` (${action.id} ${target.card.cardId})` : '';
}

export function printTranscript(
  entries: readonly TranscriptEntry[],
  options: PrintTranscriptOptions = {},
): string {
  const messages = new Map<string, TranscriptMessage>();
  for (const e of entries) if (e.type === 'message') messages.set(e.messageId, e);

  const out: string[] = [];
  for (const e of entries) {
    const time = `[${formatTranscriptTime(e.at, options.timeZone)}] `;
    const priv = e.lane === 'dm' ? ' (private)' : '';
    switch (e.type) {
      case 'message': {
        if (e.systemNotice) {
          // T-165: the centered grey subscript, printed without a speaker.
          out.push(`${time}(notice) ${e.text}`);
          break;
        }
        const outbound = e.direction === 'outbound';
        const dmName = e.dmName ?? e.dmHandle ?? '';
        const speaker = outbound
          ? e.lane === 'dm'
            ? `${e.fromName} → ${dmName} (private)`
            : e.fromName
          : e.lane === 'dm'
            ? `${e.fromName} → trav (private)`
            : e.fromName;
        const header = `${time}${speaker}: `;
        // Align continuation lines under the text of a plain `[time] Name: ` header.
        const indent = `${time}${e.fromName}: `.length;
        const lines = e.text.split(/\r?\n/);
        for (const a of e.attachments) {
          lines.push(`[${a.kind}: ${a.alt ?? a.fileName ?? a.mimeType}]`);
        }
        const card = cardLine(e);
        if (card) lines.push(card);
        out.push(...block(header, indent, lines));
        break;
      }
      case 'reaction': {
        const verb = e.removed ? 'removed ' : '';
        const meaning = e.removed
          ? ''
          : reactionMeaning(messages.get(e.targetMessageId), e.reaction);
        out.push(`${time}${e.fromName}${priv} ${verb}${e.reaction}${meaning}`);
        break;
      }
      case 'button_tap': {
        const target = messages.get(e.cardMessageId);
        const pick =
          target?.card?.type === 'options' && target.card.pickAction.id === e.actionId
            ? target.card.pickAction
            : undefined;
        const action = target?.actions.find((a) => a.id === e.actionId) ?? pick;
        const label = action?.label ?? e.actionId;
        const value = e.value !== undefined ? ` ${e.value}` : '';
        out.push(`${time}${e.fromName}${priv} tapped ${label} (${e.actionId}${value} ${e.cardId})`);
        break;
      }
      case 'member_joined':
      case 'member_left':
        out.push(`${time}${e.name} ${e.type === 'member_joined' ? 'joined' : 'left'} the chat`);
        break;
    }
  }
  return out.join('\n');
}

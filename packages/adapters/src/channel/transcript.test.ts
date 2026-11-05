import { describe, expect, it } from 'vitest';
import { createSimulatorChannel } from './simulator/index.js';
import type { ChannelSendOptions } from './types.js';
import { cardLine, formatTranscriptTime, printTranscript } from './transcript.js';
import {
  BCN_CONVERSATION,
  PROPOSAL_ACTIONS,
  PROPOSAL_TEXT,
  QR_DATA_URL,
  RECEIPT_TEXT,
  TICKET_TEXT,
  barcelona,
  dmMsg,
  groupMsg,
  manualClock,
  optionsCard,
  proposalCard,
  receiptCard,
  ticketCard,
} from './testing.js';

/** The scripted Razzmatazz moment from VOICE §9.4 / CLAUDE.md §8. */
async function razzmatazz() {
  const clock = manualClock('2026-03-14T21:40:00+01:00');
  const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
  await sim.injectMessage({
    from: 'h_dean',
    text: "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
  });
  const proposal = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
  await sim.sendGroup(BCN_CONVERSATION, proposal);
  clock.advanceMinutes(1);
  await sim.injectReaction({ from: 'h_dean', targetMessageId: proposal.id, reaction: '👍' });
  await sim.sendGroup(BCN_CONVERSATION, groupMsg(RECEIPT_TEXT, { card: receiptCard() }));
  for (const name of ['dean', 'chase', 'piotr', 'arjun', 'crowley']) {
    const memberId = `mem_${name}`;
    await sim.sendDirect(
      `h_${name}`,
      dmMsg(memberId, TICKET_TEXT, { card: ticketCard(memberId, `tkt-${name}`) }),
    );
  }
  return sim;
}

const QR40 = `${QR_DATA_URL.slice(0, 40)}...`;

describe('printTranscript (VOICE §9.4)', () => {
  it('prints the scripted Razzmatazz sequence exactly', async () => {
    const sim = await razzmatazz();
    const ticketLines = ['Dean', 'Chase', 'Piotr', 'Arjun', 'Crowley'].flatMap((n) => [
      `[9:41 pm] trav → ${n} (private): ${TICKET_TEXT}`,
      `                [card: ticket tkt-${n.toLowerCase()} · qr: ${QR40}]`,
    ]);
    expect(printTranscript(sim.transcript())).toBe(
      [
        "[9:40 pm] Dean: @trav get the 5 of us Razzmatazz tickets, Henry's sick",
        '[9:40 pm] trav: razzmatazz tonight, 5 tickets',
        '                Dean, Chase, Piotr, Arjun, Crowley (not Henry)',
        '                €18 each · €90 total · refundable until 10pm',
        "                charged to Dean's card, split 5 ways on the tab",
        '                👍 to book. price held for 15 min',
        '                [card: booking_proposal rz-001 · approve/not_me/decline]',
        '[9:41 pm] Dean 👍 (approve rz-001)',
        '[9:41 pm] trav: booked ✅ razzmatazz, 5 tickets, €90',
        '                [card: receipt rz-rcpt]',
        ...ticketLines,
      ].join('\n'),
    );
  });

  it('the group transcript shows no DMs, no tickets and no QR codes', async () => {
    const sim = await razzmatazz();
    const group = printTranscript(sim.groupTranscript());
    expect(group).not.toContain('(private)');
    expect(group).not.toContain('[card: ticket');
    expect(group).not.toContain('qr:');
    expect(group.split('\n')).toHaveLength(10);
  });

  it('a DM thread prints only that member', async () => {
    const sim = await razzmatazz();
    expect(printTranscript(sim.dmTranscript('h_arjun'))).toBe(
      [
        `[9:41 pm] trav → Arjun (private): ${TICKET_TEXT}`,
        `                [card: ticket tkt-arjun · qr: ${QR40}]`,
      ].join('\n'),
    );
    expect(printTranscript(sim.dmTranscript('h_henry'))).toBe('');
  });

  it('prints inbound DMs, button taps, removed reactions, Trav reactions and membership', async () => {
    const clock = manualClock('2026-03-15T00:05:00+01:00');
    const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
    const opt = groupMsg('two picks for tomorrow', { card: optionsCard() });
    await sim.sendGroup(BCN_CONVERSATION, opt);
    await sim.injectButtonTap({
      from: 'h_chase',
      cardMessageId: opt.id,
      actionId: 'pick',
      value: 'opt_pg',
    });
    const thanks = await sim.injectMessage({ from: 'h_crowley', text: 'thanks trav' });
    await sim.react(BCN_CONVERSATION, {
      id: 'msg_heart',
      groupId: 'grp_barcelona',
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: thanks.messageId,
      emoji: '❤️',
    });
    await sim.injectReaction({
      from: 'h_piotr',
      targetMessageId: opt.id,
      reaction: '😂',
    });
    await sim.injectReaction({
      from: 'h_piotr',
      targetMessageId: opt.id,
      reaction: '😂',
      removed: true,
    });
    clock.advanceHours(12);
    await sim.injectMessage({ from: 'h_crowley', text: 'share it', lane: 'dm' });
    await sim.injectMemberJoined({ participant: { handle: 'h_alex', displayName: 'Alex' } });
    expect(printTranscript(sim.transcript())).toBe(
      [
        '[12:05 am] trav: two picks for tomorrow',
        '                 [card: options opt-1 · pick:1/2]',
        '[12:05 am] Chase tapped Pick (pick opt_pg opt-1)',
        '[12:05 am] Crowley: thanks trav',
        '[12:05 am] trav ❤️',
        '[12:05 am] Piotr 😂',
        '[12:05 am] Piotr removed 😂',
        '[12:05 pm] Crowley → trav (private): share it',
        '[12:05 pm] Alex joined the chat',
      ].join('\n'),
    );
  });

  it('marks long text rendered as a card and lists attachments', async () => {
    const clock = manualClock('2026-03-14T13:00:00+01:00');
    const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
    await sim.injectMessage({
      from: 'h_arjun',
      text: 'lunch receipt',
      attachments: [
        { kind: 'image', mimeType: 'image/png', uri: 'fixtures/r.png', fileName: 'r.png' },
      ],
    });
    const long = groupMsg('a\nb\nc\nd\ne\nf\ng');
    const hint: ChannelSendOptions = { renderAsCard: true };
    await sim.sendGroup(BCN_CONVERSATION, long, hint);
    const printed = printTranscript(sim.transcript()).split('\n');
    expect(printed[0]).toBe('[1:00 pm] Arjun: lunch receipt');
    expect(printed[1]).toBe('                 [image: r.png]');
    expect(printed.at(-1)).toBe(`                [card: text ${long.id}]`);
  });

  it('prints outbound images as [image: alt]', async () => {
    const clock = manualClock('2026-03-15T10:00:00+01:00');
    const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
    const msg = groupMsg('day 3 ☀️', {
      images: [{ url: 'data:image/png;base64,AAAA', alt: 'sunset at bunkers' }],
    });
    await sim.sendGroup(BCN_CONVERSATION, msg);
    expect(printTranscript(sim.transcript())).toBe(
      ['[10:00 am] trav: day 3 ☀️', '                 [image: sunset at bunkers]'].join('\n'),
    );
  });
});

describe('formatTranscriptTime', () => {
  it.each([
    ['2026-03-14T21:40:00+01:00', undefined, '9:40 pm'],
    ['2026-03-14T00:05:00+01:00', undefined, '12:05 am'],
    ['2026-03-14T12:00:00+01:00', undefined, '12:00 pm'],
    ['2026-03-14T09:07:00Z', undefined, '9:07 am'],
    ['2026-03-14T20:40:00Z', 'Europe/Madrid', '9:40 pm'],
    ['2026-03-14T20:40:00Z', 'America/New_York', '4:40 pm'],
  ])('%s in %s → %s', (iso, tz, out) => {
    expect(formatTranscriptTime(iso, tz)).toBe(out);
  });

  it('throws on non-ISO input', () => {
    expect(() => formatTranscriptTime('yesterday')).toThrow();
  });
});

describe('cardLine', () => {
  it('omits the actions section when a card has none', async () => {
    const clock = manualClock('2026-03-14T21:40:00+01:00');
    const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
    const msg = groupMsg(RECEIPT_TEXT, { card: receiptCard() });
    await sim.sendGroup(BCN_CONVERSATION, msg);
    expect(cardLine(sim.sentMessage(msg.id)!)).toBe('[card: receipt rz-rcpt]');
  });

  it('a button-less channel shows no pick buttons on an options card', async () => {
    const clock = manualClock('2026-03-14T21:40:00+01:00');
    const sim = createSimulatorChannel({
      clock,
      conversations: [barcelona],
      capabilities: { buttons: false },
    });
    const msg = groupMsg('pick one', { card: optionsCard() });
    const res = await sim.sendGroup(BCN_CONVERSATION, msg);
    expect(res.ok && res.value.degraded).toBe(true);
    expect(cardLine(sim.sentMessage(msg.id)!)).toBe('[card: options opt-1]');
  });

  it('plain bubbles have no card line', async () => {
    const clock = manualClock('2026-03-14T21:40:00+01:00');
    const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
    const msg = groupMsg('hi');
    await sim.sendGroup(BCN_CONVERSATION, msg);
    expect(cardLine(sim.sentMessage(msg.id)!)).toBeUndefined();
  });
});

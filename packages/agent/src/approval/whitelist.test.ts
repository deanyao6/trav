/**
 * T-182: approval from a whitelist, decided in code. Unit tests for the
 * whitelist, then the loop: every adversarial case from the T-182 task line
 * gets no approval and no purchase, from the requester (the one whose bare
 * "yes" would count), bare inside the reply window and quote-replying the card.
 */
import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '@trav/core';
import { isReaction } from '@trav/core';
import { harness, RAZZMATAZZ_ASK, type Harness } from '../runtime.testkit.js';
import type { TurnResult } from '../loop.js';
import {
  APPROVE_REPLIES,
  APPROVE_TEXT_ALIASES,
  DECLINE_TEXT_ALIASES,
  NOT_ME_TEXT_ALIASES,
  approvalCounts,
  approvalReplyIntent,
  nearMissKind,
  nearMissReply,
  normalizeApprovalReply,
} from './whitelist.js';

const NAMES = ['Dean', 'Henry', 'Chase', 'Piotr', 'Arjun', 'Crowley'];

describe('approvalReplyIntent: exact replies only', () => {
  it.each([
    'yes',
    'Yes',
    'YES!!',
    'yes.',
    'yep',
    'approve',
    'Approved!',
    'i approve',
    'I approve.',
    'do it',
    'book it',
    'Book it 🎉',
    'yes 🙏',
    'yes!! 🙏',
    'yes 👍',
    'yes book it',
    'yes please',
    '@trav yes',
    '@trav: book it',
    'trav, do it',
    'go',
    '👍',
    '👍👍',
    '👍🏽',
    '​yes',
  ])('%j approves', (text) => {
    expect(approvalReplyIntent(text)).toBe('approve');
  });

  it.each([
    "i don't approve",
    'i dont approve',
    'yes but not for me',
    'approve for him',
    'i approve for him',
    "i don't approve for the group",
    'i approve for the group',
    'i approve for me and henry',
    'oh yeah sure, buy 50',
    'oh yeah sure',
    'sure',
    'yeah',
    'ok',
    'okay',
    'yes 😂',
    'yes 🙄',
    'yes 😉',
    'yes lol',
    'yes jk',
    'yes 👎',
    '👍👎',
    'yes?',
    'yes...?',
    'no yes',
    'yes no',
    '> yes',
    '"yes"',
    '“yes”',
    "'yes'",
    'Dean: yes',
    'fwd: yes',
    'Fwd: book it',
    '[forwarded] yes',
    'he said yes',
    'yes\nyes',
    'yes yes',
    'yesterday',
    "don't get the tickets",
    'should we get tickets?',
    '@trav get tickets?? jk',
    'do it?',
    'never book it',
    'not yet',
    '',
  ])('%j is not an approval', (text) => {
    expect(approvalReplyIntent(text)).not.toBe('approve');
  });

  it('declines and opt-outs keep their exact aliases', () => {
    expect(approvalReplyIntent('nah.')).toBe('decline');
    expect(approvalReplyIntent('👎')).toBe('decline');
    expect(approvalReplyIntent('no 👍')).toBeUndefined();
    expect(approvalReplyIntent("I'm out")).toBe('not_me');
    expect(approvalReplyIntent('without me')).toBe('not_me');
  });

  it('a quoted or forwarded reply keeps its quote marks, so it never normalizes to "yes"', () => {
    expect(normalizeApprovalReply('> yes')).toBe('> yes');
    expect(normalizeApprovalReply('"yes"')).toBe('"yes"');
    expect(normalizeApprovalReply('fwd: yes')).toBe('fwd: yes');
  });
});

describe('approvalCounts', () => {
  it('a tap or a 👍 tapback counts; the gate and handler decide who', () => {
    expect(approvalCounts({ via: 'button', intent: 'approve', text: '' })).toBe(true);
    expect(approvalCounts({ via: 'reaction', intent: 'approve', text: '' })).toBe(true);
  });

  it('text counts only when exact, and never when forwarded', () => {
    expect(approvalCounts({ via: 'text', intent: 'approve', text: 'yes' })).toBe(true);
    expect(approvalCounts({ via: 'text', intent: 'approve', text: 'yes', forwarded: true })).toBe(
      false,
    );
    expect(approvalCounts({ via: 'text', intent: 'approve', text: "everyone's in, book it" })).toBe(
      false,
    );
    expect(
      approvalCounts({ via: 'text', intent: 'approve', text: 'i approve for the group' }),
    ).toBe(false);
  });

  it('a decline is never an approval', () => {
    expect(approvalCounts({ via: 'button', intent: 'decline', text: '' })).toBe(false);
    expect(approvalCounts({ via: 'text', intent: 'not_me', text: 'not me' })).toBe(false);
  });
});

describe('nearMissKind: a question back, never a swallowed request', () => {
  it.each([
    ["i don't approve", 'decline'],
    ['yes but not for me', 'not_me'],
    ['approve for him', 'generic'],
    ["i don't approve for the group", 'decline'],
    ['oh yeah sure', 'generic'],
    ['sure lol', 'generic'],
    ['@trav ok', 'generic'],
    // T-182 r1 #5: a no gets the decline hint, never the approve hint.
    ["@trav no don't book it", 'decline'],
    ["@trav don't do it", 'decline'],
    ['never book it', 'decline'],
  ] as const)('%j ⇒ %s', (text, kind) => {
    expect(nearMissKind(text, NAMES)).toBe(kind);
  });

  // T-182 r1 #1: a party edit is never a near miss; it goes on through the loop.
  it.each([
    '@trav book me too',
    '@trav book it for me too',
    '@trav book it without chase',
    '@trav do it for me and chase only',
    '@trav book it for henry too',
    'yes for henry too',
    'do it for me and henry',
    'yes but without me',
    'book it for him too',
    'book it except me',
    'only me',
  ])('party edit %j is not a near miss', (text) => {
    expect(nearMissKind(text, NAMES)).toBeUndefined();
  });

  it('a decline near miss is answered with the decline hint', () => {
    expect(nearMissReply('decline')).toBe('not booked. reply "no" to drop it, or "yes" to book it');
  });

  it.each([
    'yes',
    '👍',
    'oh yeah sure, buy 50',
    "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
    'i paid €84 for dinner',
    "henry's sick",
    'ok see you at 9',
    'yes the restaurant was great',
    'where are we going',
  ])('%j is not a near miss', (text) => {
    expect(nearMissKind(text, NAMES)).toBeUndefined();
  });

  it('the replies follow VOICE: lowercase, no exclamation, tapback glyphs only', () => {
    for (const line of [
      nearMissReply('generic'),
      nearMissReply('not_me'),
      nearMissReply('generic', true),
    ]) {
      expect(line).toBe(line.toLowerCase());
      expect(line).not.toMatch(/!/);
      expect(line.length).toBeLessThan(120);
    }
  });
});

// ---------- the loop ----------

function messages(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
}

async function proposed(): Promise<{ h: Harness; cardMessageId: string }> {
  const h = harness();
  const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
  const card = messages(turn)[0];
  if (card === undefined || h.pending().length !== 1) throw new Error(`no card (${turn.note})`);
  return { h, cardMessageId: card.id };
}

function noApproval(h: Harness, text: string): void {
  expect(h.auditTypes(), text).not.toContain('approval.granted');
  expect(h.auditTypes(), text).not.toContain('booking.attempted');
  expect(h.tickets.purchaseCount(), text).toBe(0);
  expect(h.pending()[0]?.status, text).toBe('pending');
}

/** The T-182 adversarial approval replies. */
const ADVERSARIAL = [
  "i don't approve",
  'yes but not for me',
  'approve for him',
  // T-132 counted this as an approval once (r2 #1); regression case.
  "i don't approve for the group",
  'oh yeah sure, buy 50',
  '> yes',
  '"yes"',
  'Dean: yes',
  'fwd: yes',
  "don't get the tickets",
  'should we get tickets?',
  '@trav get tickets?? jk',
  'yes 😂',
  'i approve for the group',
  'yes i approve for all of us',
] as const;

describe('T-182 in the loop: no approval, no purchase', () => {
  it.each(ADVERSARIAL)('bare, from the requester inside the reply window: %j', async (text) => {
    const { h } = await proposed();
    await h.say('h_dean', text);
    noApproval(h, text);
  });

  it.each(ADVERSARIAL)('quote-replying the card, from the requester: %j', async (text) => {
    const { h, cardMessageId } = await proposed();
    await h.say('h_dean', text, { replyToMessageId: cardMessageId });
    noApproval(h, text);
  });

  it('a near miss on the card gets one question back and an audit row; "not me" hints when they want out', async () => {
    const { h, cardMessageId } = await proposed();
    const t1 = await h.say('h_dean', "i don't approve", { replyToMessageId: cardMessageId });
    expect(t1.note).toBe('approval:not_whitelisted');
    // T-182 r1 #5: a no gets the decline hint.
    expect(messages(t1).map((m) => m.text)).toEqual([
      'not booked. reply "no" to drop it, or "yes" to book it',
    ]);
    const t2 = await h.say('h_dean', 'yes but not for me', { replyToMessageId: cardMessageId });
    expect(messages(t2).map((m) => m.text)).toEqual([
      'not booked. reply "not me" to drop out, or "yes" to book it',
    ]);
    const rows = h.audit().filter((e) => e.type === 'approval.invalid_attempt');
    expect(rows.map((e) => (e.payload as Record<string, unknown>)['cause'])).toEqual([
      'not_whitelisted',
      'not_whitelisted',
    ]);
    noApproval(h, 'near misses');
  });

  it.each([
    '@trav book me too',
    '@trav book it for me too',
    '@trav book it without chase',
    '@trav do it for me and chase only',
    '@trav book it for henry too',
  ])(
    'T-182 r1 #1: party edit %j is never swallowed by a near-miss answer, and never approves',
    async (text) => {
      const { h, cardMessageId } = await proposed();
      const card = h.pending()[0]!;
      const turn = await h.say('h_dean', text);
      expect(turn.note, text).not.toBe('approval:not_whitelisted');
      for (const m of messages(turn)) expect(m.text, text).not.toMatch(/^not booked\./);
      expect(
        h
          .audit()
          .filter((e) => e.type === 'approval.invalid_attempt')
          .map((e) => (e.payload as Record<string, unknown>)['cause']),
        text,
      ).not.toContain('not_whitelisted');
      expect(h.auditTypes(), text).not.toContain('approval.granted');
      expect(h.tickets.purchaseCount(), text).toBe(0);
      // The old card still can't be bought by this message; a 👍 is its own act.
      expect(h.runtime.stores.group.bookings.getProposal(card.proposalId)?.status).not.toBe(
        'completed',
      );
      void cardMessageId;
    },
  );

  it('T-182 r1 #5: "no don\'t book it" / "don\'t do it" on the card get the decline hint', async () => {
    for (const text of ["@trav no don't book it", "@trav don't do it"]) {
      const { h, cardMessageId } = await proposed();
      const turn = await h.say('h_dean', text, { replyToMessageId: cardMessageId });
      expect(
        messages(turn).map((m) => m.text),
        text,
      ).toEqual(['not booked. reply "no" to drop it, or "yes" to book it']);
      noApproval(h, text);
    }
  });

  it('T-182 r1 #7: every card built from the whitelist carries exactly its text aliases', async () => {
    const h = harness();
    const turn = await h.say('h_dean', RAZZMATAZZ_ASK);
    const actions = messages(turn)[0]?.actions ?? [];
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.find((a) => a.id === 'approve')?.textAliases).toEqual(APPROVE_TEXT_ALIASES);
    expect(actions.find((a) => a.id === 'decline')?.textAliases).toEqual(DECLINE_TEXT_ALIASES);
    expect(actions.find((a) => a.id === 'not_me')?.textAliases).toEqual(NOT_ME_TEXT_ALIASES);
    expect(APPROVE_TEXT_ALIASES).toEqual(APPROVE_REPLIES.filter((r) => r !== '👍'));
  });

  it('"approve for him" keeps the T-132 claim audit (claimed_for_other), never an approval', async () => {
    const { h, cardMessageId } = await proposed();
    await h.say('h_dean', 'approve for him', { replyToMessageId: cardMessageId });
    const row = h
      .audit()
      .filter((e) => e.type === 'approval.invalid_attempt')
      .at(-1);
    expect(row?.payload).toMatchObject({ cause: 'claimed_for_other' });
    noApproval(h, 'approve for him');
  });

  it('a forwarded "yes" never approves, even on the card', async () => {
    const { h, cardMessageId } = await proposed();
    const event = await h.channel.injectMessage({
      from: 'h_dean',
      text: 'yes',
      replyToMessageId: cardMessageId,
    });
    await h.runtime.agent.handleInbound({
      ...event,
      messageId: `${event.messageId}_fwd`,
      forwarded: true,
    });
    noApproval(h, 'forwarded yes');
  });

  it('a "yes" quote-replying a member\'s message answers that member, never the card', async () => {
    const { h } = await proposed();
    const chase = await h.channel.injectMessage({ from: 'h_chase', text: 'dinner at 9 after?' });
    await h.runtime.agent.handleInbound(chase);
    await h.say('h_dean', 'yes', { replyToMessageId: chase.messageId });
    noApproval(h, 'yes to chase');
  });

  it('control: the exact replies still approve (bare in the window, on the card, a 👍)', async () => {
    for (const run of [
      async (h: Harness) => h.say('h_dean', 'yes'),
      async (h: Harness, card: string) => h.say('h_dean', 'Book it 🎉', { replyToMessageId: card }),
      async (h: Harness, card: string) => h.react('h_dean', card, '👍'),
      async (h: Harness, card: string) => h.tap('h_dean', card, 'approve'),
    ]) {
      const { h, cardMessageId } = await proposed();
      const turn = await run(h, cardMessageId);
      expect(turn.note).toBe('approval:handled');
      expect(h.auditTypes()).toContain('approval.granted');
    }
  });
});

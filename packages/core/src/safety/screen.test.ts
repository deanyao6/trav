import { describe, expect, it } from 'vitest';
import type { ContentTag } from '../domain/trip.js';
import type { Member } from '../domain/group.js';
import type {
  ExpenseConfirmCard,
  OutboundMessage,
  OutboundReaction,
  TicketCard,
} from '../cards.js';
import { RESTRICTED_TAGS, detectContentTags, lintVoice, screenOutbound } from './index.js';
import type { RoastTopicCategory, ScreenContext, SuppressionCause } from './index.js';
import {
  BCN_NOW,
  barcelonaMembers,
  consentWithRoast,
  group,
  groupMessage,
  loadSafetyFixture,
  member,
  recapCard,
  trip,
} from './test-helpers.js';

// ---------- fixtures ----------

interface BlocklistFixture {
  readonly blocked: readonly {
    readonly id: string;
    readonly category: RoastTopicCategory;
    readonly line: string;
  }[];
  readonly allowed: readonly { readonly id: string; readonly line: string }[];
  readonly gated: readonly {
    readonly id: string;
    readonly cause: SuppressionCause;
    readonly target: string;
    readonly line: string;
  }[];
}

interface TcFixture {
  readonly now: string;
  readonly members: readonly {
    readonly memberId: string;
    readonly displayName: string;
    readonly role: Member['role'];
    readonly birthDate: string;
    readonly ageBand: Member['ageBand'];
    readonly guardianMemberId?: string;
  }[];
  readonly candidates: readonly {
    readonly id: string;
    readonly expect: 'sent' | 'suppressed';
    readonly cause?: SuppressionCause;
    readonly text: string;
    readonly contentTags?: readonly ContentTag[];
    readonly to?: string;
    readonly audience?: readonly string[];
    readonly explicitAdultRequest?: boolean;
    readonly adultOnly?: boolean;
  }[];
}

const blocklist = loadSafetyFixture<BlocklistFixture>('roast-blocklist-cases.json');
const tc = loadSafetyFixture<TcFixture>('turks-caicos-candidates.json');

const BCN = barcelonaMembers();
const ALL_IN = consentWithRoast(BCN.map((m) => m.memberId));

function bcnCtx(over: Partial<ScreenContext> = {}): ScreenContext {
  return {
    group: group({ roastMode: true }),
    members: BCN,
    trip: trip(),
    consent: ALL_IN,
    now: BCN_NOW,
    ...over,
  };
}

// VOICE §4.7 B, with its two roast lines.
const ROAST_1 =
  "€62 of it was kebabs at 3am, which is a kebab-to-ticket ratio i haven't seen before";
const ROAST_2 =
  'Jordan paid for two of those. Jordan has paid for kebabs 3 nights running. the tab remembers';
const RECAP_B = [
  'morning after, day 3 ☀️',
  `razzmatazz, 5 of you, €199 all in. ${ROAST_1}`,
  ROAST_2,
  'Maya → Dean €31.60 · Priya → Dean €22.80 · Sam → Dean €18.80',
  "Sagrada Família at 3pm. it's a church, dress like it",
].join('\n');

function recapDraft(
  text = RECAP_B,
  lines: readonly string[] = [ROAST_1, ROAST_2],
): OutboundMessage {
  return groupMessage(text, { id: 'recap_1', roast: true, card: recapCard(text, lines) });
}

// ---------- roast ----------

describe('screenOutbound: roast lines', () => {
  it('roast mode on, everyone opted in: recap passes untouched', () => {
    const draft = recapDraft();
    const r = screenOutbound(draft, bcnCtx());
    expect(r.suppressed).toEqual([]);
    expect(r.outbound).toBe(draft);
  });

  it('roast mode off: roast lines stripped, neutral recap sent, roast cleared, card in sync', () => {
    const r = screenOutbound(recapDraft(), bcnCtx({ group: group() }));
    const out = r.outbound as OutboundMessage;
    expect(out.text).toBe(
      [
        'morning after, day 3 ☀️',
        'razzmatazz, 5 of you, €199 all in.',
        'Maya → Dean €31.60 · Priya → Dean €22.80 · Sam → Dean €18.80',
        "Sagrada Família at 3pm. it's a church, dress like it",
      ].join('\n'),
    );
    expect(out.roast).toBeUndefined();
    expect(out.card?.fallbackText).toBe(out.text);
    expect(out.card?.type === 'recap' ? out.card.roastLines : null).toEqual([]);
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_mode_off']);
    expect(r.suppressed[0]).toMatchObject({
      event: 'roast.suppressed',
      payload: { cause: 'mode_off', messageDraftId: 'recap_1' },
    });
    expect(lintVoice(out.text, 'recap').ok).toBe(true);
  });

  it('age unknown ⇒ roast lines stripped until everyone is confirmed 18+', () => {
    const roster = [...BCN, member({ memberId: 'alex', displayName: 'Alex' })];
    const r = screenOutbound(recapDraft(), bcnCtx({ members: roster }));
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_age_unconfirmed']);
    expect((r.outbound as OutboundMessage).roast).toBeUndefined();
    const ok = screenOutbound(
      recapDraft(),
      bcnCtx({ members: roster, group: group({ roastMode: true, allAdultsConfirmed: true }) }),
    );
    expect(ok.suppressed).toEqual([]);
  });

  it('a minor in the group strips every roast line', () => {
    const roster = [
      ...BCN,
      member({ memberId: 'kid', displayName: 'Kid', birthDate: '2011-01-01' }),
    ];
    const r = screenOutbound(recapDraft(), bcnCtx({ members: roster }));
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_minor_in_group']);
    expect(r.suppressed[0]?.payload).toMatchObject({ cause: 'minor_in_group' });
  });

  it('only the line naming an opted-out member is stripped', () => {
    const r = screenOutbound(
      recapDraft(),
      bcnCtx({ consent: consentWithRoast(['dean', 'maya', 'priya', 'sam']) }),
    );
    const out = r.outbound as OutboundMessage;
    expect(out.text).not.toContain('Jordan has paid');
    expect(out.text).toContain(ROAST_1);
    expect(out.roast).toBe(true);
    expect(out.card?.type === 'recap' ? out.card.roastLines : null).toEqual([ROAST_1]);
    expect(r.suppressed).toEqual([
      expect.objectContaining({
        cause: 'roast_member_opted_out',
        detail: 'jordan',
        payload: expect.objectContaining({ cause: 'member_opted_out' }),
      }),
    ]);
  });

  it.each(blocklist.blocked.map((c) => [c.id, c.line, c.category] as const))(
    'blocklist fixture %s is suppressed with a reason',
    (_id, line, category) => {
      const text = `morning after, day 3 ☀️\n${line}\n€199 total, €39.80 each`;
      const r = screenOutbound(recapDraft(text, [line]), bcnCtx());
      const out = r.outbound as OutboundMessage;
      expect(out.text).toBe('morning after, day 3 ☀️\n€199 total, €39.80 each');
      expect(out.roast).toBeUndefined();
      const reason = r.suppressed.find((s) => s.cause === 'roast_topic_blocked');
      expect(reason?.detail).toBe(category);
      expect(reason?.event).toBe('roast.suppressed');
      expect(reason?.payload).toMatchObject({ cause: 'topic_blocked', topicCategory: category });
    },
  );

  it.each(blocklist.allowed.map((c) => [c.id, c.line] as const))(
    'allowlist fixture %s passes',
    (_id, line) => {
      const text = `morning after, day 3 ☀️\n${line}`;
      const r = screenOutbound(recapDraft(text, [line]), bcnCtx());
      expect(r.suppressed).toEqual([]);
      expect((r.outbound as OutboundMessage).roast).toBe(true);
    },
  );

  it.each(blocklist.gated.map((c) => [c.id, c] as const))(
    'gated fixture %s is suppressed by gate 1',
    (_id, c) => {
      const roster: Member[] = [
        ...BCN.map((m) =>
          m.memberId === 'henry' ? { ...m, active: false, leftAt: '2026-03-14T09:00:00Z' } : m,
        ),
        member({ memberId: 'alex', displayName: 'Alex', role: 'guest', ageBand: 'adult' }),
      ];
      const consent = consentWithRoast(['dean', 'maya', 'jordan', 'priya', 'henry', 'alex']); // Sam opted out
      const text = `morning after, day 3 ☀️\n${c.line}`;
      const r = screenOutbound(recapDraft(text, [c.line]), bcnCtx({ members: roster, consent }));
      expect((r.outbound as OutboundMessage).text).toBe('morning after, day 3 ☀️');
      expect(r.suppressed.map((s) => s.cause)).toEqual([c.cause]);
    },
  );

  it('roast lines never ride on proposals, receipts, settle-ups or DMs', () => {
    const aside = 'Sam has booked 4 ubers today';
    const dm = groupMessage(`logged. ${aside}`, {
      to: { kind: 'member', memberId: 'sam' },
      roast: true,
    });
    const r = screenOutbound(dm, bcnCtx({ roastLines: [aside] }));
    expect((r.outbound as OutboundMessage).text).toBe('logged.');
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_wrong_place']);
  });

  it('expense aside in the group is allowed (one line, mode on)', () => {
    const aside = 'that is Jordan’s third kebab run';
    const draft = groupMessage(`logged: €12 kebabs on Jordan, 3 ways → €4 each\n${aside}`, {
      roast: true,
    });
    const r = screenOutbound(draft, bcnCtx({ roastLines: [aside] }));
    expect(r.suppressed).toEqual([]);
  });

  it('caps roast lines at 2 per message', () => {
    const lines = ['19 ubers in 4 days', '40 minutes to pick a restaurant', '€14 for a water'];
    const text = `morning after, day 3 ☀️\n${lines.join('\n')}`;
    const r = screenOutbound(recapDraft(text, lines), bcnCtx());
    const out = r.outbound as OutboundMessage;
    expect(out.text).not.toContain('€14 for a water');
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_line_limit']);
  });

  it('fails closed when a blocked roast line cannot be found in the text', () => {
    const r = screenOutbound(
      recapDraft('morning after ☀️\nHenry is sick lol', ["Henry's sick"]),
      bcnCtx(),
    );
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toContain('roast_unlocatable');
  });

  it('roast-flagged message with unidentified lines is checked whole and fails closed', () => {
    const clean = groupMessage('19 ubers in 4 days. the metro is right there', { roast: true });
    expect(screenOutbound(clean, bcnCtx()).outbound).toBe(clean);
    const dirty = groupMessage('Henry is sick, €0 spent', { roast: true });
    const r = screenOutbound(dirty, bcnCtx());
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_topic_blocked', 'roast_unlocatable']);
    expect(screenOutbound(clean, bcnCtx({ group: group() })).outbound).toBeNull();
  });

  it('roast lines built from unconfirmed private data are stripped', () => {
    const line = 'Sam spent €80 at Kebab King and kept quiet';
    const r = screenOutbound(
      recapDraft(`morning ☀️\n${line}`, [line]),
      bcnCtx({ privateTerms: ['Kebab King'] }),
    );
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_private_data']);
    expect(r.suppressed[0]?.payload).toMatchObject({
      cause: 'topic_blocked',
      topicCategory: 'private_data',
    });
  });

  it('message with only a roast line and the line stripped ⇒ fully suppressed', () => {
    const line = 'Sam was so drunk he paid twice';
    const r = screenOutbound(recapDraft(line, [line]), bcnCtx());
    expect(r.outbound).toBeNull();
  });
});

// ---------- lanes ----------

describe('screenOutbound: lanes', () => {
  const ticket: TicketCard = {
    cardId: 'tk1',
    type: 'ticket',
    title: 'your ticket',
    fallbackText: 'your razzmatazz ticket for tonight 🎟️',
    bookingId: 'b1',
    ownerMemberId: 'priya',
    deliveredTo: 'priya',
    event: { name: 'Razzmatazz', venue: 'Razzmatazz', startsAt: '2026-03-14T23:00:00+01:00' },
    qr: { dataUrl: 'data:image/png;base64,AAAA', payload: 'RZ-1' },
    holderName: 'Priya',
  };

  it('a ticket card never goes to the group', () => {
    const r = screenOutbound(groupMessage(ticket.fallbackText, { card: ticket }), bcnCtx());
    expect(r.outbound).toBeNull();
    expect(r.suppressed).toEqual([
      expect.objectContaining({ cause: 'dm_only_card_in_group', event: 'content.suppressed' }),
    ]);
    const dm = groupMessage(ticket.fallbackText, {
      card: ticket,
      to: { kind: 'member', memberId: 'priya' },
    });
    expect(screenOutbound(dm, bcnCtx()).outbound).toBe(dm);
  });

  it('a private expense card (or a digest containing one) never goes to the group', () => {
    const card: ExpenseConfirmCard = {
      cardId: 'ec1',
      type: 'expense_confirm',
      title: 'looks shared?',
      fallbackText: 'x',
      expenseId: 'e1',
      status: 'pending',
      source: 'card_transaction',
      visibility: 'group',
      description: 'uber',
      amount: { amountMinor: 2340, currency: 'EUR' },
      paidBy: 'sam',
      split: { method: 'equal', participants: [] },
      digestItems: [
        {
          cardId: 'ec2',
          type: 'expense_confirm',
          title: 'x',
          fallbackText: 'x',
          expenseId: 'e2',
          status: 'pending',
          source: 'card_transaction',
          visibility: 'private',
          description: 'bicing',
          amount: { amountMinor: 1200, currency: 'EUR' },
          paidBy: 'sam',
          split: { method: 'equal', participants: [] },
        },
      ],
    };
    const r = screenOutbound(groupMessage('x', { card }), bcnCtx());
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual(['private_card_in_group']);
  });

  it('reactions pass through', () => {
    const reaction: OutboundReaction = {
      id: 'r1',
      groupId: 'g1',
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: 'm1',
      emoji: '❤️',
    };
    expect(screenOutbound(reaction, bcnCtx()).outbound).toBe(reaction);
  });

  it('nightlife for an all-adult group is fine (Razzmatazz)', () => {
    const draft = groupMessage('razzmatazz tonight, 5 tickets. €18 each. 👍 to book');
    expect(screenOutbound(draft, bcnCtx({ contentTags: ['nightlife', 'club'] })).outbound).toBe(
      draft,
    );
  });
});

// ---------- Turks and Caicos family group ----------

describe('screenOutbound: Turks and Caicos family group', () => {
  const members = tc.members.map((m) =>
    member({
      memberId: m.memberId,
      displayName: m.displayName,
      role: m.role,
      birthDate: m.birthDate,
      ageBand: m.ageBand,
      ...(m.guardianMemberId !== undefined ? { guardianMemberId: m.guardianMemberId } : {}),
    }),
  );
  const ctxBase: ScreenContext = {
    group: group({ roastMode: false }),
    members,
    trip: trip({
      name: 'turks and caicos',
      startDate: '2026-12-26',
      endDate: '2027-01-02',
      currency: 'USD',
      familyTab: true,
    }),
    consent: consentWithRoast([]),
    now: tc.now,
  };

  const results = tc.candidates.map((c) => {
    const draft = groupMessage(c.text, {
      id: c.id,
      ...(c.to !== undefined ? { to: { kind: 'member' as const, memberId: c.to } } : {}),
    });
    const ctx: ScreenContext = {
      ...ctxBase,
      ...(c.contentTags !== undefined ? { contentTags: c.contentTags } : {}),
      ...(c.audience !== undefined ? { audience: c.audience } : {}),
      ...(c.explicitAdultRequest !== undefined
        ? { explicitAdultRequest: c.explicitAdultRequest }
        : {}),
    };
    return { c, r: screenOutbound(draft, ctx) };
  });

  it('ledger facts that mention a bar are not suppressed; explicit tags still are', () => {
    const card: ExpenseConfirmCard = {
      cardId: 'ec_tc',
      type: 'expense_confirm',
      title: 'logged',
      fallbackText: 'logged: $40 at the pool bar on Dad, on the family tab',
      expenseId: 'e_tc',
      status: 'logged',
      source: 'chat',
      visibility: 'group',
      merchant: 'pool bar',
      description: 'pool bar',
      amount: { amountMinor: 4000, currency: 'USD' },
      paidBy: 'tc_dad',
      split: { method: 'equal', participants: [] },
    };
    const draft = groupMessage(card.fallbackText, { card });
    expect(screenOutbound(draft, ctxBase).outbound).toBe(draft);
    const tagged = screenOutbound(draft, { ...ctxBase, contentTags: ['bar'] });
    expect(tagged.outbound).toBeNull();
    expect(tagged.suppressed.map((s) => s.cause)).toEqual(['minor_alcohol']);
    // The same words as a plain suggestion are suppressed.
    expect(screenOutbound(groupMessage('try the pool bar at 6'), ctxBase).outbound).toBeNull();
  });

  it('fixture has both clean and restricted candidates', () => {
    expect(tc.candidates.filter((c) => c.expect === 'sent').length).toBeGreaterThanOrEqual(5);
    expect(tc.candidates.filter((c) => c.expect === 'suppressed').length).toBeGreaterThanOrEqual(8);
  });

  it.each(results.map((x) => [x.c.id, x] as const))('%s', (_id, { c, r }) => {
    if (c.expect === 'sent') {
      expect(r.suppressed).toEqual([]);
      expect(r.outbound).not.toBeNull();
    } else {
      expect(r.outbound).toBeNull();
      expect(r.suppressed).toHaveLength(1);
      expect(r.suppressed[0]).toMatchObject({
        cause: c.cause,
        event: 'content.suppressed',
        payload: { cause: c.cause, messageDraftId: c.id },
      });
    }
  });

  it('zero restricted suggestions reach a plan that includes Lily', () => {
    const lilyPlans = results.filter((x) => x.r.outbound !== null && x.c.adultOnly !== true);
    for (const { c, r } of lilyPlans) {
      const sent = r.outbound as OutboundMessage;
      const tags = [...(c.contentTags ?? []), ...detectContentTags(sent.text)];
      expect(tags.filter((t) => RESTRICTED_TAGS.includes(t))).toEqual([]);
    }
    // The one adult-only reply excludes Lily from its audience and names the adults.
    const adult = results.filter((x) => x.r.outbound !== null && x.c.adultOnly === true);
    expect(adult).toHaveLength(1);
    expect(adult[0]?.c.audience).not.toContain('tc_lily');
  });

  it('roast mode can never apply here', () => {
    const line = '3 boat days and Dad paid for all of them';
    const draft = recapDraft(`morning, day 3 ☀️\n${line}`, [line]);
    const r = screenOutbound(draft, {
      ...ctxBase,
      group: group({ roastMode: true, allAdultsConfirmed: true }),
      consent: consentWithRoast(['tc_dad']),
    });
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_minor_in_group']);
    expect((r.outbound as OutboundMessage).roast).toBeUndefined();
  });

  it('clean family messages also pass the voice linter', () => {
    for (const { c, r } of results) {
      if (r.outbound === null || c.expect !== 'sent') continue;
      const kind = c.id === 'family-recap' ? 'recap' : 'reply';
      expect(lintVoice((r.outbound as OutboundMessage).text, kind).violations).toEqual([]);
    }
  });
});

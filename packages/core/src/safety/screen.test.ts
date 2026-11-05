import { describe, expect, it } from 'vitest';
import type { ContentTag } from '../domain/trip.js';
import type { Member } from '../domain/group.js';
import type {
  ExpenseConfirmCard,
  OutboundMessage,
  OutboundReaction,
  TicketCard,
  WrappedCard,
} from '../cards.js';
import {
  CONTENT_AUDIT_CAUSES,
  RESTRICTED_TAGS,
  ROAST_AUDIT_CAUSES,
  detectContentTags,
  lintVoice,
  screenOutbound,
} from './index.js';
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
  wrappedCard,
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

  it('T-138: the recap\'s non-roast lines are not roast material; the recap keeps its roast lines', () => {
    const line = 'Sam paid for a round at 2:14am. the tab remembers';
    const text = [
      'morning after, day 4 ☀️',
      'last night: Razzmatazz (5 of you, not Henry) €100',
      line,
      'tab: Sam → Dean €40.00 is the big one, full list in the card',
    ].join('\n');
    const draft = recapDraft(text, [line]);
    const r = screenOutbound(draft, bcnCtx());
    expect(r.suppressed).toEqual([]);
    expect(r.outbound).toBe(draft);
    // A real body topic outside the declared lines still fails the roast-marked message closed.
    const dirty = recapDraft(`${text}\nJordan looks rough today`, [line]);
    const d = screenOutbound(dirty, bcnCtx());
    expect(d.outbound).toBeNull();
    expect(d.suppressed.map((s) => s.cause)).toEqual(['roast_topic_blocked', 'roast_unlocatable']);
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

  it('flaw 4: an explicit adult request that folds the minor into the plan is suppressed', () => {
    const named = results.find((x) => x.c.id === 'bad-explicit-lily-named-in-plan');
    expect(named?.r.outbound).toBeNull();
    expect(named?.r.suppressed.map((s) => s.cause)).toEqual(['minor_alcohol']);
    // Naming the minor to keep her OFF the plan stays allowed (VOICE §8, §4.12 C).
    const ok = results.find((x) => x.c.id === 'ok-explicit-adults');
    expect(ok?.r.outbound).not.toBeNull();
    const keepOff = screenOutbound(
      groupMessage(
        "for you and Dad: the bar at Bugaloos, open till midnight. i'll keep Lily off that plan",
      ),
      { ...ctxBase, explicitAdultRequest: true, audience: ['tc_dad', 'tc_dean'] },
    );
    expect(keepOff.suppressed).toEqual([]);
    expect(keepOff.outbound).not.toBeNull();
  });

  it('flaw 5: a ticket (ledger card) addressed to a minor still gets the keyword backstop', () => {
    const ticket: TicketCard = {
      cardId: 'tk_club',
      type: 'ticket',
      title: 'your ticket',
      fallbackText: 'your ticket for tonight 🎟️',
      bookingId: 'b_club',
      ownerMemberId: 'tc_lily',
      deliveredTo: 'tc_lily',
      event: {
        name: 'Club Night 18+',
        venue: 'Danny Buoy’s',
        startsAt: '2026-12-29T23:00:00-05:00',
      },
      qr: { dataUrl: 'data:image/png;base64,AAAA', payload: 'CN-1' },
      holderName: 'Lily',
    };
    const toLily = screenOutbound(
      groupMessage(ticket.fallbackText, {
        card: ticket,
        to: { kind: 'member', memberId: 'tc_lily' },
      }),
      ctxBase,
    );
    expect(toLily.outbound).toBeNull();
    expect(toLily.suppressed.map((s) => s.cause)).toEqual(['minor_nightlife']);
    // An unknown recipient is treated as a possible minor.
    const toStranger = screenOutbound(
      groupMessage(ticket.fallbackText, {
        card: ticket,
        to: { kind: 'member', memberId: 'nobody' },
      }),
      ctxBase,
    );
    expect(toStranger.outbound).toBeNull();
    // The same ledger card to the guardian is a fact about a purchase an adult made.
    const toDad = screenOutbound(
      groupMessage(ticket.fallbackText, {
        card: ticket,
        to: { kind: 'member', memberId: 'tc_dad' },
      }),
      ctxBase,
    );
    expect(toDad.suppressed).toEqual([]);
  });

  it('flaw 2: Wrapped awards in a family group obey §7 and the minor rule', () => {
    const text = [
      'turks and caicos wrapped 🎉',
      '7 days · $4,180 on the family tab',
      "awards 🏆 Lily's pick: Lily (snorkel tour) · Big Spender: Lily ($80) · Night Owl: Dad (closed the bar twice)",
    ].join('\n');
    const card = wrappedCard(text, [
      { title: "Lily's pick", memberId: 'tc_lily', evidence: 'snorkel tour', basis: 'booking' },
      { title: 'Big Spender', memberId: 'tc_lily', evidence: '$80', basis: 'ledger' },
      { title: 'Night Owl', memberId: 'tc_dad', evidence: 'closed the bar twice', basis: 'ledger' },
    ]);
    const r = screenOutbound(groupMessage(text, { card }), ctxBase);
    // Night Owl survives the roast gate (a bar is a spending topic) but the family content
    // filter then drops the whole message: no nightlife highlight reaches a plan with Lily.
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_minor_in_group', 'minor_alcohol']);
    const cleanText = [
      'turks and caicos wrapped 🎉',
      "awards 🏆 Lily's pick: Lily (snorkel tour) · Big Spender: Lily ($80)",
    ].join('\n');
    const clean = screenOutbound(
      groupMessage(cleanText, {
        card: wrappedCard(cleanText, [
          { title: "Lily's pick", memberId: 'tc_lily', evidence: 'snorkel tour', basis: 'booking' },
          { title: 'Big Spender', memberId: 'tc_lily', evidence: '$80', basis: 'ledger' },
        ]),
      }),
      ctxBase,
    );
    const out = clean.outbound as OutboundMessage;
    expect(out.text).toBe(
      "turks and caicos wrapped 🎉\nawards 🏆 Lily's pick: Lily (snorkel tour)",
    );
    expect(out.card?.type === 'wrapped' ? out.card.awards.map((a) => a.title) : null).toEqual([
      "Lily's pick",
    ]);
    expect(clean.suppressed).toEqual([
      expect.objectContaining({ cause: 'roast_minor_in_group', detail: 'tc_lily' }),
    ]);
  });
});

// ---------- revision round 2 ----------

describe('screenOutbound: flaw 1, roast content outside the declared roast lines', () => {
  const UBERS = '19 ubers in 4 days. the metro is right there';
  const SICK = "Henry's sick, so his share of last night was €0";
  const TEXT = `morning after, day 3 ☀️\n${UBERS}\n${SICK}\n€199 total`;

  it.each([
    ['roast mode off', bcnCtx({ group: group() })],
    [
      'a minor in the roster',
      bcnCtx({
        members: [...BCN, member({ memberId: 'kid', displayName: 'Kid', birthDate: '2011-01-01' })],
      }),
    ],
    ['roast mode on', bcnCtx()],
  ])('%s: the undeclared "Henry\'s sick" line fails the whole message closed', (_n, ctx) => {
    const r = screenOutbound(recapDraft(TEXT, [UBERS]), ctx);
    expect(r.outbound).toBeNull();
    const causes = r.suppressed.map((s) => s.cause);
    expect(causes).toContain('roast_topic_blocked');
    expect(causes).toContain('roast_unlocatable');
    expect(r.suppressed.find((s) => s.cause === 'roast_topic_blocked')?.detail).toBe('health');
  });

  it('the same text with the line declared is stripped normally', () => {
    const r = screenOutbound(recapDraft(TEXT, [UBERS, SICK]), bcnCtx({ group: group() }));
    expect((r.outbound as OutboundMessage).text).toBe('morning after, day 3 ☀️\n€199 total');
  });

  it('undeclared private data fails closed too', () => {
    const line = 'Sam spent €80 at Kebab King and kept quiet';
    const r = screenOutbound(
      recapDraft(`morning ☀️\n${UBERS}\n${line}`, [UBERS]),
      bcnCtx({ privateTerms: ['Kebab King'] }),
    );
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_private_data', 'roast_unlocatable']);
  });

  it('an undeclared line naming a minor fails closed', () => {
    const gone = member({
      memberId: 'lily',
      displayName: 'Lily',
      birthDate: '2012-06-10',
      active: false,
      leftAt: '2026-03-13T10:00:00Z',
    });
    const text = `morning ☀️\n${UBERS}\nLily's pick: the churros, €12`;
    const r = screenOutbound(recapDraft(text, [UBERS]), bcnCtx({ members: [...BCN, gone] }));
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_minor_in_group', 'roast_unlocatable']);
  });

  it('settle lines naming an opted-out or departed member are ledger facts, not roasts', () => {
    // Maya opted out and Henry left; both appear in the tab line, Jordan is the roast target.
    const roster = BCN.map((m) =>
      m.memberId === 'henry' ? { ...m, active: false, leftAt: '2026-03-14T09:00:00Z' } : m,
    );
    const text = ['morning after, day 3 ☀️', ROAST_2, 'Maya → Dean €31.60 · Henry → Dean €12'].join(
      '\n',
    );
    const r = screenOutbound(
      recapDraft(text, [ROAST_2]),
      bcnCtx({ members: roster, consent: consentWithRoast(['dean', 'jordan', 'priya', 'sam']) }),
    );
    expect(r.suppressed).toEqual([]);
    expect(r.outbound).toBe(r.outbound);
    expect((r.outbound as OutboundMessage).text).toBe(text);
  });
});

describe('screenOutbound: flaw 2, Wrapped awards and stats are roast material', () => {
  const AWARD_TEXT = [
    'barcelona wrapped 🎉',
    '6 days · 6 people · €2,340 · €390 each',
    '23 ubers, €412. Priya booked 11 of them',
    'awards 🏆 Blackout Champion: Sam · Receipt Hoarder: Dean (14 photos)',
    "final settle is in the card, 4 transfers and you're done 💸",
  ].join('\n');
  const AWARDS = [
    {
      title: 'Blackout Champion',
      memberId: 'sam',
      evidence: 'Sam was so drunk he paid for everyone twice',
      basis: 'ledger' as const,
    },
    { title: 'Receipt Hoarder', memberId: 'dean', evidence: '14 photos', basis: 'ledger' as const },
  ];
  const STATS = [{ value: '23', label: 'ubers, €412. Priya booked 11 of them' }];

  function wrappedDraft(
    text = AWARD_TEXT,
    awards: WrappedCard['awards'] = AWARDS,
    stats: WrappedCard['stats'] = STATS,
  ): OutboundMessage {
    return groupMessage(text, { id: 'wrapped_1', card: wrappedCard(text, awards, stats) });
  }

  it.each([
    ['roast on', bcnCtx()],
    ['roast off', bcnCtx({ group: group() })],
    [
      'minor present',
      bcnCtx({
        members: [...BCN, member({ memberId: 'kid', displayName: 'Kid', birthDate: '2011-01-01' })],
      }),
    ],
  ])('%s: a blocklisted award is stripped from card and text', (_n, ctx) => {
    const r = screenOutbound(wrappedDraft(), ctx);
    const out = r.outbound as OutboundMessage;
    expect(out).not.toBeNull();
    expect(out.text).toBe(
      [
        'barcelona wrapped 🎉',
        '6 days · 6 people · €2,340 · €390 each',
        '23 ubers, €412. Priya booked 11 of them',
        'awards 🏆 Receipt Hoarder: Dean (14 photos)',
        "final settle is in the card, 4 transfers and you're done 💸",
      ].join('\n'),
    );
    expect(out.card?.fallbackText).toBe(out.text);
    expect(out.card?.type === 'wrapped' ? out.card.awards.map((a) => a.title) : null).toEqual([
      'Receipt Hoarder',
    ]);
    expect(r.suppressed).toEqual([
      expect.objectContaining({
        cause: 'roast_topic_blocked',
        detail: 'intoxication',
        event: 'roast.suppressed',
        payload: expect.objectContaining({ cause: 'topic_blocked', topicCategory: 'intoxication' }),
      }),
    ]);
    expect(lintVoice(out.text, 'wrapped').ok).toBe(true);
  });

  it('a blocked award in the middle of the list leaves exactly one separator', () => {
    const awards = [
      {
        title: 'Uber Captain',
        memberId: 'priya',
        evidence: 'booked 11 of 23 ubers',
        basis: 'ledger' as const,
      },
      ...AWARDS,
    ];
    const text =
      'barcelona wrapped 🎉\nawards 🏆 Uber Captain: Priya · Blackout Champion: Sam · Receipt Hoarder: Dean (14 photos)';
    const r = screenOutbound(wrappedDraft(text, awards, []), bcnCtx({ group: group() }));
    expect((r.outbound as OutboundMessage).text).toBe(
      'barcelona wrapped 🎉\nawards 🏆 Uber Captain: Priya · Receipt Hoarder: Dean (14 photos)',
    );
  });

  it('a clean Wrapped passes untouched', () => {
    const clean = AWARDS.slice(1);
    const text = AWARD_TEXT.replace('Blackout Champion: Sam · ', '');
    const draft = wrappedDraft(text, clean);
    const r = screenOutbound(draft, bcnCtx());
    expect(r.suppressed).toEqual([]);
    expect(r.outbound).toBe(draft);
  });

  it('the blocked evidence surviving in the text anywhere fails closed', () => {
    const text = `${AWARD_TEXT}\nSam was so drunk he paid for everyone twice, a legend`;
    const r = screenOutbound(wrappedDraft(text), bcnCtx());
    // The evidence is removed where it sits, leaving the harmless remainder.
    expect((r.outbound as OutboundMessage).text).not.toContain('drunk');
    // A paraphrase we cannot splice out drops the message instead.
    const paraphrased = AWARD_TEXT.replace(
      'Blackout Champion: Sam',
      'Blackout Champion goes to Sam, so drunk he paid for everyone twice',
    );
    const r2 = screenOutbound(wrappedDraft(paraphrased), bcnCtx());
    expect(r2.outbound).toBeNull();
    expect(r2.suppressed.map((s) => s.cause)).toEqual(['roast_topic_blocked', 'roast_unlocatable']);
  });

  it('with roast mode on, an award about an opted-out member is stripped; with it off, awards are neutral stats', () => {
    const awards = [
      {
        title: 'Uber Captain',
        memberId: 'priya',
        evidence: 'booked 11 of 23 ubers',
        basis: 'ledger' as const,
      },
      {
        title: 'Receipt Hoarder',
        memberId: 'dean',
        evidence: '14 photos',
        basis: 'ledger' as const,
      },
    ];
    const text = [
      'barcelona wrapped 🎉',
      'awards 🏆 Uber Captain: Priya · Receipt Hoarder: Dean (14 photos)',
    ].join('\n');
    const priyaOut = consentWithRoast(['dean', 'henry', 'maya', 'jordan', 'sam']);
    const on = screenOutbound(wrappedDraft(text, awards, []), bcnCtx({ consent: priyaOut }));
    expect((on.outbound as OutboundMessage).text).toBe(
      'barcelona wrapped 🎉\nawards 🏆 Receipt Hoarder: Dean (14 photos)',
    );
    expect(on.suppressed.map((s) => s.cause)).toEqual(['roast_member_opted_out']);
    const off = screenOutbound(
      wrappedDraft(text, awards, []),
      bcnCtx({ group: group(), consent: priyaOut }),
    );
    expect(off.suppressed).toEqual([]);
  });

  it('awards about a guest or someone who left are stripped; the awards line disappears when empty', () => {
    const roster = [
      ...BCN.map((m) =>
        m.memberId === 'henry' ? { ...m, active: false, leftAt: '2026-03-14T09:00:00Z' } : m,
      ),
      member({ memberId: 'alex', displayName: 'Alex', role: 'guest', ageBand: 'adult' }),
    ];
    const awards = [
      {
        title: 'Early Bird',
        memberId: 'henry',
        evidence: 'first to the airport',
        basis: 'attendance' as const,
      },
      {
        title: 'Tapas King',
        memberId: 'alex',
        evidence: '€40 of tapas for one',
        basis: 'ledger' as const,
      },
    ];
    const text = 'barcelona wrapped 🎉\nawards 🏆 Early Bird: Henry · Tapas King: Alex\ndone 💸';
    const r = screenOutbound(
      wrappedDraft(text, awards, []),
      bcnCtx({ members: roster, consent: consentWithRoast(roster.map((m) => m.memberId)) }),
    );
    expect((r.outbound as OutboundMessage).text).toBe('barcelona wrapped 🎉\ndone 💸');
    expect(r.suppressed.map((s) => s.cause).sort()).toEqual([
      'roast_target_inactive',
      'roast_target_not_member',
    ]);
  });

  it('a blocklisted stat is stripped from card and text', () => {
    const stats = [
      { value: '23', label: 'ubers, €412' },
      { value: '3', label: 'nights Jordan was hammered' },
    ];
    const text = 'barcelona wrapped 🎉\n23 ubers, €412\n3 nights Jordan was hammered\ndone 💸';
    const r = screenOutbound(wrappedDraft(text, AWARDS.slice(1), stats), bcnCtx());
    const out = r.outbound as OutboundMessage;
    expect(out.text).toBe('barcelona wrapped 🎉\n23 ubers, €412\ndone 💸');
    expect(out.card?.type === 'wrapped' ? out.card.stats : null).toEqual([stats[0]]);
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_topic_blocked']);
  });
});

describe('screenOutbound: flaw 3, first-name roasts and gates keyed on full display names', () => {
  it('"Jordan has paid..." is gated when Jordan Kim opted out', () => {
    const roster = BCN.map((m) =>
      m.memberId === 'jordan' ? { ...m, displayName: 'Jordan Kim' } : m,
    );
    const r = screenOutbound(
      recapDraft(),
      bcnCtx({ members: roster, consent: consentWithRoast(['dean', 'maya', 'priya', 'sam']) }),
    );
    const out = r.outbound as OutboundMessage;
    expect(out.text).not.toContain('Jordan has paid');
    expect(r.suppressed).toEqual([
      expect.objectContaining({ cause: 'roast_member_opted_out', detail: 'jordan' }),
    ]);
  });

  it('an ambiguous first name gates on every member it could mean (fail closed)', () => {
    const roster = [
      ...BCN.map((m) => (m.memberId === 'sam' ? { ...m, displayName: 'Sam Lee' } : m)),
      member({
        memberId: 'sam2',
        displayName: 'Sam Park',
        birthDate: '2003-03-03',
        ageBand: 'adult',
      }),
    ];
    const line = 'Sam took 19 ubers in 4 days';
    const r = screenOutbound(
      recapDraft(`morning ☀️\n${line}`, [line]),
      bcnCtx({
        members: roster,
        consent: consentWithRoast(roster.map((m) => m.memberId).filter((id) => id !== 'sam2')),
      }),
    );
    expect((r.outbound as OutboundMessage).text).toBe('morning ☀️');
    expect(r.suppressed.map((s) => s.detail)).toEqual(['sam2']);
  });

  it('the adult-audience check also accepts a first name when the display name has a surname', () => {
    const roster = [
      member({ memberId: 'dad', displayName: 'Dad Yao', role: 'guardian', ageBand: 'adult' }),
      member({ memberId: 'dean', displayName: 'Dean Yao', role: 'lead', ageBand: 'adult' }),
      member({ memberId: 'lily', displayName: 'Lily Yao', birthDate: '2012-06-10' }),
    ];
    const ctx: ScreenContext = {
      group: group(),
      members: roster,
      trip: trip(),
      consent: consentWithRoast([]),
      now: BCN_NOW,
      explicitAdultRequest: true,
      audience: ['dad', 'dean'],
    };
    const ok = screenOutbound(
      groupMessage(
        "for you and Dad: the bar at Bugaloos, open till midnight. Lily's not on this one",
      ),
      ctx,
    );
    expect(ok.suppressed).toEqual([]);
    // "Yao" alone is ambiguous between the adults and the minor: naming her as included suppresses.
    const bad = screenOutbound(
      groupMessage('for the Yao adults and Yao: the bar at Bugaloos'),
      ctx,
    );
    expect(bad.outbound).toBeNull();
  });
});

describe('screenOutbound: flaw 8, stripping keeps the original text (curly quotes intact)', () => {
  it('locates a straight-quote roast line inside curly-quote text and splices the original', () => {
    const roastLine = "that is Jordan's third kebab run";
    const text = `logged: €12 kebabs on Jordan, 3 ways → €4 each\nthat is Jordan’s third kebab run\nit’s a church, dress like it`;
    const r = screenOutbound(
      groupMessage(text, { roast: true }),
      bcnCtx({ group: group(), roastLines: [roastLine] }),
    );
    expect((r.outbound as OutboundMessage).text).toBe(
      'logged: €12 kebabs on Jordan, 3 ways → €4 each\nit’s a church, dress like it',
    );
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_mode_off']);
  });
});

// ---------- revision round 3 ----------

describe('round 3 flaw 1: a name-blocked award or stat never survives in the text', () => {
  const jordanOut = consentWithRoast(['dean', 'henry', 'maya', 'priya', 'sam']);
  const priyaOut = consentWithRoast(['dean', 'henry', 'maya', 'jordan', 'sam']);

  function draft(text: string, awards: WrappedCard['awards'], stats: WrappedCard['stats']) {
    return groupMessage(text, { id: 'wrapped_r3', card: wrappedCard(text, awards, stats) });
  }

  it('stat paraphrased in the text (opted-out member, roast on) fails closed', () => {
    const text = 'barcelona wrapped 🎉\nJordan paid for kebabs 3 nights running\ndone 💸';
    const r = screenOutbound(
      draft(text, [], [{ value: '3', label: 'nights Jordan paid for kebabs' }]),
      bcnCtx({ consent: jordanOut }),
    );
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual([
      'roast_member_opted_out',
      'roast_unlocatable',
    ]);
  });

  it('stat about a minor paraphrased in a family Wrapped fails closed', () => {
    const roster = [
      member({ memberId: 'dad', displayName: 'Dad', role: 'guardian', ageBand: 'adult' }),
      member({ memberId: 'lily', displayName: 'Lily', birthDate: '2012-06-10' }),
    ];
    const text = 'turks and caicos wrapped 🎉\nLily spent $80 on churros';
    const r = screenOutbound(
      draft(text, [], [{ value: '$80', label: 'spent by Lily on churros' }]),
      bcnCtx({ group: group(), members: roster, consent: consentWithRoast([]) }),
    );
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_minor_in_group', 'roast_unlocatable']);
  });

  it('letterless stat label with the name as the value fails closed', () => {
    const text = 'barcelona wrapped 🎉\n€412 by Jordan on ubers\ndone 💸';
    const r = screenOutbound(
      draft(text, [], [{ value: 'Jordan', label: '€412' }]),
      bcnCtx({ consent: jordanOut }),
    );
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual([
      'roast_member_opted_out',
      'roast_unlocatable',
    ]);
  });

  it('award rendered as "Title goes to Name" fails closed instead of leaving the name', () => {
    const text =
      'barcelona wrapped 🎉\nawards 🏆 Uber Captain goes to Priya, 11 of 23 · Receipt Hoarder: Dean (14 photos)';
    const awards = [
      { title: 'Uber Captain', memberId: 'priya', evidence: '11 of 23', basis: 'ledger' as const },
      {
        title: 'Receipt Hoarder',
        memberId: 'dean',
        evidence: '14 photos',
        basis: 'ledger' as const,
      },
    ];
    const r = screenOutbound(draft(text, awards, []), bcnCtx({ consent: priyaOut }));
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual([
      'roast_member_opted_out',
      'roast_unlocatable',
    ]);
  });

  it('a departed member named in the text after their award is stripped fails closed', () => {
    const roster = BCN.map((m) =>
      m.memberId === 'henry' ? { ...m, active: false, leftAt: '2026-03-14T09:00:00Z' } : m,
    );
    const text =
      'barcelona wrapped 🎉\nawards 🏆 Early Bird: Henry\nHenry made every flight, 2 of 2';
    const awards = [
      {
        title: 'Early Bird',
        memberId: 'henry',
        evidence: 'first to the airport',
        basis: 'attendance' as const,
      },
    ];
    const r = screenOutbound(draft(text, awards, []), bcnCtx({ members: roster }));
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual([
      'roast_target_inactive',
      'roast_unlocatable',
    ]);
  });

  it('the canonical shape is still stripped cleanly, and a kept pick award may name the minor', () => {
    const text = 'barcelona wrapped 🎉\n3 nights Jordan paid for kebabs\n23 ubers, €412\ndone 💸';
    const r = screenOutbound(
      draft(
        text,
        [],
        [
          { value: '3', label: 'nights Jordan paid for kebabs' },
          { value: '23', label: 'ubers, €412' },
        ],
      ),
      bcnCtx({ consent: jordanOut }),
    );
    expect((r.outbound as OutboundMessage).text).toBe(
      'barcelona wrapped 🎉\n23 ubers, €412\ndone 💸',
    );
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_member_opted_out']);
  });
});

describe('round 3 flaw 2: gates keyed on an accented display name', () => {
  const joseRoster = BCN.map((m) => (m.memberId === 'jordan' ? { ...m, displayName: 'José' } : m));
  const plainRoster = BCN.map((m) => (m.memberId === 'jordan' ? { ...m, displayName: 'Jose' } : m));
  const joseOut = consentWithRoast(['dean', 'henry', 'maya', 'priya', 'sam']);

  it.each([
    ['José in the roster, Jose in the line', joseRoster, 'Jose took 19 ubers in 4 days'],
    ['Jose in the roster, José in the line', plainRoster, 'José took 19 ubers in 4 days'],
  ])('%s: the declared roast line is stripped', (_n, roster, line) => {
    const r = screenOutbound(
      recapDraft(`morning ☀️\n${line}`, [line]),
      bcnCtx({ members: roster, consent: joseOut }),
    );
    expect((r.outbound as OutboundMessage).text).toBe('morning ☀️');
    expect(r.suppressed).toEqual([
      expect.objectContaining({ cause: 'roast_member_opted_out', detail: 'jordan' }),
    ]);
  });

  it('a Wrapped award about José is stripped when the text spells it Jose', () => {
    const text =
      'barcelona wrapped 🎉\nawards 🏆 Uber Captain: Jose · Receipt Hoarder: Dean (14 photos)';
    const awards = [
      { title: 'Uber Captain', memberId: 'jordan', evidence: '11 of 23', basis: 'ledger' as const },
      {
        title: 'Receipt Hoarder',
        memberId: 'dean',
        evidence: '14 photos',
        basis: 'ledger' as const,
      },
    ];
    const r = screenOutbound(
      groupMessage(text, { card: wrappedCard(text, awards, []) }),
      bcnCtx({ members: joseRoster, consent: joseOut }),
    );
    expect((r.outbound as OutboundMessage).text).toBe(
      'barcelona wrapped 🎉\nawards 🏆 Receipt Hoarder: Dean (14 photos)',
    );
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_member_opted_out']);
  });
});

describe('round 3 flaw 3: pronoun continuation after a target strip', () => {
  const jordanOut = consentWithRoast(['dean', 'henry', 'maya', 'priya', 'sam']);
  const L1 = 'Jordan took 19 ubers in 4 days';
  const L2 = 'he also tipped €0 every time, 3 for 3';

  it('a nameless third-person line after the stripped line is stripped too', () => {
    const text = `morning after, day 3 ☀️\n${L1}\n${L2}\n€199 total`;
    const r = screenOutbound(recapDraft(text, [L1, L2]), bcnCtx({ consent: jordanOut }));
    const out = r.outbound as OutboundMessage;
    expect(out.text).toBe('morning after, day 3 ☀️\n€199 total');
    expect(out.roast).toBeUndefined();
    expect(out.card?.type === 'recap' ? out.card.roastLines : null).toEqual([]);
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_member_opted_out']);
  });

  it('a guest and a departed member get the same treatment', () => {
    const roster = [
      ...BCN.map((m) =>
        m.memberId === 'henry' ? { ...m, active: false, leftAt: '2026-03-14T09:00:00Z' } : m,
      ),
      member({ memberId: 'alex', displayName: 'Alex', role: 'guest', ageBand: 'adult' }),
    ];
    const consent = consentWithRoast(roster.map((m) => m.memberId));
    for (const [first, cause] of [
      ['Henry booked 4 ubers and then left', 'roast_target_inactive'],
      ['Alex ordered €40 of tapas for one', 'roast_target_not_member'],
    ] as const) {
      const text = `morning ☀️\n${first}\nthey never once split it`;
      const r = screenOutbound(
        recapDraft(text, [first, 'they never once split it']),
        bcnCtx({ members: roster, consent }),
      );
      expect((r.outbound as OutboundMessage).text).toBe('morning ☀️');
      expect(r.suppressed.map((s) => s.cause)).toEqual([cause]);
    }
  });

  it('the chain breaks once a line names someone who passes; nameless lines with no prior strip are kept', () => {
    const L3 = 'Sam paid for kebabs twice';
    const text = `morning ☀️\n${L1}\n${L3}\n${L2}`;
    const r = screenOutbound(recapDraft(text, [L1, L3, L2]), bcnCtx({ consent: jordanOut }));
    expect((r.outbound as OutboundMessage).text).toBe(`morning ☀️\n${L3}\n${L2}`);
    const plain = recapDraft(`morning ☀️\n19 ubers in 4 days\n${L2}`, ['19 ubers in 4 days', L2]);
    const ok = screenOutbound(plain, bcnCtx());
    expect(ok.suppressed).toEqual([]);
    expect(ok.outbound).toBe(plain);
  });
});

describe('round 3 flaw 6: minor referents in the explicit-adult path', () => {
  const roster = tc.members.map((m) =>
    member({
      memberId: m.memberId,
      displayName: m.displayName,
      role: m.role,
      birthDate: m.birthDate,
      ageBand: m.ageBand,
      ...(m.guardianMemberId !== undefined ? { guardianMemberId: m.guardianMemberId } : {}),
    }),
  );
  const ctx: ScreenContext = {
    group: group(),
    members: roster,
    trip: trip({ familyTab: true }),
    consent: consentWithRoast([]),
    now: tc.now,
    explicitAdultRequest: true,
    audience: ['tc_dad', 'tc_dean'],
  };

  it.each([
    'for the adults and the kid: the bar at Bugaloos, open till midnight',
    'for you, Dad and your daughter: the bar at Bugaloos, open till midnight',
    'the adults and the teens: the rooftop bar at the Palms',
  ])('"%s" is suppressed', (text) => {
    const r = screenOutbound(groupMessage(text), ctx);
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual(['minor_alcohol']);
  });

  it('keeping the kids off the plan still passes', () => {
    const r = screenOutbound(
      groupMessage(
        'for you and Dad: the bar at Bugaloos, open till midnight. kids stay at the villa',
      ),
      ctx,
    );
    expect(r.suppressed).toEqual([]);
    expect(r.outbound).not.toBeNull();
  });

  it('the referent check only applies when the group actually has a minor', () => {
    const adults = roster.filter((m) => m.memberId !== 'tc_lily');
    const r = screenOutbound(
      groupMessage('for the adults and the kid at heart: the bar at Bugaloos'),
      { ...ctx, members: adults, group: group({ familyModeForced: true }) },
    );
    expect(r.suppressed).toEqual([]);
  });
});

describe('round 3 flaw 7: card fields and alt text go through the roast screen', () => {
  it('a roast-flagged message with a blocklisted image alt fails closed', () => {
    const d = groupMessage('19 ubers in 4 days. the metro is right there', {
      roast: true,
      images: [{ url: 'https://example.invalid/p.jpg', alt: 'Sam hammered at razzmatazz' }],
    });
    const r = screenOutbound(d, bcnCtx());
    expect(r.outbound).toBeNull();
    expect(r.suppressed.map((s) => s.cause)).toEqual(['roast_topic_blocked', 'roast_unlocatable']);
    const clean = {
      ...d,
      images: [{ url: 'https://example.invalid/p.jpg', alt: 'the group at razzmatazz' }],
    };
    expect(screenOutbound(clean, bcnCtx()).outbound).toBe(clean);
  });

  it('a recap event label or photo alt with roast material fails closed', () => {
    const card = recapCard(RECAP_B, [ROAST_1, ROAST_2]);
    const withLabel = groupMessage(RECAP_B, {
      roast: true,
      card: {
        ...card,
        lastNight: {
          ...card.lastNight,
          events: [{ label: 'Sam blackout at razzmatazz', attendees: [] }],
        },
      },
    });
    expect(screenOutbound(withLabel, bcnCtx()).outbound).toBeNull();
    const withPhoto = groupMessage(RECAP_B, {
      roast: true,
      card: {
        ...card,
        photos: [
          { url: 'https://example.invalid/p.jpg', alt: 'Henry sick in bed', byMemberId: 'dean' },
        ],
      },
    });
    const r = screenOutbound(withPhoto, bcnCtx());
    expect(r.outbound).toBeNull();
    expect(r.suppressed.find((s) => s.cause === 'roast_topic_blocked')?.detail).toBe('health');
  });

  it('Wrapped photo alts are screened whatever the roast flag says', () => {
    const text = 'barcelona wrapped 🎉\n6 days · 6 people · €2,340';
    const card = {
      ...wrappedCard(text, []),
      photos: [
        {
          url: 'https://example.invalid/p.jpg',
          alt: 'Jordan so drunk at the kebab place',
          byMemberId: 'dean',
        },
      ],
    };
    for (const ctx of [bcnCtx(), bcnCtx({ group: group() })]) {
      const r = screenOutbound(groupMessage(text, { card }), ctx);
      expect(r.outbound).toBeNull();
      expect(r.suppressed.map((s) => s.cause)).toEqual([
        'roast_topic_blocked',
        'roast_unlocatable',
      ]);
    }
    // A minor's name in a Wrapped alt is roast material too; an opted-out adult's is not (it is a caption, not a roast).
    const lily = member({ memberId: 'lily', displayName: 'Lily', birthDate: '2012-06-10' });
    const minorAlt = {
      ...card,
      photos: [
        { url: 'https://example.invalid/p.jpg', alt: 'Lily at the beach', byMemberId: 'dean' },
      ],
    };
    expect(
      screenOutbound(
        groupMessage(text, { card: minorAlt }),
        bcnCtx({ group: group(), members: [...BCN, lily] }),
      ).outbound,
    ).toBeNull();
    const priyaAlt = {
      ...card,
      photos: [
        { url: 'https://example.invalid/p.jpg', alt: 'Priya at the beach', byMemberId: 'dean' },
      ],
    };
    const priyaOut = consentWithRoast(['dean', 'henry', 'maya', 'jordan', 'sam']);
    expect(
      screenOutbound(groupMessage(text, { card: priyaAlt }), bcnCtx({ consent: priyaOut }))
        .suppressed,
    ).toEqual([]);
  });
});

describe('audit causes (flaw 9) stay inside the SAFETY §2.2 unions', () => {
  it('every emitted payload.cause is in ROAST_AUDIT_CAUSES or CONTENT_AUDIT_CAUSES', () => {
    const seen: { event: string; cause: unknown }[] = [];
    const collect = (r: ReturnType<typeof screenOutbound>): void => {
      for (const s of r.suppressed) seen.push({ event: s.event, cause: s.payload['cause'] });
    };
    collect(screenOutbound(recapDraft(), bcnCtx({ group: group() })));
    collect(screenOutbound(recapDraft(), bcnCtx({ consent: consentWithRoast(['dean']) })));
    collect(screenOutbound(recapDraft(), bcnCtx({ trip: null })));
    collect(
      screenOutbound(recapDraft('morning ☀️\nHenry is sick lol', ["Henry's sick"]), bcnCtx()),
    );
    collect(
      screenOutbound(groupMessage('a bar for the kids', { id: 'x' }), {
        ...bcnCtx(),
        members: [...BCN, member({ memberId: 'kid', displayName: 'Kid', birthDate: '2011-01-01' })],
      }),
    );
    expect(seen.length).toBeGreaterThanOrEqual(6);
    for (const s of seen) {
      const allowed: readonly string[] =
        s.event === 'roast.suppressed' ? ROAST_AUDIT_CAUSES : CONTENT_AUDIT_CAUSES;
      expect(allowed).toContain(s.cause);
    }
  });
});

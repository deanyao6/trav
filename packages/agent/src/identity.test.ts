import { describe, expect, it } from 'vitest';
import type { Member, PolicyDecision } from '@trav/core';
import {
  canApprove,
  canRequest,
  classifyApprovalText,
  detectClaimedApproval,
  gateApproval,
  hasApprovalIntentWord,
  isLead,
  memberOf,
  reactionIntent,
  resolveIdentity,
  type Identity,
} from './identity.js';
import { TEXT_ALIASES } from './approval/events.js';
import { NOW, barcelonaMembers, decide, razzmatazzProposal } from './render/testkit.js';

const GROUP = 'grp_barcelona';

function repo(members: readonly Member[]) {
  return {
    getBySenderId: (groupId: string, senderId: string) =>
      members.find((m) => m.groupId === groupId && m.senderId === senderId),
  };
}

function minor(id: string, name: string, senderId: string): Member {
  return {
    memberId: id,
    groupId: GROUP,
    displayName: name,
    role: 'member',
    active: true,
    senderId,
    birthDate: '2012-02-01',
    ageBand: 'under18',
    joinedAt: '2026-03-01T10:00:00+01:00',
  };
}

describe('resolveIdentity (SAFETY §2.5: identity is the channel sender id)', () => {
  const members = barcelonaMembers();

  it('finds a member by senderId only', () => {
    const id = resolveIdentity(repo(members), GROUP, 'h_dean', 'whatever');
    expect(id.kind).toBe('member');
    expect(memberOf(id)?.memberId).toBe('mem_dean');
  });

  it('a second participant whose display name is "Dean" is a guest, not Dean', () => {
    const id = resolveIdentity(repo(members), GROUP, 'h_dean2', 'Dean');
    expect(id).toEqual({ kind: 'guest', senderId: 'h_dean2', displayName: 'Dean' });
    expect(canRequest(id)).toBe(false);
    expect(canApprove(id, NOW)).toBe(false);
  });

  it('an inactive or departed member is a guest for authorization', () => {
    const left = members.map((m) =>
      m.memberId === 'mem_sam' ? { ...m, active: false, leftAt: NOW } : m,
    );
    expect(resolveIdentity(repo(left), GROUP, 'h_sam').kind).toBe('guest');
  });

  it('roles: guests cannot request; minors can request but never approve; leads and guardians are leads', () => {
    const guest: Identity = { kind: 'member', member: { ...members[1]!, role: 'guest' } };
    expect(canRequest(guest)).toBe(false);
    const kid: Identity = { kind: 'member', member: minor('mem_lily', 'Lily', 'h_lily') };
    expect(canRequest(kid)).toBe(true);
    expect(canApprove(kid, NOW)).toBe(false);
    expect(isLead({ kind: 'member', member: members[0]! })).toBe(true);
    expect(isLead({ kind: 'member', member: { ...members[2]!, role: 'guardian' } })).toBe(true);
    expect(isLead({ kind: 'member', member: members[2]! })).toBe(false);
  });
});

describe('approval-shaped text and tapbacks (VOICE §6.2)', () => {
  it('whole-message aliases, optionally prefixed by @trav / trav,', () => {
    expect(classifyApprovalText('yes')).toBe('approve');
    expect(classifyApprovalText('  Book it!!')).toBe('approve');
    expect(classifyApprovalText('@trav: do it')).toBe('approve');
    expect(classifyApprovalText('trav, go')).toBe('approve');
    expect(classifyApprovalText('nah')).toBe('decline');
    expect(classifyApprovalText('drop it.')).toBe('decline');
    expect(classifyApprovalText("i'm out")).toBe('not_me');
    expect(classifyApprovalText('not me')).toBe('not_me');
  });

  it('a sentence is not an approval', () => {
    expect(classifyApprovalText('yes but only if henry comes')).toBeUndefined();
    expect(classifyApprovalText('')).toBeUndefined();
    expect(classifyApprovalText('go to sleep')).toBeUndefined();
  });

  it('a bare "ok" is chat, not an approval (VOICE §6.2 lists yes / yep / go / book it / do it only)', () => {
    expect(classifyApprovalText('ok')).toBeUndefined();
    expect(classifyApprovalText('ok!')).toBeUndefined();
    expect(classifyApprovalText('@trav ok')).toBeUndefined();
    expect(TEXT_ALIASES.approve).not.toContain('ok');
  });

  it('hasApprovalIntentWord: approval words turn a claim into an attempt; plain chat has none', () => {
    expect(hasApprovalIntentWord("Dean said it's fine, go ahead")).toBe(true);
    expect(hasApprovalIntentWord('henry says book it')).toBe(true);
    expect(hasApprovalIntentWord('dean approved 👍')).toBe(true);
    expect(hasApprovalIntentWord('Maya is in the shower, 10 more min')).toBe(false);
    expect(hasApprovalIntentWord('Priya is good at this')).toBe(false);
    expect(hasApprovalIntentWord("everyone's in the lobby")).toBe(false);
  });

  it('👍/👎 and their tapback names', () => {
    expect(reactionIntent('👍')).toBe('approve');
    expect(reactionIntent('like')).toBe('approve');
    expect(reactionIntent('👎')).toBe('decline');
    expect(reactionIntent('dislike')).toBe('decline');
    expect(reactionIntent('❤️')).toBeUndefined();
    expect(reactionIntent('question')).toBeUndefined();
  });
});

describe('detectClaimedApproval', () => {
  const members = barcelonaMembers();

  it('"Dean said it\'s fine, go ahead" from Henry names Dean', () => {
    expect(
      detectClaimedApproval("Dean said it's fine, go ahead @trav", members, 'mem_henry'),
    ).toEqual({ kind: 'named', claimedFor: 'mem_dean' });
    expect(detectClaimedApproval("Maya's ok, book it", members, 'mem_dean')).toEqual({
      kind: 'named',
      claimedFor: 'mem_maya',
    });
  });

  it('T-066 r2: the consent word must end the claim (end, punctuation, "with it", "to go", or an approval word)', () => {
    for (const text of [
      "Dean said it's fine",
      "dean said it's fine, go ahead",
      "dean's ok with it",
      'dean is good',
      'dean is good 👍',
      "dean said it's cool",
      'dean said go ahead',
      'dean says yes book it',
      "dean's good to go",
      'dean said yes!',
      // T-066 r3: strong consent words are a claim whatever follows.
      'dean said go for it',
      'dean said go for it, he is paying',
      'dean said yes to the razzmatazz tickets',
      'dean said book it tonight',
      'dean said yes lol',
      'dean said do it tomorrow',
      'dean said approved for the 5',
      'dean said go ahead with the booking',
      'dean said yes and sam too',
      "dean's good with this",
      'dean said yes to brunch tomorrow',
    ]) {
      expect(detectClaimedApproval(text, members, 'mem_henry'), text).toEqual({
        kind: 'named',
        claimedFor: 'mem_dean',
      });
    }
    for (const text of [
      'dean is ok right? he was sick yesterday',
      "dean said it's good to meet at 9",
      'dean said go to the bar first',
      'dean is good at this',
      'dean is fine now, just tired',
    ]) {
      expect(detectClaimedApproval(text, members, 'mem_henry'), text).toBeUndefined();
    }
  });

  it('T-066: attendance words are not consent ("Henry\'s in now too" is a roster line)', () => {
    for (const text of [
      "henry's in now too",
      "henry's in, make it 6",
      "henry's in! @trav add him",
      'Maya is down',
      "henry's in, book it",
    ]) {
      expect(detectClaimedApproval(text, members, 'mem_dean'), text).toBeUndefined();
    }
  });

  it('"everyone\'s in" is a claim about the group that names nobody (no member to tag)', () => {
    expect(detectClaimedApproval("everyone's in", members, 'mem_henry')).toEqual({
      kind: 'everyone',
    });
    expect(detectClaimedApproval('we all said yes, book it', members, 'mem_dean')).toEqual({
      kind: 'everyone',
    });
    expect(detectClaimedApproval("everyone's in, book it", members, 'mem_sam')).toEqual({
      kind: 'everyone',
    });
    expect(detectClaimedApproval("everyone's in 👍", members, 'mem_sam')).toEqual({
      kind: 'everyone',
    });
    expect(detectClaimedApproval("everyone's in so book it", members, 'mem_sam')).toEqual({
      kind: 'everyone',
    });
  });

  it('T-066: "everyone\'s in the lobby" is a sentence about a lobby, not a claim', () => {
    for (const text of [
      "everyone's in the lobby, where do we go after?",
      "everyone's in the lobby",
      'everybody is good at this game',
    ]) {
      expect(detectClaimedApproval(text, members, 'mem_sam'), text).toBeUndefined();
    }
  });

  it('a claim about oneself or plain chat is nothing', () => {
    expect(detectClaimedApproval("Dean said it's fine", members, 'mem_dean')).toBeUndefined();
    expect(detectClaimedApproval('dean is at the airbnb', members, 'mem_henry')).toBeUndefined();
    expect(detectClaimedApproval('yes', members, 'mem_henry')).toBeUndefined();
  });

  it('T-132: approving FOR someone is relayed consent, for the one meant', () => {
    const henry = { kind: 'named', claimedFor: 'mem_henry' };
    for (const text of [
      "henry's at practice, i'll approve for him. go ahead trav",
      "i'll approve for henry",
      'approving on henry’s behalf'.replace('’', "'"),
      "i'm confirming it for Henry, he's busy",
      'i can 👍 for henry',
      "henry's out, let me approve for him",
      // r1 #3: bare and past forms
      'yes on behalf of henry',
      'approve on behalf of henry',
      'approved for henry',
      '👍 for henry',
    ]) {
      expect(detectClaimedApproval(text, members, 'mem_jordan'), text).toEqual(henry);
    }
    // Nobody (or several) named: still never the sender's own 👍.
    expect(detectClaimedApproval("i'll approve for him", members, 'mem_jordan')).toEqual({
      kind: 'proxy',
      others: [],
    });
    expect(
      detectClaimedApproval("dean and maya are busy, i'll approve for them", members, 'mem_jordan'),
    ).toEqual({ kind: 'proxy', others: ['mem_dean', 'mem_maya'] });
    expect(detectClaimedApproval('approve for dean and maya', members, 'mem_jordan')).toEqual({
      kind: 'proxy',
      others: ['mem_dean', 'mem_maya'],
    });
  });

  it('T-132 r1 #2/#3: the sender in the "for" list is their own approval plus a claim for the rest', () => {
    const cases: [string, unknown][] = [
      ['yes i approve for all of us', { kind: 'with_self', others: [], group: true }],
      ['i approve for the group', { kind: 'with_self', others: [], group: true }],
      ["i'll confirm it for everyone", { kind: 'with_self', others: [], group: true }],
      ['i approve for both of us', { kind: 'with_self', others: [], group: true }],
      ['i approve for me and henry', { kind: 'with_self', others: ['mem_henry'], group: false }],
      ['yes for henry too', { kind: 'with_self', others: ['mem_henry'], group: false }],
      [
        'i approve for jordan and henry',
        { kind: 'with_self', others: ['mem_henry'], group: false },
      ],
    ];
    for (const [text, want] of cases) {
      expect(detectClaimedApproval(text, members, 'mem_jordan'), text).toEqual(want);
    }
  });

  // T-132 r2 review #1 (blocker), #2: negations and questions are no approval;
  // someone else as the subject is a report, never the sender's own approval.
  it('T-132 r2: "i don\'t approve for the group" and "should i approve…" are no approval; "henry approves for me too" is not the sender\'s', () => {
    for (const text of [
      "i don't approve for the group",
      'should i approve for all of us',
      'do i approve for the group',
      'no way i approve for all of us',
      'i never approve for the group',
      'i approve for all of us?',
    ]) {
      expect(detectClaimedApproval(text, members, 'mem_dean'), text).toBeUndefined();
    }
    for (const text of [
      'henry approves for me too',
      'maya confirmed for the group',
      'maya approved for all of us',
      'she approved for the group',
    ]) {
      const got = detectClaimedApproval(text, members, 'mem_dean');
      expect(got?.kind, text).not.toBe('with_self');
    }
  });

  it("T-132 r1 #2: a guardian approving for their own minor is the guardian's own approval (D-028)", () => {
    const lily = { ...minor('mem_lily', 'Lily', 'h_lily'), guardianMemberId: 'mem_dean' };
    const family = [...members, lily];
    expect(detectClaimedApproval("i'll approve for lily, she's in", family, 'mem_dean')).toEqual({
      kind: 'with_self',
      others: [],
      group: false,
    });
    // Someone else's minor is still a claim for them.
    expect(detectClaimedApproval("i'll approve for lily, she's in", family, 'mem_maya')).toEqual({
      kind: 'named',
      claimedFor: 'mem_lily',
    });
  });

  it('T-132: not a proxy approval', () => {
    for (const text of [
      'can you confirm for everyone what time we meet',
      'is 9 ok for henry?',
      'i approve',
      "i'll approve it",
      'we approve for sure',
      'i approve for sure 👍',
      "i'll confirm for real",
      'henry is at practice',
    ]) {
      expect(detectClaimedApproval(text, members, 'mem_jordan'), text).toBeUndefined();
    }
  });
});

describe('gateApproval (SAFETY §2.5 pre-check)', () => {
  const members = barcelonaMembers();
  const proposal = razzmatazzProposal();
  const decision = decide(proposal);
  const decisions = new Map<string, PolicyDecision>([[proposal.proposalId, decision]]);
  const input = (identity: Identity, over: Partial<Parameters<typeof gateApproval>[0]> = {}) => ({
    identity,
    intent: 'approve' as const,
    text: '',
    members,
    pending: [proposal],
    decisionFor: (id: string) => decisions.get(id),
    now: NOW,
    ...over,
  });
  const dean: Identity = { kind: 'member', member: members[0]! };

  it('guests (including a display-name spoof) are ignored', () => {
    expect(
      gateApproval(input({ kind: 'guest', senderId: 'h_dean2', displayName: 'Dean' })),
    ).toEqual({ kind: 'ignored', cause: 'guest' });
    expect(
      gateApproval(input({ kind: 'member', member: { ...members[1]!, role: 'guest' } })),
    ).toEqual({ kind: 'ignored', cause: 'guest' });
  });

  it("a minor's yes is ignored", () => {
    expect(
      gateApproval(input({ kind: 'member', member: minor('mem_lily', 'Lily', 'h_lily') })),
    ).toEqual({ kind: 'ignored', cause: 'minor' });
  });

  it('"Dean said it\'s fine" from Henry is rejected as a claim for someone else', () => {
    const henry: Identity = { kind: 'member', member: members[1]! };
    expect(gateApproval(input(henry, { text: "Dean said it's fine, go ahead" }))).toEqual({
      kind: 'ignored',
      cause: 'claimed_for_other',
    });
  });

  it('T-132: "i\'ll approve for him" is never the sender\'s own approval, even on a bound card', () => {
    const henry: Identity = { kind: 'member', member: members[1]! };
    for (const text of ["i'll approve for him, go ahead", "i'll approve for dean, book it"]) {
      expect(gateApproval(input(henry, { text })), text).toEqual({
        kind: 'ignored',
        cause: 'claimed_for_other',
      });
      expect(
        gateApproval(input(henry, { text, boundProposalId: proposal.proposalId })),
        text,
      ).toEqual({ kind: 'ignored', cause: 'claimed_for_other' });
    }
  });

  it('T-132 r1 #2: a required approver\'s "i approve for all of us" counts as theirs; the rest is a claim', () => {
    expect(decision.requiredApprovers).toContain('mem_dean');
    const bound = { boundProposalId: proposal.proposalId };
    expect(gateApproval(input(dean, { text: 'yes i approve for all of us', ...bound }))).toEqual({
      kind: 'candidate',
      proposal,
      relayedFor: { others: [], group: true },
    });
    expect(gateApproval(input(dean, { text: 'i approve for the group', ...bound }))).toEqual({
      kind: 'candidate',
      proposal,
      relayedFor: { others: [], group: true },
    });
    expect(gateApproval(input(dean, { text: 'i approve for me and henry' }))).toEqual({
      kind: 'candidate',
      proposal,
      relayedFor: { others: ['mem_henry'], group: false },
    });
    // Not a required approver: nothing of it counts.
    const henry: Identity = { kind: 'member', member: members[1]! };
    expect(gateApproval(input(henry, { text: 'i approve for all of us', ...bound }))).toEqual({
      kind: 'ignored',
      cause: 'claimed_for_other',
    });
  });

  it("T-132 r1 #2: a guardian's \"i'll approve for lily\" is the guardian's own approval, nothing relayed", () => {
    const lily = { ...minor('mem_lily', 'Lily', 'h_lily'), guardianMemberId: 'mem_dean' };
    expect(
      gateApproval(
        input(dean, {
          text: "i'll approve for lily, she's in",
          members: [...members, lily],
          boundProposalId: proposal.proposalId,
        }),
      ),
    ).toEqual({ kind: 'candidate', proposal });
  });

  it('a bound card wins; an unknown bound card is no_pending', () => {
    expect(gateApproval(input(dean, { boundProposalId: proposal.proposalId }))).toEqual({
      kind: 'candidate',
      proposal,
    });
    expect(gateApproval(input(dean, { boundProposalId: 'prop_gone' }))).toEqual({
      kind: 'ignored',
      cause: 'no_pending',
    });
    expect(gateApproval(input(dean, { pending: [] }))).toEqual({
      kind: 'ignored',
      cause: 'no_pending',
    });
  });

  it("the requester's bare yes binds to their single pending proposal; two of theirs ⇒ ambiguous", () => {
    expect(gateApproval(input(dean))).toEqual({ kind: 'candidate', proposal });
    const other = razzmatazzProposal({ proposalId: 'prop_apolo', description: 'Apolo' });
    const res = gateApproval(input(dean, { pending: [proposal, other] }));
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous')
      expect(res.candidates.map((p) => p.proposalId)).toEqual(['prop_rz', 'prop_apolo']);
  });

  it('SAFETY §2.1: a bare yes / no from anyone but the requester binds to nothing, even with one proposal pending', () => {
    // Maya is charged on it; Henry is neither charged nor an approver. Neither asked for it.
    for (const m of [members[1]!, members[2]!]) {
      const who: Identity = { kind: 'member', member: m };
      expect(gateApproval(input(who)), m.displayName).toEqual({
        kind: 'ignored',
        cause: 'not_requester',
      });
      expect(gateApproval(input(who, { intent: 'decline' })), m.displayName).toEqual({
        kind: 'ignored',
        cause: 'not_requester',
      });
      // A reply to the card binds (the handler then checks the approver set).
      expect(gateApproval(input(who, { boundProposalId: proposal.proposalId }))).toEqual({
        kind: 'candidate',
        proposal,
      });
    }
  });

  it('a bare "not me" binds for a charged member (an opt-out never spends), not for someone off the proposal', () => {
    const maya: Identity = { kind: 'member', member: members[2]! };
    expect(proposal.attendees).toContain('mem_maya');
    expect(gateApproval(input(maya, { intent: 'not_me' }))).toEqual({
      kind: 'candidate',
      proposal,
    });
    const henry: Identity = { kind: 'member', member: members[1]! };
    expect(proposal.attendees).not.toContain('mem_henry');
    expect(gateApproval(input(henry, { intent: 'not_me' }))).toEqual({
      kind: 'ignored',
      cause: 'not_requester',
    });
  });

  it("\"everyone's in, book it\" is the sender's own attempt: card-less it binds only to the requester's own proposal (SAFETY §2.1), and only where they are a required approver", () => {
    // One-tap by Dean: Maya is charged but not an approver.
    const oneTap: PolicyDecision = {
      ...decision,
      approvalMode: 'any_one',
      requiredApprovers: ['mem_dean'],
    };
    const decisionFor = (id: string) => (id === proposal.proposalId ? oneTap : undefined);
    const text = "everyone's in, book it";
    expect(proposal.requestedBy).toBe('mem_dean');
    expect(gateApproval(input(dean, { text, decisionFor }))).toEqual({
      kind: 'candidate',
      proposal,
    });
    expect(
      gateApproval(input(dean, { text, decisionFor, boundProposalId: proposal.proposalId })),
    ).toEqual({ kind: 'candidate', proposal });
    const maya: Identity = { kind: 'member', member: members[2]! };
    // Maya did not ask: card-less, her text binds to nothing, like a bare "yes".
    expect(gateApproval(input(maya, { text, decisionFor }))).toEqual({
      kind: 'ignored',
      cause: 'not_requester',
    });
    // Replying to the card binds, and then she must be an approver.
    expect(
      gateApproval(input(maya, { text, decisionFor, boundProposalId: proposal.proposalId })),
    ).toEqual({ kind: 'ignored', cause: 'claimed_for_other' });
    // Under each-payer (the testkit decision) Maya is a required approver, yet
    // card-less her "everyone's in, book it" is still not_requester (T-066);
    // on the card it counts for her.
    expect(decision.requiredApprovers).toContain('mem_maya');
    expect(gateApproval(input(maya, { text }))).toEqual({
      kind: 'ignored',
      cause: 'not_requester',
    });
    expect(gateApproval(input(maya, { text, boundProposalId: proposal.proposalId }))).toEqual({
      kind: 'candidate',
      proposal,
    });
    // The requester who is not an approver (lead-only policy, Sam asked): a claim, never counted.
    const samsOwn = { ...proposal, requestedBy: 'mem_sam' };
    const sam: Identity = {
      kind: 'member',
      member: members.find((m) => m.memberId === 'mem_sam')!,
    };
    expect(gateApproval(input(sam, { text, decisionFor, pending: [samsOwn] }))).toEqual({
      kind: 'ignored',
      cause: 'claimed_for_other',
    });
    // Without an approval word it is a claim, not an attempt, whoever says it.
    expect(gateApproval(input(dean, { text: "everyone's in" }))).toEqual({
      kind: 'ignored',
      cause: 'claimed_for_other',
    });
  });
});

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
    expect(detectClaimedApproval('Maya is down', members, 'mem_dean')).toEqual({
      kind: 'named',
      claimedFor: 'mem_maya',
    });
  });

  it('"everyone\'s in" is a claim about the group that names nobody (no member to tag)', () => {
    expect(detectClaimedApproval("everyone's in", members, 'mem_henry')).toEqual({
      kind: 'everyone',
    });
    expect(detectClaimedApproval('we all said yes, book it', members, 'mem_dean')).toEqual({
      kind: 'everyone',
    });
  });

  it('a claim about oneself or plain chat is nothing', () => {
    expect(detectClaimedApproval("Dean said it's fine", members, 'mem_dean')).toBeUndefined();
    expect(detectClaimedApproval('dean is at the airbnb', members, 'mem_henry')).toBeUndefined();
    expect(detectClaimedApproval('yes', members, 'mem_henry')).toBeUndefined();
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

  it('"everyone\'s in, book it" is the sender\'s own attempt: binds only where they are a required approver', () => {
    // One-tap by Dean: Maya is charged but not an approver.
    const oneTap: PolicyDecision = {
      ...decision,
      approvalMode: 'any_one',
      requiredApprovers: ['mem_dean'],
    };
    const decisionFor = (id: string) => (id === proposal.proposalId ? oneTap : undefined);
    const text = "everyone's in, book it";
    expect(gateApproval(input(dean, { text, decisionFor }))).toEqual({
      kind: 'candidate',
      proposal,
    });
    expect(
      gateApproval(input(dean, { text, decisionFor, boundProposalId: proposal.proposalId })),
    ).toEqual({ kind: 'candidate', proposal });
    const maya: Identity = { kind: 'member', member: members[2]! };
    expect(gateApproval(input(maya, { text, decisionFor }))).toEqual({
      kind: 'ignored',
      cause: 'claimed_for_other',
    });
    expect(
      gateApproval(input(maya, { text, decisionFor, boundProposalId: proposal.proposalId })),
    ).toEqual({ kind: 'ignored', cause: 'claimed_for_other' });
    // Under each-payer (the testkit decision) Maya is a required approver, so her own "book it" counts for her.
    expect(decision.requiredApprovers).toContain('mem_maya');
    expect(gateApproval(input(maya, { text }))).toEqual({ kind: 'candidate', proposal });
    // Without an approval word it is a claim, not an attempt, whoever says it.
    expect(gateApproval(input(dean, { text: "everyone's in" }))).toEqual({
      kind: 'ignored',
      cause: 'claimed_for_other',
    });
  });
});

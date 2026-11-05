import { describe, expect, it } from 'vitest';
import type { Action, BookingProposalCard } from '@trav/core';
import type { ThreadEntry, ThreadMessage } from '../shared/types.js';
import { BARCELONA } from '../server/groups.js';
import { avatarColor, initials, layoutThread, planButtons, splitMentions } from './logic.js';

const member = (handle: string) => BARCELONA.members.find((m) => m.handle === handle)!;
const FIVE = ['mem_dean', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'];

const actions: Action[] = [
  { id: 'approve', label: 'Approve', style: 'primary', textAliases: [], allowedMemberIds: FIVE },
  { id: 'not_me', label: 'Not me', style: 'secondary', textAliases: [], allowedMemberIds: FIVE },
  { id: 'decline', label: 'Decline', style: 'secondary', textAliases: [], allowedMemberIds: FIVE },
];

function proposal(over: Partial<ThreadMessage> = {}, requires = FIVE): ThreadMessage {
  const card = {
    type: 'booking_proposal',
    cardId: 'c1',
    charged: FIVE.map((memberId) => ({ memberId, name: memberId })),
    policy: { requiresApprovalFrom: requires },
  } as unknown as BookingProposalCard;
  return {
    kind: 'message',
    seq: 1,
    at: '2026-03-14T21:40:00+01:00',
    lane: 'group',
    messageId: 'm1',
    direction: 'outbound',
    from: 'trav',
    fromName: 'Trav',
    isTrav: true,
    text: 'x',
    card,
    actions,
    attachments: [],
    renderedAsCard: false,
    degraded: false,
    reactions: [],
    ...over,
  };
}

describe('planButtons (VOICE §9.3: buttons only for members allowed to act)', () => {
  it('a charged member sees Approve / Not me / Decline', () => {
    expect(planButtons(proposal(), member('h_dean'), BARCELONA).buttons.map((a) => a.id)).toEqual([
      'approve',
      'not_me',
      'decline',
    ]);
  });

  it('Henry (not charged) sees "waiting on ..." and no buttons', () => {
    const plan = planButtons(proposal(), member('h_henry'), BARCELONA);
    expect(plan.buttons).toEqual([]);
    expect(plan.waitingOn).toBe('waiting on Dean, Maya +3');
  });

  it('a single approver reads "waiting on Dean"', () => {
    const one: Action[] = actions.map((a) => ({ ...a, allowedMemberIds: ['mem_dean'] }));
    const plan = planButtons(proposal({ actions: one }, ['mem_dean']), member('h_sam'), BARCELONA);
    expect(plan.waitingOn).toBe('waiting on Dean');
  });

  it('a resolved card shows no buttons for anyone', () => {
    const msg = proposal({
      cardState: { status: 'approved', label: 'Approved by Dean', liveActionIds: [] },
    });
    expect(planButtons(msg, member('h_dean'), BARCELONA)).toEqual({ buttons: [] });
    expect(planButtons(msg, member('h_henry'), BARCELONA)).toEqual({ buttons: [] });
  });

  it('omitted allowedMemberIds on a proposal means any charged member', () => {
    const open = actions.map(({ allowedMemberIds: _a, ...rest }) => rest);
    expect(
      planButtons(proposal({ actions: open }), member('h_sam'), BARCELONA).buttons,
    ).toHaveLength(3);
    expect(
      planButtons(proposal({ actions: open }), member('h_henry'), BARCELONA).buttons,
    ).toHaveLength(0);
  });

  it('any-one approval from the whole group (what the runtime sends): Henry is never named as waited on', () => {
    const open = actions.map(({ allowedMemberIds: _a, ...rest }) => rest);
    const all6 = BARCELONA.members.map((m) => m.memberId);
    const plan = planButtons(proposal({ actions: open }, all6), member('h_henry'), BARCELONA);
    expect(plan.buttons).toEqual([]);
    expect(plan.waitingOn).toBe('waiting on Dean, Maya +3');
  });

  it('approvers none of whom are charged are still named', () => {
    const open = actions.map(({ allowedMemberIds: _a, ...rest }) => rest);
    const plan = planButtons(proposal({ actions: open }, ['mem_henry']), member('h_henry'), BARCELONA);
    expect(plan.waitingOn).toBe('waiting on Henry');
  });
});

describe('splitMentions', () => {
  it('marks @trav and @Dean, not emails', () => {
    expect(splitMentions('@trav get tickets, ask @Dean or mail a@b.com')).toEqual([
      { text: '@trav', mention: true },
      { text: ' get tickets, ask ', mention: false },
      { text: '@Dean', mention: true },
      { text: ' or mail a@b.com', mention: false },
    ]);
    expect(splitMentions('')).toEqual([]);
  });
});

describe('layoutThread', () => {
  const m = (seq: number, from: string, at: string): ThreadEntry => {
    const { card: _card, ...plain } = proposal();
    return { ...plain, seq, from, isTrav: from === 'trav', at };
  };

  it('starts a separator on gaps over 15 minutes and groups runs by sender', () => {
    const entries = [
      m(1, 'h_sam', '2026-03-14T17:30:00+01:00'),
      m(2, 'h_sam', '2026-03-14T17:31:00+01:00'),
      m(3, 'h_jordan', '2026-03-14T17:32:00+01:00'),
      m(4, 'h_jordan', '2026-03-14T20:30:00+01:00'),
    ];
    const layout = layoutThread(entries, BARCELONA);
    expect(layout.map((l) => l.separator)).toEqual([
      'sat mar 14 · 5:30pm · day 3',
      undefined,
      undefined,
      'sat mar 14 · 8:30pm · day 3',
    ]);
    expect(layout.map((l) => [l.first, l.last])).toEqual([
      [true, false],
      [false, true],
      [true, true],
      [true, true],
    ]);
    expect(layoutThread([], BARCELONA)).toEqual([]);
  });
});

describe('avatars', () => {
  it('initials and stable per-member colors', () => {
    expect(initials('Dean')).toBe('D');
    expect(initials('Mary Ann Lee')).toBe('MA');
    expect(avatarColor(BARCELONA, 'h_dean')).toBe(avatarColor(BARCELONA, 'h_dean'));
    expect(avatarColor(BARCELONA, 'h_dean')).not.toBe(avatarColor(BARCELONA, 'h_henry'));
  });
});

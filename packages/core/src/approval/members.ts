/**
 * Member → MemberView projection (D-012). Age is interpreted only by the
 * `safety/` predicates (T-028); the policy functions that take raw `Member`s
 * accept the predicate as an injectable dependency so they stay pure and
 * table-testable, defaulting to `safety.isMinor`.
 */
import type { IsoDateTime } from '../primitives.js';
import type { Member } from '../domain/group.js';
import type { MemberView } from '../domain/approval.js';
import { isMinor as safetyIsMinor } from '../safety/index.js';

export type MinorPredicate = (member: Member, now: IsoDateTime) => boolean;

export interface ApprovalDeps {
  readonly isMinor: MinorPredicate;
}

export const DEFAULT_APPROVAL_DEPS: ApprovalDeps = {
  isMinor: (member, now) => safetyIsMinor(member, now),
};

/** `active` also requires no `leftAt`; a left member can never pay or approve. */
export function isActiveMember(member: Member): boolean {
  return member.active && member.leftAt === undefined;
}

/** Collapse lead/guardian/member to 'member'; `isMinor` from `safety/` unless injected. */
export function toMemberView(
  member: Member,
  now: IsoDateTime,
  deps: ApprovalDeps = DEFAULT_APPROVAL_DEPS,
): MemberView {
  const view: MemberView = {
    memberId: member.memberId,
    role: member.role === 'guest' ? 'guest' : 'member',
    isMinor: deps.isMinor(member, now),
    active: isActiveMember(member),
  };
  return member.guardianMemberId === undefined
    ? view
    : { ...view, guardianMemberId: member.guardianMemberId };
}

export function toMemberViews(
  members: readonly Member[],
  now: IsoDateTime,
  deps: ApprovalDeps = DEFAULT_APPROVAL_DEPS,
): readonly MemberView[] {
  return members.map((m) => toMemberView(m, now, deps));
}

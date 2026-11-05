/**
 * Payment profiles (T-166, D-043): read and write a member's apps, favourite
 * and handles in their own `PrivateStore` partition, and Trav's one DM ask.
 *
 * Privacy (SAFETY §2.3): a profile is the owner's. Its audit rows are
 * owner-visible and carry which rails changed, never a handle. Nothing here
 * posts to the group.
 *
 * Ask once: Trav asks "which apps do you use?" in DM the first time a member
 * joins (sign-up) or first owes or is owed money, whichever comes first.
 * `askedAt` is written with the ask, so it never goes out twice, answered or
 * not. A member who already told Trav something (a handle, their apps) is
 * never asked.
 */
import type {
  GroupId,
  HandleRail,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  OutboundMessage,
  PaymentProfile,
  PaymentRail,
  Stores,
  TripId,
} from '@trav/core';
import { payments, safety } from '@trav/core';
import type { AppsAnswer, HandleStatement } from './profileText.js';

const { RAIL_LABEL, displayHandle, railsOf } = payments;

export function getProfile(stores: Stores, memberId: MemberId): PaymentProfile | undefined {
  return stores.private.getPaymentProfile(memberId);
}

/** Never asked and never told Trav anything: the one ask may go out. */
export function needsAsk(profile: PaymentProfile | undefined): boolean {
  return profile === undefined || (profile.askedAt === undefined && railsOf(profile).length === 0);
}

/** An adult, active, non-guest member: the only people Trav asks or settles with. */
export function askable(member: Member, now: IsoDateTime): boolean {
  return (
    member.active &&
    member.leftAt === undefined &&
    member.role !== 'guest' &&
    !safety.isMinor(member, now)
  );
}

/** VOICE §4.6 D (T-166): the one ask, in DM. */
export const PROFILE_ASK_LINES: readonly string[] = [
  'quick one so settling up is painless later: which of these do you use? venmo, cash app, paypal, zelle, apple cash, cash. and which is your favourite?',
  `like "venmo and zelle, venmo's my fave". i only ask once, and it stays between us`,
];

export interface AskInput {
  readonly stores: Stores;
  readonly ids: IdGenerator;
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  readonly member: Member;
  readonly now: IsoDateTime;
  readonly askedFor: 'sign_up' | 'first_balance';
}

/** The one ask, built but not yet recorded: `commit()` once the DM actually went out. */
export interface PendingAsk {
  readonly memberId: MemberId;
  readonly message: OutboundMessage;
  /** Writes `askedAt` and the owner-only audit row. Idempotent: a second call does nothing. */
  commit(): void;
}

/**
 * The one DM ask, or `undefined` if this member was asked before, already told
 * Trav their apps, or isn't someone Trav settles with (a guest, a minor, a
 * member who left). Nothing is written until `commit()`, which the caller runs
 * only for a DM the channel delivered: a suppressed or failed send leaves the
 * member askable, a delivered one is never repeated.
 */
export function profileAsk(input: AskInput): PendingAsk | undefined {
  const { stores, member, now } = input;
  if (!askable(member, now)) return undefined;
  if (!needsAsk(getProfile(stores, member.memberId))) return undefined;
  let done = false;
  return {
    memberId: member.memberId,
    message: {
      id: input.ids.next('msg'),
      groupId: input.groupId,
      to: { kind: 'member', memberId: member.memberId },
      text: PROFILE_ASK_LINES.join('\n'),
    },
    commit() {
      // Re-read: the member may have answered something in between.
      const existing = getProfile(stores, member.memberId);
      if (done || !needsAsk(existing)) return;
      done = true;
      stores.private.putPaymentProfile(member.memberId, {
        memberId: member.memberId,
        apps: existing?.apps ?? [],
        handles: existing?.handles ?? {},
        ...(existing?.favourite !== undefined ? { favourite: existing.favourite } : {}),
        askedAt: now,
        askedFor: input.askedFor,
        updatedAt: now,
      });
      stores.group.audit.append({
        groupId: input.groupId,
        tripId: input.tripId,
        type: 'payment_profile.asked',
        actor: { kind: 'trav', id: 'trav' },
        visibility: 'owner',
        ownerId: member.memberId,
        payload: { memberId: member.memberId, askedFor: input.askedFor },
      });
    },
  };
}

/** The member owes Trav an answer to the one ask. */
export function awaitingAnswer(profile: PaymentProfile | undefined): boolean {
  return profile?.askedAt !== undefined && profile.answeredAt === undefined;
}

export interface ProfileChange {
  readonly profile: PaymentProfile;
  /** Rails whose handle was saved in this message. */
  readonly savedHandles: readonly HandleRail[];
  /** Rails named with something that isn't a handle ("my venmo is chase w"). */
  readonly badHandles: readonly HandleRail[];
  /** Rails named with one plain word that may not be a try at all ("my venmo is down"). */
  readonly softHandles: readonly HandleRail[];
  /** The apps answer was taken. */
  readonly tookApps: boolean;
}

/**
 * Applies what a member said to their profile and saves it (owner-only audit,
 * rail names only). Apps are added, never dropped; a favourite replaces the
 * old one; a handle replaces the old handle for that rail and adds the rail.
 * `apps` is only taken when it is explicit, or a bare list answering the ask.
 */
export function applyProfileWords(input: {
  readonly stores: Stores;
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  readonly memberId: MemberId;
  readonly now: IsoDateTime;
  readonly handles: readonly HandleStatement[];
  readonly apps: AppsAnswer | undefined;
}): ProfileChange | undefined {
  const { stores, memberId, now } = input;
  const before = getProfile(stores, memberId);
  const awaiting = awaitingAnswer(before);
  const takeApps =
    input.apps !== undefined && (input.apps.explicit || (awaiting && input.apps.bare));
  const saved = input.handles.filter((h) => h.handle !== undefined);
  const bad = input.handles
    .filter((h) => h.handle === undefined && h.soft !== true)
    .map((h) => h.rail);
  const soft = input.handles
    .filter((h) => h.handle === undefined && h.soft === true)
    .map((h) => h.rail);
  if (!takeApps && saved.length === 0 && bad.length === 0 && soft.length === 0) return undefined;
  if (!takeApps && saved.length === 0) {
    return {
      profile: before ?? { memberId, apps: [], handles: {}, updatedAt: now },
      savedHandles: [],
      badHandles: bad,
      softHandles: soft,
      tookApps: false,
    };
  }
  const apps: PaymentRail[] = [...(before?.apps ?? [])];
  const add = (r: PaymentRail): void => {
    if (!apps.includes(r)) apps.push(r);
  };
  if (takeApps) for (const r of input.apps!.apps) add(r);
  const handles: Partial<Record<HandleRail, string>> = { ...(before?.handles ?? {}) };
  for (const h of saved) {
    handles[h.rail] = h.handle!;
    add(h.rail);
  }
  // A single app named in passing ("i use venmo for dinner") never replaces a
  // favourite: it becomes one only when it answers the ask, or there is none yet.
  const only = takeApps ? input.apps!.onlyApp : undefined;
  const soleAsFavourite =
    only !== undefined && ((awaiting && input.apps!.bare) || before?.favourite === undefined)
      ? only
      : undefined;
  const favourite =
    (takeApps ? input.apps!.favourite : undefined) ?? soleAsFavourite ?? before?.favourite;
  const profile: PaymentProfile = {
    memberId,
    apps,
    handles,
    ...(favourite !== undefined ? { favourite } : {}),
    ...(before?.askedAt !== undefined ? { askedAt: before.askedAt } : {}),
    ...(before?.askedFor !== undefined ? { askedFor: before.askedFor } : {}),
    ...(takeApps
      ? { answeredAt: now }
      : before?.answeredAt !== undefined
        ? { answeredAt: before.answeredAt }
        : {}),
    updatedAt: now,
  };
  stores.private.putPaymentProfile(memberId, profile);
  stores.group.audit.append({
    groupId: input.groupId,
    tripId: input.tripId,
    type: 'payment_profile.updated',
    actor: { kind: 'member', id: memberId },
    visibility: 'owner',
    ownerId: memberId,
    // Rail names only: a handle never goes in the audit log.
    payload: {
      memberId,
      apps,
      ...(favourite !== undefined ? { favourite } : {}),
      handleRails: saved.map((h) => h.rail),
    },
  });
  return {
    profile,
    savedHandles: saved.map((h) => h.rail),
    badHandles: bad,
    softHandles: soft,
    tookApps: takeApps,
  };
}

const EXAMPLE: Readonly<Record<HandleRail, string>> = {
  venmo: '"my venmo is @your-name"',
  cashapp: '"my cashtag is $yourname"',
  paypal: '"my paypal is paypal.me/yourname"',
  zelle: '"my zelle is you@email.com" (or your number)',
};

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
}

/** Trav's DM reply after a profile change (VOICE §4.6 D). At most 3 lines. */
export function profileReplyLines(change: ProfileChange): string[] {
  const { profile } = change;
  const lines: string[] = [];
  if (change.tookApps) {
    const names = profile.apps.map((r) => RAIL_LABEL[r]);
    lines.push(
      profile.favourite !== undefined && profile.apps.length > 1
        ? `got it: ${list(names)}, ${RAIL_LABEL[profile.favourite]} first. i'll use that when you settle up`
        : `got it: ${list(names)}. i'll use that when you settle up`,
    );
  }
  if (change.savedHandles.length > 0) {
    const saved = change.savedHandles.map(
      (r) => `${RAIL_LABEL[r]} (${displayHandle(r, profile.handles[r]!)})`,
    );
    lines.push(`saved your ${list(saved)}. only someone paying you gets it, in their dm`);
  }
  for (const r of change.badHandles) {
    lines.push(`that doesn't look like a ${RAIL_LABEL[r]} handle. try ${EXAMPLE[r]}`);
  }
  for (const r of change.softHandles) {
    lines.push(`if that was your ${RAIL_LABEL[r]} handle, send it like ${EXAMPLE[r]}`);
  }
  // The rail they'd most likely be paid on still has no handle: one nudge.
  const first = railsOf(profile).find((r) => payments.railNeedsHandle(r));
  if (
    change.tookApps &&
    first !== undefined &&
    payments.railNeedsHandle(first) &&
    profile.handles[first] === undefined
  ) {
    lines.push(
      `send your ${RAIL_LABEL[first]} when you get a sec, like ${EXAMPLE[first]}, so people can pay you in one tap`,
    );
  }
  return lines.slice(0, 3);
}

/** Group lane: a handle said in the group is not stored there (VOICE §4.6 D). */
export const HANDLE_IN_GROUP_TEXT = 'send me that in a dm, handles stay between you and me';

/** A payee's bare Got it with several rows and nobody said sent (VOICE §4.6 F). */
export const WHICH_ROW_TEXT =
  "nobody's said sent yet, so i can't tell whose landed. once they tap Sent, your 👍 clears it";

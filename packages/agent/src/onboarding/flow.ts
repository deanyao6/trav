/**
 * T-170 (D-055): real-member onboarding on a phone-number channel (iMessage
 * relay lines). Every handle in the group (an E.164 number or an Apple ID
 * email, as the relay normalized it) maps to exactly one `Member` row by
 * `senderId`; display names are labels and never identity (SAFETY §2.5).
 *
 * An unknown handle that speaks (or joins) gets a pending row
 * (`onboarding: 'pending'`, role guest, inactive: on no split, roster or
 * approval; roast mode blocked while they are in the chat with no age). The
 * first time they speak, Trav DMs them once: the consent line (Trav reads the
 * group), their name (pre-filled when a member named them in the group, or
 * from the contact name), and whether they are 18+ (self-attested, DM only).
 * Then they are a member, and T-166's one payment-apps ask goes out with the
 * last setup line. Nothing in setup is ever addressed to the group.
 *
 * State lives in the newcomer's own `PrivateStore` partition (namespace
 * `onboarding`), so "forget me", a pending newcomer leaving, and "@trav leave"
 * delete it with the rest of the partition. Rules only, never the model.
 */
import type {
  AuditEventInput,
  Group,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  OutboundMessage,
  SenderId,
  Stores,
  TripId,
} from '@trav/core';
import { isOnboardingPending, parseIso, safety } from '@trav/core';
import { cleanName, parseAgeAnswer, parseNameAnswer, parseNameHint, yesNo } from './parse.js';
import * as T from './text.js';

export const ONBOARDING_NS = 'onboarding';
const STATE_KEY = 'setup';
/** A member's "welcome Sam" counts as a pre-fill for a newcomer who arrived this recently. */
export const HINT_WINDOW_MS = 60 * 60_000;

export type SetupStep = 'waiting' | 'name' | 'age';

export interface SetupState {
  /** `waiting`: no DM yet; `name` / `age`: the DM went out and this is the open question. */
  readonly step: SetupStep;
  readonly createdAt: IsoDateTime;
  /** Pre-fill for the name question. */
  readonly hint?: string;
  /** Where the hint came from: a member said it in the group, or the channel's contact name. */
  readonly hintFrom?: 'group' | 'contact';
  /** The name they gave (step `age`). */
  readonly name?: string;
  readonly dmAt?: IsoDateTime;
}

export interface OnboardingDeps {
  readonly stores: Stores;
  readonly ids: IdGenerator;
}

function isSetupState(v: unknown): v is SetupState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    (s['step'] === 'waiting' || s['step'] === 'name' || s['step'] === 'age') &&
    typeof s['createdAt'] === 'string'
  );
}

export function readSetup(stores: Stores, member: Member): SetupState | undefined {
  const e = stores.private.getRuntimeState(
    member.memberId,
    ONBOARDING_NS,
    member.groupId,
    STATE_KEY,
  );
  return e !== undefined && isSetupState(e.value) ? e.value : undefined;
}

function writeSetup(stores: Stores, member: Member, state: SetupState): void {
  stores.private.putRuntimeState(member.memberId, {
    namespace: ONBOARDING_NS,
    groupId: member.groupId,
    key: STATE_KEY,
    value: state,
  });
}

function clearSetup(stores: Stores, member: Member): void {
  stores.private.deleteRuntimeState(member.memberId, ONBOARDING_NS, member.groupId, STATE_KEY);
}

function dmTo(ids: IdGenerator, member: Member, text: string): OutboundMessage {
  return {
    id: ids.next('msg'),
    groupId: member.groupId,
    to: { kind: 'member', memberId: member.memberId },
    text,
  };
}

function audit(
  stores: Stores,
  group: Group,
  tripId: TripId | null,
  input: Omit<AuditEventInput, 'groupId' | 'tripId'>,
): void {
  stores.group.audit.append({ groupId: group.groupId, tripId, ...input });
}

const currentTripId = (stores: Stores, group: Group, now: IsoDateTime): TripId | null =>
  stores.group.trips.current(group.groupId, now)?.tripId ?? null;

/** Someone with this name (case-insensitive) is already a member, other than `self`. */
function nameTaken(members: readonly Member[], name: string, self: MemberId): boolean {
  const n = name.toLocaleLowerCase();
  return members.some(
    (m) =>
      m.memberId !== self &&
      m.leftAt === undefined &&
      !isOnboardingPending(m) &&
      m.displayName.toLocaleLowerCase() === n,
  );
}

/** Label for a pending row until they answer: never matched as a name in chat text. */
export const PENDING_LABEL = 'new member';

/**
 * The pending row for a handle no member has (a newcomer), created once. A
 * handle that is already a member (active or not) is returned as is.
 */
export function ensureNewcomer(
  deps: OnboardingDeps,
  group: Group,
  handle: SenderId,
  contactName: string | undefined,
  now: IsoDateTime,
): { readonly member: Member; readonly created: boolean } {
  const { stores, ids } = deps;
  const existing = stores.group.members.getBySenderId(group.groupId, handle);
  if (existing !== undefined) return { member: existing, created: false };
  const member: Member = {
    memberId: ids.next('mem'),
    groupId: group.groupId,
    displayName: PENDING_LABEL,
    role: 'guest',
    active: false,
    senderId: handle,
    ageBand: 'unknown',
    joinedAt: now,
    onboarding: 'pending',
  };
  stores.group.members.upsert(member);
  const hint = contactName === undefined ? undefined : cleanName(contactName);
  writeSetup(stores, member, {
    step: 'waiting',
    createdAt: now,
    ...(hint !== undefined ? { hint, hintFrom: 'contact' as const } : {}),
  });
  // Ids only: never the handle or a name (the row is visible to the group's audit view).
  audit(stores, group, currentTripId(stores, group, now), {
    type: 'member.joined',
    actor: { kind: 'trav', id: 'trav' },
    visibility: 'group',
    payload: { memberId: member.memberId, onboarding: 'pending' },
  });
  return { member, created: true };
}

/** The one setup DM, built but not recorded: `commit()` once the channel delivered it. */
export interface SetupDm {
  readonly message: OutboundMessage;
  commit(): void;
}

/**
 * The hello + consent + name question, or undefined when it already went out
 * (the newcomer is DMed once; a later group line from them changes nothing).
 */
export function setupDm(
  deps: OnboardingDeps,
  group: Group,
  member: Member,
  now: IsoDateTime,
): SetupDm | undefined {
  if (!isOnboardingPending(member)) return undefined;
  const state = readSetup(deps.stores, member) ?? { step: 'waiting' as const, createdAt: now };
  if (state.step !== 'waiting') return undefined;
  const message = dmTo(deps.ids, member, T.helloLines(group.name, state.hint).join('\n'));
  return {
    message,
    commit() {
      const latest = readSetup(deps.stores, member) ?? state;
      if (latest.step !== 'waiting') return;
      writeSetup(deps.stores, member, { ...latest, step: 'name', dmAt: now });
    },
  };
}

/**
 * A member's group line naming a newcomer ("welcome Sam"): the pre-fill for
 * the one newcomer still waiting for their DM who arrived in the last hour.
 * Ignored when it names an existing member, or when two newcomers could be meant.
 */
export function noteNameHint(
  deps: OnboardingDeps,
  members: readonly Member[],
  text: string,
  now: IsoDateTime,
): boolean {
  const hint = parseNameHint(text);
  if (hint === undefined) return false;
  const lower = hint.toLocaleLowerCase();
  const named = members.some(
    (m) =>
      !isOnboardingPending(m) &&
      m.leftAt === undefined &&
      (m.displayName.toLocaleLowerCase() === lower ||
        m.displayName.toLocaleLowerCase().split(' ')[0] === lower),
  );
  if (named) return false;
  const waiting = members
    .filter((m) => isOnboardingPending(m))
    .map((m) => ({ m, s: readSetup(deps.stores, m) }))
    .filter(
      (x): x is { m: Member; s: SetupState } =>
        x.s !== undefined &&
        x.s.step === 'waiting' &&
        parseIso(now) - parseIso(x.s.createdAt) <= HINT_WINDOW_MS,
    );
  if (waiting.length !== 1) return false;
  const { m, s } = waiting[0]!;
  if (s.hintFrom === 'group') return false; // the first one said wins
  writeSetup(deps.stores, m, { ...s, hint, hintFrom: 'group' });
  return true;
}

export interface SetupAnswer {
  readonly drafts: readonly OutboundMessage[];
  /** Set when this answer finished setup: the member as stored (active, named, age known). */
  readonly completed?: Member;
  readonly note: string;
}

/**
 * The newcomer's DM answer to the open setup question. On the last answer
 * the row becomes a member (`role: 'member'`, active, the name they gave,
 * `ageBand` from their answer, `ageSelfAttested`); the caller adds the done
 * line (with T-166's apps ask for an adult).
 */
export function answerSetup(
  deps: OnboardingDeps,
  group: Group,
  member: Member,
  text: string,
  now: IsoDateTime,
): SetupAnswer {
  const { stores, ids } = deps;
  const state = readSetup(stores, member);
  if (state === undefined || state.step === 'waiting') {
    return { drafts: [], note: 'onboarding:no_question' };
  }
  const reply = (t: string, note: string): SetupAnswer => ({
    drafts: [dmTo(ids, member, t)],
    note,
  });
  const members = stores.group.members.listByGroup(group.groupId);

  if (state.step === 'name') {
    const yn = yesNo(text);
    const { hint, hintFrom: _from, ...rest } = state;
    void _from;
    if (hint !== undefined && yn === 'no') {
      writeSetup(stores, member, rest);
      return reply(T.NAME_ASK_TEXT, 'onboarding:name_not_hint');
    }
    const name = hint !== undefined && yn === 'yes' ? hint : parseNameAnswer(text);
    if (name === undefined) return reply(T.NAME_AGAIN_TEXT, 'onboarding:name_again');
    if (nameTaken(members, name, member.memberId)) {
      writeSetup(stores, member, rest);
      return reply(T.nameTakenText(name), 'onboarding:name_taken');
    }
    writeSetup(stores, member, { ...rest, step: 'age', name });
    return reply(T.ageAskText(name), 'onboarding:name_saved');
  }

  // step 'age'
  const band = parseAgeAnswer(text);
  if (band === undefined) return reply(T.AGE_AGAIN_TEXT, 'onboarding:age_again');
  const name = state.name ?? PENDING_LABEL;
  const { onboarding: _pending, ...base } = member;
  void _pending;
  const completed: Member = {
    ...base,
    displayName: name,
    role: 'member',
    active: true,
    ageBand: band,
    ageSelfAttested: true,
  };
  stores.group.members.upsert(completed);
  clearSetup(stores, member);
  // The age stays out of the group-visible row: owner-only, like the DM it came from.
  const tripId = currentTripId(stores, group, now);
  audit(stores, group, tripId, {
    type: 'member.role_changed',
    actor: { kind: 'member', id: member.memberId },
    visibility: 'group',
    payload: { memberId: member.memberId, before: 'guest', after: 'member', onboarding: 'done' },
  });
  audit(stores, group, tripId, {
    type: 'settings.changed',
    actor: { kind: 'member', id: member.memberId },
    visibility: 'owner',
    ownerId: member.memberId,
    payload: { setting: 'ageBand', source: 'self_attested_dm', after: band },
  });
  return { drafts: [], completed, note: `onboarding:done:${band}` };
}

export type LeftOutcome =
  /** A newcomer who never finished setup: their row and partition are gone. */
  | { readonly kind: 'pending_removed'; readonly memberId: MemberId }
  /** A member: inactive from now, their ledger lines stay. */
  | { readonly kind: 'left'; readonly memberId: MemberId }
  | { readonly kind: 'none' };

/**
 * Someone left the group chat. A member is deactivated (`leftAt`; on no new
 * split, roster or approval; the tab keeps what they already share). A
 * pending newcomer never had anything on the tab, so their row and their
 * whole private partition (the setup state, any DM lane) are deleted.
 */
export function memberLeft(
  deps: OnboardingDeps,
  group: Group,
  handle: SenderId,
  now: IsoDateTime,
): LeftOutcome {
  const { stores } = deps;
  const m = stores.group.members.getBySenderId(group.groupId, handle);
  if (m === undefined) return { kind: 'none' };
  const tripId = currentTripId(stores, group, now);
  if (m.onboarding === 'pending') {
    stores.private.deletePartition(m.memberId);
    stores.group.members.remove(m.memberId);
    audit(stores, group, tripId, {
      type: 'member.left',
      actor: { kind: 'trav', id: 'trav' },
      visibility: 'group',
      payload: { memberId: m.memberId, onboarding: 'removed' },
    });
    return { kind: 'pending_removed', memberId: m.memberId };
  }
  if (m.leftAt !== undefined) return { kind: 'none' };
  stores.group.members.upsert({ ...m, active: false, leftAt: now });
  audit(stores, group, tripId, {
    type: 'member.left',
    actor: { kind: 'trav', id: 'trav' },
    visibility: 'group',
    payload: { memberId: m.memberId },
  });
  return { kind: 'left', memberId: m.memberId };
}

/**
 * A member who left came back to the chat: active again under the same
 * identity (their old ledger lines are theirs). If their age is unknown and a
 * lead had attested "everyone's 18+", the attestation covered the roster it
 * was given for and resets (SAFETY §2.7, audited `settings.changed`).
 */
export function memberRejoined(
  deps: OnboardingDeps,
  group: Group,
  member: Member,
  now: IsoDateTime,
): Member {
  const { stores } = deps;
  if (member.leftAt === undefined && member.active) return member;
  const { leftAt: _left, ...rest } = member;
  void _left;
  const back: Member = { ...rest, active: true };
  stores.group.members.upsert(back);
  const tripId = currentTripId(stores, group, now);
  audit(stores, group, tripId, {
    type: 'member.joined',
    actor: { kind: 'trav', id: 'trav' },
    visibility: 'group',
    payload: { memberId: member.memberId, rejoined: true },
  });
  const latest = stores.group.groups.get(group.groupId) ?? group;
  if (latest.settings.allAdultsConfirmed && safety.isAgeUnknown(back)) {
    stores.group.groups.update({
      ...latest,
      settings: { ...latest.settings, allAdultsConfirmed: false },
    });
    audit(stores, group, tripId, {
      type: 'settings.changed',
      actor: { kind: 'trav', id: 'trav' },
      visibility: 'group',
      payload: {
        setting: 'allAdultsConfirmed',
        before: true,
        after: false,
        reason: 'roster_change',
      },
    });
  }
  return back;
}

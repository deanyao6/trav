/**
 * Group context and prompt rendering (SAFETY §2.3; D-007). `buildGroupContext`
 * reads ONLY `stores.group`: it takes no private store at all, so not even a
 * per-member pending count can reach a group-lane prompt (T-112, SAFETY §2.3
 * "even a count is the owner's"). The DM lane adds the sender's own count.
 * Its parameter and return types contain no `Private<...>`; the T-007 type
 * test passes a `CardTransaction` to `withExtra` and expects a compile error.
 *
 * Rendering: every free-text field that came from a member or a provider
 * (display names, chat text, descriptions, memory) is sanitized: invisible
 * characters stripped, newlines collapsed, `<`/`>` escaped. So a member who
 * types `<untrusted>` or `</system>` cannot forge prompt structure, and the
 * rendered context never contains an `<untrusted` block (which would make the
 * tool-enabled call throw `untrusted_with_tools`).
 */
import type {
  Activity,
  Balance,
  Booking,
  BookingProposal,
  Clock,
  Expense,
  GroupContext,
  GroupId,
  GroupMessageSummary,
  GroupSafe,
  GroupStore,
  IsoDateTime,
  Member,
  MemberId,
  Money,
  Roster,
  SplitSpec,
  TimeZone,
  Trip,
  TripId,
} from '@trav/core';
import {
  formatMoney,
  formatTime,
  safety,
  STRIPPED_FIELDS,
  TravError,
  tripDayNumber,
} from '@trav/core';
import { stripInvisible } from '../untrusted.js';
import { tripMoney } from './tripMoney.js';

export interface GroupContextDeps {
  readonly group: GroupStore;
  readonly clock: Clock;
}

export interface BuildGroupContextOptions {
  /** Default 20. */
  readonly recentMessageLimit?: number;
  /** Default 15. */
  readonly recentExpenseLimit?: number;
  /** Default 30. */
  readonly groupMemoryLimit?: number;
  /**
   * Recent group-thread messages, identity-resolved by the caller (the
   * GroupStore keeps no transcript). Group-lane messages only; never DMs.
   */
  readonly recentMessages?: readonly GroupMessageSummary[];
}

function byTime(a: IsoDateTime | undefined, b: IsoDateTime | undefined): number {
  const ta = a === undefined ? Number.POSITIVE_INFINITY : Date.parse(a);
  const tb = b === undefined ? Number.POSITIVE_INFINITY : Date.parse(b);
  return ta - tb;
}

function lastN<T>(items: readonly T[], n: number): readonly T[] {
  return n <= 0 ? [] : items.slice(Math.max(0, items.length - n));
}

export function buildGroupContext(
  deps: GroupContextDeps,
  groupId: GroupId,
  tripId: TripId | null,
  opts?: BuildGroupContextOptions,
): GroupContext {
  const { group: store, clock } = deps;
  const now = clock.now();
  const group = store.groups.get(groupId);
  if (group === undefined) throw new TravError('not_found', `group ${groupId} not found`);

  const members = store.members.listByGroup(groupId);
  const trip: Trip | null =
    tripId === null
      ? (store.trips.current(groupId, now) ?? null)
      : (store.trips.get(tripId) ?? null);
  if (tripId !== null && trip === null)
    throw new TravError('not_found', `trip ${tripId} not found`);
  if (trip !== null && trip.groupId !== groupId) {
    throw new TravError(
      'invalid_argument',
      `trip ${trip.tripId} does not belong to group ${groupId}`,
    );
  }

  const memberOrder = members.map((m) => m.memberId);
  const orderIndex = new Map(memberOrder.map((id, i) => [id, i] as const));
  const inOrder = (ids: readonly MemberId[]): MemberId[] =>
    [...ids].sort((a, b) => (orderIndex.get(a) ?? Infinity) - (orderIndex.get(b) ?? Infinity));

  let activities: readonly Activity[] = [];
  let rosters: readonly Roster[] = [];
  let recentExpenses: readonly Expense[] = [];
  let balances: readonly Balance[] = [];
  let balancesWaitingOn: readonly MemberId[] = [];
  let bookings: readonly Booking[] = [];
  let dayNumber = 0;

  if (trip !== null) {
    activities = [...store.trips.listActivities(trip.tripId)].sort((a, b) =>
      byTime(a.startsAt, b.startsAt),
    );
    rosters = activities.map((a) => {
      const rows = store.trips.listAttendance(a.activityId);
      const pick = (s: 'in' | 'out' | 'maybe'): MemberId[] =>
        inOrder(rows.filter((r) => r.status === s).map((r) => r.memberId));
      return {
        activityId: a.activityId,
        inMemberIds: pick('in'),
        outMemberIds: pick('out'),
        maybeMemberIds: pick('maybe'),
        asOf: now,
      };
    });
    const expenses = [...store.expenses.listByTrip(trip.tripId)].sort((a, b) =>
      byTime(a.occurredAt, b.occurredAt),
    );
    recentExpenses = lastN(expenses, opts?.recentExpenseLimit ?? 15);
    // T-065: minors folded into their guardian, a family tab nets to zero. A
    // guardian-less minor with money leaves balances empty (get_balances asks
    // the leads, VOICE §8); the prompt then shows no balances line.
    const money = tripMoney({
      trip,
      members,
      expenses,
      entries: store.expenses.listEntries(trip.tripId),
      payments: store.settlements.listByTrip(trip.tripId),
      now,
    });
    balances = money.kind === 'ok' ? money.ledger.balances : [];
    if (money.kind === 'needs_guardian') balancesWaitingOn = money.minors;
    bookings = store.bookings.listByTrip(trip.tripId);
    dayNumber = tripDayNumber(now, trip.startDate, trip.timeZone);
  }

  const familyMode = safety.isFamilyMode(group, members, now);
  const roastMode =
    group.settings.roastMode &&
    !familyMode &&
    !safety.groupHasMinor(members, now) &&
    !safety.groupAgeUnconfirmed(group, members);

  const recentMessages = lastN(
    (opts?.recentMessages ?? []).filter((m) => m.messageId.length > 0),
    opts?.recentMessageLimit ?? 20,
  );

  return {
    group,
    members,
    trip,
    activities,
    rosters,
    recentExpenses,
    balances,
    ...(balancesWaitingOn.length > 0 ? { balancesWaitingOn } : {}),
    pendingProposals: store.bookings
      .listPendingProposals(groupId)
      .filter((p) => trip === null || p.tripId === trip.tripId),
    bookings,
    groupMemory: store.groupMemory.listByGroup(groupId, { limit: opts?.groupMemoryLimit ?? 30 }),
    recentMessages,
    now,
    dayNumber,
    familyMode,
    roastMode,
  };
}

// ---------- extras ----------

export type GroupContextWithExtras = GroupContext & {
  readonly extras: Readonly<Record<string, unknown>>;
};

const PRIVATE_KEYS = new Set<string>(STRIPPED_FIELDS);

/** Runtime belt to the compile-time brace: reject any object carrying a private field name. */
function findPrivateKey(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findPrivateKey(v, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(k)) return k;
    const hit = findPrivateKey(v, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function existingExtras(ctx: GroupContext): Readonly<Record<string, unknown>> {
  const maybe = (ctx as Partial<GroupContextWithExtras>).extras;
  return typeof maybe === 'object' && maybe !== null ? maybe : {};
}

/**
 * Attach extra group-safe data (e.g. search results) to the context; rejects
 * private types at compile time (`GroupSafe`) and objects carrying any
 * `STRIPPED_FIELDS` key at runtime (`invalid_argument`).
 */
export function withExtra<T>(
  ctx: GroupContext,
  key: string,
  extra: T & GroupSafe<T>,
): GroupContextWithExtras {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) {
    throw new TravError('invalid_argument', `extra key "${key}" must be snake_case`);
  }
  const leaked = findPrivateKey(extra);
  if (leaked !== undefined) {
    throw new TravError('invalid_argument', `extra "${key}" carries a private field (${leaked})`);
  }
  return { ...ctx, extras: { ...existingExtras(ctx), [key]: extra } };
}

// ---------- rendering ----------

export interface RenderedPrompt {
  readonly systemPromptId: string;
  readonly system: string;
  /** Plain text; no `<untrusted` blocks here (member chat is not a document). */
  readonly context: string;
}

/** One-line, tag-proof text: invisible chars stripped, whitespace collapsed, `<`/`>` escaped, length capped. */
export function sanitizeInline(text: string, max = 300): string {
  const flat = stripInvisible(text).replace(/\s+/g, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return cut.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Ids, currency codes, statuses, kinds: short, but still not trusted to be tag-free. */
function sid(value: string): string {
  return sanitizeInline(value, 80);
}

function m(amountMinor: number, currency: string): Money {
  return { amountMinor, currency };
}

function signed(x: Money): string {
  return x.amountMinor > 0 ? `+${formatMoney(x)}` : formatMoney(x);
}

function describeSplit(split: SplitSpec, name: (id: MemberId) => string): string {
  switch (split.method) {
    case 'equal':
      return `equal among ${split.participants.map(name).join(', ')}`;
    case 'exclude':
      return split.excluded.length === 0
        ? 'equal among everyone'
        : `everyone except ${split.excluded.map(name).join(', ')}`;
    case 'weighted':
      return `weighted: ${split.weights.map((w) => `${name(w.memberId)} ×${w.weight}`).join(', ')}`;
    case 'exact':
      return `exact: ${split.amounts.map((a) => `${name(a.memberId)} ${formatMoney(a.amount)}`).join(', ')}`;
    case 'itemized':
      return `itemized (${split.lineItems.length} lines) among ${split.participants.map(name).join(', ')}`;
  }
}

function memberLine(mem: Member, now: IsoDateTime): string {
  const tags: string[] = [sid(mem.role)];
  if (safety.isMinor(mem, now)) tags.push('under 18');
  if (!mem.active) tags.push('left the group');
  return `- ${sanitizeInline(mem.displayName, 60)} (${sid(mem.memberId)}) · ${tags.join(' · ')}`;
}

function extrasOf(ctx: GroupContext): Readonly<Record<string, unknown>> {
  return existingExtras(ctx);
}

/**
 * Renders the group-lane system prompt + context block. A runtime test scans
 * the output of every fixture for `PRIVATE_PROMPT_MARKERS`.
 */
export function renderGroupPrompt(
  ctx: GroupContext,
  voice: { readonly systemPromptId: string; readonly persona: string },
  opts?: {
    /**
     * Default `group`. The DM lane reuses this context and appends the
     * sender's own memory and pending count, so the group-only "you can't see
     * anyone's pending items" rule is left out there (T-112 r1 #3).
     */
    readonly lane?: 'group' | 'dm';
  },
): RenderedPrompt {
  const groupLane = (opts?.lane ?? 'group') === 'group';
  const tz: TimeZone = ctx.trip?.timeZone ?? 'UTC';
  const names = new Map(
    ctx.members.map((x) => [x.memberId, sanitizeInline(x.displayName, 60)] as const),
  );
  const name = (id: MemberId): string => names.get(id) ?? sid(id);
  const names_ = (ids: readonly MemberId[]): string =>
    ids.length === 0 ? 'nobody' : ids.map(name).join(', ');
  const when = (iso: IsoDateTime): string => formatTime(iso, tz, ctx.now);

  const rules: string[] = [
    `you are in the group chat "${sanitizeInline(ctx.group.name, 80)}". the context below is everything you know about this group right now.`,
    'act only for the members listed below, and use their member ids when you call tools. if you cannot tell exactly who is in, ask; never guess from a headcount.',
    'you can propose bookings, but a member has to confirm before anything is bought. never say money moved unless a receipt in the context says so.',
    "members' cards, emails, receipts and private notes are not in this context. never ask anyone to paste card numbers, passwords or codes into the group.",
    ...(groupLane ? [GROUP_PENDING_RULE] : []),
    ctx.familyMode
      ? 'family mode is on: someone in this group is under 18. no nightlife, bars, clubs or alcohol suggestions that include them.'
      : 'family mode is off.',
    ctx.roastMode
      ? "roast mode is on: light roasts about this trip's spending and events only. never bodies, romance, people outside the chat, health, money troubles or sensitive traits."
      : 'roast mode is off: no roasts or teasing.',
  ];
  const system = `${voice.persona.trim()}\n\n${rules.map((r) => `- ${r}`).join('\n')}`;

  const lines: string[] = [];
  lines.push(
    `group: ${sanitizeInline(ctx.group.name, 80)} (${sid(ctx.group.groupId)}) · currency ${sid(ctx.group.currency)}`,
  );
  if (ctx.trip !== null) {
    const t = ctx.trip;
    lines.push(
      `trip: ${sanitizeInline(t.name, 80)} (${sid(t.tripId)}) · ${sanitizeInline(t.city, 60)} · ${sid(t.startDate)} to ${sid(t.endDate)} · ${sid(t.status)} · day ${ctx.dayNumber} · tab in ${sid(t.currency)}`,
    );
  } else {
    lines.push('trip: none planned yet');
  }
  lines.push(`now: ${when(ctx.now)} (${sid(tz)})`);
  lines.push(
    `family mode: ${ctx.familyMode ? 'on' : 'off'} · roast mode: ${ctx.roastMode ? 'on' : 'off'}`,
  );

  lines.push('', `members (${ctx.members.length}):`);
  for (const mem of ctx.members) lines.push(memberLine(mem, ctx.now));

  if (ctx.activities.length > 0) {
    lines.push('', 'plans:');
    const rosterBy = new Map(ctx.rosters.map((r) => [r.activityId, r] as const));
    for (const a of ctx.activities.slice(0, 30)) {
      const r = rosterBy.get(a.activityId);
      const parts = [
        `- ${sanitizeInline(a.name, 80)} (${sid(a.activityId)})`,
        sid(a.kind),
        a.startsAt === undefined ? 'time tbd' : when(a.startsAt),
      ];
      if (a.venue !== undefined) parts.push(sanitizeInline(a.venue, 80));
      if (a.bookingId !== undefined) parts.push(`booked (${sid(a.bookingId)})`);
      if (r !== undefined) {
        parts.push(`in: ${names_(r.inMemberIds)}`, `out: ${names_(r.outMemberIds)}`);
        if (r.maybeMemberIds.length > 0) parts.push(`maybe: ${names_(r.maybeMemberIds)}`);
      }
      lines.push(parts.join(' · '));
    }
  }

  if (ctx.recentExpenses.length > 0) {
    lines.push('', 'recent expenses:');
    for (const e of ctx.recentExpenses) {
      const payers = e.paidBy.map((p) => name(p.memberId)).join(' + ');
      const label = sanitizeInline(e.merchantDisplay ?? e.description, 80);
      lines.push(
        `- ${label} (${sid(e.expenseId)}) · ${formatMoney(e.amount)} · paid by ${payers} · ${describeSplit(e.split, name)} · ${when(e.occurredAt)}`,
      );
    }
  }

  if (ctx.trip?.familyTab === true) {
    lines.push(
      '',
      'money: family tab, one pot, nobody owes anybody and there is nothing to settle',
    );
  } else if ((ctx.balancesWaitingOn?.length ?? 0) > 0) {
    // T-065 review #3: never let the model say nobody owes anything
    lines.push(
      '',
      `money: settle-up is waiting on who covers ${names_(ctx.balancesWaitingOn ?? [])} (under 18, no guardian set); ask before settling, never say nobody owes anything`,
    );
  } else if (ctx.balances.length > 0) {
    lines.push(
      '',
      `balances (positive = is owed): ${ctx.balances.map((b) => `${name(b.memberId)} ${signed(b.net)}`).join(' · ')}`,
    );
  }

  if (ctx.pendingProposals.length > 0) {
    lines.push('', 'waiting for approval:');
    for (const p of ctx.pendingProposals) lines.push(proposalLine(p, name, names_, when));
  }

  if (ctx.bookings.length > 0) {
    lines.push('', 'booked:');
    for (const b of ctx.bookings) {
      lines.push(
        `- ${sanitizeInline(b.description, 80)} (${sid(b.bookingId)}) · ${formatMoney(m(b.totalMinor, b.currency))} · for ${names_(b.attendees)} · ${b.refundable ? 'refundable' : 'non-refundable'} · ${sid(b.status)}`,
      );
    }
  }

  if (ctx.groupMemory.length > 0) {
    lines.push('', 'what the group has said before:');
    for (const f of ctx.groupMemory) {
      const about = f.aboutMemberIds.length > 0 ? ` (about ${names_(f.aboutMemberIds)})` : '';
      lines.push(`- ${sanitizeInline(f.text, 200)}${about}`);
    }
  }

  const extras = Object.entries(extrasOf(ctx));
  if (extras.length > 0) {
    lines.push('', 'extra info:');
    for (const [k, v] of extras)
      lines.push(`- ${k}: ${sanitizeInline(JSON.stringify(v) ?? 'null', 2000)}`);
  }

  if (ctx.recentMessages.length > 0) {
    lines.push('', 'recent messages in the group:');
    for (const msg of ctx.recentMessages) {
      const who = msg.fromTrav
        ? 'trav'
        : msg.senderMemberId === null
          ? `${sanitizeInline(msg.senderDisplayName, 60)} (guest)`
          : name(msg.senderMemberId);
      lines.push(`- ${who}: ${sanitizeInline(msg.text, 500)}`);
    }
  }

  return { systemPromptId: voice.systemPromptId, system, context: lines.join('\n') };
}

function proposalLine(
  p: BookingProposal,
  name: (id: MemberId) => string,
  names_: (ids: readonly MemberId[]) => string,
  when: (iso: IsoDateTime) => string,
): string {
  return [
    `- ${sanitizeInline(p.description, 80)} (${sid(p.proposalId)})`,
    formatMoney(m(p.totalMinor, p.currency)),
    `for ${names_(p.attendees)}`,
    `requested by ${name(p.requestedBy)} ${when(p.requestedAt)}`,
    p.refundable ? 'refundable' : 'non-refundable',
  ].join(' · ');
}

/** Group lane only (T-112): the DM lane does see the sender's own pending count. */
export const GROUP_PENDING_RULE =
  "you can't see what anyone has waiting for their 👍 in their own thread with you, not even how many. never guess it in the group; if someone asks about their own, point them to their thread with you.";

/** Strings that must never appear in a rendered group prompt (SAFETY C2). */
export const PRIVATE_PROMPT_MARKERS: readonly string[] = [
  'last4',
  'accountId',
  'merchantRaw',
  'bodyText',
  'ocrText',
  'subject:',
];

const PENDING_WORDS =
  /\b(?:pending|waiting|unconfirmed|unshared|looks? shared|private items?|own threads?)\b/iu;

const ITEM = String.raw`(?:charges?|items?|receipts?|transactions?|emails?|purchases?)`;
const PEND = String.raw`(?:looks? shared|waiting|pending|unconfirmed|unshared)`;

/**
 * Count phrasings for private items: "private items waiting …", "2 charges
 * that look shared", "3 card charges are pending", "2 of Sam's charges are
 * pending", "2 of their charges are waiting for a 👍", "charges waiting: 3".
 */
const PENDING_COUNT_PHRASES: readonly RegExp[] = [
  /private items? waiting/iu,
  /\bcounts only\b/iu,
  /\bget_my_pending_items\b/u,
  new RegExp(String.raw`\b\d+\s+(?:\p{L}+\s+){0,2}?${ITEM}\b[^\n]{0,30}\b${PEND}\b`, 'iu'),
  new RegExp(
    String.raw`\b\d+\s+of\s+(?:their|his|her|my|your|our|\p{L}[\p{L}-]*'s)\s+(?:\p{L}+\s+){0,2}?${ITEM}\b[^\n]{0,30}\b${PEND}\b`,
    'iu',
  ),
  new RegExp(String.raw`\b${ITEM}\s+(?:\p{L}+\s+){0,2}?${PEND}\w*\s*(?:[:=]\s*)?[×x]?\d+\b`, 'iu'),
];

/**
 * SAFETY C2 / §2.3 "even a count is the owner's" (T-112): lines of a rendered
 * group-lane prompt that carry a pending private-item count, for anyone. Only
 * Trav-authored structure is scanned: the transcript lines under "recent
 * messages in the group:" (members' own words, each "- name: text") are
 * skipped, and scanning resumes at the first line after them.
 * `memberNames` adds the per-member shapes on a line with a pending word:
 * "Sam 2 · Maya 1", "Sam (2)", "pending: Sam ×2", "Sam=2", "Sam has 2 waiting".
 */
export function pendingCountLeaks(prompt: string, memberNames: readonly string[] = []): string[] {
  const perMember = memberNames
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .map(
      (n) =>
        new RegExp(
          String.raw`(?<![\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:'s)?\s*(?:[:(=]\s*|(?:has|have|got)\s+)?[×x]?\d+\b`,
          'iu',
        ),
    );
  const out: string[] = [];
  let inTranscript = false;
  for (const line of prompt.split('\n')) {
    if (line.trim() === 'recent messages in the group:') {
      inTranscript = true;
      continue;
    }
    if (inTranscript) {
      if (line.startsWith('- ')) continue;
      inTranscript = false;
    }
    if (
      PENDING_COUNT_PHRASES.some((re) => re.test(line)) ||
      (PENDING_WORDS.test(line) && perMember.some((re) => re.test(line)))
    )
      out.push(line);
  }
  return out;
}

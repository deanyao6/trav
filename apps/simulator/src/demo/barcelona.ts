/**
 * The Barcelona flagship demo (T-021): the whole trip, offline, through the
 * real Trav runtime (`createTravRuntime` behind the simulator's agent
 * backend, the same code path `pnpm sim` serves), on the simulated clock.
 *
 *   trip setup → multi-origin flights → lodging → Barça tickets → dinner
 *   expense → Uber email → Razzmatazz 5-of-6 → receipt + 5 ticket DMs →
 *   card confirm → Morning After → settle-up → Wrapped
 *
 * Every chat line, tapback and button tap goes through the simulator channel
 * into `agent.handleInbound`; every clock move drains the scheduler through
 * `agent.runScheduled` (the Morning Afters, Wrapped, and every consenting
 * owner's card import at 10:00 and 20:00, T-067); Crowley's card syncing at 9am
 * is the real `agent.importCardTransactions` on the simulated clock, and the
 * email documents go through `agent.intakeDocument`. Group flights (T-074)
 * are the chat flow too: `search_flights` runs the core multi-origin
 * optimizer over the mock airline and posts the options card, and "book
 * option 1" goes through the approval policy like every booking.
 *
 * `runBarcelonaDemo()` returns the transcript and the list of checks; it
 * never throws on a failed check (the CLI turns `ok: false` into exit 1).
 */
import type { TravRuntime } from '@trav/agent';
import { createTravRuntime } from '@trav/agent';
import type {
  AuditEvent,
  Balance,
  IsoDateTime,
  MemberId,
  RichCard,
  SettleUpCard,
} from '@trav/core';
import { audit as auditChain, formatMoney, ledger, money, parseIso } from '@trav/core';
import type { SimulatorBackend } from '../server/backend.js';
import { clockLabel } from '../server/clock.js';
import { BARCELONA } from '../server/groups.js';
import type { SimRuntimeInput, SimRuntimeOutput } from '../server/runtime.js';
import { loadAgentBackend } from '../server/runtime.js';
import type { GroupView, ThreadEntry, ThreadMessage } from '../shared/types.js';

export interface DemoCheck {
  readonly step: string;
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface DemoResult {
  readonly ok: boolean;
  /** Markdown transcript (what `docs/DEMO_TRANSCRIPT.md` holds). */
  readonly transcript: string;
  readonly checks: readonly DemoCheck[];
  /** Journey steps that did not run through the chat (named in the transcript header). */
  readonly notes: readonly string[];
}

export interface DemoOptions {
  /** Called with each transcript chunk as it is produced (the CLI prints live). */
  readonly onChunk?: (text: string) => void;
}

const G = BARCELONA;
const TRIP_ID = 'trip_barcelona';
const MEMBER_ORDER: readonly MemberId[] = G.members.map((m) => m.memberId);
const FIVE: readonly MemberId[] = [
  'mem_dean',
  'mem_chase',
  'mem_piotr',
  'mem_arjun',
  'mem_crowley',
];
const HENRY: MemberId = 'mem_henry';
/** The 4 riders on Arjun's Uber email (`fixtures/emails/em_bcn_arjun_uber_0314.json`). */
const UBER_RIDERS: readonly MemberId[] = ['mem_arjun', 'mem_dean', 'mem_piotr', 'mem_crowley'];
/** The group chat the evening the trip became official (Madrid time, the trip's zone). */
const DEMO_START: IsoDateTime = '2026-02-03T20:00:00+01:00';
const BASES: readonly string[] = ['ledger', 'booking', 'attendance', 'album'];
/**
 * The offline client's full-miss reply (`OFFLINE_NOT_SURE_TEXT` in
 * packages/agent/src/model/offline/client.ts, not exported from @trav/agent).
 * The demo checks no scripted step lands on it.
 */
export const OFFLINE_FALLBACK = "i'm not sure what you mean";

/** The steps that have no chat flow in v0 (printed in the transcript header). */
export const DEMO_NOTES: readonly string[] = [
  'step 10 (settle-up): Trav answers "@trav settle now" with the transfers; Chase\'s 👍 on the card (or a [Paid] tap) records that Chase says Chase paid and re-posts the card with Chase\'s row ticked (T-141). Payee confirmation, disputes and nudges are not built (T-037), so the demo applies the remaining transfers to the balances itself and checks that everyone ends at €0. No money moves.',
];

function nameOf(id: string): string {
  return G.members.find((m) => m.memberId === id || m.handle === id)?.name ?? id;
}

function handleOf(name: string): string {
  const m = G.members.find((x) => x.name === name);
  if (!m) throw new Error(`demo: no member ${name}`);
  return m.handle;
}

function messages(entries: readonly ThreadEntry[]): ThreadMessage[] {
  return entries.filter((e): e is ThreadMessage => e.kind === 'message');
}

function messageById(v: GroupView, id: string): ThreadMessage | undefined {
  return messages(v.thread).find((m) => m.messageId === id);
}

function isPendingPrompt(m: ThreadMessage): boolean {
  return m.card?.type === 'expense_confirm' && m.card.status === 'pending';
}

/** One message as markdown list lines; `dmOf` marks a private DM thread. */
export function formatMessage(m: ThreadMessage, dmOf?: string): string {
  // T-165: the ledger notice is the centered grey subscript, not a Trav bubble.
  if (m.systemNotice === true) return `- _(notice) ${m.text}_`;
  const who = m.isTrav ? 'trav' : m.fromName;
  const lane = dmOf !== undefined ? `🔒 dm ${m.isTrav ? `→ ${dmOf}` : `from ${dmOf}`} · ` : '';
  const text = m.text.length > 0 ? m.text : m.card ? `[${m.card.type} card]` : '';
  const [first = '', ...rest] = text.split('\n');
  const out = [`- ${lane}**${who}**: ${first}`, ...rest.map((l) => `      ${l}`)];
  if (m.actions.length > 0) out.push(`      [${m.actions.map((a) => a.label).join('] [')}]`);
  return out.join('\n');
}

/**
 * Drives the journey. Exported for the in-process test (`barcelona.test.ts`)
 * and the CLI (`cli/demo.ts`).
 */
export async function runBarcelonaDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const checks: DemoCheck[] = [];
  const body: string[] = [];
  let step = 'setup';
  let runtime: TravRuntime | undefined;

  const emit = (text: string): void => {
    body.push(text);
    options.onChunk?.(`${text}\n`);
  };
  const check = (name: string, ok: boolean, detail?: string): boolean => {
    checks.push({ step, name, ok, ...(detail !== undefined ? { detail } : {}) });
    if (!ok) emit(`> ✗ check failed: ${name}${detail !== undefined ? ` (${detail})` : ''}`);
    return ok;
  };

  // The simulator's agent backend over the real runtime (exactly what
  // `pnpm sim` serves); the demo keeps a handle on the runtime to read the
  // ledger, bookings and audit log for its checks.
  const capture = (input: SimRuntimeInput): SimRuntimeOutput => {
    runtime = createTravRuntime({
      channel: input.channel,
      clock: input.clock,
      offline: true,
      voice: 'log',
    });
    return runtime;
  };
  const backend: SimulatorBackend = await loadAgentBackend({
    offline: true,
    groups: [G],
    startAt: DEMO_START,
    createTravRuntime: capture,
  });
  const rt = (): TravRuntime => {
    if (runtime === undefined) throw new Error('demo: runtime was not created');
    return runtime;
  };

  const view = (): GroupView => backend.state().groups.find((g) => g.group.groupId === G.groupId)!;
  /** T-165 ledger notices in the group thread (the grey subscript lines). */
  const notices = (): ThreadMessage[] =>
    messages(view().thread).filter((m) => m.systemNotice === true);
  let groupSeen = 0;
  const dmSeen = new Map<MemberId, number>();
  /** Prints whatever appeared in the group thread and in each DM since the last flush. */
  const flush = (): { group: ThreadMessage[]; dms: Map<MemberId, ThreadMessage[]> } => {
    const v = view();
    const all = messages(v.thread);
    const fresh = all.filter((m) => m.seq > groupSeen);
    for (const m of fresh) emit(formatMessage(m));
    groupSeen = Math.max(groupSeen, ...all.map((m) => m.seq));
    const dms = new Map<MemberId, ThreadMessage[]>();
    for (const id of MEMBER_ORDER) {
      const seen = dmSeen.get(id) ?? 0;
      const list = messages(v.dms[id] ?? []);
      const newer = list.filter((m) => m.seq > seen);
      for (const m of newer) emit(formatMessage(m, nameOf(id)));
      if (newer.length > 0) dms.set(id, newer);
      dmSeen.set(id, Math.max(seen, ...list.map((m) => m.seq)));
    }
    if (v.status !== undefined) emit(`- _(simulator status: ${v.status})_`);
    return { group: fresh, dms };
  };

  /** Moves the clock forward (draining due jobs through Trav) and prints anything posted. */
  const at = async (iso: IsoDateTime): Promise<void> => {
    if (parseIso(iso) > parseIso(backend.now())) {
      await backend.advanceClock!({ to: iso, groupId: G.groupId });
      flush();
    }
  };
  const say = async (who: string, text: string, when?: IsoDateTime): Promise<ThreadMessage[]> => {
    if (when !== undefined) await at(when);
    await backend.inject({ type: 'message', from: handleOf(who), text, groupId: G.groupId });
    return flush().group.filter((m) => m.isTrav);
  };
  const dm = async (who: string, text: string, when?: IsoDateTime): Promise<ThreadMessage[]> => {
    if (when !== undefined) await at(when);
    await backend.inject({ type: 'message', from: handleOf(who), text, lane: 'dm' });
    const id = G.members.find((m) => m.name === who)!.memberId;
    return (flush().dms.get(id) ?? []).filter((m) => m.isTrav);
  };
  const react = async (
    who: string,
    target: ThreadMessage,
    reaction = '👍',
  ): Promise<ThreadMessage[]> => {
    emit(`- _${who} reacts ${reaction} on trav's ${target.card?.type ?? 'message'}_`);
    await backend.inject({
      type: 'reaction',
      from: handleOf(who),
      targetMessageId: target.messageId,
      reaction,
    });
    return flush().group.filter((m) => m.isTrav);
  };
  const tap = async (who: string, target: ThreadMessage, actionId: string): Promise<void> => {
    const label = target.actions.find((a) => a.id === actionId)?.label ?? actionId;
    emit(`- _${who} taps [${label}]_`);
    await backend.inject({
      type: 'button_tap',
      from: handleOf(who),
      cardMessageId: target.messageId,
      actionId,
    });
    flush();
  };
  const clock = async (iso: IsoDateTime, label: string): Promise<ThreadMessage[]> => {
    emit(`- _⏩ clock → ${clockLabel(iso, G)} (${label})_`);
    await backend.advanceClock!({ to: iso, groupId: G.groupId });
    return flush().group.filter((m) => m.isTrav);
  };
  const section = async (title: string, when?: IsoDateTime): Promise<void> => {
    step = title;
    if (when !== undefined) await at(when);
    emit(`\n### ${title}\n\n_${clockLabel(backend.now(), G)}_\n`);
  };
  const auditLog = (): readonly AuditEvent[] => rt().stores.group.audit.listByGroup(G.groupId);

  try {
    // ---------------- 1. trip setup ----------------
    await section('1. trip setup', '2026-02-03T20:02:00+01:00');
    await say('Dean', 'ok its official. BARCELONA mar 12-17 🇪🇸 everyone lock it in');
    await say('Arjun', "ok i'm at my sister's in nyc that week so jfk out, dc back");
    await say('Chase', 'i have to fly out of SF but back to LA, cousins thing on the 18th');
    await say('Crowley', 'LA out, seattle back (new internship 🤠)');
    await say('Henry', 'miami out, atlanta back. grandparents');
    await say('Piotr', 'chicago both ways ✈️');
    await say('Dean', 'im bos out but jfk back, internship starts the 18th');
    const trip = rt().stores.group.trips.get(TRIP_ID);
    check(
      'trip is set up (Barcelona, mar 12-17, EUR)',
      trip?.startDate === '2026-03-12' && trip.endDate === '2026-03-17' && trip.currency === 'EUR',
    );
    check('six members on the trip', rt().stores.group.members.listByGroup(G.groupId).length === 6);

    // ---------------- 2. multi-origin flights ----------------
    await section('2. multi-origin flights', '2026-02-03T20:11:00+01:00');
    const flightsReply = await say(
      'Dean',
      "@trav we're 6, flying BOS SFO ORD JFK LAX MIA into BCN thurs mar 12, home tues mar 17 to JFK LAX ORD IAD SEA ATL. find flights that land around the same time",
    );
    const flightsText = flightsReply.map((m) => m.text).join(' | ');
    const optionsMsg = flightsReply.find((m) => m.card?.type === 'options');
    const optionsCard = optionsMsg?.card?.type === 'options' ? optionsMsg.card : undefined;
    check(
      "Trav posts the optimizer's group options in chat (one per-person card, refundable first, nothing booked)",
      optionsCard !== undefined &&
        !flightsText.includes(OFFLINE_FALLBACK) &&
        /^flights for 6 into BCN thu mar 12, home tue mar 17/.test(optionsMsg?.text ?? '') &&
        optionsCard.options.length >= 2 &&
        optionsCard.options[0]!.refundable &&
        optionsCard.options.every((o) => o.details?.length === 6) &&
        /nothing's booked yet/.test(optionsMsg?.text ?? ''),
      flightsText,
    );
    if (optionsCard !== undefined) {
      emit(
        [
          '> option 1, per person (the options card):',
          ...(optionsCard.options[0]!.details ?? []).map((line) => `> - ${line}`),
        ].join('\n'),
      );
    }
    check(
      'no flight is bought by the search',
      rt()
        .stores.group.bookings.listByTrip(TRIP_ID)
        .every((b) => b.kind !== 'flight'),
    );

    await say(
      'Arjun',
      'option 1 looks good, everyone lands within like an hour',
      '2026-02-03T20:15:00+01:00',
    );
    const bookReply = await say('Dean', '@trav book option 1', '2026-02-03T20:16:00+01:00');
    const flightCard = bookReply.find((m) => m.card?.type === 'booking_proposal');
    const flightProposal =
      flightCard?.card?.type === 'booking_proposal'
        ? rt().stores.group.bookings.getProposal(flightCard.card.proposalId)
        : undefined;
    const flightDecision =
      flightProposal === undefined
        ? undefined
        : rt().stores.group.bookings.getDecision(flightProposal.proposalId)?.decision;
    check(
      '"book option 1" proposes those 6 flights through the approval policy: each on their own card, every payer 👍s',
      flightCard !== undefined &&
        flightProposal?.kind === 'flight' &&
        flightProposal.attendees.length === 6 &&
        flightProposal.paidBy.kind === 'per_person_cards' &&
        flightProposal.totalMinor === optionsCard?.options[0]?.price.amountMinor &&
        flightDecision?.approvalMode === 'each_payer' &&
        flightDecision.requiredApprovers.length === 6 &&
        /each pays their own fare/.test(flightCard.text),
      bookReply.map((m) => m.text).join(' | '),
    );
    if (flightCard !== undefined && flightProposal !== undefined) {
      const flightBookings = (): number =>
        rt()
          .stores.group.bookings.listByTrip(TRIP_ID)
          .filter((b) => b.kind === 'flight').length;
      // Flights are on every payer (SAFETY C2/C9): nothing books until the 6th 👍.
      const order = ['Dean', 'Chase', 'Arjun', 'Piotr', 'Crowley', 'Henry'];
      for (const [i, name] of order.entries()) {
        const live = messageById(view(), flightCard.messageId);
        if (live?.cardState?.liveActionIds.includes('approve') !== true) break;
        if (i === order.length - 1) {
          check('five of six 👍s book nothing', flightBookings() === 0);
        }
        await tap(name, live, 'approve');
      }
      const booked = rt()
        .stores.group.bookings.listByTrip(TRIP_ID)
        .filter((b) => b.kind === 'flight');
      const flightReceipt = messages(view().thread).find(
        (m) => m.seq > flightCard.seq && m.card?.type === 'receipt',
      );
      const log = auditLog().filter((e) => e.proposalId === flightProposal.proposalId);
      check(
        'the last 👍 books all 6 through the mock airline once, audited, each on their own card, nothing on the tab',
        booked.length === 1 &&
          booked[0]!.attendees.length === 6 &&
          booked[0]!.totalMinor === flightProposal.totalMinor &&
          booked[0]!.orderRef.split(', ').length === 6 &&
          flightReceipt !== undefined &&
          /booked ✅/.test(flightReceipt.text) &&
          /each on your own card, nothing to split/.test(flightReceipt.text) &&
          log.filter((e) => e.type === 'approval.granted').length === 6 &&
          log.some((e) => e.type === 'policy.evaluated') &&
          log.filter((e) => e.type === 'booking.completed').length === 1 &&
          !log.some((e) => e.type === 'ledger.written') &&
          rt()
            .stores.group.expenses.listByTrip(TRIP_ID)
            .every((x) => x.category !== 'flights'),
        JSON.stringify({ booked: booked.length, receipt: flightReceipt?.text }),
      );
    }

    // ---------------- 3. lodging ----------------
    await section('3. lodging', '2026-02-03T20:31:00+01:00');
    const stayReply = await say(
      'Dean',
      'ok now a place. @trav find a 6 person airbnb in eixample or gracia, under €1500 total, refundable',
    );
    const stayCard = stayReply.find((m) => m.card?.type === 'booking_proposal');
    check(
      'Trav proposed the refundable Eixample stay for all 6 (€1,380, €230 each), passing on the cheaper non-refundable one',
      stayCard !== undefined &&
        /€1,380 for 5 nights · €230 each · free cancel/.test(stayCard.text) &&
        /non-refundable/.test(stayCard.text),
      stayReply.map((m) => m.text).join(' | '),
    );
    if (stayCard) {
      // Lodging is on everyone paying (SAFETY C2): each of the 6 taps.
      for (const name of ['Dean', 'Chase', 'Piotr', 'Arjun', 'Crowley']) {
        const live = messageById(view(), stayCard.messageId);
        if (live?.cardState?.liveActionIds.includes('approve') !== true) break;
        await tap(name, live, 'approve');
      }
      // A relayed approval is never a grant (SAFETY §2.5).
      await say('Piotr', "henry's at practice, i'll approve for him. go ahead trav");
      const stays = (): number =>
        rt()
          .stores.group.bookings.listByTrip(TRIP_ID)
          .filter((b) => b.kind === 'lodging').length;
      check('Piotr\'s "i\'ll approve for him" books nothing', stays() === 0);
      const live = messageById(view(), stayCard.messageId);
      if (live?.cardState?.liveActionIds.includes('approve') === true) {
        await tap('Henry', live, 'approve');
      }
      const receipt = messages(view().thread).find(
        (m) => m.seq > stayCard.seq && m.card?.type === 'receipt',
      );
      const shares = shareAmounts(rt(), expenseWith(rt(), 138000));
      check(
        "Henry's own 👍 books it: one stay, €1,380 on Dean's card, €230 each on the tab",
        stays() === 1 &&
          receipt !== undefined &&
          /booked ✅/.test(receipt.text) &&
          /€1,380/.test(receipt.text) &&
          shares.size === 6 &&
          MEMBER_ORDER.every((id) => shares.get(id) === 23000),
        JSON.stringify([...shares]),
      );
    }

    // ---------------- 4. Barça tickets ----------------
    await section('4. Barça tickets', '2026-02-10T19:30:00+01:00');
    await say('Arjun', 'WE HAVE TO SEE BARÇA. sevilla is at home sunday the 15th');
    const barcaReply = await say(
      'Dean',
      '@trav get the 6 of us barça vs sevilla tickets for sunday mar 15',
    );
    const barcaCard = barcaReply.find((m) => m.card?.type === 'booking_proposal');
    check(
      'Trav proposed 6 Barça tickets (over the €60 cap, so everyone confirms)',
      barcaCard !== undefined && /6 tickets/.test(barcaCard.text),
      barcaReply.map((m) => m.text).join(' | '),
    );
    if (barcaCard) {
      // Over the per-person cap every payer has to tap (at most one tap per member).
      for (const name of ['Dean', 'Henry', 'Chase', 'Piotr', 'Arjun', 'Crowley']) {
        const live = messageById(view(), barcaCard.messageId);
        if (live?.cardState?.liveActionIds.includes('approve') !== true) break;
        await tap(name, live, 'approve');
      }
      const receipt = messages(view().thread).find(
        (m) => m.seq > barcaCard.seq && m.card?.type === 'receipt',
      );
      check('Barça receipt posted in the group', receipt !== undefined);
      const barca = ticketDmsFor(view(), /barcelona vs sevilla/i);
      check(
        'one Barça ticket DM each, all 6',
        barca.size === 6 && MEMBER_ORDER.every((id) => barca.get(id) === 1),
        JSON.stringify([...barca]),
      );
    }

    // ---------------- 5. dinner expense ----------------
    await section('5. dinner expense', '2026-03-12T09:40:00+01:00');
    await say('Chase', 'LANDED 🛬');
    // Consent is per member and opt-in (SAFETY §2.6): Arjun turns on email receipts, Crowley card import.
    await dm('Arjun', 'email receipts on', '2026-03-12T16:07:00+01:00');
    await dm('Crowley', 'card import on');
    const dinner = await say(
      'Piotr',
      '@trav i paid €126 for dinner, everyone',
      '2026-03-12T23:50:00+01:00',
    );
    const e126 = expenseWith(rt(), 12600);
    check(
      '€126 dinner logged on Piotr, 6 ways',
      dinner.length > 0 && sharesOf(rt(), e126).size === 6,
      dinner.map((m) => m.text).join(' | '),
    );

    // Every morning at 10 the scheduler runs that day's Morning After (T-015).
    await clock('2026-03-13T10:00:00+01:00', 'next morning');

    // ---------------- 6. Uber email ----------------
    // The El Born night, as the group thread had it (fixtures/chats/barcelona.jsonl
    // msg_bcn_0094..0102): Henry heads back early, Chase loses the others.
    await section('6. Uber email receipt', '2026-03-13T23:30:00+01:00');
    await say('Crowley', "bar crawl in el born?? who's in");
    await say('Chase', 'me', '2026-03-13T23:31:00+01:00');
    await say('Piotr', 'ya');
    await say('Henry', 'im beat, heading back', '2026-03-13T23:32:00+01:00');
    await say('Arjun', 'in');
    await say('Dean', 'in', '2026-03-13T23:33:00+01:00');
    await say('Chase', 'where r u guys', '2026-03-14T00:40:00+01:00');
    await say('Arjun', 'bar with the green door', '2026-03-14T00:41:00+01:00');
    await at('2026-03-14T09:00:00+01:00');
    emit("- _Arjun's Uber receipt email arrives (mock inbox): €18.60, 4 riders_");
    await backend.intake!('doc_bcn_arjun_email_1');
    const emailPrompt = (flush().dms.get('mem_arjun') ?? []).find(isPendingPrompt);
    check('"looks shared?" prompt goes to Arjun\'s DM only', emailPrompt !== undefined);
    check('the group sees nothing of the email', !JSON.stringify(view().thread).includes('18.60'));
    // T-135 / T-075: "Riders on this trip: 4" with that night's thread is Arjun,
    // Dean, Piotr, Crowley (Henry went back, Chase lost the group), never all 6.
    const promptCard = emailPrompt?.card?.type === 'expense_confirm' ? emailPrompt.card : undefined;
    const proposed = new Set((promptCard?.split.participants ?? []).map((p) => p.memberId));
    check(
      "the card proposes the email's 4 riders: Arjun, Dean, Piotr, Crowley",
      sameSet(proposed, UBER_RIDERS) && /4 riders/.test(emailPrompt?.text ?? ''),
      `${[...proposed].map(nameOf).join(', ')} | ${emailPrompt?.text ?? ''}`,
    );
    if (emailPrompt) await tap('Arjun', emailPrompt, 'confirm');
    const uber = expenseWith(rt(), 1860);
    check("Arjun's €18.60 Uber is on the tab once Arjun shares it", uber !== undefined);
    // T-165: only now, after Arjun's share, the group gets one grey notice line
    // built from the tab entry (never the email: no route, no time, no inbox).
    const uberNotices = notices().filter((m) => m.text.includes('18.60'));
    check(
      'after Arjun\'s share the group gets exactly one notice: "Arjun added Uber €18.60 · 4 ways (not Henry, Chase)"',
      uberNotices.length === 1 &&
        uberNotices[0]!.text === 'Arjun added Uber €18.60 · 4 ways (not Henry, Chase)' &&
        messages(view().thread).filter((m) => m.text.includes('18.60')).length === 1,
      uberNotices.map((m) => m.text).join(' | '),
    );
    const uberShares = shareAmounts(rt(), uber);
    check(
      'the Uber is split among the 4 riders at €4.65 each (Chase and Henry owe nothing)',
      sameSet(new Set(uberShares.keys()), UBER_RIDERS) &&
        [...uberShares.values()].every((v) => v === 465),
      [...uberShares].map(([id, v]) => `${nameOf(id)} ${String(v)}`).join(', '),
    );
    await clock('2026-03-14T10:00:00+01:00', 'next morning');

    // ---------------- 7. Razzmatazz 5-of-6 ----------------
    await section('7. Razzmatazz, 5 of 6', '2026-03-14T20:30:00+01:00');
    await say('Henry', 'yeah im out tonight, sorry guys. have fun');
    const dinner84 = await say(
      'Dean',
      '@trav i paid €84 for dinner, split with everyone but Henry',
      '2026-03-14T21:35:00+01:00',
    );
    check(
      '€84 dinner logged among the 5, not Henry',
      sameSet(sharesOf(rt(), expenseWith(rt(), 8400)), FIVE),
      dinner84.map((m) => m.text).join(' | '),
    );
    const purchasesBefore = countAudit(auditLog(), 'booking.completed');
    const henryDmsBefore = messages(view().dms[HENRY] ?? []).length;
    const ask = await say(
      'Dean',
      "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
      '2026-03-14T21:40:00+01:00',
    );
    const razz = ask.find((m) => m.card?.type === 'booking_proposal');
    const proposal = razz?.card?.type === 'booking_proposal' ? razz.card : undefined;
    check(
      'Trav proposed 5 Razzmatazz tickets for the 5 who are in (the reason Henry is out is never repeated)',
      razz !== undefined &&
        /razzmatazz tonight, 5 tickets/.test(razz.text) &&
        /\(not Henry\)/.test(razz.text) &&
        !/sick/i.test(razz.text),
      ask.map((m) => m.text).join(' | '),
    );
    if (razz) {
      await react('Dean', razz);
      // A second 👍 after the booking never buys twice.
      await react('Chase', razz);
    }
    const receipt = messages(view().thread).find(
      (m) => razz !== undefined && m.seq > razz.seq && m.card?.type === 'receipt',
    );
    check(
      'receipt posted in the group',
      receipt !== undefined && /^booked ✅ razzmatazz, 5 tickets, €90/.test(receipt.text),
      receipt?.text,
    );
    check(
      'exactly one purchase after two 👍',
      countAudit(auditLog(), 'booking.completed') === purchasesBefore + 1,
    );
    const razzTickets = ticketDmsFor(view(), /razzmatazz/i);
    check(
      '5 Razzmatazz ticket DMs, one each for Dean, Chase, Piotr, Arjun, Crowley',
      razzTickets.size === 5 && FIVE.every((id) => razzTickets.get(id) === 1),
      JSON.stringify([...razzTickets]),
    );
    check(
      'Henry got nothing from the booking',
      messages(view().dms[HENRY] ?? []).length === henryDmsBefore,
    );
    check(
      'no ticket card in the group thread',
      messages(view().thread).every((m) => m.card?.type !== 'ticket'),
    );
    const razzExpense = rt()
      .stores.group.expenses.listByTrip(TRIP_ID)
      .find((e) => e.sourceRef?.kind === 'booking' && e.amount.amountMinor === 9000);
    check(
      'ledger: the €90 is split among exactly the 5, Henry not charged',
      razzExpense !== undefined && sameSet(sharesOf(rt(), razzExpense), FIVE),
    );
    check(
      'audit: policy.evaluated → approval.granted → booking.attempted → booking.completed → ledger.written',
      proposal !== undefined &&
        inOrder(
          rt()
            .stores.group.audit.listByProposal(proposal.proposalId)
            .map((e) => e.type),
          [
            'policy.evaluated',
            'approval.granted',
            'booking.attempted',
            'booking.completed',
            'ledger.written',
          ],
        ),
    );

    // At the club (fixtures/chats/barcelona.jsonl msg_bcn_0139): on the tab
    // from chat, so Crowley's card charge for it is never asked about.
    const waters = await say(
      'Crowley',
      '@trav 2 waters in here were €28, €14 EACH, me and chase',
      '2026-03-15T01:30:00+01:00',
    );
    check(
      "Crowley's €28 of waters logged from chat, split with Chase",
      sameSet(sharesOf(rt(), expenseWith(rt(), 2800)), ['mem_crowley', 'mem_chase']),
      waters.map((m) => m.text).join(' | '),
    );

    // ---------------- 8. card confirm ----------------
    await section("8. card import: Crowley's 2am Uber", '2026-03-15T09:00:00+01:00');
    const crowleyRuns = auditLog().filter(
      (e) => e.type === 'card_import.ran' && e.ownerId === 'mem_crowley',
    );
    check(
      "Crowley's card synced on the clock at the 10am/8pm slots since he turned it on (a slot the clock jumped past waits for the next), owner-only in the audit log, nothing to ask yet",
      crowleyRuns.some((e) => e.payload['status'] === 'imported') &&
        crowleyRuns.every(
          (e) =>
            e.visibility === 'owner' &&
            (e.payload['status'] === 'stale' || e.payload['prompted'] === 0),
        ),
      crowleyRuns
        .map((e) => `${String(e.payload['slot'])}:${String(e.payload['status'])}`)
        .join(', '),
    );
    emit("- _Crowley's card syncs (Plaid-shaped mock, simulated clock)_");
    await backend.intake!('doc_bcn_crowley_card_1');
    const crowleyDms = flush().dms.get('mem_crowley') ?? [];
    const cardPrompt = crowleyDms.find(isPendingPrompt);
    check('"looks shared?" prompt goes to Crowley\'s DM only', cardPrompt !== undefined);
    check(
      'the 9am sync asks about the €23.40 Uber only: no later-day charges, not the waters already on the tab',
      crowleyDms.filter(isPendingPrompt).length === 1 &&
        cardPrompt !== undefined &&
        cardPrompt.text.startsWith('saw €23.40 from Uber at 2:14am'),
      cardPrompt?.text,
    );
    check(
      'the group sees nothing of the card charge before Crowley answers',
      !messages(view().thread).some((m) => m.text.includes('23.40')),
    );
    if (cardPrompt) await tap('Crowley', cardPrompt, 'confirm');
    check(
      "Crowley's €23.40 Uber is shared with the 5 who went",
      sameSet(sharesOf(rt(), expenseWith(rt(), 2340)), FIVE),
    );
    // T-165: the share produces one grey notice from the tab entry, nothing from
    // the card itself (no 2:14am, no statement descriptor).
    const cardNotices = messages(view().thread).filter((m) => m.text.includes('23.40'));
    check(
      'after the share the group gets exactly one notice line and no card detail: "Crowley added Uber €23.40 · 5 ways (not Henry)"',
      cardNotices.length === 1 &&
        cardNotices[0]!.systemNotice === true &&
        cardNotices[0]!.text === 'Crowley added Uber €23.40 · 5 ways (not Henry)',
      cardNotices.map((m) => m.text).join(' | '),
    );

    // ---------------- 9. Morning After ----------------
    await section('9. Morning After');
    const crowleyPrompts = (): number =>
      messages(view().dms['mem_crowley'] ?? []).filter(isPendingPrompt).length;
    const promptsBefore = crowleyPrompts();
    const morning = await clock('2026-03-15T10:00:00+01:00', 'next morning');
    check(
      "Crowley's 10am scheduled sync finds nothing new and stays quiet (the Uber was asked once)",
      crowleyPrompts() === promptsBefore &&
        auditLog().some(
          (e) =>
            e.type === 'card_import.ran' &&
            e.ownerId === 'mem_crowley' &&
            e.payload['slot'] === '2026-03-15T10:00:00+01:00',
        ),
    );
    const recap = morning.find((m) => m.card?.type === 'recap');
    check('Morning After recap posted at 10am', recap !== undefined);
    check(
      'recap says the 5 went, "not Henry" as a fact, never why',
      recap !== undefined && recap.text.includes('not Henry') && !/sick/i.test(recap.text),
      recap?.text,
    );

    await clock('2026-03-16T10:00:00+01:00', 'next morning');
    await clock('2026-03-17T10:00:00+01:00', 'last morning');

    // ---------------- 10. settle-up ----------------
    await section('10. settle-up', '2026-03-17T10:30:00+01:00');
    const settleNow = await say('Dean', '@trav settle now');
    const settleReply = settleNow.map((m) => m.text).join('\n');
    const lines = expectedTransfers(rt()).map(
      (t) => `${nameOf(t.from)} → ${nameOf(t.to)} ${formatMoney(t.amount)}`,
    );
    check(
      "Trav's settle-up lists exactly the minimal transfers",
      lines.length > 0 && lines.every((l) => settleReply.includes(l)),
      settleReply,
    );
    // Chase paid Dean outside Trav and says so with a 👍 (T-141): Chase's row is
    // ticked, the rest still owed. No money moves; it is Chase's word, audited.
    const finalCard = settleNow.find((m) => m.card?.type === 'settle_up');
    const chaseRow = expectedTransfers(rt()).find((t) => t.from === 'mem_chase');
    if (finalCard !== undefined && chaseRow !== undefined) {
      const ticked = (await react('Chase', finalCard)).find((m) => m.card?.type === 'settle_up');
      const tcard = ticked?.card?.type === 'settle_up' ? ticked.card : undefined;
      check(
        "Chase's 👍 ticks Chase's transfer paid and leaves the rest owed",
        tcard !== undefined &&
          tcard.transfers
            .filter((t) => t.paid === true)
            .map((t) => t.from)
            .join() === 'mem_chase' &&
          (ticked?.text.includes(
            `${nameOf(chaseRow.from)} → ${nameOf(chaseRow.to)} ${formatMoney(chaseRow.amount)} · paid`,
          ) ??
            false),
        ticked?.text,
      );
      check(
        'marking paid is audited and moves no money',
        auditLog().some(
          (e) => e.type === 'settlement.marked_paid' && e.payload['moneyMoved'] === false,
        ),
      );
    }
    emit(settleUp(rt(), check));

    // ---------------- 11. Wrapped ----------------
    await section('11. trip Wrapped');
    const end = await clock('2026-03-18T10:00:00+01:00', 'end of trip');
    const wrapped = end.find((m) => m.card?.type === 'wrapped');
    const wcard = wrapped?.card?.type === 'wrapped' ? wrapped.card : undefined;
    check('Wrapped card posted the morning after the trip', wcard !== undefined);
    check(
      'Wrapped names the trip and its dates',
      wcard?.trip.name === 'Barcelona spring break' &&
        wcard.trip.startDate === '2026-03-12' &&
        wcard.trip.endDate === '2026-03-17',
    );
    if (wcard !== undefined) {
      emit(formatSettleCard(wcard.finalSettle));
      check(
        "Wrapped's final settle-up matches the ledger",
        sameTransfers(wcard.finalSettle.transfers, expectedTransfers(rt())),
      );
    }
    check(
      "Henry's sick night never shows up in Wrapped",
      wrapped !== undefined && !/sick/i.test(wrapped.text),
    );
    check(
      'every award traces to ledger, booking, attendance or album data',
      (wcard?.awards ?? []).every((a) => BASES.includes(a.basis)),
    );

    // ---------------- the whole trip ----------------
    step = 'whole trip';
    check(
      'no private card ever rendered in the group thread',
      messages(view().thread).every((m) => !isPrivateCard(m.card)),
    );
    // T-165: every expense on the tab reached the group exactly once, either as
    // the group card that logged it (chat "logged:", a booking receipt) or as
    // one grey notice line (the shared email and card items), never both.
    const announcedIn = new Map<string, number>();
    const bump = (id: string): void => {
      announcedIn.set(id, (announcedIn.get(id) ?? 0) + 1);
    };
    for (const m of messages(view().thread)) {
      if (m.card?.type === 'receipt') bump(m.card.ledger.expenseId);
      if (m.card?.type === 'expense_confirm' && m.card.status === 'logged') bump(m.card.expenseId);
    }
    for (const e of auditLog()) {
      if (e.type !== 'message.sent' || e.payload['systemNotice'] !== true) continue;
      const ids = e.payload['expenseIds'];
      if (Array.isArray(ids)) for (const id of ids) bump(String(id));
    }
    const tab = rt().stores.group.expenses.listByTrip(TRIP_ID);
    const unannounced = tab.filter((x) => announcedIn.get(x.expenseId) !== 1);
    check(
      `every expense on the tab reached the group exactly once (${String(tab.length)} expenses, ${String(notices().length)} as notices)`,
      tab.length > 0 && unannounced.length === 0 && notices().length === 2,
      unannounced
        .map((x) => `${x.description} ${String(announcedIn.get(x.expenseId) ?? 0)}x`)
        .join(', '),
    );
    check('no live model call was possible (offline)', rt().model.mode === 'offline');
    const chain = auditChain.verifyAuditChain(auditLog());
    check(
      `audit hash chain verifies (${String(chain.count)} events)`,
      chain.ok,
      JSON.stringify(chain.problems.slice(0, 3)),
    );
  } catch (e) {
    check(
      'the journey ran without throwing',
      false,
      e instanceof Error ? (e.stack ?? e.message) : String(e),
    );
  } finally {
    runtime?.close();
  }

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  return { ok, transcript: renderTranscript(body, checks, ok), checks, notes: DEMO_NOTES };
}

// ---------------- helpers ----------------

function isPrivateCard(card: RichCard | undefined): boolean {
  if (card === undefined) return false;
  if (card.type === 'ticket') return true;
  return card.type === 'expense_confirm' && card.visibility === 'private';
}

function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((x) => a.has(x));
}

function countAudit(events: readonly AuditEvent[], type: string): number {
  return events.filter((e) => e.type === type).length;
}

/** `wanted` appears in `types` as a subsequence, in order. */
export function inOrder(types: readonly string[], wanted: readonly string[]): boolean {
  let i = 0;
  for (const t of types) if (t === wanted[i]) i += 1;
  return i === wanted.length;
}

function expenseWith(rt: TravRuntime, amountMinor: number): { expenseId: string } | undefined {
  return rt.stores.group.expenses
    .listByTrip(TRIP_ID)
    .find((e) => e.amount.amountMinor === amountMinor);
}

/** Each member's owed share of one expense, minor units (from the persisted ledger rows). */
function shareAmounts(
  rt: TravRuntime,
  expense: { expenseId: string } | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  if (expense === undefined) return out;
  for (const e of rt.stores.group.expenses.listEntries(TRIP_ID)) {
    if (e.expenseId !== expense.expenseId || e.kind !== 'owes' || e.amount.amountMinor === 0)
      continue;
    out.set(e.memberId, (out.get(e.memberId) ?? 0) + e.amount.amountMinor);
  }
  return out;
}

/** Who owes a share of one expense (from the persisted ledger rows). */
function sharesOf(rt: TravRuntime, expense: { expenseId: string } | undefined): Set<string> {
  if (expense === undefined) return new Set();
  return new Set(
    rt.stores.group.expenses
      .listEntries(TRIP_ID)
      .filter((e) => e.expenseId === expense.expenseId && e.kind === 'owes')
      .filter((e) => e.amount.amountMinor !== 0)
      .map((e) => e.memberId),
  );
}

function ticketDmsFor(v: GroupView, event: RegExp): Map<MemberId, number> {
  const out = new Map<MemberId, number>();
  for (const id of MEMBER_ORDER) {
    const n = messages(v.dms[id] ?? []).filter(
      (m) => m.card?.type === 'ticket' && event.test(m.text),
    ).length;
    if (n > 0) out.set(id, n);
  }
  return out;
}

// ---------------- settle-up ----------------

function tripBalances(rt: TravRuntime): Balance[] {
  return ledger.computeBalances(rt.stores.group.expenses.listEntries(TRIP_ID), 'EUR', MEMBER_ORDER);
}

function expectedTransfers(rt: TravRuntime): ReturnType<typeof ledger.settle> {
  return ledger.settle(tripBalances(rt));
}

function sameTransfers(a: SettleUpCard['transfers'], b: ReturnType<typeof ledger.settle>): boolean {
  const key = (t: { from: string; to: string; amount: { amountMinor: number } }): string =>
    `${t.from}>${t.to}:${String(t.amount.amountMinor)}`;
  const x = a.map(key).sort();
  const y = b.map(key).sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/** Checks the ledger adds up and the minimal transfers clear it; returns the transcript block. */
function settleUp(
  rt: TravRuntime,
  check: (name: string, ok: boolean, detail?: string) => boolean,
): string {
  const expenses = rt.stores.group.expenses.listByTrip(TRIP_ID);
  const entries = rt.stores.group.expenses.listEntries(TRIP_ID);
  const total = ledger.totalSpent(expenses, 'EUR');
  const paid = entries
    .filter((e) => e.kind === 'paid')
    .reduce((s, e) => s + e.amount.amountMinor, 0);
  const owed = entries
    .filter((e) => e.kind === 'owes')
    .reduce((s, e) => s + e.amount.amountMinor, 0);
  check(
    'ledger adds up: paid = owed = trip total (integer cents)',
    paid === total.amountMinor && Math.abs(owed) === total.amountMinor,
    `paid ${String(paid)} · owed ${String(owed)} · total ${String(total.amountMinor)}`,
  );
  const balances = tripBalances(rt);
  const sum = balances.reduce((s, b) => s + b.net.amountMinor, 0);
  check('balances sum to zero', sum === 0, `sum ${String(sum)}`);
  const transfers = ledger.settle(balances);
  check(
    `at most ${String(MEMBER_ORDER.length - 1)} transfers`,
    transfers.length <= MEMBER_ORDER.length - 1,
  );
  const after = new Map(balances.map((b) => [b.memberId, b.net.amountMinor] as const));
  for (const t of transfers) {
    after.set(t.from, (after.get(t.from) ?? 0) + t.amount.amountMinor);
    after.set(t.to, (after.get(t.to) ?? 0) - t.amount.amountMinor);
  }
  check(
    'everyone is at €0 after the transfers',
    [...after.values()].every((v) => v === 0),
  );
  const lines = [
    `> **settle-up** (\`ledger.settle\` over the trip ledger): ${String(expenses.length)} expenses, ${formatMoney(total)} total`,
    '>',
  ];
  for (const b of balances) {
    const n = b.net.amountMinor;
    const amount = formatMoney(money(Math.abs(n), 'EUR'));
    lines.push(
      `> - ${nameOf(b.memberId)}: ${n > 0 ? `is owed ${amount}` : n < 0 ? `owes ${amount}` : 'square'}`,
    );
  }
  lines.push('>');
  for (const t of transfers) {
    lines.push(`> - ${nameOf(t.from)} → ${nameOf(t.to)} ${formatMoney(t.amount)}`);
  }
  lines.push(`> - after these ${String(transfers.length)} transfers everyone is at €0`);
  return lines.join('\n');
}

function formatSettleCard(card: SettleUpCard): string {
  const lines = [
    `> **Wrapped card, final settle-up** (${String(card.transfers.length)} transfers):`,
    '>',
  ];
  for (const t of card.transfers) {
    lines.push(
      `> - ${nameOf(t.from)} → ${nameOf(t.to)} ${formatMoney(t.amount)}${t.paid === true ? ' · paid' : ''}`,
    );
  }
  return lines.join('\n');
}

// ---------------- transcript ----------------

function renderTranscript(
  body: readonly string[],
  checks: readonly DemoCheck[],
  ok: boolean,
): string {
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok);
  return [
    '# Barcelona flagship demo transcript',
    '',
    'Generated by `pnpm demo:barcelona` (`apps/simulator/src/demo/barcelona.ts`): offline (`TRAV_OFFLINE=1`), no API key, mock providers only, no real money or messages. Regenerate it with the same command.',
    '',
    'Every chat line, tapback and tap below went through the simulator channel into the real Trav runtime (`createTravRuntime`, the same one `pnpm sim` serves); every clock move ran due scheduled jobs through `agent.runScheduled`; the email and card items went through `agent.intakeDocument`.',
    '',
    `Result: **${ok ? 'PASS' : 'FAIL'}**, ${String(passed)}/${String(checks.length)} checks.`,
    '',
    'Steps that did not run entirely through the chat (v0 gaps):',
    '',
    ...DEMO_NOTES.map((n) => `- ${n}`),
    '',
    'Lines marked `🔒 dm` are private DMs between Trav and one member; the group never sees them. Lines in _italics_ are taps, tapbacks, clock moves and mock data arriving.',
    '',
    '## Transcript',
    ...body,
    '',
    '## Checks',
    '',
    ...checks.map((c) => `- [${c.ok ? 'x' : ' '}] ${c.step}: ${c.name}`),
    ...(failed.length > 0 ? ['', `${String(failed.length)} failed.`] : []),
    '',
  ].join('\n');
}

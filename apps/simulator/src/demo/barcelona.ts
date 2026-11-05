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
 * `agent.runScheduled`; card and email documents go through
 * `agent.intakeDocument`. The two planning steps v0 has no booking flow for
 * yet (group flights, lodging) also run the real core optimizer and the mock
 * lodging provider directly and say so in the transcript header.
 *
 * `runBarcelonaDemo()` returns the transcript and the list of checks; it
 * never throws on a failed check (the CLI turns `ok: false` into exit 1).
 */
import type { LodgingSearchResult } from '@trav/adapters';
import { loadMockFlightInventory, toFlightChoice } from '@trav/adapters';
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
import { audit as auditChain, flights, formatMoney, ledger, money, parseIso } from '@trav/core';
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
const FIVE: readonly MemberId[] = ['mem_dean', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'];
const HENRY: MemberId = 'mem_henry';
/** The 4 riders on Priya's Uber email (`fixtures/emails/em_bcn_priya_uber_0314.json`). */
const UBER_RIDERS: readonly MemberId[] = ['mem_priya', 'mem_dean', 'mem_jordan', 'mem_sam'];
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
  "step 2 (flights): v0 has no chat flow that posts group flight options or books flights (`booking/proposals.ts` answers `unsupported_kind` for flights). Trav's chat reply is scripted to say exactly that (it can't line up or book group flights in chat yet) and quotes no optimizer numbers; the step then runs the core multi-origin optimizer (`flights.optimizeGroupFlights`) over the mock flights provider directly, in a labeled block. Nothing is booked.",
  'step 3 (lodging): the real `search_lodging` call; the offline reply text is scripted on its result. No chat flow proposes or books a stay yet, so the step also lists the mock search directly for the check. Nothing is booked.',
  'step 10 (settle-up): Trav answers "@trav settle now" with the transfers, but the settle-up card\'s [Paid] button and its "i\'ll tick you off" line are not wired yet (no mark-paid flow; T-037), so the demo applies the transfers to the balances itself and checks that everyone ends at €0. No money moves.',
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
  const react = async (who: string, target: ThreadMessage, reaction = '👍'): Promise<void> => {
    emit(`- _${who} reacts ${reaction} on trav's ${target.card?.type ?? 'message'}_`);
    await backend.inject({
      type: 'reaction',
      from: handleOf(who),
      targetMessageId: target.messageId,
      reaction,
    });
    flush();
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
    await say('Priya', "ok i'm at my sister's in nyc that week so jfk out, dc back");
    await say('Maya', 'i have to fly out of SF but back to LA, cousins thing on the 18th');
    await say('Sam', 'LA out, seattle back (new internship 🤠)');
    await say('Henry', 'miami out, atlanta back. grandparents');
    await say('Jordan', 'chicago both ways ✈️');
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
    check(
      "Trav answers the flights ask honestly (not the offline fallback): it can't book flights in chat yet",
      flightsReply.length > 0 &&
        !flightsText.includes(OFFLINE_FALLBACK) &&
        /can't line up or book group flights/.test(flightsText) &&
        /nothing's booked/.test(flightsText),
      flightsText,
    );
    const plan = await planFlights(rt());
    emit(plan.text);
    check('the optimizer found one itinerary covering all 6 origins', plan.ok, plan.detail);

    // ---------------- 3. lodging ----------------
    await section('3. lodging', '2026-02-03T20:31:00+01:00');
    await say(
      'Dean',
      'ok now a place. @trav find a 6 person airbnb in eixample or gracia, under €1500 total, refundable',
    );
    const stay = await planLodging(rt());
    emit(stay.text);
    check('a refundable 6-person stay under €1,500 is the first option', stay.ok, stay.detail);

    // ---------------- 4. Barça tickets ----------------
    await section('4. Barça tickets', '2026-02-10T19:30:00+01:00');
    await say('Priya', 'WE HAVE TO SEE BARÇA. sevilla is at home sunday the 15th');
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
      for (const name of ['Dean', 'Henry', 'Maya', 'Jordan', 'Priya', 'Sam']) {
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
    await say('Maya', 'LANDED 🛬');
    // Consent is per member and opt-in (SAFETY §2.6): Priya turns on email receipts, Sam card import.
    await dm('Priya', 'email receipts on', '2026-03-12T16:07:00+01:00');
    await dm('Sam', 'card import on');
    const dinner = await say(
      'Jordan',
      '@trav i paid €126 for dinner, everyone',
      '2026-03-12T23:50:00+01:00',
    );
    const e126 = expenseWith(rt(), 12600);
    check(
      '€126 dinner logged on Jordan, 6 ways',
      dinner.length > 0 && sharesOf(rt(), e126).size === 6,
      dinner.map((m) => m.text).join(' | '),
    );

    // Every morning at 10 the scheduler runs that day's Morning After (T-015).
    await clock('2026-03-13T10:00:00+01:00', 'next morning');

    // ---------------- 6. Uber email ----------------
    // The El Born night, as the group thread had it (fixtures/chats/barcelona.jsonl
    // msg_bcn_0094..0102): Henry heads back early, Maya loses the others.
    await section('6. Uber email receipt', '2026-03-13T23:30:00+01:00');
    await say('Sam', "bar crawl in el born?? who's in");
    await say('Maya', 'me', '2026-03-13T23:31:00+01:00');
    await say('Jordan', 'ya');
    await say('Henry', 'im beat, heading back', '2026-03-13T23:32:00+01:00');
    await say('Priya', 'in');
    await say('Dean', 'in', '2026-03-13T23:33:00+01:00');
    await say('Maya', 'where r u guys', '2026-03-14T00:40:00+01:00');
    await say('Priya', 'bar with the green door', '2026-03-14T00:41:00+01:00');
    await at('2026-03-14T09:00:00+01:00');
    emit("- _Priya's Uber receipt email arrives (mock inbox): €18.60, 4 riders_");
    await backend.intake!('doc_bcn_priya_email_1');
    const emailPrompt = (flush().dms.get('mem_priya') ?? []).find(isPendingPrompt);
    check('"looks shared?" prompt goes to Priya\'s DM only', emailPrompt !== undefined);
    check('the group sees nothing of the email', !JSON.stringify(view().thread).includes('18.60'));
    // T-135 / T-075: "Riders on this trip: 4" with that night's thread is Priya,
    // Dean, Jordan, Sam (Henry went back, Maya lost the group), never all 6.
    const promptCard = emailPrompt?.card?.type === 'expense_confirm' ? emailPrompt.card : undefined;
    const proposed = new Set((promptCard?.split.participants ?? []).map((p) => p.memberId));
    check(
      "the card proposes the email's 4 riders: Priya, Dean, Jordan, Sam",
      sameSet(proposed, UBER_RIDERS) && /4 riders/.test(emailPrompt?.text ?? ''),
      `${[...proposed].map(nameOf).join(', ')} | ${emailPrompt?.text ?? ''}`,
    );
    if (emailPrompt) await tap('Priya', emailPrompt, 'confirm');
    const uber = expenseWith(rt(), 1860);
    check("Priya's €18.60 Uber is on the tab once she shares it", uber !== undefined);
    const uberShares = shareAmounts(rt(), uber);
    check(
      'the Uber is split among the 4 riders at €4.65 each (Maya and Henry owe nothing)',
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
      await react('Maya', razz);
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
      '5 Razzmatazz ticket DMs, one each for Dean, Maya, Jordan, Priya, Sam',
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

    // ---------------- 8. card confirm ----------------
    await section("8. card import: Sam's 2am Uber", '2026-03-15T09:00:00+01:00');
    emit("- _Sam's card syncs (Plaid-shaped mock)_");
    await backend.intake!('doc_bcn_sam_card_1');
    const cardPrompt = (flush().dms.get('mem_sam') ?? []).find(isPendingPrompt);
    check('"looks shared?" prompt goes to Sam\'s DM only', cardPrompt !== undefined);
    if (cardPrompt) await tap('Sam', cardPrompt, 'confirm');
    check(
      "Sam's €23.40 Uber is shared with the 5 who went",
      sameSet(sharesOf(rt(), expenseWith(rt(), 2340)), FIVE),
    );
    check(
      'the group never saw the card charge',
      !messages(view().thread).some((m) => m.text.includes('23.40')),
    );

    // ---------------- 9. Morning After ----------------
    await section('9. Morning After');
    const morning = await clock('2026-03-15T10:00:00+01:00', 'next morning');
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

// ---------------- planning steps without a chat flow (v0) ----------------

interface PlanResult {
  readonly ok: boolean;
  readonly text: string;
  readonly detail?: string;
}

/** Each traveler's offers from the mock flights provider → the core multi-origin optimizer. */
async function planFlights(rt: TravRuntime): Promise<PlanResult> {
  const inv = loadMockFlightInventory('barcelona');
  const members: flights.MemberTravel[] = inv.travelers.map((t) => ({
    memberId: t.memberId,
    origin: t.origin,
    returnTo: t.returnTo,
    ...(t.name !== undefined ? { name: t.name } : {}),
  }));
  const choices: flights.FlightChoice[] = [];
  for (const m of members) {
    const res = await rt.providers.flights.search({
      slices: [
        { origin: m.origin, destination: 'BCN', departureDate: '2026-03-12' },
        { origin: 'BCN', destination: m.returnTo, departureDate: '2026-03-17' },
      ],
      passengers: [{ memberId: m.memberId, type: 'adult' }],
    });
    if (!res.ok) continue;
    for (const offer of res.value) choices.push(toFlightChoice(offer, m.memberId));
  }
  const result = flights.optimizeGroupFlights({
    destination: 'BCN',
    members,
    choices,
    weights: flights.DEFAULT_WEIGHTS,
    constraints: {},
    maxResults: 3,
  });
  const lines = [
    '> **[planner step, no chat flow yet]** `flights.optimizeGroupFlights` over the mock flights provider:',
    `> ${String(choices.length)} round-trip offers from ${String(members.length)} origins`,
    '>',
  ];
  for (const it of result.itineraries) lines.push(`> option ${String(it.rank)}: ${it.rationale}`);
  const best = result.itineraries[0];
  if (best !== undefined) {
    lines.push('>', '> option 1, per person:');
    for (const p of best.picks) {
      const out = p.outbound;
      lines.push(
        `> - ${nameOf(p.memberId)}: ${out.origin}→${out.destination} ${out.flightNumbers.join('/')}, lands ${out.arriveAt.slice(11, 16)}, home to ${p.inbound?.destination ?? '?'} · ${formatMoney(p.price)}`,
      );
    }
  }
  const ok = best !== undefined && result.missing.length === 0 && best.picks.length === 6;
  return {
    ok,
    text: lines.join('\n'),
    ...(ok ? {} : { detail: `missing ${result.missing.join(', ')}` }),
  };
}

/** The mock lodging provider: whole-unit stays for 6, refundable first, then cheapest. */
async function planLodging(rt: TravRuntime): Promise<PlanResult> {
  const res = await rt.providers.lodging.search({
    near: { city: 'Barcelona' },
    checkIn: '2026-03-12',
    checkOut: '2026-03-17',
    adults: 6,
    wholeUnitForGroup: true,
    maxTotal: money(150000, 'EUR'),
  });
  if (!res.ok) return { ok: false, text: '> lodging search failed', detail: res.error.message };
  const rows = res.value
    .flatMap((r: LodgingSearchResult) =>
      r.rates.filter((x) => x.sleeps >= 6).map((rate) => ({ property: r.property, rate })),
    )
    .sort(
      (a, b) =>
        Number(b.rate.refundPolicy.refundable) - Number(a.rate.refundPolicy.refundable) ||
        a.rate.totalAmount.amountMinor - b.rate.totalAmount.amountMinor,
    )
    .slice(0, 3);
  const lines = [
    '> **[planner step, no chat flow yet]** mock lodging search, refundable first, under €1,500:',
    '>',
  ];
  rows.forEach((r, i) => {
    lines.push(
      `> ${String(i + 1)}. ${r.property.name} · ${formatMoney(r.rate.totalAmount)} for 5 nights · sleeps ${String(r.rate.sleeps)} · ${r.rate.refundPolicy.refundable ? 'refundable' : 'non-refundable'}`,
    );
  });
  const first = rows[0];
  const ok =
    first !== undefined &&
    first.rate.refundPolicy.refundable &&
    first.rate.totalAmount.amountMinor <= 150000;
  return { ok, text: lines.join('\n'), ...(ok ? {} : { detail: 'no refundable stay' }) };
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
    lines.push(`> - ${nameOf(t.from)} → ${nameOf(t.to)} ${formatMoney(t.amount)}`);
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

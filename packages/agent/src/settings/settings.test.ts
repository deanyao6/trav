/**
 * T-017 end to end on the real runtime (`createTravAgent` through
 * `runtime.testkit.ts`, production send path in strict voice mode, offline
 * model): settings, roast mode, roast consent, consent flags, roast requests
 * and the rule-made refusals. Nothing here reaches the model.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  Activity,
  Expense,
  Group,
  Member,
  MemberId,
  Money,
  OutboundMessage,
  SimulatedClock,
  Trip,
} from '@trav/core';
import {
  createDeterministicIdGenerator,
  createSimulatedClock,
  defaultConsent,
  isReaction,
  ledger,
  safety,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import {
  createMockEmailReceiptSource,
  createMockTransactions,
  createOfflineReceiptEmailParser,
  createSimulatorChannel,
} from '@trav/adapters';
import { BARCELONA, createTravRuntime } from '../compose.js';
import type { TurnResult } from '../loop.js';
import type { ModelClient } from '../model/client.js';
import { deriveScriptKey } from '../model/offline/scripts.js';
import { repoRoot } from '../model/paths.js';
import { morningAfterJobFor } from '../recaps/morningAfter.js';
import {
  RAZZMATAZZ_ASK,
  harness,
  offlineModel,
  tempStateDir,
  type Harness,
} from '../runtime.testkit.js';
import * as T from './text.js';

const G = BARCELONA.groupId;
const TRIP = BARCELONA.tripId;

function only(r: TurnResult): OutboundMessage {
  const msgs = r.outbound.filter((o): o is OutboundMessage => !isReaction(o));
  expect(msgs).toHaveLength(1);
  return msgs[0]!;
}

function auditOf(h: Pick<Harness, 'audit'>, type: string) {
  return h.audit().filter((e) => e.type === type);
}

function group(h: Harness): Group {
  return h.runtime.stores.group.groups.get(G)!;
}

function consent(h: Harness, memberId: MemberId) {
  return h.runtime.stores.private.getConsent(memberId, G);
}

const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

function onTab(
  h: Harness,
  id: string,
  payer: MemberId,
  amount: Money,
  occurredAt: string,
  description: string,
  category: Expense['category'],
): void {
  const order = BARCELONA.members.map((m) => m.memberId);
  const expense: Expense = {
    expenseId: `exp_${id}`,
    groupId: G,
    tripId: TRIP,
    description,
    category,
    amount,
    paidBy: [{ memberId: payer, amount }],
    split: { method: 'equal', participants: order },
    source: 'chat',
    sourceRef: { kind: 'message', id: `msg_${id}` },
    occurredAt,
    createdAt: occurredAt,
    createdBy: payer,
    status: 'logged',
  };
  h.runtime.stores.group.expenses.create(
    expense,
    ledger.buildLedgerEntries(expense, { memberOrder: order, participantsUniverse: order }),
  );
}

/** Razzmatazz night on the tab: Jordan's 2:07am kebabs, Sam's 2:14am uber. */
function razzNight(h: Harness): void {
  onTab(h, 'kebab', 'mem_jordan', eur(6200), '2026-03-15T02:07:00+01:00', 'late-night kebabs', 'food');
  onTab(h, 'uber', 'mem_sam', eur(2340), '2026-03-15T02:14:00+01:00', 'uber back', 'transport');
}

function optIn(h: Harness, memberId: MemberId): void {
  h.runtime.stores.private.putConsent(memberId, {
    ...defaultConsent(memberId, G, h.clock.now()),
    roast: true,
  });
}

function setRoastMode(h: Harness, on: boolean): void {
  const g = group(h);
  h.runtime.stores.group.groups.update({ ...g, settings: { ...g.settings, roastMode: on } });
}

function voiceClean(msg: OutboundMessage, members: readonly Member[], kind: safety.MessageKind) {
  return safety
    .lintVoice(msg.text, { kind, properNouns: members.map((m) => m.displayName) })
    .violations.map((v) => v.rule);
}

// ---------- @trav settings ----------

describe('@trav settings', () => {
  it('shows roast mode, replies, caps and the trip currency in the group', async () => {
    const h = harness();
    const r = await h.say('h_sam', '@trav settings');
    expect(r.note).toBe('settings:show');
    expect(r.modelSources).toEqual([]);
    expect(only(r).text).toBe(
      [
        'roast mode off · replies normal',
        'per-person cap €60 · daily cap €500 · trip cap off',
        'per-booking max €5,000 · trip currency EUR',
        "to change one: '@trav set the per-person cap to €80'",
      ].join('\n'),
    );
  });

  it("in a DM: that member's own consent flags (all off by default), no one else's", async () => {
    const h = harness();
    const r = await h.dm('h_priya', 'settings');
    const msg = only(r);
    expect(msg.to).toEqual({ kind: 'member', memberId: 'mem_priya' });
    expect(msg.text.split('\n')[0]).toBe(
      'yours: photos off · roasts off · card import off · email import off · memory across trips off',
    );
  });
});

// ---------- roast mode ----------

describe('roast mode (VOICE §7.2, SAFETY §2.8)', () => {
  it('is off by default and only a lead turns it on; the change is audited', async () => {
    const h = harness();
    expect(group(h).settings.roastMode).toBe(false);
    const sam = await h.say('h_sam', '@trav roast mode on');
    expect(only(sam).text).toBe(T.ROAST_LEAD_ONLY_TEXT);
    expect(group(h).settings.roastMode).toBe(false);
    expect(auditOf(h, 'settings.changed')).toEqual([]);

    const dean = await h.say('h_dean', '@trav roast mode on');
    expect(only(dean).text).toBe(T.ROAST_ON_TEXT);
    expect(only(dean).to).toEqual({ kind: 'group' });
    expect(group(h).settings.roastMode).toBe(true);
    expect(auditOf(h, 'settings.changed').map((e) => e.payload)).toEqual([
      expect.objectContaining({ memberId: 'mem_dean', setting: 'roastMode', before: false, after: true }),
    ]);
    expect((await h.say('h_dean', '@trav roast mode on')).note).toBe('settings:roast_on:already');
  });

  it('asks "everyone 18+?" when ages are unknown, and only the lead\'s yes turns it on', async () => {
    const h = harness();
    const g = group(h);
    h.runtime.stores.group.groups.update({ ...g, settings: { ...g.settings, allAdultsConfirmed: false } });
    const sam = h.runtime.stores.group.members.get('mem_sam')!;
    const { birthDate: _b, ...noBirth } = sam;
    h.runtime.stores.group.members.upsert({ ...noBirth, ageBand: 'unknown' });

    const ask = await h.say('h_dean', '@trav roast mode on');
    expect(only(ask).text).toBe(T.ROAST_AGE_QUESTION_TEXT);
    expect(group(h).settings.roastMode).toBe(false);
    // Someone else's "yes" is not the lead's answer.
    await h.say('h_maya', 'yes');
    expect(group(h).settings.roastMode).toBe(false);
    const yes = await h.say('h_dean', 'yes');
    expect(only(yes).text).toBe(T.ROAST_ON_TEXT);
    expect(group(h).settings).toMatchObject({ roastMode: true, allAdultsConfirmed: true });
    expect(auditOf(h, 'settings.changed').map((e) => e.payload['setting'])).toEqual([
      'allAdultsConfirmed',
      'roastMode',
    ]);
  });

  it('"no" to the age question leaves it off', async () => {
    const h = harness();
    const g = group(h);
    h.runtime.stores.group.groups.update({ ...g, settings: { ...g.settings, allAdultsConfirmed: false } });
    const sam = h.runtime.stores.group.members.get('mem_sam')!;
    const { birthDate: _b, ...noBirth } = sam;
    h.runtime.stores.group.members.upsert({ ...noBirth, ageBand: 'unknown' });
    await h.say('h_dean', '@trav roast mode on');
    const no = await h.say('h_dean', 'no');
    expect(only(no).text).toBe(T.ROAST_AGE_DECLINED_TEXT);
    expect(group(h).settings.roastMode).toBe(false);
  });

  it('anyone turns it off, in one word, effective on the very next message', async () => {
    const h = harness();
    razzNight(h);
    h.clock.set('2026-03-15T11:00:00+01:00');
    setRoastMode(h, true);
    optIn(h, 'mem_jordan');
    const off = await h.say('h_maya', '@trav stop roasting');
    expect(only(off).text).toBe('off');
    expect(group(h).settings.roastMode).toBe(false);
    const next = await h.say('h_priya', '@trav roast Jordan for the kebabs');
    expect(only(next).text).toBe(T.REFUSE_MODE_OFF_TEXT);
    expect(only(next).roast).not.toBe(true);
    expect(auditOf(h, 'roast.suppressed').at(-1)?.payload).toMatchObject({ cause: 'mode_off' });
  });

  it('"trav chill" is the off switch only while there is something to turn off', async () => {
    const h = harness();
    const idle = await h.say('h_sam', 'trav, chill');
    expect(idle.note.startsWith('settings:')).toBe(false);
    setRoastMode(h, true);
    expect(only(await h.say('h_sam', 'trav, chill')).text).toBe('off');
    expect(group(h).settings.roastMode).toBe(false);
  });

  it('the kill switch works said to the room while roast mode is on; ordinary chat is untouched', async () => {
    const h = harness();
    setRoastMode(h, true);
    const chat = await h.say('h_sam', 'lol stop roasting him');
    expect(chat.silent).toBe(true);
    expect(group(h).settings.roastMode).toBe(true);
    const kill = await h.say('h_sam', 'stop roasting');
    expect(only(kill).text).toBe('off');
    expect(group(h).settings.roastMode).toBe(false);
  });

  it('a guest cannot touch settings', async () => {
    const h = harness();
    const r = await h.say('h_ava', '@trav roast mode off');
    expect(r.note).toBe('guest:refused');
    expect(auditOf(h, 'settings.changed')).toEqual([]);
  });
});

// ---------- roast consent ----------

describe('roast consent: "roast me" / "stop roasting me" (SAFETY §2.6)', () => {
  it('opting in and out is the member\'s own, audited, and effective on the next message', async () => {
    const h = harness();
    razzNight(h);
    h.clock.set('2026-03-15T11:00:00+01:00');
    await h.say('h_dean', '@trav roast mode on');
    expect(consent(h, 'mem_sam')).toBeUndefined();

    const notYet = await h.say('h_priya', '@trav roast Sam for the ubers');
    expect(only(notYet).text).toBe(T.notOptedInText('Sam'));

    const inR = await h.say('h_sam', '@trav roast me');
    expect(only(inR).text).toBe(T.ROAST_ME_ON_TEXT);
    expect(consent(h, 'mem_sam')?.roast).toBe(true);
    expect(auditOf(h, 'consent.changed').map((e) => [e.payload, e.visibility])).toEqual([
      [{ memberId: 'mem_sam', flag: 'roast', from: false, to: true, via: 'chat' }, 'group'],
    ]);

    const roast = await h.say('h_priya', '@trav roast Sam for the ubers');
    const line = only(roast);
    expect(line.text).toBe('€23.40 ride on Sam at 2:14am. walking is free');
    expect(line.roast).toBe(true);
    expect(auditOf(h, 'roast.generated').map((e) => e.payload)).toEqual([
      { targets: ['mem_sam'], topics: ['rides'], place: 'aside', messageId: line.id },
    ]);

    // "stop roasting me": a 👍 tapback, consent off, and the next ask is refused.
    const out = await h.say('h_sam', 'trav, stop roasting me');
    expect(out.outbound).toHaveLength(1);
    expect(out.outbound[0]).toMatchObject({ kind: 'reaction', emoji: '👍' });
    expect(consent(h, 'mem_sam')?.roast).toBe(false);
    const after = await h.say('h_jordan', '@trav roast Sam for the ubers');
    expect(only(after).text).toBe(T.REFUSE_OPTED_OUT_TEXT);
  });

  it('one roast aside per day', async () => {
    const h = harness();
    razzNight(h);
    h.clock.set('2026-03-15T11:00:00+01:00');
    setRoastMode(h, true);
    optIn(h, 'mem_sam');
    optIn(h, 'mem_jordan');
    expect(only(await h.say('h_priya', '@trav roast Sam for the ubers')).roast).toBe(true);
    const second = await h.say('h_priya', '@trav roast Jordan for the kebabs');
    expect(only(second).text).toBe(T.REFUSE_DAILY_TEXT);
    h.clock.set('2026-03-16T11:00:00+01:00');
    expect(only(await h.say('h_priya', '@trav roast Jordan for the kebabs')).roast).toBe(true);
  });

  it('Morning After drops the roast line the next morning after "stop roasting me" or "stop roasting"', async () => {
    const recapRoast = async (kill?: { from: string; text: string }) => {
      const h = harness();
      // Jordan's 2:07am kebabs are the night's last receipt (the recap's roast candidate).
      onTab(h, 'kebab', 'mem_jordan', eur(6200), '2026-03-15T02:07:00+01:00', 'late-night kebabs', 'food');
      setRoastMode(h, true);
      optIn(h, 'mem_jordan');
      // A second night-out signal (chat after midnight), so the recap is the full one.
      h.clock.set('2026-03-15T00:40:00+01:00');
      await h.say('h_sam', 'where is everyone');
      h.clock.set('2026-03-15T09:00:00+01:00');
      if (kill !== undefined) await h.say(kill.from, kill.text);
      const trip = h.runtime.stores.group.trips.get(TRIP)!;
      const job = morningAfterJobFor(trip, '2026-03-15');
      h.clock.set(job.runAt);
      const r = await h.runtime.agent.runScheduled(job);
      expect(r.note).toBe('scheduled:morning_after:full');
      const recap = r.outbound.find(
        (o): o is OutboundMessage => !isReaction(o) && o.card?.type === 'recap',
      );
      expect(recap).toBeDefined();
      return recap!;
    };
    const control = await recapRoast();
    expect(control.roast).toBe(true);
    expect(control.text).toMatch(/^Jordan paid for .* at 2:07am\. the tab remembers$/mu);

    for (const kill of [
      { from: 'h_jordan', text: '@trav stop roasting me' },
      { from: 'h_maya', text: '@trav stop roasting' },
      { from: 'h_jordan', text: 'trav, leave me out' },
    ]) {
      const recap = await recapRoast(kill);
      expect(recap.roast, kill.text).not.toBe(true);
      expect(recap.text, kill.text).not.toContain('the tab remembers');
    }
  });
});

// ---------- roast requests through the loop ----------

describe('roast requests (VOICE §7.5) through the loop', () => {
  const REFUSALS: readonly [string, string][] = [
    ["@trav roast Maya's outfit", T.REFUSE_BODY_TEXT],
    ['@trav roast Henry for being hungover', T.REFUSE_HANGOVER_TEXT],
    ['@trav roast Sam for going home with that girl', T.REFUSE_PERSONAL_TEXT],
    ["@trav roast the host, she's so annoying", "she's not in the chat, so no"],
    ['@trav roast Jordan for being broke', T.REFUSE_HARDSHIP_TEXT],
  ];
  it.each(REFUSALS)('%s → refused, no emoji, roast.suppressed audited', async (ask, expected) => {
    const h = harness();
    setRoastMode(h, true);
    for (const m of BARCELONA.members) optIn(h, m.memberId);
    const r = await h.say('h_priya', ask);
    const msg = only(r);
    expect(msg.text).toBe(expected);
    expect(msg.roast).not.toBe(true);
    expect(safety.extractEmoji(msg.text)).toEqual([]);
    expect(voiceClean(msg, h.runtime.stores.group.members.listByGroup(G), 'refusal')).toEqual([]);
    expect(auditOf(h, 'roast.suppressed').at(-1)?.payload).toMatchObject({
      cause: 'topic_blocked',
      messageDraftId: msg.id,
      detail: 'request',
    });
    expect(r.modelSources).toEqual([]);
  });
});

// ---------- caps, currency, reply mode ----------

describe('settings edits need the requester\'s yes, then they are audited', () => {
  it('per-person cap: lead asks, Trav confirms, only the lead\'s yes applies it (policy.changed)', async () => {
    const h = harness();
    const ask = await h.say('h_dean', '@trav set the per-person cap to €80');
    expect(only(ask).text).toBe('change the per-person cap from €60 to €80? yes to confirm');
    expect(group(h).spendingPolicy.perPersonAutoCapMinor).toBe(6000);
    // Someone else's "yes" does nothing to Dean's change.
    await h.say('h_sam', 'yes');
    expect(group(h).spendingPolicy.perPersonAutoCapMinor).toBe(6000);
    const yes = await h.say('h_dean', 'yes');
    expect(only(yes).text).toBe('per-person cap is now €80');
    expect(group(h).spendingPolicy.perPersonAutoCapMinor).toBe(8000);
    const changed = auditOf(h, 'policy.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({
      memberId: 'mem_dean',
      setting: 'perPersonAutoCapMinor',
      before: expect.objectContaining({ perPersonAutoCapMinor: 6000 }),
      after: expect.objectContaining({ perPersonAutoCapMinor: 8000 }),
    });
    // A second "yes" has nothing to confirm.
    const again = await h.say('h_dean', 'yes');
    expect(again.note.startsWith('settings:')).toBe(false);
  });

  it('a reply to the question confirms it after the 2-minute window; "no" leaves it', async () => {
    const h = harness();
    const ask = only(await h.say('h_dean', '@trav set the daily cap to 300'));
    h.clock.advanceMs(5 * 60 * 1000);
    const yes = await h.say('h_dean', 'yes', { replyToMessageId: ask.id });
    expect(only(yes).text).toBe('daily cap is now €300');
    const ask2 = only(await h.say('h_dean', '@trav set the trip cap to €2,000'));
    const no = await h.say('h_dean', 'no', { replyToMessageId: ask2.id });
    expect(only(no).text).toBe(T.CONFIRM_DECLINED_TEXT);
    expect(group(h).spendingPolicy.tripGroupCapMinor).toBeNull();
  });

  it('caps are a lead call; a minor or a guest changes nothing', async () => {
    const h = harness();
    expect(only(await h.say('h_sam', '@trav set the per-person cap to €200')).text).toBe(T.LEAD_ONLY_TEXT);
    expect(only(await h.say('h_dean', '@trav set the per-person cap to $80')).text).toBe(
      T.capCurrencyText('EUR'),
    );
    expect(only(await h.say('h_dean', '@trav set the per-person cap to €60')).text).toBe(T.ALREADY_SET_TEXT);
    expect(auditOf(h, 'policy.changed')).toEqual([]);
  });

  it('trip currency: confirmed and audited while the tab is empty, locked once money is on it', async () => {
    const h = harness();
    only(await h.say('h_dean', '@trav set trip currency to USD'));
    const yes = await h.say('h_dean', 'yes');
    expect(only(yes).text).toBe('trip currency is now USD. per-person cap $60');
    expect(h.runtime.stores.group.trips.get(TRIP)!.currency).toBe('USD');
    expect(group(h)).toMatchObject({ currency: 'USD', spendingPolicy: expect.objectContaining({ currency: 'USD' }) });
    expect(auditOf(h, 'settings.changed').map((e) => e.payload)).toEqual([
      expect.objectContaining({ setting: 'tripCurrency', before: 'EUR', after: 'USD' }),
    ]);

    const locked = harness();
    razzNight(locked);
    expect(only(await locked.say('h_dean', '@trav set trip currency to USD')).text).toBe(
      T.currencyLockedText('EUR'),
    );
  });

  it('reply mode: any adult member, confirmed, settings.changed', async () => {
    const h = harness();
    expect(only(await h.say('h_maya', '@trav set reply mode to quiet')).text).toBe(
      'change replies from normal to quiet? yes to confirm',
    );
    await h.say('h_maya', 'yep');
    expect(group(h).settings.quietMode).toBe(true);
    expect(auditOf(h, 'settings.changed').at(-1)?.payload).toMatchObject({
      memberId: 'mem_maya',
      setting: 'quietMode',
      before: false,
      after: true,
    });
  });

  it('a booking proposal asked after the question takes the bare "yes"', async () => {
    const h = harness();
    await h.say('h_dean', '@trav set the per-person cap to €80');
    const proposal = await h.say('h_dean', "@trav get the 5 of us Razzmatazz tickets, Henry's sick");
    expect(proposal.note).toMatch(/^tool:propose_booking:/u);
    const yes = await h.say('h_dean', 'yes');
    expect(yes.note.startsWith('settings:')).toBe(false);
    expect(group(h).spendingPolicy.perPersonAutoCapMinor).toBe(6000);
  });
});

// ---------- consent flags ----------

describe('consent flags (SAFETY §2.6)', () => {
  it('default false; only the owner flips them; every change is consent.changed', async () => {
    const h = harness();
    const r = await h.say('h_maya', '@trav photos on');
    expect(only(r).text).toBe(T.PHOTOS_ON_TEXT);
    expect(consent(h, 'mem_maya')).toMatchObject({ photos: true, roast: false, cardImport: false });
    const other = await h.say('h_jordan', "@trav maya's photos off");
    expect(only(other).text).toBe(T.ownerOnlyText('Maya'));
    expect(consent(h, 'mem_maya')?.photos).toBe(true);
    await h.dm('h_maya', 'memory across trips on');
    await h.dm('h_maya', 'turn on email import');
    const events = auditOf(h, 'consent.changed');
    expect(events.map((e) => [e.payload['flag'], e.payload['to'], e.visibility])).toEqual([
      ['photos', true, 'group'],
      ['memoryAcrossTrips', true, 'owner'],
      ['emailImport', true, 'owner'],
    ]);
    expect(events.every((e) => e.payload['memberId'] === 'mem_maya')).toBe(true);
    expect(events.filter((e) => e.visibility === 'owner').every((e) => e.ownerId === 'mem_maya')).toBe(true);
  });

  it('card import off drops pending "looks shared?" cards at once: off-then-on before a tap shares nothing (T-013 note)', async () => {
    const h = harness();
    h.clock.set('2026-03-17T21:00:00+01:00');
    await h.dm('h_sam', 'turn on card import');
    const imported = await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: 'mem_sam',
      adapter: createMockTransactions(),
    });
    const card = imported.outbound.find(
      (o): o is OutboundMessage => !isReaction(o) && o.card?.type === 'expense_confirm',
    );
    expect(card).toBeDefined();
    const pending = h.runtime.stores.private.listPendingItems('mem_sam', G, 'pending');
    expect(pending.length).toBeGreaterThan(0);

    const off = await h.dm('h_sam', 'card import off');
    expect(only(off).text).toBe(T.droppedPendingText(T.CARD_IMPORT_OFF_TEXT, pending.length));
    expect(h.runtime.stores.private.listPendingItems('mem_sam', G, 'pending')).toEqual([]);
    expect(
      auditOf(h, 'private.item_dismissed').filter((e) => e.payload['cause'] === 'consent_revoked'),
    ).toHaveLength(pending.length);
    expect(h.runtime.stores.private.listCardTransactions('mem_sam', G).every((t) => t.merchantRaw === '')).toBe(
      true,
    );

    await h.dm('h_sam', 'card import on');
    expect(consent(h, 'mem_sam')?.cardImport).toBe(true);
    const tap = await h.tap('h_sam', card!.id, 'confirm');
    expect(tap.note).not.toBe('looks_shared:shared');
    expect(
      h.runtime.stores.group.expenses.listByTrip(TRIP).filter((e) => e.source === 'card_transaction'),
    ).toEqual([]);
  });

  it('email import off drops pending items at once too: off-then-on before a tap shares nothing (T-013 note)', async () => {
    const h = harness();
    h.clock.set('2026-03-14T10:00:00+01:00');
    await h.dm('h_priya', 'turn on email import');
    const imported = await h.runtime.agent.importEmailReceipts({
      groupId: G,
      ownerMemberId: 'mem_priya',
      source: createMockEmailReceiptSource(),
      parser: createOfflineReceiptEmailParser(),
    });
    const card = imported.outbound.find(
      (o): o is OutboundMessage => !isReaction(o) && o.card?.type === 'expense_confirm',
    );
    expect(card).toBeDefined();
    const pending = h.runtime.stores.private.listPendingItems('mem_priya', G, 'pending');
    expect(pending.length).toBeGreaterThan(0);

    const off = await h.dm('h_priya', 'email import off');
    expect(only(off).text).toBe(T.droppedPendingText(T.EMAIL_IMPORT_OFF_TEXT, pending.length));
    expect(h.runtime.stores.private.listPendingItems('mem_priya', G, 'pending')).toEqual([]);

    await h.dm('h_priya', 'email import on');
    expect(consent(h, 'mem_priya')?.emailImport).toBe(true);
    const tap = await h.tap('h_priya', card!.id, 'confirm');
    expect(tap.note).not.toBe('looks_shared:shared');
    expect(
      h.runtime.stores.group.expenses.listByTrip(TRIP).filter((e) => e.source === 'email_receipt'),
    ).toEqual([]);
  });
});

// ---------- refusals ----------

describe('rule-made refusals', () => {
  it("VOICE §4.12 D: another member's card, never the model", async () => {
    const h = harness();
    const r = await h.say('h_jordan', "@trav what did Sam's card get charged last night");
    expect(only(r).text).toBe(
      "that's Sam's, not mine to share. anything Sam confirms as shared shows up on the tab",
    );
    expect(r.modelSources).toEqual([]);
    expect(h.model.completions).toEqual([]);
  });
});

// ---------- Turks and Caicos (family mode) ----------

interface GroupFixture {
  readonly group: Group;
  readonly members: Member[];
  readonly trip: Trip;
  readonly activities: Activity[];
}
const TCI = JSON.parse(
  readFileSync(join(repoRoot(), 'fixtures', 'groups', 'turks-and-caicos.json'), 'utf8'),
) as GroupFixture;

function tci(at = '2026-06-20T15:00:00-04:00', modelFor?: (clock: SimulatedClock) => ModelClient) {
  const clock = createSimulatedClock(at);
  const ids = createDeterministicIdGenerator('tci');
  const stores = createMemoryStores({ clock, ids });
  stores.group.groups.create(TCI.group);
  for (const m of TCI.members) stores.group.members.upsert(m);
  stores.group.trips.create(TCI.trip);
  for (const a of TCI.activities) stores.group.trips.upsertActivity(a);
  const channel = createSimulatorChannel({
    clock,
    conversations: [
      {
        conversationId: TCI.group.conversationId,
        participants: TCI.members.map((m) => ({
          handle: m.senderId,
          displayName: m.displayName,
          memberId: m.memberId,
        })),
      },
    ],
  });
  const runtime = createTravRuntime({
    channel,
    clock,
    ids,
    stores,
    seed: 'none',
    offline: true,
    env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: tempStateDir() },
    voice: 'strict',
    ...(modelFor !== undefined ? { model: modelFor(clock) } : {}),
  });
  return {
    clock,
    runtime,
    async say(from: string, text: string): Promise<TurnResult> {
      return runtime.agent.handleInbound(await channel.injectMessage({ from, text }));
    },
    audit: () => runtime.stores.group.audit.listByGroup(TCI.group.groupId),
    consent: (id: MemberId) => runtime.stores.private.getConsent(id, TCI.group.groupId),
  };
}

describe('family mode (VOICE §8): Turks and Caicos', () => {
  it('roast mode on is refused for every member, lead included, and audited', async () => {
    const w = tci();
    for (const from of ['h_mom', 'h_dad', 'h_dean']) {
      const r = await w.say(from, '@trav roast mode on');
      expect(only(r).text).toBe(T.ROAST_MINOR_TEXT);
      expect(only(r).text).toContain('under 18');
    }
    expect(w.runtime.stores.group.groups.get(TCI.group.groupId)!.settings.roastMode).toBe(false);
    expect(w.audit().filter((e) => e.type === 'roast.suppressed').map((e) => e.payload['cause'])).toEqual([
      'minor_in_group',
      'minor_in_group',
      'minor_in_group',
    ]);
    expect(w.audit().some((e) => e.type === 'settings.changed')).toBe(false);
  });

  it('"roast Lily" is "nope"; Lily cannot opt into roasts or imports', async () => {
    const w = tci('2026-06-22T15:05:00-04:00');
    expect(only(await w.say('h_dean', '@trav roast lily for taking 40 min in the bathroom')).text).toBe('nope');
    expect(only(await w.say('h_lily', '@trav roast me')).text).toBe('nope');
    expect(only(await w.say('h_lily', '@trav card import on')).text).toBe(T.IMPORT_MINOR_TEXT);
    expect(w.consent('mem_tci_lily')).toBeUndefined();
  });

  it("a minor's photos need the guardian: Lily asks, Mom can't, Dad can", async () => {
    const w = tci();
    expect(only(await w.say('h_lily', '@trav photos on for me!!')).text).toBe(
      T.guardianCallText('Dad', 'Lily'),
    );
    expect(only(await w.say('h_mom', "@trav lily's photos on")).text).toBe(
      T.guardianCallText('Dad', 'Lily'),
    );
    expect(w.consent('mem_tci_lily')).toBeUndefined();
    expect(only(await w.say('h_dad', "@trav lily's photos on")).text).toBe(T.minorPhotosText('Lily', true));
    expect(w.consent('mem_tci_lily')?.photos).toBe(true);
    const ev = w.audit().filter((e) => e.type === 'consent.changed');
    expect(ev.map((e) => e.payload)).toEqual([
      { memberId: 'mem_tci_lily', flag: 'photos', from: false, to: true, via: 'guardian', by: 'mem_tci_dad' },
    ]);
    // Lily can always take herself out.
    await w.say('h_lily', '@trav photos off');
    expect(w.consent('mem_tci_lily')?.photos).toBe(false);
  });

  it('VOICE §4.12 C: clubs with Lily get family options and content.suppressed', async () => {
    const w = tci('2026-06-20T20:30:00-04:00');
    const r = await w.say('h_dean', '@trav any good clubs or bars tonight? lily can come lol');
    const msg = only(r);
    expect(msg.text).toContain("i'll keep Lily off that plan");
    expect(safety.isRestrictedText(msg.text)).toBe(false);
    expect(safety.extractEmoji(msg.text)).toEqual([]);
    expect(w.audit().filter((e) => e.type === 'content.suppressed').map((e) => e.payload)).toEqual([
      expect.objectContaining({ cause: 'minor_nightlife', messageDraftId: msg.id }),
    ]);
    expect(r.modelSources).toEqual([]);
  });

  it('the family-mode notice posts once as its own message, and again only after family mode ends and returns', async () => {
    const w = tci();
    const first = await w.runtime.announceFamilyMode(TCI.group.groupId);
    expect(first).toHaveLength(1);
    const notice = first[0] as OutboundMessage;
    expect(notice.to).toEqual({ kind: 'group' });
    expect(notice.text).toBe(
      "family mode is on since Lily's on the trip: all-ages plans only, no roasts, their tickets go to Dad",
    );
    expect(safety.isRestrictedText(notice.text)).toBe(false);
    expect(safety.extractEmoji(notice.text)).toEqual([]);
    const changes = () =>
      w.audit().filter((e) => e.type === 'settings.changed' && e.payload['setting'] === 'familyMode');
    expect(changes().map((e) => [e.actor, e.payload['after'], e.payload['minors']])).toEqual([
      [{ kind: 'trav', id: 'trav' }, true, ['mem_tci_lily']],
    ]);
    // Once: a second call (or a restart reading the same audit) says nothing.
    expect(await w.runtime.announceFamilyMode(TCI.group.groupId)).toEqual([]);
    // Ordinary turns stay one group message each.
    expect(only(await w.say('h_mom', '@trav settings')).text.split('\n')[0]).toContain('family mode on');

    const lily = TCI.members.find((m) => m.memberId === 'mem_tci_lily')!;
    w.runtime.stores.group.members.upsert({ ...lily, active: false });
    expect(await w.runtime.announceFamilyMode(TCI.group.groupId)).toEqual([]);
    expect(changes().map((e) => e.payload['after'])).toEqual([true, false]);
    w.runtime.stores.group.members.upsert({ ...lily, active: true });
    expect(await w.runtime.announceFamilyMode(TCI.group.groupId)).toHaveLength(1);
    expect(changes().map((e) => e.payload['after'])).toEqual([true, false, true]);
  });

  it('settings show family mode on', async () => {
    const w = tci();
    expect(only(await w.say('h_mom', '@trav settings')).text.split('\n')[0]).toBe(
      'roast mode off · replies normal · family mode on',
    );
  });

  it("Dad's \"how much did we spend at the bar?\" gets the tab, not the nightlife intercept", async () => {
    // The model asks the ledger (get_balances); the loop posts the tab as the settle_up card.
    const ledgerModel = (clock: SimulatedClock): ModelClient => {
      const inner = offlineModel(clock);
      return {
        mode: 'offline',
        complete(req) {
          const last = req.messages.at(-1);
          const afterTool = last !== undefined && typeof last.content !== 'string';
          return Promise.resolve({
            text: '',
            toolCalls: afterTool ? [] : [{ id: 'c1', name: 'get_balances', input: {} }],
            usage: { inputTokens: 0, outputTokens: 0 },
            source: 'script',
            scriptKey: deriveScriptKey(req),
          });
        },
        classify: (req) => inner.classify(req),
      };
    };
    const w = tci('2026-06-21T16:00:00-04:00', ledgerModel);
    const r = await w.say('h_dad', '@trav how much did we spend at the bar?');
    expect(r.note).toBe('tool:get_balances:settle_up');
    expect(r.toolCalls).toEqual(['get_balances']);
    expect(only(r).card?.type).toBe('settle_up');
    expect(w.audit().some((e) => e.type === 'content.suppressed')).toBe(false);
  });
});

// ---------- T-017 round 2 ----------

describe('T-017 r2: expenses that name a card are logged, not refused', () => {
  it.each([
    ["@trav split the €200 groceries with everyone, it went on Dean's card", 20000, 'mem_dean'],
    ["@trav i paid €84 for dinner on Jordan's card, split with everyone", 8400, 'mem_jordan'],
  ])('%s', async (text, amountMinor, payer) => {
    const h = harness();
    const r = await h.say('h_sam', text);
    expect(r.note).not.toBe('refusal:private_data');
    const logged = h.runtime.stores.group.expenses.listByTrip(TRIP).filter((e) => e.status === 'logged');
    expect(logged).toHaveLength(1);
    // The card's owner is the payer: their money paid for it.
    expect(logged[0]).toMatchObject({
      amount: { amountMinor, currency: 'EUR' },
      paidBy: [{ memberId: payer }],
    });
    expect(only(r).card?.type).toBe('expense_confirm');
  });

  it('"did sam\'s card go through for the tickets?" reaches the model with the booking in its context', async () => {
    const h = harness();
    const ask = await h.say('h_dean', RAZZMATAZZ_ASK);
    const card = only(ask);
    expect((await h.tap('h_dean', card.id, 'approve')).note).toBe('approval:handled');
    const booking = h.runtime.stores.group.bookings.listByTrip(TRIP)[0]!;
    const before = h.model.completions.length;
    const r = await h.say('h_jordan', "@trav did sam's card go through for the tickets?");
    expect(r.note).not.toBe('refusal:private_data');
    expect(r.outbound.some((o) => !isReaction(o) && o.text.startsWith("that's Sam's"))).toBe(false);
    const req = h.model.completions.at(before);
    expect(req).toBeDefined();
    expect(req!.system).toContain(booking.description);
    expect(req!.system).toContain(booking.status);
  });

  it('a question about what is on the tab with a name is not refused; a reveal ask still is', async () => {
    const h = harness();
    razzNight(h);
    h.clock.set('2026-03-15T11:00:00+01:00');
    const tab = await h.say('h_maya', "@trav what did jordan's card get charged for the late-night kebabs");
    expect(tab.note).not.toBe('refusal:private_data');
    const priv = await h.say('h_maya', "@trav what did jordan's card get charged last night");
    expect(priv.note).toBe('refusal:private_data');
  });
});

describe('T-017 r2: card/email import toggled in the group', () => {
  it('applies the change; the pending count goes to the owner by DM, the group gets a count-free 👍', async () => {
    const h = harness();
    h.clock.set('2026-03-17T21:00:00+01:00');
    await h.dm('h_sam', 'turn on card import');
    await h.runtime.agent.importCardTransactions({
      groupId: G,
      ownerMemberId: 'mem_sam',
      adapter: createMockTransactions(),
    });
    const pending = h.runtime.stores.private.listPendingItems('mem_sam', G, 'pending').length;
    expect(pending).toBeGreaterThan(0);

    const off = await h.say('h_sam', '@trav card import off');
    expect(consent(h, 'mem_sam')?.cardImport).toBe(false);
    expect(h.runtime.stores.private.listPendingItems('mem_sam', G, 'pending')).toEqual([]);
    const toGroup = off.outbound.filter((o) => o.to.kind === 'group');
    expect(toGroup).toHaveLength(1);
    expect(toGroup[0]).toMatchObject({ kind: 'reaction', emoji: '👍' });
    const dms = off.outbound.filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'member');
    expect(dms).toHaveLength(1);
    expect(dms[0]!.to).toEqual({ kind: 'member', memberId: 'mem_sam' });
    expect(dms[0]!.text).toBe(T.droppedPendingText(T.CARD_IMPORT_OFF_TEXT, pending));

    // Turning it on from the group: applied, confirmation by DM too.
    const on = await h.say('h_sam', '@trav email import on');
    expect(consent(h, 'mem_sam')?.emailImport).toBe(true);
    expect(on.outbound.filter((o) => o.to.kind === 'group').every((o) => isReaction(o))).toBe(true);
    expect(
      on.outbound.filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'member').map((o) => o.text),
    ).toEqual([T.EMAIL_IMPORT_ON_TEXT]);
  });
});

describe('T-017 r2: a join that brings in a minor posts the family-mode notice once', () => {
  it('a 14-year-old joins the Barcelona chat: one notice, and none on the next roster change', async () => {
    const h = harness();
    const notices = () =>
      h.audit().filter((e) => e.type === 'settings.changed' && e.payload['setting'] === 'familyMode');
    expect(notices()).toEqual([]);
    // The host adds the member record (with the birth date) as the channel reports the join.
    h.runtime.stores.group.members.upsert({
      memberId: 'mem_kid',
      groupId: G,
      displayName: 'Kai',
      role: 'member',
      active: true,
      senderId: 'h_kai',
      birthDate: '2012-01-10',
      ageBand: 'under18',
      joinedAt: h.clock.now(),
    });
    const join = await h.runtime.agent.handleInbound(
      await h.channel.injectMemberJoined({
        conversationId: BARCELONA.conversationId,
        participant: { handle: 'h_kai', displayName: 'Kai' },
      }),
    );
    const msgs = join.outbound.filter((o): o is OutboundMessage => !isReaction(o));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.to).toEqual({ kind: 'group' });
    expect(msgs[0]!.text).toMatch(/^family mode is on since Kai's on the trip/u);
    expect(notices().map((e) => e.payload['after'])).toEqual([true]);

    // A roster change after that says nothing more about family mode.
    const roster = await h.say('h_dean', "@trav henry's out tonight");
    expect(roster.note).toMatch(/^roster:/u);
    expect(roster.outbound.some((o) => !isReaction(o) && o.text.startsWith('family mode'))).toBe(false);
    const again = await h.runtime.agent.handleInbound(
      await h.channel.injectMemberJoined({
        conversationId: BARCELONA.conversationId,
        participant: { handle: 'h_kai', displayName: 'Kai' },
      }),
    );
    expect(again.outbound).toEqual([]);
    expect(notices()).toHaveLength(1);
  });
});

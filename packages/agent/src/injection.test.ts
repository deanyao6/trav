/**
 * Every `fixtures/injection/inj_*.json` case through the agent (SAFETY §2.4,
 * checklist D1–D4): zero tool calls, zero proposals, exactly one
 * `injection.detected` audit event, and, for documents that carry an amount,
 * a low-confidence "looks shared?" card to the owner only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '@trav/core';
import { isReaction } from '@trav/core';
import { BARCELONA } from './compose.js';
import { LOW_CONFIDENCE_LINE } from './ingest/intake.js';
import { GUEST_REFUSAL_TEXT } from './loop.js';
import { repoRoot } from './model/paths.js';
import { RAZZMATAZZ_ASK, harness, optIn, type Harness } from './runtime.testkit.js';
import { detectInjection, type UntrustedSource } from './untrusted.js';

interface InjectionFixture {
  readonly id: string;
  readonly category: 'injection' | 'adversarial';
  readonly vector: string;
  readonly text: string;
  readonly message?: {
    readonly senderId: string;
    readonly lane: 'group' | 'direct';
    readonly text: string;
  };
  readonly source?: { readonly owner?: string; readonly postedBy?: string };
  readonly pendingProposals?: readonly string[];
  readonly expect: {
    readonly toolCalls?: number;
    readonly proposals?: number;
    readonly audit?: readonly string[];
    readonly invalidAttemptCause?: string;
    readonly action?: string | readonly string[];
    readonly expectedText?: string;
    readonly mustNotContain?: readonly string[];
    readonly extraction?: { readonly totalMinor?: number };
    readonly lowConfidenceCard?: boolean;
    readonly matchedPatterns: readonly string[];
  };
}

interface Index {
  readonly cases: readonly {
    readonly id: string;
    readonly category: string;
    readonly vector: string;
  }[];
  readonly negatives: readonly string[];
}

const dir = join(repoRoot(), 'fixtures', 'injection');
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Index;
const load = (id: string): InjectionFixture =>
  JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as InjectionFixture;
const injections = index.cases.filter((c) => c.category === 'injection').map((c) => load(c.id));

const DOCUMENT_SOURCE: Readonly<Record<string, UntrustedSource>> = {
  receipt_ocr: 'receipt_ocr',
  email_body: 'email_receipt',
  photo_caption: 'photo_caption',
  provider_listing: 'provider_listing',
  host_message: 'host_message',
  card_descriptor: 'card_descriptor',
};
const EXPENSE_SOURCES = new Set<UntrustedSource>([
  'receipt_ocr',
  'email_receipt',
  'card_descriptor',
]);

const chatCases = injections.filter((f) => f.message !== undefined);
const documentCases = injections.filter((f) => f.message === undefined);

function injectionEvents(h: Harness) {
  return h.audit().filter((e) => e.type === 'injection.detected');
}

describe('fixtures/injection coverage', () => {
  it('has at least 10 injected cases, split between chat vectors and document vectors', () => {
    expect(injections.length).toBeGreaterThanOrEqual(10);
    expect(chatCases.length).toBeGreaterThanOrEqual(4);
    expect(documentCases.length).toBeGreaterThanOrEqual(6);
    for (const f of documentCases) expect(DOCUMENT_SOURCE[f.vector], f.id).toBeDefined();
  });

  it('the detector fires the labeled patterns on every case and stays quiet on the negatives', () => {
    for (const f of injections) {
      const hit = detectInjection(f.text).map((m) => m.pattern);
      expect(hit, f.id).toEqual(expect.arrayContaining([...f.expect.matchedPatterns]));
    }
    for (const n of index.negatives) expect(detectInjection(n), n).toEqual([]);
  });
});

describe('chat vectors through handleInbound (guest messages, forwards, pasted cards)', () => {
  for (const f of chatCases) {
    it(`${f.id}: ${f.vector}`, async () => {
      const h = harness();
      let priorProposals = 0;
      if (f.pendingProposals !== undefined) {
        await h.say('h_dean', RAZZMATAZZ_ASK);
        priorProposals = h.pending().length;
        expect(priorProposals).toBe(1);
      }
      const auditBefore = h.auditTypes().length;
      const m = f.message!;
      const turn =
        m.lane === 'direct' ? await h.dm(m.senderId, m.text) : await h.say(m.senderId, m.text);

      expect(turn.toolCalls, 'zero tool calls').toEqual([]);
      expect(h.pending().length - priorProposals, 'zero new proposals').toBe(0);
      expect(h.tickets.purchaseCount()).toBe(0);
      expect(h.model.completions.length, 'no tool-enabled model call for this message').toBe(
        f.pendingProposals === undefined ? 0 : 1,
      );

      const detected = injectionEvents(h);
      expect(detected, 'exactly one injection.detected').toHaveLength(1);
      expect(detected[0]?.payload['patterns']).toEqual(
        expect.arrayContaining([...f.expect.matchedPatterns]),
      );
      expect(String(detected[0]?.payload['excerpt']).length).toBeLessThanOrEqual(200);
      for (const t of f.expect.audit ?? []) expect(h.auditTypes().slice(auditBefore)).toContain(t);
      if (f.expect.invalidAttemptCause !== undefined) {
        const attempt = h.audit().find((e) => e.type === 'approval.invalid_attempt');
        expect(attempt?.payload['cause']).toBe(f.expect.invalidAttemptCause);
      }

      const texts = turn.outbound
        .filter((o): o is OutboundMessage => !isReaction(o))
        .map((o) => o.text);
      expect(texts.length).toBeLessThanOrEqual(1);
      if (f.expect.action === 'refuse')
        expect(texts).toEqual([f.expect.expectedText ?? GUEST_REFUSAL_TEXT]);
      for (const bad of f.expect.mustNotContain ?? [])
        for (const t of texts) expect(t).not.toContain(bad);
      // Whatever Trav says, it never repeats the injected instruction as if a member said it.
      for (const t of texts) expect(t.toLowerCase()).not.toContain('approve all');
    });
  }
});

describe('document vectors through intakeDocument (OCR, email, card descriptor, caption, listing, host)', () => {
  for (const f of documentCases) {
    it(`${f.id}: ${f.vector}`, async () => {
      const h = harness();
      const source = DOCUMENT_SOURCE[f.vector]!;
      const owner = f.source?.owner ?? f.source?.postedBy ?? 'mem_dean';
      const isExpense = EXPENSE_SOURCES.has(source);
      // T-090: card and email documents are only read after the owner opts in.
      if (source === 'card_descriptor' || source === 'email_receipt') {
        const handle = `h_${owner.replace(/^mem_/, '')}`;
        await optIn(h, handle, source === 'card_descriptor' ? 'card' : 'email');
      }
      const result = await h.runtime.agent.intakeDocument({
        groupId: BARCELONA.groupId,
        ownerMemberId: owner,
        source,
        itemId: f.id,
        text: f.text,
        ...(isExpense
          ? {
              extracted: {
                amountMinor: f.expect.extraction?.totalMinor ?? 2300,
                currency: 'EUR',
                merchantDisplay: source === 'email_receipt' ? 'ride' : 'bar tab',
                category: 'other' as const,
              },
            }
          : {}),
      });

      expect(result.toolCalls).toEqual([]);
      expect(h.model.completions, 'no model call at all on intake').toEqual([]);
      expect(h.pending()).toEqual([]);
      expect(h.tickets.purchaseCount()).toBe(0);
      expect(
        h.runtime.stores.group.expenses.listByTrip(BARCELONA.tripId),
        'nothing on the ledger without a confirmation',
      ).toEqual([]);

      expect(result.injectionPatterns).toEqual(
        expect.arrayContaining([...f.expect.matchedPatterns]),
      );
      expect(result.lowConfidence).toBe(true);
      const detected = injectionEvents(h);
      expect(detected).toHaveLength(1);
      expect(detected[0]?.visibility).toBe('owner');
      expect(detected[0]?.ownerId).toBe(owner);
      expect(detected[0]?.payload).toMatchObject({ source, itemId: f.id });
      expect(JSON.stringify(detected[0]?.payload)).not.toMatch(/bodyText|ocrText/);

      if (isExpense) {
        expect(result.pendingItemId).toBeDefined();
        const item = h.runtime.stores.private.getPendingItem(owner, result.pendingItemId!);
        expect(item?.lowConfidence).toBe(true);
        expect(item?.status).toBe('pending');
        expect(
          h.runtime.stores.private.listPendingItems(
            owner === 'mem_dean' ? 'mem_chase' : 'mem_dean',
            BARCELONA.groupId,
          ),
        ).toEqual([]);
        expect(result.outbound).toHaveLength(1);
        const dm = result.outbound[0] as OutboundMessage;
        expect(dm.to).toEqual({ kind: 'member', memberId: owner });
        expect(dm.card?.type).toBe('expense_confirm');
        if (dm.card?.type === 'expense_confirm') {
          expect(dm.card.lowConfidence).toBe(true);
          expect(dm.card.visibility).toBe('private');
        }
        expect(dm.text).toContain(LOW_CONFIDENCE_LINE);
        for (const bad of f.expect.mustNotContain ?? []) expect(dm.text).not.toContain(bad);
        expect(dm.text).not.toContain(f.text.slice(0, 20));
        expect(h.channel.groupTranscript().filter((e) => e.direction === 'outbound')).toEqual([]);
        expect(h.auditTypes()).toContain('private.item_ingested');
      } else {
        expect(result.outbound).toEqual([]);
        expect(result.pendingItemId).toBeUndefined();
      }
    });
  }

  it('a clean document is not flagged, and its card is not low confidence', async () => {
    const h = harness();
    const result = await h.runtime.agent.intakeDocument({
      groupId: BARCELONA.groupId,
      ownerMemberId: 'mem_piotr',
      source: 'receipt_ocr',
      itemId: 'rcpt_clean',
      text: 'TAPAS 24 MESA 7 PATATAS BRAVAS 6.50 CAVA 22.00 TOTAL 84.00',
      extracted: {
        amountMinor: 8400,
        currency: 'EUR',
        merchantDisplay: 'tapas 24',
        category: 'food',
      },
    });
    expect(result.injectionPatterns).toEqual([]);
    expect(result.lowConfidence).toBe(false);
    expect(injectionEvents(h)).toEqual([]);
    expect((result.outbound[0] as OutboundMessage).text).not.toContain(LOW_CONFIDENCE_LINE);
  });

  it('never prompts a minor and refuses an unknown owner', async () => {
    const h = harness();
    const crowley = h.runtime.stores.group.members.get('mem_crowley')!;
    h.runtime.stores.group.members.upsert({
      ...crowley,
      birthDate: '2012-02-01',
      ageBand: 'under18',
    });
    const result = await h.runtime.agent.intakeDocument({
      groupId: BARCELONA.groupId,
      ownerMemberId: 'mem_crowley',
      source: 'email_receipt',
      itemId: 'em_crowley',
      text: 'Your ride: 12.00 EUR',
      extracted: { amountMinor: 1200, currency: 'EUR', merchantDisplay: 'ride' },
    });
    // T-090: a minor can't hold email import, so nothing is kept and nothing is said.
    expect(result.outbound).toEqual([]);
    expect(result.pendingItemId).toBeUndefined();
    expect(h.runtime.stores.private.listPendingItems('mem_crowley', BARCELONA.groupId)).toEqual([]);
    expect(h.audit().at(-1)?.payload).toMatchObject({ cause: 'minor', sourceItemId: 'em_crowley' });
    await expect(
      h.runtime.agent.intakeDocument({
        groupId: BARCELONA.groupId,
        ownerMemberId: 'mem_nobody',
        source: 'receipt_ocr',
        itemId: 'x',
        text: 'x',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

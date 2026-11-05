/**
 * Demo documents for VOICE §9.5 state 4 ("Sam's DM shows the 'looks shared?'
 * uber prompt"): one member's own card charge or email receipt, from the
 * fixtures, fed through `agent.intakeDocument` (SAFETY §2.4 screening, a
 * pending private item in the owner's store, the "looks shared?" DM to the
 * owner only).
 *
 * Simulator-only shortcuts:
 *  - one curated card charge instead of a card sync: the real per-owner sync
 *    + "looks shared" classifier is `agent.importCardTransactions` (T-013,
 *    `ingest/card.ts`), but the mock provider has no notion of the simulated
 *    clock (it returns the whole trip's history at once, future charges
 *    included), so the demo feeds the one charge VOICE §9.5 state 4 shows.
 *    The answer (Share it / Keep private / 👍 / 👎) is the real flow either
 *    way (`ingest/pending.ts`);
 *  - one curated email instead of an inbox import: the real per-owner path
 *    (consent-gated, parser + "looks shared" classifier, flagged emails
 *    under a neutral name) is `agent.importEmailReceipts` (T-012,
 *    `ingest/email.ts`); the demo parses the one fixture email with the
 *    same offline receipt parser and feeds it through the intake path;
 *  - consent (privacy, CLAUDE.md §2): only members who turned the import on
 *    in the Barcelona chat script (`fixtures/chats/barcelona.jsonl`
 *    msg_bcn_d_0005–0008) have documents here. Jordan and Henry never did,
 *    so the simulator never reads their card or email fixtures.
 *
 * The UI payload only ever carries `{ docId, kind }` (no amount, merchant or
 * text). The document text reaches Trav only as untrusted text through the
 * intake path, never the tool loop.
 */
import { createMockEmailReceiptSource, createMockTransactions, createOfflineReceiptEmailParser } from '@trav/adapters';
import type { ProviderTransaction } from '@trav/adapters';
import type { ExpenseCategory, MemberId } from '@trav/core';
import { TravError } from '@trav/core';
import type { DocumentIntake } from '@trav/agent';

export interface DemoDocument {
  readonly docId: string;
  readonly groupId: string;
  readonly ownerMemberId: MemberId;
  readonly kind: 'card' | 'email';
  /** Provider transaction id or email id in the fixtures. */
  readonly sourceItemId: string;
  /** Which consent the owner gave in the chat script (the gate for this document). */
  readonly consent: 'cardImport' | 'emailImport';
}

/**
 * Barcelona: Sam's €23.40 Uber at 2:14am (VOICE §4.5 A, the demo state 4
 * prompt), Dean's groceries charge, Priya's Uber email (§4.5 C) and Maya's
 * Uber email with an injected instruction (SAFETY T6: low confidence).
 */
export const DEMO_DOCUMENTS: readonly DemoDocument[] = [
  {
    docId: 'doc_bcn_sam_card_1',
    groupId: 'grp_barcelona',
    ownerMemberId: 'mem_sam',
    kind: 'card',
    sourceItemId: 'txn_sam_uber_0315',
    consent: 'cardImport',
  },
  {
    docId: 'doc_bcn_dean_card_1',
    groupId: 'grp_barcelona',
    ownerMemberId: 'mem_dean',
    kind: 'card',
    sourceItemId: 'txn_dean_groceries_0313',
    consent: 'cardImport',
  },
  {
    docId: 'doc_bcn_priya_email_1',
    groupId: 'grp_barcelona',
    ownerMemberId: 'mem_priya',
    kind: 'email',
    sourceItemId: 'em_bcn_priya_uber_0314',
    consent: 'emailImport',
  },
  {
    docId: 'doc_bcn_maya_email_1',
    groupId: 'grp_barcelona',
    ownerMemberId: 'mem_maya',
    kind: 'email',
    sourceItemId: 'em_bcn_maya_uber_injection',
    consent: 'emailImport',
  },
];

/** Plaid personal-finance primary category → ledger category (best effort; T-012 owns the real map). */
const CARD_CATEGORY: Readonly<Record<string, ExpenseCategory>> = {
  TRANSPORTATION: 'transport',
  FOOD_AND_DRINK: 'food',
  TRAVEL: 'transport',
  ENTERTAINMENT: 'activities',
};

/** Pages are capped so a broken fixture cursor can never loop forever. */
const MAX_SYNC_PAGES = 50;

async function cardTransaction(doc: DemoDocument): Promise<ProviderTransaction> {
  const tx = createMockTransactions();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SYNC_PAGES; page++) {
    const res = await tx.sync(doc.ownerMemberId, cursor);
    if (!res.ok) throw new TravError('not_found', `card fixture for ${doc.ownerMemberId}: ${res.error.message}`);
    const found = [...res.value.added, ...res.value.modified].find(
      (t) => t.transactionId === doc.sourceItemId,
    );
    if (found !== undefined) return found;
    if (!res.value.hasMore) break;
    cursor = res.value.nextCursor;
  }
  throw new TravError('not_found', `card fixture has no ${doc.sourceItemId}`);
}

/** Builds the `DocumentIntake` for one demo document from its fixture. */
export async function buildIntake(doc: DemoDocument): Promise<DocumentIntake> {
  if (doc.kind === 'card') {
    const t = await cardTransaction(doc);
    if (t.ownerMemberId !== doc.ownerMemberId) {
      throw new TravError('not_owner', `${doc.sourceItemId} belongs to another member`);
    }
    const category = CARD_CATEGORY[t.personalFinanceCategory?.primary ?? ''];
    return {
      groupId: doc.groupId,
      ownerMemberId: doc.ownerMemberId,
      source: 'card_descriptor',
      itemId: t.transactionId,
      text: t.rawName,
      extracted: {
        amountMinor: t.amount.amountMinor,
        currency: t.amount.currency,
        merchantDisplay: t.merchantName ?? t.rawName,
        ...(t.datetime !== undefined ? { occurredAt: t.datetime } : {}),
        ...(category !== undefined ? { category } : {}),
      },
    };
  }
  const source = createMockEmailReceiptSource();
  const list = await source.list(doc.ownerMemberId);
  if (!list.ok) throw new TravError('not_found', `email fixtures for ${doc.ownerMemberId}: ${list.error.message}`);
  const email = list.value.find((e) => e.emailId === doc.sourceItemId);
  if (email === undefined) throw new TravError('not_found', `no email ${doc.sourceItemId} for ${doc.ownerMemberId}`);
  const parsed = await createOfflineReceiptEmailParser().parse(email);
  if (!parsed.ok) throw new TravError('invalid_argument', `${doc.sourceItemId}: ${parsed.error.message}`);
  const p = parsed.value;
  return {
    groupId: doc.groupId,
    ownerMemberId: doc.ownerMemberId,
    source: 'email_receipt',
    itemId: email.emailId,
    text: [email.subject, email.textBody ?? email.htmlBody ?? ''].join('\n'),
    extracted: {
      amountMinor: p.total.amountMinor,
      currency: p.total.currency,
      merchantDisplay: p.merchantName,
      occurredAt: p.occurredAt,
      ...(p.source === 'rideshare' ? { category: 'transport' as const } : {}),
      // Typed ride facts (places, rider count) so the card can split by riders (T-135).
      ...(p.ride !== undefined ? { ride: p.ride } : {}),
    },
  };
}

/** Demo documents of one group, by owner (for `GroupView.intake`). */
export function documentsFor(groupId: string): readonly DemoDocument[] {
  return DEMO_DOCUMENTS.filter((d) => d.groupId === groupId);
}

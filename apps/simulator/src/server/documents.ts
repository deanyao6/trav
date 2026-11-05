/**
 * Demo documents for VOICE §9.5 state 4 ("Sam's DM shows the 'looks shared?'
 * uber prompt"): one member's card syncing now, or one of their email
 * receipts arriving, from the fixtures.
 *
 *  - a card document is "this owner's card syncs now" (T-067): the real
 *    import, `agent.importCardTransactions` without an adapter, i.e. the
 *    runtime's Plaid-shaped mock on the simulated clock from the owner's saved
 *    cursor, the same sync the scheduled `card_import` job runs at 10:00 and
 *    20:00. Only charges that already happened come back (at 9am the morning
 *    after Razzmatazz, Sam's €23.40 Uber), consent off means the provider is
 *    never called, and two or more new prompts wait for the next digest slot
 *    (VOICE §2). `sourceItemId` names the charge the demo expects; the import
 *    reads whatever the card has by now. The answer (Share it / Keep private /
 *    👍 / 👎) is the real flow (`ingest/pending.ts`);
 *  - one curated email instead of an inbox import (simulator-only shortcut):
 *    fed through `agent.intakeDocument` (SAFETY §2.4 screening, a pending
 *    private item in the owner's store, the "looks shared?" DM to the owner
 *    only). The real per-owner path
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
import { createMockEmailReceiptSource, createOfflineReceiptEmailParser } from '@trav/adapters';
import type { IsoDateTime, MemberId } from '@trav/core';
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
  /**
   * Card syncs (T-067): the rail offers it only once the charge it stands for
   * has happened (`sourceItemId`'s time in the fixture), since a sync before
   * then finds nothing.
   */
  readonly availableAt?: IsoDateTime;
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
    availableAt: '2026-03-15T02:14:00+01:00',
  },
  {
    docId: 'doc_bcn_dean_card_1',
    groupId: 'grp_barcelona',
    ownerMemberId: 'mem_dean',
    kind: 'card',
    sourceItemId: 'txn_dean_groceries_0313',
    consent: 'cardImport',
    availableAt: '2026-03-13T11:40:00+01:00',
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

/**
 * Builds the `DocumentIntake` for one demo email from its fixture. Card
 * documents never come through here: they run the real card import (header).
 */
export async function buildIntake(doc: DemoDocument): Promise<DocumentIntake> {
  if (doc.kind === 'card') {
    throw new TravError(
      'invalid_argument',
      `${doc.docId} is a card sync: it runs agent.importCardTransactions, not the document intake`,
    );
  }
  const source = createMockEmailReceiptSource();
  const list = await source.list(doc.ownerMemberId);
  if (!list.ok)
    throw new TravError(
      'not_found',
      `email fixtures for ${doc.ownerMemberId}: ${list.error.message}`,
    );
  const email = list.value.find((e) => e.emailId === doc.sourceItemId);
  if (email === undefined)
    throw new TravError('not_found', `no email ${doc.sourceItemId} for ${doc.ownerMemberId}`);
  const parsed = await createOfflineReceiptEmailParser().parse(email);
  if (!parsed.ok)
    throw new TravError('invalid_argument', `${doc.sourceItemId}: ${parsed.error.message}`);
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

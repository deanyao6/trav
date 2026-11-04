/**
 * Untrusted-document intake (SAFETY §2.4). Receipt OCR, email bodies, card
 * descriptors, provider listings, host messages and photo captions are data,
 * never instructions, and they never enter the tool loop. This module is the
 * one place that screens such text before anything else sees it:
 *
 *  1. `detectInjection` ⇒ one `injection.detected` audit event (owner-visible
 *     when the document has an owner) with the pattern names and a ≤200-char excerpt.
 *  2. `wrapUntrusted` ⇒ the block a zero-tool extraction call may receive.
 *  3. If the caller already extracted amounts (T-011 OCR, T-029 email parser,
 *     T-012 card import), they become a `PendingPrivateItem` in the OWNER's
 *     private store, flagged `lowConfidence` whenever a pattern fired, and a
 *     "looks shared?" DM (VOICE §4.5) is drafted for the owner only. The item
 *     reaches the ledger only after the owner confirms (`promote`), never here.
 *
 * No model call happens in this module; the loop sends the drafts.
 */
import type {
  AuditEventId,
  Clock,
  ExpenseCategory,
  Group,
  GroupId,
  IdGenerator,
  IsoDateTime,
  LineItem,
  Member,
  MemberId,
  OutboundMessage,
  PendingPrivateItem,
  Stores,
  Trip,
} from '@trav/core';
import { markPrivate, safety, TravError } from '@trav/core';
import { renderLooksShared } from '../render/expenseConfirm.js';
import { sanitizeInline } from '../context/groupContext.js';
import { sharePlan } from './pending.js';
import {
  detectInjection,
  stripInvisible,
  wrapUntrusted,
  type InjectionMatch,
  type UntrustedSource,
} from '../untrusted.js';

/** Amounts a document extractor produced (already typed; never the raw text). */
export interface ExtractedAmounts {
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchantDisplay: string;
  readonly occurredAt?: IsoDateTime;
  readonly category?: ExpenseCategory;
  readonly lineItems?: readonly LineItem[];
}

export interface DocumentIntake {
  readonly groupId: GroupId;
  /** The member whose document this is (receipt poster, email owner, card owner). */
  readonly ownerMemberId: MemberId;
  readonly source: UntrustedSource;
  /** Provider / fixture item id; goes into the audit payload, never the text. */
  readonly itemId: string;
  /** Raw document text (OCR, body, descriptor, caption, listing, host message). */
  readonly text: string;
  readonly extracted?: ExtractedAmounts;
}

export interface DocumentIntakeDeps {
  readonly stores: Stores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
}

export interface DocumentIntakeOutcome {
  readonly matches: readonly InjectionMatch[];
  readonly lowConfidence: boolean;
  /** `<untrusted source id>` block for a zero-tool extraction call. */
  readonly wrapped: string;
  readonly auditEventIds: readonly AuditEventId[];
  readonly pendingItemId?: string;
  /** At most one DM to the owner; nothing for the group lane. */
  readonly drafts: readonly OutboundMessage[];
}

/** VOICE §4.5 + SAFETY §2.4: the line the confirm card carries when a pattern fired. */
export const LOW_CONFIDENCE_LINE = 'double-check the amount before you 👍';

type PendingSource = PendingPrivateItem['source'];

/** Which documents are expenses a member might share; the rest are screened only. */
const PENDING_SOURCE: Readonly<Partial<Record<UntrustedSource, PendingSource>>> = {
  receipt_ocr: 'receipt',
  email_receipt: 'email',
  card_descriptor: 'card',
};

const INGESTED_SOURCE: Readonly<Record<PendingSource, 'card' | 'email' | 'photo_receipt'>> = {
  card: 'card',
  email: 'email',
  receipt: 'photo_receipt',
};

function excerpt(text: string): string {
  const flat = stripInvisible(text).replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? flat.slice(0, 200) : flat;
}

export function intakeDocument(
  input: DocumentIntake,
  deps: DocumentIntakeDeps,
): DocumentIntakeOutcome {
  const { stores, group, members, trip } = deps;
  const now = deps.clock.now();
  const owner = members.find((m) => m.memberId === input.ownerMemberId);
  if (owner === undefined) {
    throw new TravError(
      'not_found',
      `member ${input.ownerMemberId} is not in group ${group.groupId}`,
    );
  }
  const auditIds: AuditEventId[] = [];
  const matches = detectInjection(input.text);
  if (matches.length > 0) {
    auditIds.push(
      stores.group.audit.append({
        groupId: group.groupId,
        tripId: trip?.tripId ?? null,
        type: 'injection.detected',
        actor: { kind: 'system', id: 'trav' },
        visibility: 'owner',
        ownerId: owner.memberId,
        payload: {
          source: input.source,
          itemId: input.itemId,
          matchedPattern: matches[0]!.pattern,
          patterns: matches.map((m) => m.pattern),
          excerpt: excerpt(matches[0]!.excerpt),
        },
      }).id,
    );
  }
  const lowConfidence = matches.length > 0;
  const wrapped = wrapUntrusted(input.text, input.source, input.itemId);

  const pendingSource = PENDING_SOURCE[input.source];
  if (input.extracted === undefined || pendingSource === undefined) {
    return { matches, lowConfidence, wrapped, auditEventIds: auditIds, drafts: [] };
  }
  if (!Number.isSafeInteger(input.extracted.amountMinor) || input.extracted.amountMinor <= 0) {
    throw new TravError('invalid_argument', 'extracted amountMinor must be a positive integer');
  }
  // VOICE §6.1: a minor never gets a "looks shared?" prompt; the item is still kept for a guardian flow.
  const promptable = !safety.isMinor(owner, now);
  const occurredAt = input.extracted.occurredAt ?? now;
  const category = input.extracted.category ?? 'other';
  // T-013: the same split rule the card flow uses (the plan's roster, else everyone), so the
  // DM says who it would be split with and the owner's 👍 shares exactly that.
  const plan = sharePlan({
    trips: stores.group.trips,
    trip,
    members,
    ownerMemberId: owner.memberId,
    occurredAt,
    category,
  });
  const drafted: PendingPrivateItem = markPrivate({
    id: deps.ids.next('priv'),
    ownerMemberId: owner.memberId,
    groupId: group.groupId,
    tripId: trip?.tripId ?? null,
    createdAt: now,
    source: pendingSource,
    sourceItemId: input.itemId,
    status: 'pending' as const,
    amount: { amountMinor: input.extracted.amountMinor, currency: input.extracted.currency },
    occurredAt,
    merchantDisplay: sanitizeInline(input.extracted.merchantDisplay, 60),
    category,
    ...(input.extracted.lineItems !== undefined ? { lineItems: input.extracted.lineItems } : {}),
    lowConfidence,
    suggestedParticipants: plan.participants,
    ...(plan.activityId !== undefined ? { suggestedActivityId: plan.activityId } : {}),
  });
  const dm = promptable
    ? renderLooksShared(
        {
          ownerMemberId: owner.memberId,
          items: [
            {
              item: drafted,
              ...(plan.guess !== undefined ? { guess: plan.guess } : {}),
              ...(plan.label !== undefined ? { splitWithLabel: plan.label } : {}),
            },
          ],
        },
        { groupId: group.groupId, members, timeZone: trip?.timeZone ?? 'UTC', now, ids: deps.ids },
      )
    : undefined;
  // The card the owner answers on (`ingest/pending.ts` finds the item by it).
  const item: PendingPrivateItem =
    dm === undefined ? drafted : markPrivate({ ...drafted, cardMessageId: dm.id });
  stores.private.putPendingItem(owner.memberId, item);
  auditIds.push(
    stores.group.audit.append({
      groupId: group.groupId,
      tripId: trip?.tripId ?? null,
      type: 'private.item_ingested',
      actor: { kind: 'system', id: 'trav' },
      visibility: 'owner',
      ownerId: owner.memberId,
      payload: {
        source: INGESTED_SOURCE[pendingSource],
        itemId: item.id,
        sourceItemId: input.itemId,
        amountMinor: item.amount.amountMinor,
        currency: item.amount.currency,
        lowConfidence,
        injectionDetected: matches.length > 0,
      },
    }).id,
  );
  if (dm === undefined) {
    return {
      matches,
      lowConfidence,
      wrapped,
      auditEventIds: auditIds,
      pendingItemId: item.id,
      drafts: [],
    };
  }
  return {
    matches,
    lowConfidence,
    wrapped,
    auditEventIds: auditIds,
    pendingItemId: item.id,
    drafts: [dm],
  };
}

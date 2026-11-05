/**
 * PrivateStore, written once against `Backend` (T-005; SAFETY §2.3, C3, D-007).
 *
 * Rules enforced here for both backends:
 * - every method takes `ownerMemberId` first; reads are scoped by it, so another
 *   owner's row reads as `undefined` / is absent from lists;
 * - a write whose row names a different owner throws `not_owner`, and so does a
 *   write that would overwrite another owner's row with the same id;
 * - there is no cross-owner method, not even a count (T-112, SAFETY §2.3).
 */
import { parseIso } from '../../clock.js';
import type { MemberId, PrivateItemId } from '../../primitives.js';
import type { PrivateStore } from '../../repositories.js';
import type {
  CardTransaction,
  EmailReceipt,
  PendingPrivateItem,
  ReceiptScan,
} from '../../privacy.js';
import { markPrivate } from '../../privacy.js';
import { TravError } from '../../errors.js';
import type { Backend, PrivateTableName, RowTable } from './backend.js';
import { PRIVATE_TABLES } from './backend.js';
import {
  cardTransactionsSpec,
  consentSpec,
  emailReceiptsSpec,
  memberMemorySpec,
  memberPrefsSpec,
  pendingItemsSpec,
  receiptScansSpec,
  ticketArtifactsSpec,
} from './schema.js';
import { requireId } from './util.js';

function notOwner(table: string, ownerMemberId: string, itemId: string): TravError {
  // Ids only, never contents (SAFETY §2.9 logging rules).
  return new TravError('not_owner', 'row does not belong to this owner', {
    table,
    ownerMemberId,
    itemId,
  });
}

/** Read one row by key, returning it only if `ownerOf(row) === owner`. */
function scopedGet<T>(
  table: RowTable<T>,
  owner: string,
  key: string,
  ownerOf: (row: T) => string,
): T | undefined {
  const row = table.get(key);
  return row !== undefined && ownerOf(row) === owner ? row : undefined;
}

/** Upsert a row the caller claims belongs to `owner`; refuses to cross owners. */
function scopedPut<T>(
  table: RowTable<T>,
  tableName: string,
  owner: string,
  row: T,
  key: string,
  ownerOf: (row: T) => string,
): void {
  requireId(key, `${tableName} key`);
  if (ownerOf(row) !== owner) throw notOwner(tableName, owner, key);
  const existing = table.get(key);
  if (existing !== undefined && ownerOf(existing) !== owner) throw notOwner(tableName, owner, key);
  table.upsert(row);
}

export function createPrivateStore(backend: Backend): PrivateStore {
  const cards = backend.table(cardTransactionsSpec);
  const emails = backend.table(emailReceiptsSpec);
  const scans = backend.table(receiptScansSpec);
  const pending = backend.table(pendingItemsSpec);
  const consent = backend.table(consentSpec);
  const prefs = backend.table(memberPrefsSpec);
  const memory = backend.table(memberMemorySpec);
  const tickets = backend.table(ticketArtifactsSpec);

  const tablesByName: Readonly<Record<PrivateTableName, RowTable<unknown>>> = {
    card_transactions: cards,
    email_receipts: emails,
    receipt_scans: scans,
    pending_private_items: pending,
    consent,
    member_prefs: prefs,
    member_memory: memory,
    ticket_artifacts: tickets,
  };

  const owner = (ownerMemberId: MemberId): string => requireId(ownerMemberId, 'ownerMemberId');

  /** Owner of the row a pending item points at, or undefined if that row does not exist (yet). */
  const sourceRowOwner = (item: PendingPrivateItem): string | undefined => {
    const table = item.source === 'card' ? cards : item.source === 'email' ? emails : scans;
    return table.get(item.sourceItemId)?.ownerMemberId;
  };

  /** Blank raw inputs on one source row; returns true if anything changed. */
  const purgeSource = (o: string, item: PendingPrivateItem, beforeMs: number): boolean => {
    const id: PrivateItemId = item.sourceItemId;
    if (item.source === 'card') {
      const tx = scopedGet(cards, o, id, (r) => r.ownerMemberId);
      if (tx === undefined || parseIso(tx.createdAt) >= beforeMs || tx.merchantRaw === '') {
        return false;
      }
      cards.upsert(markPrivate({ ...tx, merchantRaw: '' }) as CardTransaction);
      return true;
    }
    if (item.source === 'email') {
      const email = scopedGet(emails, o, id, (r) => r.ownerMemberId);
      if (email === undefined || parseIso(email.createdAt) >= beforeMs) return false;
      if (email.bodyText === '' && email.subject === '') return false;
      emails.upsert(markPrivate({ ...email, bodyText: '', subject: '' }) as EmailReceipt);
      return true;
    }
    const scan = scopedGet(scans, o, id, (r) => r.ownerMemberId);
    if (scan === undefined || parseIso(scan.createdAt) >= beforeMs) return false;
    if (scan.ocrText === '' && scan.imageRef === '') return false;
    scans.upsert(markPrivate({ ...scan, ocrText: '', imageRef: '' }) as ReceiptScan);
    return true;
  };

  return {
    // ---------- raw ingested items ----------
    putCardTransaction(ownerMemberId, tx) {
      const o = owner(ownerMemberId);
      backend.transaction(() => {
        const sameProviderId = cards.find({
          owner_member_id: o,
          provider_transaction_id: tx.providerTransactionId,
        })[0];
        if (sameProviderId !== undefined && sameProviderId.id !== tx.id) {
          throw new TravError('duplicate', 'card transaction already stored under another id', {
            ownerMemberId: o,
            itemId: tx.id,
            existingItemId: sameProviderId.id,
          });
        }
        scopedPut(cards, 'card_transactions', o, tx, tx.id, (r) => r.ownerMemberId);
      });
    },
    getCardTransaction: (ownerMemberId, id) =>
      scopedGet(cards, owner(ownerMemberId), id, (r) => r.ownerMemberId),
    getCardTransactionByProviderId: (ownerMemberId, providerTransactionId) =>
      cards.find({
        owner_member_id: owner(ownerMemberId),
        provider_transaction_id: providerTransactionId,
      })[0],
    listCardTransactions: (ownerMemberId, groupId) =>
      cards.find({ owner_member_id: owner(ownerMemberId), group_id: groupId }),

    putEmailReceipt(ownerMemberId, email) {
      scopedPut(
        emails,
        'email_receipts',
        owner(ownerMemberId),
        email,
        email.id,
        (r) => r.ownerMemberId,
      );
    },
    getEmailReceipt: (ownerMemberId, id) =>
      scopedGet(emails, owner(ownerMemberId), id, (r) => r.ownerMemberId),
    listEmailReceipts: (ownerMemberId, groupId) =>
      emails.find({ owner_member_id: owner(ownerMemberId), group_id: groupId }),

    putReceiptScan(ownerMemberId, scan) {
      scopedPut(
        scans,
        'receipt_scans',
        owner(ownerMemberId),
        scan,
        scan.id,
        (r) => r.ownerMemberId,
      );
    },
    getReceiptScan: (ownerMemberId, id) =>
      scopedGet(scans, owner(ownerMemberId), id, (r) => r.ownerMemberId),

    // ---------- "looks shared?" queue ----------
    putPendingItem(ownerMemberId, item) {
      const o = owner(ownerMemberId);
      // A pending item may only point at a source row of the same owner.
      const sourceOwner = sourceRowOwner(item);
      if (sourceOwner !== undefined && sourceOwner !== o) {
        throw notOwner('pending_private_items', o, item.id);
      }
      scopedPut(pending, 'pending_private_items', o, item, item.id, (r) => r.ownerMemberId);
    },
    getPendingItem: (ownerMemberId, id) =>
      scopedGet(pending, owner(ownerMemberId), id, (r) => r.ownerMemberId),
    listPendingItems(ownerMemberId, groupId, status) {
      const o = owner(ownerMemberId);
      return status === undefined
        ? pending.find({ owner_member_id: o, group_id: groupId })
        : pending.find({ owner_member_id: o, group_id: groupId, status });
    },

    // ---------- consent, prefs, memory ----------
    getConsent(ownerMemberId, groupId) {
      // The composite key is ambiguous when an id contains `|`, so the row's own
      // memberId/groupId are the authority, not the key.
      const o = owner(ownerMemberId);
      const row = scopedGet(consent, o, `${o}|${groupId}`, (r) => r.memberId);
      return row !== undefined && row.groupId === groupId ? row : undefined;
    },
    putConsent(ownerMemberId, flags) {
      const o = owner(ownerMemberId);
      requireId(flags.groupId, 'groupId');
      scopedPut(
        consent,
        'consent',
        o,
        flags,
        `${flags.memberId}|${flags.groupId}`,
        (r) => r.memberId,
      );
    },
    getPrefs: (ownerMemberId) => prefs.get(owner(ownerMemberId)),
    putPrefs(ownerMemberId, p) {
      scopedPut(prefs, 'member_prefs', owner(ownerMemberId), p, p.memberId, (r) => r.memberId);
    },
    putMemberMemory(ownerMemberId, fact) {
      scopedPut(
        memory,
        'member_memory',
        owner(ownerMemberId),
        fact,
        fact.factId,
        (r) => r.ownerMemberId,
      );
    },
    listMemberMemory: (ownerMemberId, groupId) =>
      memory.find({ owner_member_id: owner(ownerMemberId), group_id: groupId }),

    // ---------- tickets ----------
    putTicket(ownerMemberId, ticket) {
      scopedPut(
        tickets,
        'ticket_artifacts',
        owner(ownerMemberId),
        ticket,
        ticket.id,
        (r) => r.ownerMemberId,
      );
    },
    listTickets: (ownerMemberId, bookingId) =>
      tickets.find({ owner_member_id: owner(ownerMemberId), booking_id: bookingId }),

    // ---------- retention (SAFETY §2.9) ----------
    deletePartition(ownerMemberId) {
      const o = owner(ownerMemberId);
      return backend.transaction(() => {
        const counts: Record<string, number> = {};
        for (const name of PRIVATE_TABLES) {
          counts[name] = tablesByName[name].deleteWhere({ owner_member_id: o });
        }
        return counts;
      });
    },
    purgeRawInputs(ownerMemberId, before) {
      const o = owner(ownerMemberId);
      const beforeMs = parseIso(before);
      return backend.transaction(() => {
        let purged = 0;
        for (const item of pending.find({ owner_member_id: o })) {
          // Anything no longer awaiting the owner's decision (SAFETY §2.9).
          if (item.status === 'pending') continue;
          if (purgeSource(o, item, beforeMs)) purged += 1;
        }
        return purged;
      });
    },
  };
}

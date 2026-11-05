/**
 * Receipt photo → line items → "who had what?" → itemized split (T-011;
 * VOICE §4.4 C, §4.10 D, §4.11; SAFETY §2.4).
 *
 * A member posts a photo addressed to Trav ("@trav [photo] dinner, i paid,
 * Priya didn't drink"). In order:
 *
 *  1. The image is read from an allowed local root only (no network, size and
 *     type checked against the file's magic bytes).
 *  2. `receipt_ocr_v1`: one zero-tool vision call transcribes it. The image is
 *     a document; whatever it says is text to be screened, never obeyed.
 *  3. `receipt_extract_v1`: one zero-tool JSON call over the transcription
 *     wrapped as `<untrusted source="receipt_ocr">` (M-08). Offline, both
 *     calls answer from `fixtures/receipts/*.json` by image hash.
 *  4. The transcription is screened (`intake.ts`): a pattern ⇒ one
 *     `injection.detected` audit event, owner-visible to the poster. It is
 *     stored only in the poster's private store (`ReceiptScan`).
 *  5. `checkReceipt`: lines must add up to the printed total and every amount
 *     used must be printed on the receipt; anything off (or an injection, or a
 *     low model confidence) makes the card low-confidence.
 *  6. The caption's own words ("i paid", "Priya didn't drink", "Sam's paying
 *     his own") set the payer and the claims (`receiptClaims.ts`); the table is
 *     the plan's roster at that time, else everyone.
 *  7. ONE group card (`render/receiptRead.ts`) shows the total, the split and
 *     either "who had what? or 👍 to split it N ways" or "👍 to log it, or send
 *     fixes". Later words from the poster (or anyone replying to the card)
 *     refine the claims and re-post the card.
 *  8. Only the POSTER's 👍 (tapback, button, or "yes") writes the expense:
 *     `source: 'receipt_photo'`, `sourceRef: message:<photo id>` (a replay is
 *     "already got that one"), itemized split, `ledger.entry_created`. The
 *     logged line carries "👎 to undo" through the loop's existing undo path.
 *     👎 / "no" from the poster drops it. Nobody else's 👍 counts.
 *
 * SAFETY §2.4 "structured results are proposals": a document's amounts never
 * reach the ledger without the poster's 👍 on a card that shows them. This is
 * the one deliberate difference from VOICE §4.4 C's "the post is the
 * confirmation" (docs/DECISIONS.md D-024).
 *
 * A photo sent to Trav in a DM is the owner's own document: it becomes a
 * private pending item and a "looks shared?" DM through `intakeDocument`,
 * like an email receipt, and never touches the group until they share it.
 */
import { createHash } from 'node:crypto';
import { realpathSync, statSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Clock,
  Expense,
  ExpenseId,
  Group,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  MessageId,
  Outbound,
  OutboundMessage,
  Stores,
  Trip,
} from '@trav/core';
import { formatMoney, ledger, markPrivate, parseIso, safety } from '@trav/core';
import type { Attachment } from '@trav/adapters';
import type { ModelClient, ResponseSource } from '../model/client.js';
import { OFFLINE_NOT_SURE_TEXT } from '../model/client.js';
import { repoRoot } from '../model/paths.js';
import {
  RECEIPT_EXTRACT_PROMPT_ID,
  RECEIPT_EXTRACT_SYSTEM,
  RECEIPT_OCR_INSTRUCTION,
  RECEIPT_OCR_PROMPT_ID,
  RECEIPT_OCR_SYSTEM,
  RECEIPT_SCHEMA,
} from '../prompts/receipt.js';
import type { RenderContext } from '../render/common.js';
import { nameOf } from '../render/common.js';
import { renderExpenseLogged } from '../render/expenseConfirm.js';
import { renderReceiptRead } from '../render/receiptRead.js';
import { wrapUntrusted } from '../untrusted.js';
import { intakeDocument } from './intake.js';
import { plansAt } from './looksShared.js';
import { activeMembers, activityWindows } from './pending.js';
import {
  applyClaims,
  buildSplit,
  hasItemInfo,
  initialClaimState,
  parseClaims,
  type ClaimContext,
  type ClaimOp,
  type ClaimState,
} from './receiptClaims.js';
import {
  checkReceipt,
  matchLines,
  parseReceiptJson,
  printedAmounts,
  type CheckedReceipt,
} from './receiptLines.js';

// ---------- texts (VOICE §4.10 D, §4.11) ----------

export const RECEIPT_UNREADABLE_TEXT =
  "couldn't read that receipt, too blurry. send another shot or just tell me the total and who's in";
export const RECEIPT_NO_TRIP_TEXT =
  "there's no trip on right now, so there's no tab to put that receipt on";
export const RECEIPT_DROPPED_TEXT = 'dropped it, nothing went on the tab';
export function receiptCurrencyText(receipt: string, trip: string): string {
  return `that receipt is in ${receipt} and the tab is in ${trip}. tell me the ${trip} total and who's in and i'll log it`;
}

/** How long a posted receipt card takes a 👍, a reply on it, or an addressed fix. */
export const RECEIPT_OPEN_TTL_MS = 6 * 60 * 60 * 1000;
/** How long the poster's UNaddressed words still count as an answer ("dean and i split the paella"). */
export const RECEIPT_ANSWER_TTL_MS = 15 * 60 * 1000;
/** A logged expense with the same amount this close in time is probably the same receipt. */
export const RECEIPT_DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;
export const RECEIPT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** A 👍 on a card the poster's later words replaced (VOICE §4.11: one line, no money moved). */
export const RECEIPT_STALE_TEXT = 'that one changed, 👍 the latest card';
export const RECEIPT_EXPIRED_TEXT = 'that receipt expired, send it again';

// "good" / "perfect" alone are chatter, never a confirmation (T-011 r1 #2).
const CONFIRM_TEXT =
  /^\s*(?:@trav\s*,?\s*)?(?:yes|yep|yeah|yup|ok|okay|log it|looks good|looks right|that's right|thats right|👍)\s*[.!]*\s*$/iu;
const DROP_TEXT =
  /^\s*(?:@trav\s*,?\s*)?(?:no|nah|nope|drop it|don'?t log (?:it|that)|nvm|never ?mind|forget it|cancel|👎)\s*[.!]*\s*$/iu;

/** Words with a photo that say it's a receipt (else the transcription has to). */
const RECEIPT_CAPTION =
  /\b(?:receipt|bill|check|cheque|tab|total|paid|pay|paying|split|tip|dinner|lunch|breakfast|brunch|drinks|groceries|who had what)\b|[€$£]\s?\d|\d\s?(?:€|eur|euros?|usd|dollars?)\b/iu;
const RECEIPT_OCR_WORDS =
  /\b(?:total|subtotal|sub-total|importe|suma|amount due|balance due|tip|iva|tax|vat|propina|gratuity|service)\b/iu;
/** A money amount in a member's words: a chat expense, not a claim on the receipt. */
const MONEY_IN_TEXT = /[€$£]\s?\d|\d\s?(?:€|eur|euros?|usd|dollars?|bucks)\b/iu;
/** A claim verb, for an addressed question that names a receipt line ("@trav who had the vermut?"). */
const CLAIM_VERB = /\b(?:had|got|ordered|ate|drank|split|shared|share|mine|was for|were for)\b/iu;

export function captionLooksLikeReceipt(text: string): boolean {
  return RECEIPT_CAPTION.test(text);
}

/** A transcription that reads like a receipt: a total-ish word and a printed amount. */
export function ocrLooksLikeReceipt(ocrText: string): boolean {
  return RECEIPT_OCR_WORDS.test(ocrText) && printedAmounts(ocrText).size > 0;
}

// ---------- the image ----------

export type ReceiptMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ReceiptImage {
  readonly bytes: Uint8Array;
  readonly mediaType: ReceiptMediaType;
  readonly sha256: string;
}

export type ReceiptImageReader = (attachment: Attachment) => Promise<ReceiptImage | undefined>;

const MEDIA_TYPES: readonly ReceiptMediaType[] = ['image/png', 'image/jpeg', 'image/webp'];

/** The first image attachment Trav can read as a receipt. */
export function receiptAttachment(attachments: readonly Attachment[]): Attachment | undefined {
  return attachments.find(
    (a) => a.kind === 'image' && (MEDIA_TYPES as readonly string[]).includes(a.mimeType),
  );
}

function sniff(bytes: Uint8Array): ReceiptMediaType | undefined {
  const b = (i: number): number => bytes[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45)
    return 'image/webp';
  return undefined;
}

/**
 * Reads an attachment from disk, only inside `roots` (default: the repo's
 * `fixtures/` and `.trav/attachments/`). Remote URLs, paths that resolve
 * outside the roots (symlinks included), oversized files and anything that
 * isn't really a PNG/JPEG/WebP are refused (`undefined`).
 */
export function createLocalImageReader(
  opts: { readonly roots?: readonly string[]; readonly maxBytes?: number } = {},
): ReceiptImageReader {
  const base = repoRoot();
  const roots = (opts.roots ?? [join(base, 'fixtures'), join(base, '.trav', 'attachments')]).map(
    (r) => {
      try {
        return realpathSync(r);
      } catch {
        return resolve(r);
      }
    },
  );
  const maxBytes = opts.maxBytes ?? RECEIPT_MAX_IMAGE_BYTES;
  return (attachment) => {
    try {
      const uri = attachment.uri;
      if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith('file:')) return Promise.resolve(undefined);
      const raw = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
      const abs = isAbsolute(raw) ? raw : resolve(base, raw);
      const real = realpathSync(abs);
      if (!roots.some((r) => real === r || real.startsWith(r + sep))) return Promise.resolve(undefined);
      const st = statSync(real);
      if (!st.isFile() || st.size === 0 || st.size > maxBytes) return Promise.resolve(undefined);
      const bytes = readFileSync(real);
      const mediaType = sniff(bytes);
      if (mediaType === undefined) return Promise.resolve(undefined);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return Promise.resolve({ bytes, mediaType, sha256 });
    } catch {
      return Promise.resolve(undefined);
    }
  };
}

// ---------- the flow ----------

export interface ReceiptFlowDeps {
  readonly stores: Stores;
  readonly model: ModelClient;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Default: `createLocalImageReader()`. */
  readonly readImage?: ReceiptImageReader;
}

interface Base {
  readonly group: Group;
  /** Every member of the group, in group order. */
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  /** The sender, identity-resolved from the channel (SAFETY §2.5). */
  readonly me: Member;
  readonly messageId: MessageId;
  readonly at: IsoDateTime;
}

export interface ReceiptPhotoInput extends Base {
  readonly lane: 'group' | 'dm';
  readonly attachment: Attachment;
  /** The sender's own words with the photo (quoted lines removed). */
  readonly text: string;
}

export interface ReceiptTextInput extends Base {
  readonly text: string;
  readonly replyToMessageId?: MessageId;
  /** Addressed to Trav (mention, reply to Trav, inside the reply window). */
  readonly addressed: boolean;
  /**
   * A booking proposal is waiting on approval in this group. A bare "yes" /
   * "no" that doesn't reply to the receipt card is then ambiguous, so it is
   * left to the approval flow; the receipt still takes a 👍 or a reply.
   */
  readonly otherPending?: boolean;
  /** Explicitly to Trav ("@trav", "trav, …", a reply to Trav), not just inside the reply window. */
  readonly mentioned?: boolean;
  /** The group thread's latest message before this one (a bare "ok" counts only right under the card). */
  readonly lastMessageId?: MessageId;
}

export interface ReceiptAnswerInput {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly me: Member | null;
  readonly cardMessageId: MessageId;
  readonly intent: 'confirm' | 'drop';
}

export interface ReceiptOutcome {
  readonly drafts: readonly Outbound[];
  readonly note: string;
  readonly modelSources: readonly ResponseSource[];
}

export interface ReceiptFlow {
  /**
   * A photo from a member (group: addressed to Trav; DM: always).
   * `undefined` ⇒ neither the words nor the photo look like a receipt: not for this flow.
   */
  photo(input: ReceiptPhotoInput): Promise<ReceiptOutcome | undefined>;
  /** Words about an open receipt (claims, fixes, "yes", "no"); `undefined` ⇒ not for this flow. */
  text(input: ReceiptTextInput): ReceiptOutcome | undefined;
  /** 👍/👎/button on a card this flow posted; `undefined` ⇒ not one of ours. */
  answer(input: ReceiptAnswerInput): ReceiptOutcome | undefined;
  /** True for a "read it" card this flow posted (current or superseded). */
  owns(messageId: MessageId): boolean;
  /** True when `text` may want this member's message (a reply on our card, or an open receipt). */
  wants(groupId: string, memberId: MemberId, replyToMessageId?: MessageId): boolean;
  reset(): void;
}

interface OpenReceipt {
  readonly scanId: string;
  readonly groupId: string;
  readonly tripId: string;
  readonly poster: MemberId;
  /**
   * Whose 👍 logs it: the poster, or, when the poster is a minor, their
   * guardian (else the group's adults). A minor never confirms money (VOICE §8).
   */
  readonly confirmers: readonly MemberId[];
  readonly photoMessageId: MessageId;
  readonly postedAt: IsoDateTime;
  readonly occurredAt: IsoDateTime;
  readonly checked: CheckedReceipt;
  readonly expenseId: ExpenseId;
  readonly description: string;
  readonly activityId?: string;
  /** The plan roster the table came from (the expense links to the plan only inside it). */
  readonly planRoster: readonly MemberId[];
  readonly duplicate?: { readonly amount: Expense['amount']; readonly description: string; readonly payer: string };
  state: ClaimState;
  cardMessageId: MessageId;
  lastActivityAt: IsoDateTime;
  status: 'open' | 'logged' | 'dropped';
}

export function createReceiptFlow(deps: ReceiptFlowDeps): ReceiptFlow {
  const { stores, model, ids, clock } = deps;
  const readImage = deps.readImage ?? createLocalImageReader();
  const receipts = new Map<string, OpenReceipt>();
  const byCard = new Map<MessageId, string>();
  const byImage = new Map<string, string>();

  const rctx = (group: Group, members: readonly Member[], trip: Trip | null): RenderContext => ({
    groupId: group.groupId,
    members,
    timeZone: trip?.timeZone ?? 'UTC',
    now: clock.now(),
    ids,
  });
  const order = (members: readonly Member[]): MemberId[] => members.map((m) => m.memberId);
  const splitContext = (members: readonly Member[]): ledger.SplitContext => ({
    memberOrder: order(members),
    participantsUniverse: activeMembers(members).map((m) => m.memberId),
  });
  const text = (b: { group: Group }, to: OutboundMessage['to'], t: string): OutboundMessage => ({
    id: ids.next('msg'),
    groupId: b.group.groupId,
    to,
    text: t,
  });
  const ageMs = (iso: IsoDateTime): number => parseIso(clock.now()) - parseIso(iso);

  function claimContext(o: OpenReceipt, members: readonly Member[], sender: MemberId): ClaimContext {
    return {
      members: activeMembers(members).map((m) => ({ memberId: m.memberId, displayName: m.displayName })),
      senderId: sender,
      lines: o.checked.lines,
      table: o.state.table,
    };
  }

  function provisional(o: OpenReceipt, members: readonly Member[]): Expense | undefined {
    const built = buildSplit(o.state, o.checked.lines, order(members));
    if (built === undefined) return undefined;
    return {
      expenseId: o.expenseId,
      groupId: o.groupId,
      tripId: o.tripId,
      description: o.description,
      merchantDisplay: o.checked.merchant,
      category: o.checked.category,
      amount: o.checked.total,
      paidBy: [{ memberId: o.state.payer, amount: o.checked.total }],
      split: built.split,
      source: 'receipt_photo',
      sourceRef: { kind: 'message', id: o.photoMessageId },
      ...(o.activityId !== undefined && built.participants.every((p) => o.planRoster.includes(p))
        ? { activityId: o.activityId }
        : {}),
      occurredAt: o.occurredAt,
      createdAt: clock.now(),
      createdBy: o.poster,
      status: 'logged',
    };
  }

  /** Posts (or re-posts) the card for the receipt's current state. */
  function card(
    o: OpenReceipt,
    b: { group: Group; members: readonly Member[]; trip: Trip | null },
    question?: string,
  ): Outbound {
    const expense = provisional(o, b.members);
    if (expense === undefined) {
      return text(b, { kind: 'group' }, `who's in on the ${formatMoney(o.checked.total)} at ${o.checked.merchant}?`);
    }
    const msg = renderReceiptRead(
      {
        expense,
        splitContext: splitContext(b.members),
        excluded: o.state.excluded,
        lowConfidence: o.checked.lowConfidence,
        itemInfo: o.state.itemInfo || !o.checked.itemized,
        ...(question !== undefined ? { question } : {}),
        ...(o.duplicate !== undefined ? { duplicate: o.duplicate } : {}),
        poster: o.poster,
        confirmers: o.confirmers,
        ...(b.trip?.familyTab === true ? { familyTab: true } : {}),
      },
      rctx(b.group, b.members, b.trip),
    );
    o.cardMessageId = msg.id;
    byCard.set(msg.id, o.scanId);
    return msg;
  }

  /**
   * Who was at the table: the roster of the plan the receipt belongs to (the
   * latest one that had started by the receipt's time, else the next one
   * about to), with the poster in it; else everyone. A receipt printed at
   * 23:01 belongs to the 21:30 dinner, not to the 23:30 bar crawl.
   */
  function receiptTable(
    trip: Trip,
    members: readonly Member[],
    poster: MemberId,
    at: IsoDateTime,
  ): { readonly participants: readonly MemberId[]; readonly activityId?: string } {
    const t = parseIso(at);
    const plans = plansAt(activityWindows(stores.group.trips, trip, members), at).filter(
      (p) => p.inMemberIds.includes(poster) && p.inMemberIds.length >= 2,
    );
    const started = plans
      .filter((p) => parseIso(p.startsAt!) <= t)
      .sort((a, b) => parseIso(b.startsAt!) - parseIso(a.startsAt!));
    const upcoming = plans
      .filter((p) => parseIso(p.startsAt!) > t)
      .sort((a, b) => parseIso(a.startsAt!) - parseIso(b.startsAt!));
    const plan = started[0] ?? upcoming[0];
    if (plan === undefined) return { participants: activeMembers(members).map((m) => m.memberId) };
    return { participants: plan.inMemberIds, activityId: plan.activityId };
  }

  function findDuplicate(
    trip: Trip,
    checked: CheckedReceipt,
    occurredAt: IsoDateTime,
    members: readonly Member[],
  ): OpenReceipt['duplicate'] {
    const at = parseIso(occurredAt);
    const hit = stores.group.expenses
      .listByTrip(trip.tripId)
      .find(
        (e) =>
          e.status === 'logged' &&
          e.amount.currency === checked.total.currency &&
          e.amount.amountMinor === checked.total.amountMinor &&
          Math.abs(parseIso(e.occurredAt) - at) <= RECEIPT_DUPLICATE_WINDOW_MS,
      );
    if (hit === undefined) return undefined;
    const payer = hit.paidBy[0]?.memberId;
    return {
      amount: hit.amount,
      description: hit.description.toLowerCase(),
      payer: payer !== undefined && members.some((m) => m.memberId === payer) ? nameOf({ members }, payer) : 'someone',
    };
  }

  function isMinorId(id: MemberId, members: readonly Member[]): boolean {
    const m = members.find((x) => x.memberId === id);
    return m !== undefined && safety.isMinor(m, clock.now());
  }

  /** Adults only: the poster, else the minor's guardian, else every adult in the group. */
  function confirmersFor(poster: Member, members: readonly Member[]): MemberId[] {
    const adults = activeMembers(members).filter((m) => !safety.isMinor(m, clock.now()));
    if (adults.some((m) => m.memberId === poster.memberId)) return [poster.memberId];
    const guardian = adults.find((m) => m.memberId === poster.guardianMemberId);
    return guardian !== undefined ? [guardian.memberId] : adults.map((m) => m.memberId);
  }

  /** Who paid is the confirmers' call, and never a minor (VOICE §8). */
  function payerOpsFrom(
    ops: readonly ClaimOp[],
    sender: MemberId,
    o: Pick<OpenReceipt, 'confirmers' | 'poster'>,
    members: readonly Member[],
  ): ClaimOp[] {
    const mayName = o.confirmers.includes(sender) || sender === o.poster;
    return ops.filter(
      (op) => op.op !== 'payer' || (mayName && !isMinorId(op.memberId, members)),
    );
  }

  async function photo(input: ReceiptPhotoInput): Promise<ReceiptOutcome | undefined> {
    const sources: ResponseSource[] = [];
    const { group, members, trip, me } = input;
    // "@trav look at this view" is a photo, not a receipt: without receipt
    // words in the caption, only a transcription that reads like a receipt
    // starts this flow; anything else goes back to the normal loop (r1 #4).
    const receipty = captionLooksLikeReceipt(input.text);
    const back: OutboundMessage['to'] = input.lane === 'dm' ? { kind: 'member', memberId: me.memberId } : { kind: 'group' };
    const unreadable = (note: string): ReceiptOutcome => ({
      // VOICE §4.10 D: a DM to the poster, two lines max, no money moved.
      drafts: [text(input, { kind: 'member', memberId: me.memberId }, RECEIPT_UNREADABLE_TEXT)],
      note,
      modelSources: sources,
    });
    if (trip === null) {
      if (!receipty) return undefined;
      return { drafts: [text(input, back, RECEIPT_NO_TRIP_TEXT)], note: 'receipt:no_trip', modelSources: [] };
    }
    const image = await readImage(input.attachment);
    if (image === undefined) return receipty ? unreadable('receipt:unreadable:image') : undefined;

    // The same photo again: one receipt, one card.
    const imageKey = `${group.groupId}:${input.lane}:${me.memberId}:${image.sha256}`;
    const prior = receipts.get(byImage.get(imageKey) ?? '');
    // Still the same receipt only while its card is open or its expense is
    // still on the tab: after a 👎 undo, a drop or the card expiring, a
    // re-post is read again.
    const priorLive =
      prior !== undefined &&
      (prior.status === 'logged'
        ? stores.group.expenses.get(prior.expenseId)?.status === 'logged'
        : isOpen(prior));
    if (prior !== undefined && priorLive) {
      const t =
        prior.status === 'logged'
          ? `already got that one: ${formatMoney(prior.checked.total)} ${prior.description}`
          : `already got that one, it's waiting on a 👍 from ${nameOf(
              { members },
              prior.confirmers.length === 1 ? prior.confirmers[0]! : prior.poster,
            )}`;
      return { drafts: [text(input, back, t)], note: 'receipt:duplicate_image', modelSources: [] };
    }

    // 1. vision: the photo → a transcription (zero tools)
    const ocr = await model.complete({
      model: 'main',
      systemPromptId: RECEIPT_OCR_PROMPT_ID,
      system: RECEIPT_OCR_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              mediaType: image.mediaType,
              dataBase64: Buffer.from(image.bytes).toString('base64'),
            },
            { type: 'text', text: RECEIPT_OCR_INSTRUCTION },
          ],
        },
      ],
      tools: [],
      maxTokens: 1500,
    });
    sources.push(ocr.source);
    const ocrText = ocr.text.trim();
    const scanId = ids.next('priv');
    const intakeDeps = { stores, clock, ids, group, members, trip };
    if (ocrText.length === 0 || ocrText === 'UNREADABLE' || ocrText === OFFLINE_NOT_SURE_TEXT) {
      return receipty ? unreadable('receipt:unreadable:ocr') : undefined;
    }
    if (!receipty && !ocrLooksLikeReceipt(ocrText)) return undefined;

    // 2. extraction over the transcription, wrapped as untrusted (M-08, zero tools)
    const wrapped = wrapUntrusted(ocrText, 'receipt_ocr', scanId);
    const ext = await model.complete({
      model: 'main',
      systemPromptId: RECEIPT_EXTRACT_PROMPT_ID,
      system: RECEIPT_EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: `[image sha256:${image.sha256}]\n${wrapped}` }],
      tools: [],
      jsonSchema: RECEIPT_SCHEMA,
      maxTokens: 2000,
    });
    sources.push(ext.source);
    const parsed = ext.json === undefined ? null : parseReceiptJson(ext.json);

    // 3. screen the transcription once (injection.detected, owner-visible) and keep it private
    const checkedOrNull =
      parsed === null ? null : checkReceipt(parsed, ocrText, { injection: false });
    const dmItem =
      input.lane === 'dm' && parsed !== null && checkedOrNull !== null
        ? {
            amountMinor: checkedOrNull.total.amountMinor,
            currency: checkedOrNull.total.currency,
            merchantDisplay: checkedOrNull.merchant,
            ...(checkedOrNull.occurredAt !== undefined ? { occurredAt: checkedOrNull.occurredAt } : {}),
            category: checkedOrNull.category,
            ...(checkedOrNull.itemized ? { lineItems: checkedOrNull.lines } : {}),
          }
        : undefined;
    const screened = intakeDocument(
      {
        groupId: group.groupId,
        ownerMemberId: me.memberId,
        source: 'receipt_ocr',
        itemId: scanId,
        text: ocrText,
        ...(dmItem !== undefined ? { extracted: dmItem } : {}),
      },
      intakeDeps,
    );
    const injection = screened.matches.length > 0;
    stores.private.putReceiptScan(
      me.memberId,
      markPrivate({
        id: scanId,
        ownerMemberId: me.memberId,
        groupId: group.groupId,
        tripId: trip.tripId,
        createdAt: clock.now(),
        imageRef: `sha256:${image.sha256}`,
        ocrText,
        parsed,
        ...(input.lane === 'group' ? { postedInGroupMessageId: input.messageId } : {}),
        injectionDetected: injection,
      }),
    );
    if (parsed === null || checkedOrNull === null) return unreadable('receipt:unreadable:parse');

    // A photo in the DM lane is the owner's own: the "looks shared?" DM, nothing in the group.
    if (input.lane === 'dm') {
      return { drafts: screened.drafts, note: 'receipt:private', modelSources: sources };
    }

    const checked = checkReceipt(parsed, ocrText, { injection });
    if (checked.total.currency !== trip.currency) {
      return {
        drafts: [text(input, back, receiptCurrencyText(checked.total.currency, trip.currency))],
        note: 'receipt:currency',
        modelSources: sources,
      };
    }

    // 4. the table, the poster's own words, the card
    const occurredAt = checked.occurredAt ?? input.at;
    const plan = receiptTable(trip, members, me.memberId, occurredAt);
    const confirmers = confirmersFor(me, members);
    // A minor's receipt is on their guardian (VOICE §8: never a payer or debtor).
    const defaultPayer = isMinorId(me.memberId, members) ? confirmers[0] : me.memberId;
    if (defaultPayer === undefined) return undefined; // no adult in the group at all
    const o: OpenReceipt = {
      scanId,
      groupId: group.groupId,
      tripId: trip.tripId,
      poster: me.memberId,
      confirmers,
      photoMessageId: input.messageId,
      postedAt: clock.now(),
      occurredAt,
      checked,
      expenseId: ids.next('exp'),
      description: checked.merchant,
      ...(plan.activityId !== undefined ? { activityId: plan.activityId } : {}),
      planRoster: plan.participants,
      state: initialClaimState(defaultPayer, plan.participants),
      cardMessageId: '',
      lastActivityAt: clock.now(),
      status: 'open',
    };
    const dup = findDuplicate(trip, checked, occurredAt, members);
    let question: string | undefined;
    const parse = parseClaims(input.text, claimContext(o, members, me.memberId));
    let occasion: string | undefined;
    if (parse.kind === 'question') question = parse.question;
    else {
      occasion = parse.occasion;
      const ops = payerOpsFrom(parse.ops, me.memberId, o, members);
      const applied = applyClaims(o.state, ops, order(members));
      if (applied.kind === 'question') question = applied.question;
      else o.state = { ...applied.state, itemInfo: hasItemInfo(ops) || applied.state.itemInfo };
    }
    const description =
      occasion !== undefined && checked.merchant !== 'that receipt'
        ? `${occasion} at ${checked.merchant}`
        : checked.merchant;
    const open: OpenReceipt = { ...o, description, ...(dup !== undefined ? { duplicate: dup } : {}) };
    receipts.set(scanId, open);
    byImage.set(imageKey, scanId);
    const draft = card(open, input, question);
    return {
      drafts: [draft],
      note:
        question !== undefined
          ? 'receipt:clarify'
          : open.state.itemInfo || trip.familyTab
            ? 'receipt:read'
            : 'receipt:who_had_what',
      modelSources: sources,
    };
  }

  function isOpen(o: OpenReceipt): boolean {
    return o.status === 'open' && ageMs(o.postedAt) <= RECEIPT_OPEN_TTL_MS;
  }

  /** The open receipt a member's words are about, if any. */
  function target(input: ReceiptTextInput): OpenReceipt | undefined {
    if (input.replyToMessageId !== undefined) {
      const o = receipts.get(byCard.get(input.replyToMessageId) ?? '');
      if (o !== undefined && o.groupId === input.group.groupId && isOpen(o)) return o;
      return undefined;
    }
    let best: OpenReceipt | undefined;
    for (const o of receipts.values()) {
      if (o.groupId !== input.group.groupId || !isOpen(o)) continue;
      if (input.trip === null || o.tripId !== input.trip.tripId) continue;
      const mine = o.poster === input.me.memberId || o.confirmers.includes(input.me.memberId);
      const fresh = ageMs(o.lastActivityAt) <= RECEIPT_ANSWER_TTL_MS;
      // Unaddressed words count only from the poster, shortly after Trav asked;
      // someone else's addressed words go to a receipt only while it's fresh.
      if (!input.addressed && (!mine || !fresh)) continue;
      if (!mine && !fresh) continue;
      if (best === undefined || parseIso(o.lastActivityAt) > parseIso(best.lastActivityAt)) best = o;
    }
    return best;
  }

  function confirm(
    o: OpenReceipt,
    b: { group: Group; members: readonly Member[]; trip: Trip | null },
    by: MemberId,
  ): ReceiptOutcome {
    const draft = provisional(o, b.members);
    if (draft === undefined) {
      return { drafts: [card(o, b)], note: 'receipt:clarify:who', modelSources: [] };
    }
    const expense: Expense = { ...draft, createdBy: by };
    const repo = stores.group.expenses;
    const prior = repo.getBySourceRef(expense.sourceRef);
    o.status = 'logged';
    if (prior !== undefined) {
      return {
        drafts: [text(b, { kind: 'group' }, `already got that one: ${formatMoney(prior.amount)} ${prior.description.toLowerCase()}`)],
        note: 'receipt:already_logged',
        modelSources: [],
      };
    }
    const ctx = splitContext(b.members);
    const shares = ledger.computeShares(expense, ctx);
    repo.create(expense, ledger.buildLedgerEntries(expense, ctx));
    stores.group.audit.append({
      groupId: o.groupId,
      tripId: o.tripId,
      type: 'ledger.entry_created',
      actor: { kind: 'member', id: by },
      visibility: 'group',
      payload: {
        expenseId: expense.expenseId,
        splitMethod: expense.split.method,
        participants: shares.filter((s) => s.amount.amountMinor !== 0).map((s) => s.memberId),
        amounts: shares.map((s) => ({ memberId: s.memberId, amountMinor: s.amount.amountMinor })),
        sourceMessageId: o.photoMessageId,
        sourceRef: expense.sourceRef.id,
        source: 'receipt_photo',
        lowConfidence: o.checked.lowConfidence,
      },
    });
    const logged = renderExpenseLogged({ expense, splitContext: ctx }, rctx(b.group, b.members, b.trip));
    const payer = nameOf({ members: b.members }, o.state.payer);
    const t = `logged: ${formatMoney(expense.amount)} ${expense.description} on ${payer}\n👎 to undo`;
    return {
      drafts: [{ ...logged, text: t, card: { ...logged.card, fallbackText: t } }],
      note: 'receipt:logged',
      modelSources: [],
    };
  }

  function drop(o: OpenReceipt, b: { group: Group }): ReceiptOutcome {
    o.status = 'dropped';
    return { drafts: [text(b, { kind: 'group' }, RECEIPT_DROPPED_TEXT)], note: 'receipt:dropped', modelSources: [] };
  }

  function answer(input: ReceiptAnswerInput): ReceiptOutcome | undefined {
    const o = receipts.get(byCard.get(input.cardMessageId) ?? '');
    if (o === undefined || o.groupId !== input.group.groupId) return undefined;
    const quiet = (note: string): ReceiptOutcome => ({ drafts: [], note, modelSources: [] });
    // Only the poster (or, for a minor's receipt, their guardian) confirms what
    // Trav read off the photo (SAFETY §2.4, VOICE §8); anyone else: silence.
    if (input.me === null || !o.confirmers.includes(input.me.memberId))
      return quiet('receipt:not_poster');
    if (o.status !== 'open') return quiet(`receipt:${o.status}`);
    // The confirmer's 👍 on a card that no longer counts gets one line back (r1 #5).
    const say = (note: string, t: string): ReceiptOutcome => ({
      drafts: [text(input, { kind: 'group' }, t)],
      note,
      modelSources: [],
    });
    if (!isOpen(o)) return say('receipt:expired', RECEIPT_EXPIRED_TEXT);
    if (o.cardMessageId !== input.cardMessageId) return say('receipt:stale_card', RECEIPT_STALE_TEXT);
    return input.intent === 'confirm' ? confirm(o, input, input.me.memberId) : drop(o, input);
  }

  function textTurn(input: ReceiptTextInput): ReceiptOutcome | undefined {
    const o = target(input);
    if (o === undefined) return undefined;
    const canConfirm = o.confirmers.includes(input.me.memberId);
    const onCard = input.replyToMessageId !== undefined; // `target` checked it's this receipt's card
    const fresh = ageMs(o.lastActivityAt) <= RECEIPT_ANSWER_TTL_MS;
    const words = input.text.trim();
    const isConfirm = CONFIRM_TEXT.test(words);
    const isDrop = DROP_TEXT.test(words);
    if (isConfirm || isDrop) {
      if (!canConfirm) return undefined;
      if (input.otherPending === true && !onCard) return undefined;
      // A bare "ok" means the card only when it says so: a reply to the card,
      // "@trav ok", or nothing else said in between (r1 #2).
      const underCard = input.lastMessageId !== undefined && input.lastMessageId === o.cardMessageId;
      if (!onCard && input.mentioned !== true && !underCard) return undefined;
      return isConfirm ? confirm(o, input, input.me.memberId) : drop(o, input);
    }
    // Not a reply to the card: the words are about the receipt only when they
    // parse cleanly into claims. Anything else (a booking, a roll call, a
    // balance question, a new expense) belongs to the rest of the loop (r1 #1).
    if (!onCard && MONEY_IN_TEXT.test(words)) return undefined;
    const ctx = claimContext(o, input.members, input.me.memberId);
    const parse = parseClaims(words, ctx);
    const asks = (q: string): ReceiptOutcome => {
      o.lastActivityAt = clock.now();
      return { drafts: [text(input, { kind: 'group' }, q)], note: 'receipt:clarify', modelSources: [] };
    };
    if (parse.kind === 'question') {
      // Off the card, ask only about words that name a line with a claim verb.
      const aboutALine =
        input.addressed && CLAIM_VERB.test(words) && matchLines(words, o.checked.lines).kind !== 'none';
      return onCard || aboutALine ? asks(parse.question) : undefined;
    }
    if (parse.ops.length === 0) return undefined;
    if (!onCard && parse.noise > 0) return undefined;
    // "Sam is out" off the card is a roll call unless the receipt was just discussed.
    if (!onCard && !hasItemInfo(parse.ops) && !parse.ops.some((op) => op.op === 'payer') && !fresh)
      return undefined;
    const ops = payerOpsFrom(parse.ops, input.me.memberId, o, input.members);
    if (ops.length === 0) return undefined;
    const applied = applyClaims(o.state, ops, order(input.members));
    if (applied.kind === 'question') {
      if (!input.addressed && !onCard) return undefined;
      return asks(applied.question);
    }
    o.state = applied.state;
    o.lastActivityAt = clock.now();
    return { drafts: [card(o, input)], note: 'receipt:updated', modelSources: [] };
  }

  return {
    photo,
    text: textTurn,
    answer,
    owns: (id) => byCard.has(id),
    wants: (groupId, memberId, replyTo) => {
      if (replyTo !== undefined) return byCard.has(replyTo);
      for (const o of receipts.values()) {
        if (
          o.groupId === groupId &&
          isOpen(o) &&
          (o.poster === memberId ||
            o.confirmers.includes(memberId) ||
            ageMs(o.lastActivityAt) <= RECEIPT_ANSWER_TTL_MS)
        )
          return true;
      }
      return false;
    },
    reset: () => {
      receipts.clear();
      byCard.clear();
      byImage.clear();
    },
  };
}

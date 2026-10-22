/**
 * Mock `EmailReceiptSource` (T-029-b): per-member forwarding addresses and an
 * in-memory inbox seeded from `fixtures/emails/*.json`.
 *
 * Routing: the owner of an email is the member whose forwarding address it
 * arrived at, never a name or id the email claims. `deliver()` (the mock's
 * stand-in for the inbound mail webhook) resolves the owner from the `to`
 * address; unknown or rotated-away addresses are rejected. Fixture emails are
 * routed the same way when the fixture names its `forwardingAddress`, and the
 * fixture's declared owner must agree with the address book.
 *
 * Privacy: `list(owner)` only ever returns that owner's emails. `onEmail`
 * handlers see every member's mail (interface contract) and must keep items
 * owner-private. Consent (`emailImport`, SAFETY §2.6) is checked by the
 * ingestion caller; this adapter only models the provider.
 *
 * Addresses: fixture addresses are kept; other members get a deterministic,
 * hard-to-guess address derived from a seed. `rotateAddress` replaces it and
 * the old one stops accepting mail. No network, no wall clock.
 */
import { createHash } from 'node:crypto';
import { TravError, parseIso } from '@trav/core';
import type { MemberId } from '@trav/core';
import type { AdapterError, AdapterInfo, Result, Unsubscribe } from '../../interfaces/common.js';
import type { EmailReceiptSource, InboundEmail } from '../../interfaces/emailReceipts.js';
import { deepFreeze } from '../transactions/fixtureFiles.js';
import { isForwardingAddress, loadEmailFixtures, parseInboundEmail } from './fixture.js';
import type { EmailFixture } from './fixture.js';

export interface MockEmailSourceOptions {
  /** Use exactly these fixtures (tests). Omitted ⇒ every file in `fixtures/<fixtureDir...>/`. */
  readonly fixtures?: readonly EmailFixture[];
  /** Default `['emails']`. */
  readonly fixtureDir?: readonly string[];
  /** Seed for generated addresses. Default `'trav-mock-email'`. */
  readonly seed?: string;
  /** Domain for generated addresses. Default `'in.trav.example.test'`. */
  readonly domain?: string;
}

/** An inbound message as the mail provider hands it over: no owner yet. */
export type InboundDelivery = Omit<InboundEmail, 'ownerMemberId'> & {
  /** Anything a sender writes here is ignored; the owner comes from `to`. */
  readonly ownerMemberId?: string;
};

export interface MockEmailReceiptSource extends EmailReceiptSource {
  /**
   * Mock control: an email arrives at forwarding address `to`. Resolves the
   * owner from the address book, stores it, and notifies `onEmail` handlers
   * in subscription order. `not_found` for an unknown or rotated address;
   * `duplicate` for an already-delivered `emailId`.
   */
  deliver(to: string, email: InboundDelivery): Promise<Result<InboundEmail>>;
  /** Test hook: number of emails stored (fixtures + deliveries). */
  size(): number;
  /** Test hook: `onEmail` handlers that threw or rejected (they are isolated; delivery still succeeds). */
  handlerFailureCount(): number;
}

const MEMBER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

function err(code: AdapterError['code'], message: string): { ok: false; error: AdapterError } {
  return { ok: false, error: { code, message, retryable: false } };
}

function byReceived(a: InboundEmail, b: InboundEmail): number {
  return (
    parseIso(a.receivedAt) - parseIso(b.receivedAt) ||
    (a.emailId < b.emailId ? -1 : a.emailId > b.emailId ? 1 : 0)
  );
}

export function createMockEmailReceiptSource(
  options: MockEmailSourceOptions = {},
): MockEmailReceiptSource {
  const info: AdapterInfo = { provider: 'mock-email-receipts', mode: 'mock' };
  const seed = options.seed ?? 'trav-mock-email';
  const domain = options.domain ?? 'in.trav.example.test';

  const addressOf = new Map<MemberId, string>();
  const ownerOf = new Map<string, MemberId>();
  const generation = new Map<MemberId, number>();
  const emails = new Map<string, InboundEmail>();
  const handlers: ((email: InboundEmail) => void | Promise<void>)[] = [];
  let handlerFailures = 0;

  function assign(member: MemberId, address: string): void {
    const prev = addressOf.get(member);
    if (prev !== undefined) ownerOf.delete(prev);
    addressOf.set(member, address);
    ownerOf.set(address, member);
  }

  function generateAddress(member: MemberId): string {
    for (let n = generation.get(member) ?? 0; ; n += 1) {
      const token = createHash('sha256')
        .update(`${seed}\n${member}\n${n}`)
        .digest('hex')
        .slice(0, 16);
      const local = member
        .replace(/^mem_/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 24);
      const address = `${local || 'member'}.${token}@${domain}`;
      if (!ownerOf.has(address)) {
        generation.set(member, n + 1);
        return address;
      }
    }
  }

  // Seed the address book and inbox from fixtures.
  const fixtures = options.fixtures ?? loadEmailFixtures(options.fixtureDir ?? ['emails']);
  for (const f of fixtures) {
    const { email } = f;
    if (emails.has(email.emailId)) {
      throw new TravError('invalid_argument', `duplicate email fixture ${email.emailId}`);
    }
    if (f.forwardingAddress !== undefined) {
      const known = ownerOf.get(f.forwardingAddress);
      if (known !== undefined && known !== email.ownerMemberId) {
        throw new TravError(
          'invalid_argument',
          `forwarding address of ${email.emailId} belongs to another member`,
        );
      }
      const mine = addressOf.get(email.ownerMemberId);
      if (mine !== undefined && mine !== f.forwardingAddress) {
        throw new TravError(
          'invalid_argument',
          `${email.emailId}: member has two forwarding addresses`,
        );
      }
      assign(email.ownerMemberId, f.forwardingAddress);
    }
    emails.set(email.emailId, deepFreeze({ ...email }));
  }

  function addressFor(member: MemberId): string {
    const existing = addressOf.get(member);
    if (existing !== undefined) return existing;
    const address = generateAddress(member);
    assign(member, address);
    return address;
  }

  return {
    info,

    forwardingAddressFor(memberId) {
      if (!MEMBER_ID_RE.test(memberId))
        return Promise.resolve(err('invalid_request', 'bad member id'));
      return Promise.resolve({ ok: true, value: addressFor(memberId) });
    },

    onEmail(handler): Unsubscribe {
      handlers.push(handler);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },

    list(ownerMemberId, since) {
      let sinceMs: number | undefined;
      if (since !== undefined) {
        try {
          sinceMs = parseIso(since);
        } catch {
          return Promise.resolve(
            err('invalid_request', 'since must be an ISO date-time with offset'),
          );
        }
      }
      const mine = [...emails.values()]
        .filter((e) => e.ownerMemberId === ownerMemberId)
        .filter((e) => sinceMs === undefined || parseIso(e.receivedAt) >= sinceMs)
        .sort(byReceived);
      return Promise.resolve({ ok: true, value: mine });
    },

    rotateAddress(memberId) {
      if (!MEMBER_ID_RE.test(memberId))
        return Promise.resolve(err('invalid_request', 'bad member id'));
      const address = generateAddress(memberId);
      assign(memberId, address);
      return Promise.resolve({ ok: true, value: address });
    },

    async deliver(to, delivery) {
      const address = to.trim().toLowerCase();
      if (!isForwardingAddress(address)) return err('invalid_request', 'bad recipient address');
      const owner = ownerOf.get(address);
      if (owner === undefined) return err('not_found', 'no member uses this forwarding address');
      let email: InboundEmail;
      try {
        email = parseInboundEmail({ ...delivery, ownerMemberId: owner }, 'delivery');
      } catch (e) {
        if (e instanceof TravError) return err('invalid_request', e.message);
        throw e;
      }
      if (emails.has(email.emailId)) return err('duplicate', 'email already delivered');
      const stored = deepFreeze(email);
      emails.set(stored.emailId, stored);
      // A failing handler never blocks the others or the delivery result.
      for (const h of [...handlers]) {
        try {
          await h(stored);
        } catch {
          handlerFailures += 1;
        }
      }
      return { ok: true, value: stored };
    },

    handlerFailureCount() {
      return handlerFailures;
    },

    size() {
      return emails.size;
    },
  };
}

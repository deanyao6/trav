/**
 * Cross-fixture consistency (T-146): a chat line that expects a ticket
 * proposal with `refundable: true|false` must agree with the ticket inventory
 * at the moment that line is sent. The mock presents an offer as
 * non-refundable from its `refundableUntil` onwards, so a deadline that passes
 * before the booking line silently adds `non_refundable` to the policy reasons.
 */
import { describe, expect, it } from 'vitest';
import { loadTicketInventory } from '@trav/adapters';
import { TRIP_NAMES, loadJsonl, type ChatLine } from './fixtures.js';

interface OfferFixture {
  readonly offerId: string;
  readonly refundPolicy: { readonly refundable: boolean; readonly refundableUntil?: string };
}

interface ProposalExpect {
  readonly kind?: string;
  readonly itemRef?: string;
  readonly refundable?: boolean;
}

/**
 * Mirrors `refundableNow` in packages/agent/src/booking/proposals.ts, which sets
 * a proposal's `refundable` flag: refundable strictly before the deadline.
 */
function refundableAt(offer: OfferFixture, at: string): boolean {
  const p = offer.refundPolicy;
  if (!p.refundable) return false;
  return p.refundableUntil === undefined || Date.parse(at) < Date.parse(p.refundableUntil);
}

describe('chat fixtures agree with ticket inventory on refundability', () => {
  for (const trip of TRIP_NAMES) {
    it(trip, () => {
      // The adapter's own loader: the same parse the mock (and the eval runner) uses.
      const offers = new Map<string, OfferFixture>(
        loadTicketInventory(trip).events.flatMap((e) =>
          e.offers.map((o) => [o.offer.offerId, o.offer] as const),
        ),
      );
      const checked: string[] = [];
      for (const line of loadJsonl<ChatLine>(`chats/${trip}.jsonl`)) {
        const proposal = (line.expect as { proposal?: ProposalExpect } | undefined)?.proposal;
        if (proposal?.kind !== 'ticket' || proposal.refundable === undefined) continue;
        if (proposal.itemRef === undefined) continue;
        const offer = offers.get(proposal.itemRef);
        expect(
          offer,
          `${line.id}: offer ${proposal.itemRef} is in the ${trip} ticket inventory`,
        ).toBeDefined();
        if (offer === undefined) continue;
        expect(
          refundableAt(offer, line.ts),
          `${line.id}: ${proposal.itemRef} refundable at ${line.ts}`,
        ).toBe(proposal.refundable);
        checked.push(line.id);
      }
      expect(checked.length, `${trip}: at least one line checked`).toBeGreaterThan(0);
      if (trip === 'lisbon') {
        expect(checked).toEqual(
          expect.arrayContaining(['msg_lis_0018', 'msg_lis_0021', 'msg_lis_0032']),
        );
      }
    });
  }

  it('the deadline rule matches refundableNow: refundable until, not at, the deadline', () => {
    const o: OfferFixture = {
      offerId: 'x',
      refundPolicy: { refundable: true, refundableUntil: '2026-04-19T15:00:00+01:00' },
    };
    expect(refundableAt(o, '2026-04-19T14:59:59+01:00')).toBe(true);
    expect(refundableAt(o, '2026-04-19T15:00:00+01:00')).toBe(false);
    expect(
      refundableAt({ offerId: 'y', refundPolicy: { refundable: false } }, '2026-01-01T00:00:00Z'),
    ).toBe(false);
    expect(
      refundableAt({ offerId: 'z', refundPolicy: { refundable: true } }, '2030-01-01T00:00:00Z'),
    ).toBe(true);
  });
});

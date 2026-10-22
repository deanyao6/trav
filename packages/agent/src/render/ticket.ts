/**
 * Per-person ticket / QR delivery (VOICE §4.3, card `ticket`). DM lane only:
 * the message is addressed to `artifact.deliveredToMemberId` (the holder, or
 * the guardian for a minor, VOICE §8) and carries exactly one ticket. The QR
 * payload lives only in this DM; `screenOutbound` and the channel both refuse
 * a ticket card on the group lane.
 */
import type { OutboundMessage, TicketArtifact, TicketCard } from '@trav/core';
import { TravError, formatClockTime } from '@trav/core';
import type { RenderContext } from './common.js';
import { cardMessage, dayPhrase, dm, headlineName, nameOf, possessive } from './common.js';

export interface TicketRenderInput {
  /** From `PrivateStore.listTickets(holder, bookingId)`; read on the DM lane only. */
  readonly artifact: TicketArtifact;
  /** Short lowercase event name ("razzmatazz"); defaults to the venue lowercased. */
  readonly headline?: string;
  readonly notes?: string;
}

export function renderTicket(
  input: TicketRenderInput,
  ctx: RenderContext,
): OutboundMessage & { readonly card: TicketCard } {
  const { artifact } = input;
  // The artifact lives in the holder's partition (ownerMemberId); a minor's goes to the guardian.
  const owner = artifact.ownerMemberId;
  const to = artifact.deliveredToMemberId;
  const ownerName = nameOf(ctx, owner);
  if (to !== owner) {
    const holder = ctx.members.find((m) => m.memberId === owner);
    if (holder?.guardianMemberId !== to) {
      throw new TravError(
        'invalid_argument',
        'renderTicket: only a guardian may receive another ticket',
        {
          bookingId: artifact.bookingId,
        },
      );
    }
  }
  nameOf(ctx, to);
  const headline = input.headline ?? headlineName(artifact.event.venue);
  const forGuardian = to !== owner;
  const day = dayPhrase(artifact.event.startsAt, ctx.timeZone, ctx.now);
  const whose = forGuardian ? `${possessive(ownerName)}` : 'your';
  const line1 = `${whose} ${headline} ticket for ${day} 🎟️`;

  const details: string[] = [];
  const seat = artifact.seat;
  if (seat !== undefined) {
    if (seat.gate !== undefined) details.push(`gate ${seat.gate}`);
    if (seat.section !== undefined) details.push(`sector ${seat.section}`);
    if (seat.row !== undefined) details.push(`row ${seat.row}`);
    if (seat.seat !== undefined) details.push(`seat ${seat.seat}`);
  }
  const info: string[] = [];
  if (artifact.event.doorsAt !== undefined) {
    info.push(`doors ${formatClockTime(artifact.event.doorsAt, ctx.timeZone)}`);
  } else {
    info.push(`starts ${formatClockTime(artifact.event.startsAt, ctx.timeZone)}`);
  }
  if (artifact.event.address !== undefined) info.push(artifact.event.address);

  const lines = [line1, info.join(' · ')];
  if (details.length > 0) lines.push(details.join(' · '));
  lines.push(
    forGuardian
      ? `it's under your name, don't forward it`
      : "this one's yours only, don't forward it. everyone got their own",
  );

  return cardMessage<TicketCard>(
    ctx,
    dm(to),
    lines,
    {
      type: 'ticket',
      title: `${headline} ticket`,
      bookingId: artifact.bookingId,
      ownerMemberId: owner,
      deliveredTo: to,
      event: {
        name: artifact.event.name,
        venue: artifact.event.venue,
        ...(artifact.event.address !== undefined ? { address: artifact.event.address } : {}),
        startsAt: artifact.event.startsAt,
        ...(artifact.event.doorsAt !== undefined ? { doorsAt: artifact.event.doorsAt } : {}),
      },
      ...(seat !== undefined ? { seat: { ...seat } } : {}),
      qr: { dataUrl: artifact.qrDataUrl, payload: artifact.qrPayload },
      holderName: artifact.holderName,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
    { images: [{ url: artifact.qrDataUrl, alt: `QR code, ${possessive(ownerName)} ticket` }] },
  );
}

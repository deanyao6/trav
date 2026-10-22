/**
 * The single send path (SAFETY F1; VOICE §10; D-009). Every Trav message,
 * reaction, card and DM leaves through `sendOutbound`, which in order:
 *  1. `safety.screenOutbound` (minors, roast gates, DM-only cards on the group lane)
 *  2. `safety.lintVoice` on `text` (a violation fails in tests; in production it is logged and the message still sends)
 *  3. resolves the lane: `to.kind === 'group'` ⇒ `channel.sendGroup`; `to.kind === 'member'` ⇒ `channel.sendDirect(handle)`
 *     (no `privateDm` capability ⇒ DM content is dropped and only a count line may be posted to the group)
 *  4. writes `message.sent` (ids only; never the text of DMs) and any `content.suppressed`/`roast.suppressed` events
 * The message-budget guard is a `ChannelAdapter` decorator (`packages/adapters/src/channel/budget.ts`), not here.
 */
import type {
  AuditRepository,
  Clock,
  ConsentLookup,
  Group,
  Member,
  MemberId,
  Outbound,
  Trip,
} from '@trav/core';
import { notImplemented } from '@trav/core';
import type { ChannelAdapter, ChannelHandle, SentMessage } from '@trav/adapters';

export interface SendDeps {
  readonly channel: ChannelAdapter;
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly consent: ConsentLookup;
  readonly audit: AuditRepository;
  readonly clock: Clock;
  /** Channel handle for a member's DM lane. */
  handleFor(memberId: MemberId): ChannelHandle | undefined;
  /** Test hook / production logger for lint violations. */
  onLintViolation?(outbound: Outbound, violations: readonly string[]): void;
}

export interface SendOutcome {
  readonly outbound: Outbound;
  readonly sent: SentMessage | null;
  readonly suppressed: boolean;
  readonly degraded: boolean;
}

export async function sendOutbound(outbound: Outbound, deps: SendDeps): Promise<SendOutcome> {
  return notImplemented(`sendOutbound(${outbound.id}, ${deps.group.groupId})`);
}

/** Convenience: screen + lint + send every message of a turn, in order; one group message plus N DMs is the only multi-message turn (VOICE §3.7). */
export async function sendTurn(
  outbounds: readonly Outbound[],
  deps: SendDeps,
): Promise<readonly SendOutcome[]> {
  return notImplemented(`sendTurn(${outbounds.length}, ${deps.group.groupId})`);
}

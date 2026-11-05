/**
 * T-169: the simulator over the iMessage relay channel (`pnpm relay:dev`).
 *
 * Each simulator session gets a relay loopback (`createRelayLoopback` in
 * `@trav/adapters`): the members' phones are the simulator's world, every
 * member action reaches Trav as the vendor's signed webhook through
 * `RelayChannel.handleWebhook`, and every Trav send goes out as the vendor's
 * HTTP request to the in-process mock relay, through T-071 pacing. The UI
 * runs in the `overlay` view by default, so the demo's buttons still work: a
 * tap is played as the member's iMessage action (a 👍 tapback, or a reply such
 * as "sent"), never as a button tap.
 *
 * Always the mock relay: this path never builds a live transport, whatever
 * `TRAV_RELAY_LIVE` says (a live line is `createRelayFromEnv`, docs/RELAY.md).
 */
import type {
  RelayDiagnostic,
  RelayLoopback,
  RelayVendorId,
  RelayWebhookOutcome,
  WebhookTarget,
} from '@trav/adapters';
import { createRelayLoopback, isRelayVendorId } from '@trav/adapters';
import type { SimChannelFactory } from './runtime.js';

export type RelayView = 'phone' | 'overlay';

export interface RelaySessionsOptions {
  readonly vendor: RelayVendorId;
  /** Default `overlay` (see the module comment). */
  readonly view?: RelayView;
  readonly onDiagnostic?: (d: RelayDiagnostic) => void;
}

export interface RelaySessions {
  readonly vendor: RelayVendorId;
  readonly view: RelayView;
  /** Pass to `loadAgentBackend` / `selectBackend`. */
  readonly channelFactory: SimChannelFactory;
  /** The loopback of the newest session (a reset builds a new one). */
  current(): RelayLoopback | undefined;
  /** Forwards a webhook to the newest session's relay channel (for the 127.0.0.1 receiver). */
  readonly webhookTarget: WebhookTarget;
}

export function createRelaySessions(options: RelaySessionsOptions): RelaySessions {
  const view = options.view ?? 'overlay';
  let latest: RelayLoopback | undefined;
  const channelFactory: SimChannelFactory = ({ clock, conversations }) => {
    latest = createRelayLoopback({
      vendor: options.vendor,
      clock,
      conversations,
      view,
      ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
    });
    return latest.channel;
  };
  const webhookTarget: WebhookTarget = {
    async handleWebhook(input): Promise<RelayWebhookOutcome> {
      if (latest === undefined) {
        return {
          status: 400,
          accepted: 0,
          duplicates: 0,
          ignored: 0,
          delivered: Promise.resolve(),
        };
      }
      return latest.relay.handleWebhook(input);
    },
  };
  return { vendor: options.vendor, view, channelFactory, current: () => latest, webhookTarget };
}

/**
 * `--relay` / `--relay=<vendor>` (default photon, or `TRAV_RELAY_VENDOR`), and
 * `--relay-view=phone|overlay`. Undefined when `--relay` is absent.
 */
export function relayArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { vendor: RelayVendorId; view: RelayView } | undefined {
  // The last one wins: `pnpm relay:dev -- --relay=sendblue` follows the script's own `--relay`.
  const flag = argv.findLast((a) => a === '--relay' || a.startsWith('--relay='));
  if (flag === undefined) return undefined;
  const raw = (
    flag.includes('=') ? flag.slice('--relay='.length) : (env['TRAV_RELAY_VENDOR'] ?? '')
  )
    .trim()
    .toLowerCase();
  const vendor = raw === '' ? 'photon' : raw;
  if (!isRelayVendorId(vendor)) {
    throw new Error(`--relay must be photon or sendblue, got "${vendor}"`);
  }
  const viewFlag = argv.findLast((a) => a.startsWith('--relay-view='));
  const rawView = viewFlag?.slice('--relay-view='.length) ?? 'overlay';
  if (rawView !== 'phone' && rawView !== 'overlay') {
    throw new Error(`--relay-view must be phone or overlay, got "${rawView}"`);
  }
  return { vendor, view: rawView };
}

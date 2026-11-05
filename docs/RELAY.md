# iMessage relay channel (T-169)

Trav can live in an iMessage group through a **relay vendor**: a company that runs a real iMessage line (a phone number or Apple ID on Apple hardware) and gives you an HTTP API for it. The vendor posts each group event to a webhook. Trav replies by calling the vendor's send API. This doc covers the adapter, how to run it locally against the mock relay, and what it would take to go live.

**Nothing in this repo calls a real vendor** unless `TRAV_CHANNEL=imessage_relay`, `TRAV_RELAY_LIVE=1`, the vendor key **and** `TRAV_RELAY_LINE` are all set (see [Going live](#going-live)). Tests, `pnpm relay:dev` and the demo always use the in-process mock relay.

## Run it locally

```sh
pnpm relay:dev                                   # simulator UI over the mock Photon relay
pnpm relay:dev -- --relay=sendblue               # ... over the mock Sendblue relay
pnpm relay:dev -- --relay-view=phone             # show only what an iPhone shows
pnpm demo:barcelona -- --relay                   # the whole Barcelona demo over the relay (Photon)
pnpm demo:barcelona -- --relay=sendblue --quiet  # same over Sendblue, summary only
```

`relay:dev` is `pnpm sim` with each session's channel swapped for the **relay loopback**:

```
member in the UI ─▶ the "world" (what the members' phones show)
  ─▶ mock relay builds the vendor's signed webhook (exact bytes + signature header)
  ─▶ RelayChannel.handleWebhook: size cap, signature, parse, dedupe, id mapping
  ─▶ Trav (the real runtime, offline model)
Trav ─▶ withOutboundPacing (T-071) ─▶ RelayChannel: text fallback, PNG QR codes, retries
  ─▶ the vendor-shaped HTTP request ─▶ mock relay (validates it like the vendor would, records it)
  ─▶ the world transcript, under the vendor's message id
```

It also starts a webhook receiver on `http://127.0.0.1:5181/relay/webhook` (`TRAV_RELAY_PORT` changes the port; `GET /healthz` answers `{"ok":true}`). It forwards to the current session's relay channel, so you can post a signed delivery by hand. Unsigned or tampered bodies get `401`, and requests whose `Host` is not loopback get `403`.

**Views.** iMessage has no buttons or cards, so on the wire every card is its `fallbackText`, with answer instructions reworded for the line (D-048: `👍 to book`, `reply "yes"`, `reply "sent"`).
- `overlay` (default) also draws the card and buttons Trav meant, as a developer aid. A tap is **never** sent as a tap. It is played as what the member would do on iMessage: a 👍 / 👎 tapback when the action has one, otherwise its first text alias as a reply (`sent`, `undo`), and an option's number for a pick. That action then travels as a signed webhook. A T-165 ledger notice is drawn as the grey line, but on the wire it is a plain one-line text.
- `phone` shows exactly what a phone shows (text, images, tapbacks). Button taps are refused.

## How Trav uses the line

| | Photon | Sendblue |
|---|---|---|
| Inbound group messages, DMs, images | yes | yes (one `media_url` per message) |
| Inbound tapbacks | structured `reaction.*` events | the iOS text form (`Liked “…”`), matched to the one Trav message it quotes; an ambiguous quote, or a truncated one under 20 characters, stays plain text |
| Trav sends tapbacks | yes | yes |
| Inline (threaded) replies | yes | no |
| Joins / leaves | `chat.participant_*` events | diffed from `participants` on each group message |
| Webhook auth | `x-photon-signature: t=…,v1=HMAC-SHA256("t.body")`, 5 min replay window | shared secret in `sb-signing-secret`, constant-time compare |
| Idempotency key on sends | yes (`idempotency-key`) | no |

- **Approvals** are a 👍 tapback on the proposal or a reply of "yes" (or another D-042 alias). The core maps the vendor id of the 👍 target back to the Trav message id, so the agent sees a 👍 on its own card. A relayed approval is still only an approval: every booking goes through `ApprovalPolicy` and the audit log, as on any channel.
- **Images**: QR codes (SVG data URLs) are rendered to PNG and published through a media host. The mock host is in memory; a live deployment needs a real `https:` host (T-188). Inbound attachment URLs must be `https:`. They are passed to Trav only through `resolveInboundMedia`, because the receipt reader never opens a URL.
- **Idempotency**: inbound events are deduped on the vendor's message / event id (bounded memory of 10,000; T-185 makes it persistent). Each Trav message id is sent at most once. A resend returns the first result, and an in-flight resend waits for it.
- **Retries**: exponential backoff (500 ms × 2ⁿ, capped at 8 s, `Retry-After` honored), 3 tries. For a vendor without idempotency keys (Sendblue), only `429` and `503` are retried, since both guarantee nothing was sent. Any other failure (a `500`, a network error, a lost reply) comes back as **not retryable**, so the pacing queue doesn't requeue it either. A lost reply never becomes a double text.
- **Pacing (T-071, D-048)**: `withOutboundPacing` sits in front: 500 sends per rolling 24 h with 20 reserved for approval prompts, a send-to-receive ratio of at most `max(10, 3 × receives)`, and content-free replies sent as a 👍. The inbound burst debounce is **not** wired in front of the relay yet, because a merged "do" + "it" would read as an exact approval until the agent refuses merged approvals (D-048 §4).
- **Privacy**: DMs keep the simulator's refusals. A DM goes only to a known contact handle bound to the member it is addressed to; a raw phone number or email, an unknown handle, or a contact with no member binding is refused (`unknown handle`, as on the simulator). A ticket only goes to its holder, a private card expense only to its owner, and a DM-only card never goes to the group. Webhook content (text, names, URLs) is untrusted data. Diagnostics carry no text, names or keys.

## Code map

| File | What |
|---|---|
| `packages/adapters/src/channel/relay/core.ts` | `createRelayChannel`: the vendor-neutral `ChannelAdapter` (`kind: 'imessage_relay'`) |
| `.../relay/vendors/photon.ts`, `sendblue.ts` | Pure vendor modules: verify, parse, build sends, read replies |
| `.../relay/http.ts` | Webhook receiver (127.0.0.1 only, loopback `Host` check, 1 MB cap) |
| `.../relay/config.ts` | Env config and the live gate; `createLiveRelayTransport` is the only code that calls `fetch` |
| `.../relay/media.ts`, `tapbacks.ts` | PNG rendering and media hosts; tapback ↔ emoji, `Liked “…”` parsing |
| `packages/adapters/src/mock/relay/` | The mock relay (vendor-accurate request validation, signed webhooks, faults) and the loopback |
| `apps/simulator/src/server/relay.ts` | `relay:dev` wiring: a loopback per simulator session |
| `fixtures/relay/<vendor>/` | Recorded webhook bodies, send requests and send replies for the contract tests |

Tests: `channel/relay/contract.test.ts` runs both vendors against the fixtures, with signatures computed independently. `core.test.ts` covers dedupe, retries, id mapping and refusals. `config.test.ts` checks the live gate and that only `config.ts` references `fetch`. `mock/relay/loopback.test.ts` covers the loopback and overlay. `apps/simulator/src/server/relay.test.ts` runs the full Barcelona demo over both mock vendors and the 127.0.0.1 receiver.

## Going live

Not done in v0, and never from tests. To go live, each step is required:

1. **Get a line.** Photon: the Business plan includes group messaging. Sendblue: the plan must include the (beta) group API, and the line answers only in groups it was added to. Use a dedicated line, never a personal Apple ID. Self-hosted lines (BlueBubbles, T-187) are for Dean's own dogfooding only.
2. **Re-record the fixtures.** The JSON shapes in the vendor modules and `fixtures/relay/` were reconstructed from the vendors' public descriptions, not from real traffic. Capture one real delivery of each kind (message, image, tapback, join/leave, echo) and one reply per send from the account's webhook log. Replace the fixture bodies, then fix any field the contract tests flag.
3. **Expose the receiver.** It binds 127.0.0.1 only. Run a tunnel you control (for example `cloudflared` or `ngrok`) to `127.0.0.1:5181`, construct the receiver with `loopbackHostOnly: false` (the `Host` will be the tunnel's), and register `https://<tunnel>/relay/webhook` with the vendor. Nothing in this repo opens a tunnel.
4. **Set the environment** in `.env` (gitignored; never commit or print it):

   | Variable | Meaning |
   |---|---|
   | `TRAV_CHANNEL=imessage_relay` | Turns the relay on (`createRelayFromEnv`) |
   | `TRAV_RELAY_VENDOR` | `photon` (default) or `sendblue` |
   | `TRAV_RELAY_LIVE=1` | Required for any real call |
   | `TRAV_RELAY_API_KEY` | Photon bearer key, or Sendblue key id |
   | `TRAV_RELAY_API_SECRET` | Sendblue secret key (required for Sendblue live) |
   | `TRAV_RELAY_WEBHOOK_SECRET` | Photon signing secret, or Sendblue signing secret. If empty while live, **every** delivery is refused (fail closed) |
   | `TRAV_RELAY_LINE` | The line's own number / Apple ID, so its echoes are dropped. Required for live: without it the channel stays on the mock (never sends as the fictional mock line) |
   | `TRAV_RELAY_PORT` | Receiver port (default 5181) |

   If `TRAV_CHANNEL`, `TRAV_RELAY_LIVE=1`, `TRAV_RELAY_API_KEY` or `TRAV_RELAY_LINE` is missing (or `TRAV_RELAY_API_SECRET` for Sendblue), the channel stays on the mock relay, and `resolveRelayConfig` gives the reason. `describeRelayConfig` logs which variables are set, never their values. The live transport refuses any URL outside the vendor's `https` API origin.
5. **Still open before real groups:** a persistent dedupe and pacing store (T-185), a real media host plus inbound downloads into `.trav/attachments/` (T-188), contact and consent onboarding for a member's first DM (T-070), and the agent-side follow-ups listed below.

## Known gaps

- **Unthreaded "sent" / "got it" (agent).** The agent binds a "sent" / "got it" reply to the final settle card only as a quote-reply. On Sendblue, which has no inline replies, a bare "sent" in the group is not tied to the card, even though the card says `reply "sent"`. A 👍 on the card works on both vendors (the agent reads it by role).
- **The Sendblue demo plays [Sent] as a 👍, not a "sent" reply.** Because of the gap above, the overlay plays [Sent] / [Got it] as a 👍 tapback on lines without threads, so `pnpm demo:barcelona --relay=sendblue` does not exercise the `reply "sent"` path the card advertises. The fix is agent-side (a follow-up; `packages/agent` is out of T-169's scope).
- **"tap Sent" on a line with no buttons.** The settle-up DMs say "tap Sent on the group card". D-048 rewording only touches messages that carry actions or an answer card, so on iMessage, which has no buttons, that line still says "tap". Agent-side follow-up.
- **Inbound debounce** is off in front of the relay (see Pacing).
- In MMS-fallback groups, iOS turns tapbacks into `Liked “…”` texts. The core reads that text as a tapback only where tapbacks arrive as text: on Sendblue (no structured reaction events), and on Photon only when the message's service is SMS or MMS. A truncated quote must be at least 20 characters to match by prefix.
- **Other non-iMessage services on Photon.** Only `sms` and `mms` count as text-tapback services. A thread Photon labels with another service (for example `RCS`) reads `Liked “…”` as a plain message, so a typed 👍 there is not an approval. It fails closed, never a wrong purchase. Check the real service strings when re-recording the fixtures.

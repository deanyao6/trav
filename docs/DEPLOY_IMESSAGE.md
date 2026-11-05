# Deploying Trav on a self-hosted iMessage line (BlueBubbles, T-187)

**For Dean's own dogfooding only.** A self-hosted line is a Mac signed in to an Apple ID, with the open-source BlueBubbles server exposing that Mac's Messages app over HTTP. Research found a self-hosted line banned within a day at launch volume. So:

- Use a **dedicated Mac** and a **dedicated Apple ID** made for Trav. Never Dean's personal Apple ID, never a family member's.
- Put it only in **Dean's own test groups**. Friends' real trip groups go on a paid relay line (Photon or Sendblue, docs/RELAY.md).
- Keep the volume low. The adapter caps a BlueBubbles line at **150 iMessages per rolling 24 h** (`BLUEBUBBLES_MAX_SENDS_PER_DAY`, against 500 for a paid line). The cap counts what goes on the wire: BlueBubbles sends each image as its own iMessage after the text, so a ticket DM with its QR counts as 2. Approvals keep their 20 reserved slots, and anything over the cap queues instead of being dropped (T-071).
- If a QR upload fails after its text went out, the text is not sent again. The message reports a retryable failure, the pacing queue retries only the image (up to 3 tries in all), and after that it is reported as sent but degraded, with `missingImages`.

Nothing in this repo talks to a real BlueBubbles server today. Tests, `pnpm relay:dev` and `pnpm demo:barcelona --relay=bluebubbles` use the fake server in `packages/adapters/src/mock/relay/` (origin `https://bluebubbles.mock-relay.invalid`). There is also no long-running process yet that would run the live channel: that is `apps/server` (T-188). This guide is what to set up once that lands.

## 1. The Mac

- Any Apple-silicon Mac that can stay on (a Mac mini is ideal), on the latest macOS that BlueBubbles supports.
- Settings → Energy: never sleep, start up automatically after a power failure. Settings → Users & Groups: log in automatically to the Trav user. Messages only runs inside a logged-in session.
- A standard (non-admin) macOS user for Trav. FileVault on. No other accounts, no browsing, no personal data on this machine.

## 2. The Apple ID

- Create a new Apple ID for Trav (an email-based ID; a phone number is optional). Turn on two-factor authentication and store the recovery key offline.
- Sign in to **Messages only** (not iCloud Drive, Photos, or Keychain). In Messages → Settings → iMessage, choose the address people will text. That address is `TRAV_RELAY_LINE`.
- Members save the line as a contact. If they save it under a name other than "Trav" (for example "Trav Bot"), put that name in `TRAV_RELAY_CONTACT_NAME` so "Trav Bot, split dinner" is read as an @trav (step 5).
- Send a few normal messages to and from the account before adding it to a group. A brand-new account that only talks to groups is the pattern that gets flagged.

## 3. BlueBubbles server

1. Install the BlueBubbles server app from the project's official releases (bluebubbles.app). Download it on the Mac itself and check that it is the signed release.
2. Grant what it asks for: Full Disk Access (to read the Messages database) and Accessibility (to drive Messages for sends).
3. Set a long random **server password** (32+ characters, from a password manager). That password is `TRAV_RELAY_API_KEY`. The server's REST API takes it as the `?password=` query parameter. Trav's transport never logs request URLs.
4. **Private API (optional).** Tapbacks out and inline (threaded) replies need the server's Private API helper, which requires lowering macOS System Integrity Protection on this Mac. That is a real security trade-off. It is acceptable on a dedicated machine that holds nothing else, and never on a personal Mac. Without it, set `TRAV_BLUEBUBBLES_PRIVATE_API=` (empty). Trav then sends with AppleScript, sends no tapbacks and no threads, and asks for "reply yes" instead of 👍. Members' own tapbacks still arrive either way.
5. Leave the server's own public-URL features (its Cloudflare or ngrok integration, Firebase) **off** if Trav runs on the same Mac. Nothing needs to reach the server from outside.

## 4. Network: same Mac first, tunnel only if Trav moves

**Recommended: Trav runs on the same Mac.** Then nothing is exposed to the internet:

- Trav → BlueBubbles: `TRAV_BLUEBUBBLES_URL=http://127.0.0.1:1234` (the server's port). Plain `http` is accepted **only** on `127.0.0.1` or `localhost`. Any other host must be `https`, and the URL must carry no credentials and no path.
- BlueBubbles → Trav: in the server's Webhooks settings, add
  `http://127.0.0.1:5181/relay/webhook?token=<TRAV_RELAY_WEBHOOK_SECRET>`
  (the secret from `openssl rand -hex 32`, pasted as is) with the events **New Messages**, **Participant Added**, **Participant Removed** and **Participant Left**. Trav's receiver binds 127.0.0.1 only. BlueBubbles can neither sign a webhook nor add a header, so the shared secret travels in the URL. Trav compares it in constant time and accepts exactly one `token` parameter. A wrong, missing or doubled token gets `401`.

**If Trav later runs elsewhere (Fly.io or Render, T-188):** both directions need a tunnel you control, for example a named `cloudflared` tunnel:

- Expose the BlueBubbles server at `https://bb.<your-domain>` and set `TRAV_BLUEBUBBLES_URL` to that origin. Put Cloudflare Access (or an IP allowlist) in front of it, so the password is not the only guard.
- Expose Trav's receiver at `https://trav.<your-domain>/relay/webhook`. Build the receiver with `loopbackHostOnly: false` (the `Host` header will be the tunnel's), and register `https://trav.<your-domain>/relay/webhook?token=<secret>` in BlueBubbles.
- Nothing in this repo opens a tunnel. Never use a temporary public URL: the webhook URL carries the secret.

## 5. Environment

In `.env` on the Mac (gitignored; never commit, print or paste it):

| Variable | Value |
|---|---|
| `TRAV_CHANNEL` | `imessage_relay` |
| `TRAV_RELAY_VENDOR` | `bluebubbles` |
| `TRAV_RELAY_LIVE` | `1`. Without it the channel stays on the mock, whatever else is set |
| `TRAV_RELAY_API_KEY` | The BlueBubbles server password |
| `TRAV_RELAY_WEBHOOK_SECRET` | A second long random value, also put in the registered webhook URL as `?token=`. It travels in a URL, so make it URL-safe: generate it with `openssl rand -hex 32`. Only letters, digits and `- . _ ~` are accepted; anything else (`+`, `&`, `#`, `%`, `/`) keeps the line on the mock, with a reason that says so. Empty while live means every delivery is refused (fail closed) |
| `TRAV_RELAY_LINE` | The Apple ID address Messages sends from (so Trav drops its own echoes). Required for live |
| `TRAV_BLUEBUBBLES_URL` | `http://127.0.0.1:1234`, or the server's `https` tunnel origin. Required for live |
| `TRAV_BLUEBUBBLES_PRIVATE_API` | `1` only if the Private API helper is installed (step 3.4) |
| `TRAV_RELAY_CONTACT_NAME` | Optional. Comma-separated names members saved the line under, other than "Trav" (for example `Trav Bot`) |
| `TRAV_RELAY_PORT` | Receiver port, default `5181` |

`resolveRelayConfig` explains the mode it chose ("mock relay: TRAV_RELAY_LIVE=1 but TRAV_BLUEBUBBLES_URL is not set", and so on) without echoing any value. `describeRelayConfig` prints one status line that says which variables are set, never what they hold.

## 6. How "@trav" works on iMessage

iMessage has no bot mentions. Trav is addressed when a message:

- has `@trav` anywhere, or starts with "trav," / "hey trav" / "trav can you" (the agent's own rules, `packages/agent/src/mention.ts`, the same on every channel);
- has a structured mention of the line from the iOS mention picker (BlueBubbles reports it in `attributedBody`);
- starts with one of `TRAV_RELAY_CONTACT_NAME`'s names followed by `,` `:` `!` `?`, nothing, or a request ("Trav Bot, split dinner", "Trav Bot can you split dinner"), or has `@<name>` anywhere.

"ask Trav Bot later" (the name mid-sentence) or "Trav Bot is asleep" is talking *about* Trav, and `"Trav Bot," she said` is quoting someone, so none of them is a mention. A mention is only addressing. It is never an approval, and every booking still goes through `ApprovalPolicy` and the audit log.

## 7. Before the first live message

1. **Re-record the fixtures.** `fixtures/relay/bluebubbles/` was reconstructed from the server's public docs, not from real traffic. From the real server, capture one webhook of each kind (a message, a photo, a tapback, a tapback removal, an inline reply, a join, a leave, Trav's own echo) and the reply to one text, one attachment and one react call. Replace the fixture bodies, then run `pnpm test` and fix any field the contract tests flag.
2. **Persistent dedupe (T-185).** BlueBubbles re-sends webhooks after a reconnect. Pass `seen: <a SQLite-backed RelaySeenStore>` to the channel so a restart doesn't replay old messages. The default store is in memory.
3. **Inbound attachments (T-188).** A member's photo arrives as `<server>/api/v1/attachment/<guid>/download`. The downloader must add the password, save into `.trav/attachments/`, and hand that path to `resolveInboundMedia`. The receipt reader never opens a URL.
4. Start with a two-person test group (Dean plus a second test Apple ID). Check that a message, a 👍 on a proposal, a receipt photo and a ticket QR all work, and that `pacing.failures()` is empty, before adding anyone else.

## 8. If the line gets flagged

Stop Trav (`TRAV_RELAY_LIVE=` and restart). Don't create a new Apple ID on the same Mac right away. Move the test groups to a paid line instead. A ban on the dedicated ID costs nothing else, which is why it must never be a personal one.

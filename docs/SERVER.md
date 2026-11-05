# apps/server: Trav on a relay line (T-188, D-056)

One long-running process is Trav on an iMessage relay line. It's meant to run on the relay Mac (BlueBubbles, docs/DEPLOY_IMESSAGE.md) or a vendor-hosted line (Photon, Sendblue; docs/RELAY.md), and it can be containerized for Fly.io or Render later. It owns:

- the HTTP endpoint (below);
- the runtime: `createTravRuntime` over SQLite (`node:sqlite`, T-185);
- the relay channel: `createRelayFromEnv`, the in-process fake relay unless every live gate is set, behind T-071 pacing;
- the scheduler on the real clock: Morning After, daily settle-up, digests, card imports, expiries and Wrapped, drained every `TRAV_SERVER_TICK_MS` (default 30 s, minimum 1 s) and once at boot to catch up;
- STOP / START and "@trav delete my data" (docs/PRIVACY_TEXTING.md);
- JSON logs on stdout.

**Nothing here calls a live service.** The line stays on the fake relay unless `TRAV_RELAY_LIVE=1`, the vendor key and `TRAV_RELAY_LINE` are all set (docs/RELAY.md, "Going live"). The model stays offline under `TRAV_OFFLINE=1`. `--demo` forces the fake relay whatever the env says.

## Run it

```sh
TRAV_OFFLINE=1 pnpm server:demo     # Barcelona on the fake relay, own DB (.trav/server-demo.sqlite), clock from the Razzmatazz moment
TRAV_OFFLINE=1 pnpm server          # the line; groups from TRAV_SERVER_GROUPS
```

With the demo running, play a member's line through the signed webhook path:

```sh
curl -s 127.0.0.1:5181/healthz
curl -s -X POST 127.0.0.1:5181/dev/say -H 'content-type: application/json' \
  -d '{"from":"mem_dean","text":"@trav get the 5 of us Razzmatazz tickets, Henry'"'"'s sick"}'
```

The reply lists what went out on the wire: the receipt in the group and five ticket DMs with a QR each. The demo's database persists, so stop and restart and the tab is still there. Delete `.trav/server-demo.sqlite` to start over.

The server reads its env from the shell (like `pnpm sim`). Nothing loads `.env` automatically.

## Endpoints

| Path | What |
|---|---|
| `POST /relay/webhook` | The vendor's signed delivery → `RelayChannel.handleWebhook` (size cap, signature, dedupe). Unsigned or tampered: `401`; wrong method: `405` |
| `GET /healthz` | `{ ok, mode, vendor, model, groups, jobs, queued, uptimeS }`, with counts only and no personal data. `503` if the database can't be read |
| `POST /dev/say` | **Demo and loopback only** (`404` otherwise). `content-type: application/json` is required (`415` otherwise). Body: `{ from: <memberId>, text, dm? }` → the fake relay signs it as that member → the webhook path |

The `Host` header must be loopback or one of `TRAV_SERVER_PUBLIC_HOSTS`. Anything else gets `403`. Any request with an `Origin` header gets `403`, except `GET /healthz`. Browsers send `Origin`; vendor webhooks and curl don't. So a web page open in a browser on the same Mac can't drive Trav, and the JSON requirement means no CORS "simple request" (text/plain, a form) reaches `/dev/say`.

**Shutdown.** On SIGINT / SIGTERM the server stops the scheduler and the listener, finishes the turn in progress, then ticks the pacing queue for up to 5 s so queued ticket DMs and recaps can go out. Anything still queued after that is lost (the queue isn't stored), and it's logged as `send.lost_on_close` with a count.

## Who it answers

- A chat that isn't provisioned gets no answer at all.
- In a provisioned chat, an unknown number is a **guest**: it can chat, but never book, approve or pay, and never gets a DM (SAFETY §2.5).
- A DM goes only to an address that is that member's own `senderId` (`resolveContact`). Never the line itself, and never an address bound to another member.

**Groups file** (`TRAV_SERVER_GROUPS`, JSON, strictly validated; an error names the field, never its value):

```json
{ "groups": [ {
  "groupId": "grp_lisbon", "name": "lisbon", "chatId": "<the relay's chat id>", "currency": "EUR",
  "perPersonAutoCapMinor": 6000,
  "members": [ { "memberId": "mem_dean", "name": "Dean", "address": "+1...", "birthDate": "1995-01-01", "role": "lead" } ],
  "trip": { "tripId": "trip_lisbon", "name": "lisbon", "city": "Lisbon", "countryCode": "PT",
            "timeZone": "Europe/Lisbon", "startDate": "2027-05-01", "endDate": "2027-05-05" }
} ] }
```

Provisioning is idempotent: a group, member or trip already stored is left as is, so editing the file never rewrites history. Without `birthDate` a member's age is unknown, which means no roast mode and family-safe suggestions.

## What survives a restart

Everything in the SQLite file: groups, members, trips, the ledger, bookings, audit, the agent's runtime state and dedupe keys, and the scheduler queue (T-185, D-054). On top of that, the relay's dedupe keys (`seenKeys('relay')`), the vendor id → Trav id map (so a 👍 on a card posted before the restart still approves it), the chat rosters, the opt-out list and its HMAC key, and tickets held for opted-out members. Pacing counters and the pacing queue are in memory: a restart resets the day's send count, and a send still queued after the shutdown drain is lost.

## Env

| Variable | Meaning |
|---|---|
| `TRAV_RELAY_PORT` | Port (default 5181) |
| `TRAV_SERVER_DB` | SQLite path; must sit under a `.trav/` directory (default `<repo>/.trav/trav.sqlite`) |
| `TRAV_SERVER_GROUPS` | Groups file |
| `TRAV_SERVER_TICK_MS` | Scheduler tick (default 30000, minimum 1000) |
| `TRAV_SERVER_PUBLIC_HOSTS` | Extra accepted `Host` names (the tunnel's or platform's hostname), comma-separated |
| `TRAV_SERVER_DEPLOY` + `TRAV_SERVER_HOST` | Containers only: `TRAV_SERVER_DEPLOY=1 TRAV_SERVER_HOST=0.0.0.0`. Without both, the server binds 127.0.0.1 and refuses any other host |

Plus the relay's own variables (docs/RELAY.md) and the model's (`.env.example`). The startup log names which are set, never their values.

## Logs

One JSON object per line: `ts`, `level`, `event`, and then only fields from a fixed allowlist (`log.ts`). Strings that aren't id-like (a `+`, an `@`, a quote, a newline, an emoji) become `[redacted]`. So message text, phone numbers, emails, secrets and env values can't reach a log by accident. A relay send failure is logged by type only, because its detail is the vendor's error text.

## Deploying later (Fly.io or Render)

Not done in v0, and nothing here is wired to a platform. What it takes:

1. A container running `node --import tsx apps/server/src/main.ts` with `TRAV_SERVER_DEPLOY=1 TRAV_SERVER_HOST=0.0.0.0`, and `TRAV_SERVER_PUBLIC_HOSTS` set to the app's hostname.
2. A persistent volume mounted at a path that contains `.trav/` (for example `/data/.trav/trav.sqlite` via `TRAV_SERVER_DB`). One instance only: the runtime is single-writer over its file (D-054 §7).
3. Secrets in the platform's secret store, never in the image.
4. `GET /healthz` as the platform's health check.
5. Still open before real members: a real `https:` media host for QR images and inbound attachment downloads into `.trav/attachments/` (docs/RELAY.md), first-DM consent onboarding (T-070), and a legal read of docs/PRIVACY_TEXTING.md.

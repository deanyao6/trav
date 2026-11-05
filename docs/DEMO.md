# Trav

Trav is an AI group-chat agent that stays with a group before, during, and after a trip, keeping the group's expenses, experiences, and memories in one place. See `MOTIVATION.md` for the why.

This repo is the v0: a local, demoable build. **No real money, no real messages, no real credentials.** Every booking, payment, card feed, inbox and photo album is a mock adapter, and every command below runs offline by default.

## Setup

Needs Node 22.13+ and pnpm 10+.

```sh
pnpm install
```

That's it for offline use. A `.env` file is optional (see [Offline vs live](#offline-vs-live)).

## The Barcelona demo (one command)

```sh
pnpm demo:barcelona
```

Runs the flagship Barcelona trip end to end through the real Trav runtime, offline, on a simulated clock, and prints the chat as it goes:

trip setup → multi-origin group flights → lodging → Barça tickets (two seat sections, so Trav posts the options and buys on Dean's pick) → dinner logged from chat → Arjun's Uber email receipt (DM-only "looks shared?" → share) → €84 dinner split "everyone but Henry" → **"@trav get the 5 of us Razzmatazz tickets, Henry's sick"** → bought on the ask (explicit ask, under the group's €500 auto-buy cap, through ApprovalPolicy) → one mock purchase → receipt in the group → 5 per-person ticket DMs → €90 split among only those 5 → Crowley's 2am Uber from the Plaid-shaped card feed (DM-only confirm) → Morning After recap → "@trav settle now" → end-of-trip Wrapped.

It checks 55 things along the way (ledger sums in integer cents, the approval and audit trail, Henry never being charged or told why he's out, nothing private ever landing in the group) and exits 0 only if all of them pass. The transcript is written to [`docs/DEMO_TRANSCRIPT.md`](DEMO_TRANSCRIPT.md).

- `pnpm demo:barcelona --no-write` prints without touching `docs/DEMO_TRANSCRIPT.md`.
- `pnpm demo:barcelona --quiet` prints only the PASS/FAIL line (and any failed checks).

The demo is always offline, even if a key is set. Flights, the stay and the Uber rider split all run in chat now. The transcript header lists the one step that still doesn't run fully in chat: settle-up. A 👍 or [Paid] on the card ticks off the payer's row, but payee confirmation isn't built yet (T-166), so the demo applies the remaining transfers itself and checks that everyone ends at €0.

## The group chat simulator

```sh
pnpm sim
```

Then open http://127.0.0.1:5179. It binds to 127.0.0.1 only; set `TRAV_SIM_PORT` to change the port.

It's an iMessage-style group chat backed by the real Trav runtime over mock providers (the same runtime the demo uses). It opens on the Barcelona chat on the Saturday night, with the six friends already talking about Razzmatazz and Henry out sick.

- Pick a trip on the left (Barcelona, Lisbon, Turks and Caicos) and choose who you're sending as. All three chats run on the real runtime. Lisbon and Turks and Caicos are seeded from `fixtures/groups/`. Turks and Caicos opens with Trav's family-mode notice because Lily is under 18, so that chat gets no nightlife or alcohol suggestions and no roasts.
- Type `@trav ...` to talk to Trav. For example, as Dean: `@trav get the 5 of us Razzmatazz tickets, Henry's sick`, and Trav buys on the ask (explicit ask under the €500 auto-buy cap). You get a mock purchase, a receipt in the group, and one ticket in each of the five DM tabs on the right.
- Private items (tickets, "looks shared?" prompts for email and card imports) show up only in that member's DM tab.
- The top bar shows the simulated clock. **+1 hour**, **next morning** and **end of trip** move it forward and run whatever's due (daily tab, Morning After, Wrapped). **replay** steps through `fixtures/chats/barcelona.jsonl` one line at a time, and **restart demo** to reset.
- An **offline** badge shows when no model call can leave the machine.

`pnpm sim` serves the UI through Vite dev middleware. To serve a production build instead:

```sh
pnpm --filter @trav/simulator build
pnpm --filter @trav/simulator start
```

The headless-browser smoke test (`pnpm --filter @trav/simulator qa`) needs a one-time Playwright Chromium install, plus local port binding. See the header of `apps/simulator/e2e/smoke.spec.ts`.

## Evals

```sh
pnpm eval
```

Replays the scenario suite (`packages/evals/scenarios`) through Trav, grades every decision, prints a summary, and writes `evals/reports/<timestamp>.md` and `.json`. It exits 1 on any safety failure. Useful flags:

- `--regression` runs only the regression suite.
- `--heldout` runs only the held-out set.
- `--filter razzmatazz` runs only matching scenario ids.
- `--no-report` prints the summary and writes nothing.
- `--live` uses live models (see below).
- `--help` lists everything else.

Scenarios marked "known gap" are waiting on a named backlog task, and they're scored separately.

## Tests and checks

```sh
pnpm check        # typecheck + lint + tests (this is the CI)
pnpm test         # Vitest, always offline (TRAV_OFFLINE=1 is forced)
pnpm typecheck
pnpm lint
```

## Offline vs live

**Offline is the default.** Trav is offline whenever `TRAV_OFFLINE=1` is set **or** no `TRAV_ANTHROPIC_API_KEY` is present. In offline mode, model calls are answered by deterministic scripts (`fixtures/scripts/*.json`) and stub fallbacks, so nothing leaves the machine. Unscripted asks get a polite "say it again" reply and a line in `.trav/offline-misses.jsonl`. Tests and `pnpm demo:barcelona` are always offline.

**Live mode** is only for evals and demo checks. Nothing reads `.env` automatically, so export the variables yourself:

```sh
cp .env.example .env              # then fill in TRAV_ANTHROPIC_API_KEY and set TRAV_OFFLINE=0
set -a; . ./.env; set +a          # export them into this shell
pnpm sim                          # the simulator badge drops "offline"
pnpm eval --live                  # live models; rubric graders on TRAV_GRADER_MODEL
```

- Models: `TRAV_MODEL` (main chat loop), `TRAV_FAST_MODEL` (small classifiers), and `TRAV_GRADER_MODEL` (eval grading, so Trav never grades itself).
- The key is `TRAV_ANTHROPIC_API_KEY`, never `ANTHROPIC_API_KEY`.
- Every live call goes through one client wrapper that records tokens and estimated cost in `.trav/spend.json`. It refuses live calls once the estimate reaches `TRAV_LIVE_BUDGET_USD` (default 45).
- `.env` is gitignored. Never commit it.

## What's mocked

Everything that would touch money, messages or someone's accounts:

| Real-world thing | v0 |
|---|---|
| iMessage / WhatsApp group chats | in-memory simulator channel (`packages/adapters`); real relays are stubs behind the same interface |
| Event tickets (Razzmatazz, Barça) | mock ticket provider with per-person QR codes |
| Flights | mock multi-origin inventory (`fixtures/flights`); the group optimizer in `packages/core` is real |
| Lodging | mock lodging inventory (`fixtures/lodging`) |
| Payments / card charges | mock payments adapter; no money moves |
| Card transactions (Plaid) | Plaid-sandbox-shaped fixtures (`fixtures/transactions`) |
| Email receipts (Uber/Lyft) | mock inbox (`fixtures/emails`) |
| Shared photo album | mock, opt-in per member (`fixtures/album`) |
| The model | offline scripts unless you opt into live mode |

What is real: the ledger (splits, balances, minimal settle-up transfers, all in integer minor units), the approval policy (spending caps, confirm above the cap, refundable first), the hash-chained audit log, the flight optimizer, the agent's tool-use loop, privacy lanes (card and email data stays in the owner's DM until they share it), roast guardrails, and the minors rules.

Every booking goes through `ApprovalPolicy` and lands in the audit log. `pnpm audit:verify` checks the hash chain of the on-disk audit log (`.trav/trav.sqlite`) and says so if there isn't one yet. The demo checks its own chain in-process.

## Layout

```
packages/core       domain types, ledger, splits, settlement, approval policy, flight optimizer (pure)
packages/agent      Trav's agent loop, prompts, personality, memory, offline model client
packages/adapters   channel and provider adapters (all mock in v0)
packages/evals      scenario runner, graders, reports
apps/simulator      web chat simulator, server, and the demo CLI
fixtures/           synthetic data for every feature
docs/               architecture, decisions, voice, safety, demo transcript
```

# Trav Backlog

Format: `- [ ] T-xxx | P0/P1/P2 | title | source | acceptance`
Only the Orchestrator edits the prioritized list. Agents append to `## Proposed`.

## Prioritized

### P0 — v0 demo (seed list; the Orchestrator may refine after the research sprint)
- [ ] T-001 | P0 | Monorepo scaffold (pnpm workspaces, TS, Vitest, ESLint/Prettier, `pnpm test/typecheck/lint`, .env.example, .gitignore) | source: core | acceptance: all scripts run green on an empty test; CI-style script `pnpm check` runs all three
- [ ] T-002 | P0 | Domain types: Group, Member (age, opt-ins), Trip, Activity, Attendance ("who's in tonight"), Expense, Split, LedgerEntry, Booking, AuditEvent, Money (integer minor units + currency) | source: core | acceptance: types exported from packages/core; Money helpers with rounding tests
- [ ] T-003 | P0 | Ledger + splits: equal, exclude members, custom shares, itemized with tax/tip pro-rata; balances; minimal settle-up transfers | source: core | acceptance: sums always reconcile to the cent; property-based tests; 10+ unit cases incl. remainders
- [ ] T-004 | P0 | ApprovalPolicy + audit log: per-group/per-person caps, confirm above cap or non-refundable, approver rules, idempotency keys | source: safety | acceptance: test proves no booking path bypasses policy; duplicate request does not double-buy
- [ ] T-005 | P0 | Storage layer (SQLite) for groups, trips, ledger, bookings, audit, memory | source: core | acceptance: repository interfaces + in-memory and SQLite impls, same test suite passes on both
- [ ] T-006 | P0 | Channel abstraction + local simulator channel; CLI runner to play a scripted chat | source: adapters | acceptance: CLI replays a fixture chat and prints Trav replies in offline mode
- [ ] T-007 | P0 | Trav agent loop: @mention detection, Claude tool use, tool registry, group state, offline scripted mode | source: agent | acceptance: offline test of "@trav get the 5 of us Razzmatazz tickets, Henry's sick" produces a proposal for 5 named members
- [ ] T-008 | P0 | Mock providers: tickets (per-person QR codes as PNG/SVG), flights, lodging, payments | source: adapters | acceptance: deterministic inventory from fixtures; sold-out and over-budget cases
- [ ] T-009 | P0 | Razzmatazz flow end to end: proposal → approval in chat → mock purchase → receipt card → per-person QR delivery → ledger split among only attendees | source: agent | acceptance: integration test passes offline; audit log has every step
- [ ] T-010 | P0 | Expense from chat text ("I paid €84 for dinner, split w everyone but Henry") with confirmation | source: agent | acceptance: 15+ phrasing fixtures parsed correctly
- [ ] T-011 | P0 | Receipt photo → line items (Claude vision; offline stub) → itemized split flow | source: agent | acceptance: works on fixture receipts; offline stub returns fixture JSON
- [ ] T-012 | P0 | Email receipt parser (Uber/Lyft/restaurant-style fictional emails) → private pending items | source: adapters | acceptance: parsed amounts/time/place correct on fixtures; items private to owner until confirmed
- [ ] T-013 | P0 | Card transactions (Plaid-sandbox-shaped) + "looks shared" classifier + one-tap confirm in chat | source: core | acceptance: precision/recall reported on labeled fixtures; nothing shared without owner confirmation
- [ ] T-014 | P0 | Multi-origin group flight optimizer (arrival/departure spread, total cost, per-person cost cap, layovers) | source: core | acceptance: matches brute force on small cases; returns ranked trade-off options with explanations
- [ ] T-015 | P0 | Daily settle-up + Morning After recap (spend vs budget, highlights, who owes whom, album photos if opted in) | source: ideas | acceptance: scheduled trigger in simulator clock; follows VOICE.md
- [ ] T-016 | P0 | Trip Wrapped (end of trip) | source: ideas | acceptance: totals, awards, top photos; shareable card in simulator
- [ ] T-017 | P0 | Personality engine + roast mode with guardrails (off by default, blocked with minors) | source: ux | acceptance: guardrail tests incl. refusal cases from fixtures
- [ ] T-018 | P0 | Mock shared album adapter with per-member consent | source: adapters | acceptance: non-consenting members' photos never returned
- [ ] T-019 | P0 | Simulator web UI (iMessage-like, Trav avatar, rich cards for receipts/QR/recaps, approval buttons) | source: ux | acceptance: Barcelona demo playable in the browser
- [ ] T-020 | P0 | Eval harness v1 + regression suite (see evaluator agent) | source: eval | acceptance: `pnpm eval` produces a report; safety failures are hard failures
- [ ] T-021 | P0 | Barcelona flagship demo script + README one-command demo | source: core | acceptance: `pnpm demo:barcelona` runs end to end offline
- [ ] T-022 | P1 | Lisbon scenario: per-person preferences, Dad's conference blocks → Dean-only suggestions, daily budget pacing | source: core | acceptance: eval scenario passes
- [ ] T-023 | P1 | Turks and Caicos family mode (minor present) | source: safety | acceptance: no nightlife/alcohol/roasts involving the minor across all eval cases
- [ ] T-024 | P1 | Over-budget handling: closest alternatives with explicit trade-offs instead of failing | source: ux | acceptance: eval scenarios with nothing in budget
- [ ] T-025 | P1 | Real-adapter stubs + docs (iMessage relay, WhatsApp, Plaid, Stripe test mode, Duffel) behind interfaces, never called live | source: connectors | acceptance: compile, documented, disabled by default

## Proposed
<!-- Agents append here. -->

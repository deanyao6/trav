# Morning report (draft, updated as the night goes on)

Last updated: 2026-10-22 16:20 PDT, session 4. **Status: v0 is not demoable end to end yet.** The core, adapters, agent loop, outbound screen and simulator are built and reviewed; the approval handler (T-030), booking executor (T-009), expense ingestion (T-010..T-013), recaps (T-015/T-016), personality/settings (T-017) and the flagship demo script (T-021) are still open. See `docs/PROGRESS.md` for the timeline and `tasks/BACKLOG.md` for the exact state.

## Demo

Not yet. What runs today:

```
pnpm install
pnpm check                      # typecheck + lint + 1898 tests, all offline
TRAV_OFFLINE=1 pnpm sim         # iMessage-style simulator at http://127.0.0.1:5179
TRAV_SIM_BACKEND=scripted TRAV_OFFLINE=1 pnpm sim   # scripted Razzmatazz walkthrough
pnpm audit:verify               # audit hash-chain verifier
pnpm fixtures:gen               # regenerate synthetic fixtures
```

`pnpm demo:barcelona` (T-021) and `pnpm eval` (T-020) are in progress.

## Built (reviewed and committed)

- Core: Money, ids, clocks, domain types, privacy `promote()` (T-002); ledger with every split mode, balances, minimal settle-up (T-003); ApprovalPolicy, grants, consistency check, hash-chained audit log + verifier (T-004, T-055); in-memory and `node:sqlite` storage with owner-gated private partitions (T-005); multi-origin flight optimizer verified against brute force (T-014); safety predicates, outbound screen, roast guardrails, voice linter (T-028); scheduler (T-056).
- Adapters: simulator channel, keyword fallback, message budget (T-006); mock tickets + payments with ApprovalProof and idempotency (T-008-a); mock lodging + settle-up (T-008-b); mock flights + FX (T-029-a); mock email receipts, card transactions, shared album (T-029-b).
- Agent: spend-guarded model client with offline mode, untrusted-content wrapper, tool registry (T-007-a); card rendering and the single outbound send path with privacy lane enforcement (T-026); agent loop, mention/identity gates, memory, v0 tools, document intake (T-007-b, round-2 review in progress).
- Simulator: server + web UI + CLI runner (T-019-a). Not yet clicked in a real browser: the sandbox blocks local port binding and the Chromium download (see `docs/QUESTIONS.md`).
- Architectural tests: single purchase call site, append-only audit, offline mocks, no secrets in fixtures (T-054).
- Fixtures: complete synthetic data set with a deterministic generator (`fixtures/README.md`).

## Stubbed or mocked

Every provider (tickets, flights, lodging, payments, settle-up, card transactions, email receipts, album) is a mock reading `fixtures/`. Real iMessage/WhatsApp/Plaid/Stripe adapters exist only as interfaces in `packages/adapters/src/interfaces/` (T-025 would add documented stubs). No live model call has been made yet (`.trav/spend.json` does not exist; spend is $0).

## Evals

Harness (T-020) in progress; no scores yet.

## Research insights (top 5)

See `research/market.md`, `research/gaps.md`, `docs/IDEAS.md`. To be summarized here at the end of the run.

## Connector feasibility

See `research/connectors.md`. To be summarized here at the end of the run.

## Security

- `.claude/hooks/blocked.log`: 154 entries so far. Nearly all are reviewers trying to write throwaway probe tests via shell heredocs (the guard blocks regex-looking tokens and doc-comment openers in command text) and agents trying to read Claude session transcripts under `~/.claude/projects` (blocked by the read sandbox). No agent attempted anything outside the repo on purpose; nothing was worked around.
- `research/INJECTION_LOG.md`: empty. No research agent found instruction-like text in any web page, and the fixture receipts/emails that contain planted injections are our own synthetic data (they are flagged by the parsers, which is the point).

## Open questions for Dean

See `docs/QUESTIONS.md`. Top items: (1) browser verification of the simulator needs `sandbox.network.allowLocalBinding` and the Playwright download hosts; (2) who may approve a booking (any adult member vs requester + leads + attendees); (3) DM handles per channel identity vs per group.

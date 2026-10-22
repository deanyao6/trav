# Questions for Dean

Things the overnight run could not decide or was blocked on. Ranked by importance within each section; newest at the bottom.

## Blocked / needs a decision

- **Simulator could not be run in a browser inside the sandbox (T-019-a, 2026-10-22 10:15).** Two sandbox limits: local port binding (`listen EPERM: operation not permitted 127.0.0.1:5179`) and the Playwright Chromium download (`cdn.playwright.dev` and `storage.googleapis.com` are blocked by the network allowlist). The server, API, scripted backend and UI are covered by 77 unit/integration tests (request handler exercised directly, server-rendered UI), and `vite build` is clean, but nothing has been clicked in a real browser yet. To verify yourself: `pnpm install`, then `pnpm sim` and open `http://127.0.0.1:5179`; for the headless smoke test run `cd apps/simulator && PLAYWRIGHT_BROWSERS_PATH=$PWD/../../.cache/ms-playwright pnpm exec playwright install chromium` then `pnpm --filter @trav/simulator qa`. If you want the overnight loop to do this next time, allow `sandbox.network.allowLocalBinding: true` and the two download hosts.
- **DM handles are global per channel (T-019-a):** the simulator channel keys DM threads by handle across all chats, and the fixtures reuse `h_dean`/`h_dad` across trips, so the simulator gives Lisbon and Turks and Caicos trip-scoped handles (`h_lis_dean`, `h_tci_mom`). Decide whether handles should be per-channel-identity (real iMessage: one number per person, so DMs are shared across groups anyway) or per-group. T-021 seeding must follow the same convention.

## Noted, not blocking

- **Who may approve a booking (T-026 builder, 2026-10-22 09:40):** the ApprovalPolicy's default rule C1 lets any adult member approve (including Henry, who is not going), while VOICE §6.2 says the requester or a lead. The proposal card currently shows the policy's list. Decide: approvers = any adult member (simpler, current code) or requester + leads + attendees (stricter). Related: over the auto-approve cap the policy escalates to `each_payer`, so the card reads "all 6 of you have to ok it" rather than VOICE §4.1 B's "@Dean has to ok it".

- **Adapter interface gaps found in review (T-008-a):** (a) `PurchaseTicketsRequest`/`ChargeRequest` carry no `groupId`, so provider mocks can't compare `ApprovalProof.groupId`; the executor (T-009) does that check instead (recorded in the T-009 acceptance). (b) `BookingPaymentsAdapter.refund` takes no `ApprovalProof` or caller identity, unlike `TicketsAdapter.refund`; a refund only returns money, but audit should record who asked. Proposed as T-059 (P1).

- pnpm 12 needs `XDG_RUNTIME_DIR` pointed inside the repo to work in the sandbox (see `docs/DECISIONS.md` D-002). `scripts/overnight.sh` now sets it; the currently running overnight loop already started, so this session's agents set it per shell. If you run pnpm yourself outside the sandbox, nothing changes.
- The guard hook's "dumping environment variables" rule also matches any command that mentions `.env` followed by a pipe (e.g. `cat .env | wc -c`). Harmless, but the orchestrator avoids touching `.env` entirely.
- The guard hook also rejects any Bash command text containing parent-directory tokens, `/**` doc-comment openers, or regex-looking `/x/` tokens, so agents can't write throwaway TypeScript via heredoc; they write temp files with the Write tool under the temp dir instead. Harmless, but it costs each reviewer a few minutes.

# Progress log

Timestamps are local time on Dean's Mac (PDT) unless noted. Newest entries at the bottom.

## 2026-10-22

- 03:05 — Session 1 started (`scripts/overnight.sh 9`, runs until ~12:05). Fresh repo: only the initial commit existed.
- 03:10 — Phase 1 research/design agents launched in parallel: market-researcher, connector-scout, conversation-designer, ideation, safety-reviewer. Each writes proposals to `tasks/proposed/<agent>.md` (the Orchestrator merges into `tasks/BACKLOG.md` to avoid write races).
- 03:15 — Phase 0 scaffold: pnpm workspaces monorepo (`packages/core`, `packages/agent`, `packages/adapters`, `packages/evals`, `apps/simulator`), TypeScript 6, Vitest 5, ESLint 10 + Prettier, `pnpm check` = typecheck + lint + test.
- 03:20 — Phase 0 committed and pushed (e86aab4). pnpm 12 needed `XDG_RUNTIME_DIR` inside the repo (D-002).
- 03:30 — Phase 1 done: research/market.md, research/gaps.md, research/connectors.md (+ 10 adapter interface files), docs/VOICE.md, docs/IDEAS.md, docs/SAFETY.md. 67 proposals from 6 agents merged into tasks/BACKLOG.md: 22 P0 (dependency-ordered), 24 P1, 3 P2. No prompt-injection text was found by any research agent (research/INJECTION_LOG.md is empty).
- 03:44 — Phase 1.5 committed and pushed (6ee33e7): docs/ARCHITECTURE.md, D-003..D-013, core/agent/adapter skeletons, parallel-wave table in the backlog. T-054/T-055/T-056 (architecture tasks) promoted to P0.
- 03:50 — Build loop started. Wave 0: T-002 (builder, fable). Started in parallel because they don't depend on Money: T-006 (simulator channel), T-007-a (model client + untrusted wrapper + registry), and synthetic-data (all fixtures).
- 03:58 — T-006 approved + committed (98722a8). 04:02 — T-056 approved (round 2; fixed a DST gap bug for western zones) + committed (b64fe3b).
- 04:12 — T-002 approved + committed (9dee7de). Builders done, awaiting review: T-003, T-007-a, T-008-a, T-005, T-028. Still building: T-004, T-014, T-029-a. synthetic-data still generating fixtures.
- 04:17 — T-003 approved + committed (8678324). Reviews in flight: T-004, T-005, T-008-a, T-028, T-029-a. Fix rounds: T-007-a (9 minors). Wave 2 started: T-008-b, T-029-b, T-026; T-007-b and T-055 next. Note: T-004 commits the audit payload via `payloadHash` inside the hashed header so redacted tombstones stay verifiable (SAFETY §2.2 wording deviation; DECISIONS entry pending reviewer verdict).

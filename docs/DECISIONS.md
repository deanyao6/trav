# Architecture decisions

One entry per significant decision. Format: context, decision, alternatives, consequences. Newest at the bottom.

## D-001: Monorepo tooling versions (2026-10-22, Orchestrator)

- **Context:** CLAUDE.md §3 fixes the stack (TypeScript, pnpm workspaces, Vitest, ESLint + Prettier, `node:sqlite`). Exact versions were open.
- **Decision:** TypeScript 6.0.x (not 7.x: `typescript-eslint` 8.72 supports `<6.1`), ESLint 10 flat config, Vitest 5 with `test.projects`, Vite 8 + React 19 for the simulator UI, `tsx` for running TypeScript scripts, `@anthropic-ai/sdk` 1.1.0. All pinned exactly. Workspace packages export their `src/index.ts` directly (no build step; Vitest, Vite and tsx consume TypeScript source).
- **Alternatives:** TypeScript 7 (native), building packages to `dist/` with project references.
- **Consequences:** No build step for the library packages, which keeps the loop fast. If a published build is ever needed, add `tsc -b` with `outDir` later.

## D-002: pnpm 12 inside the sandbox (2026-10-22, Orchestrator)

- **Context:** `pnpm install` failed with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK: Operation not permitted`. pnpm 12 (a Rust binary from Homebrew) opens its store locks under `$XDG_RUNTIME_DIR`, which defaults to a location outside the repo that the sandbox cannot write.
- **Decision:** Every shell that runs pnpm in the sandbox sets `XDG_RUNTIME_DIR="$PWD/.cache/runtime"` (added to `scripts/overnight.sh`; builder prompts include it). Store and cache dirs are set in `pnpm-workspace.yaml` (pnpm 12 ignores the `pnpm` field in `package.json` and `store-dir` in `.npmrc`). `verifyDepsBeforeRun` is off so scripts don't trigger hidden installs. Build scripts are allowed only for `esbuild` via `allowBuilds`.
- **Alternatives:** Install pnpm 10 (can't: no installs outside the repo), use npm (loses workspace ergonomics).
- **Consequences:** Running pnpm from a fresh shell without the env var fails with the lock error; the fix is one `export`.

## D-003: Package map and import direction (2026-10-22, architect)

- **Context:** CLAUDE.md §3 names five packages; builders need a hard rule about who imports whom so parallel tasks don't tangle.
- **Decision:** `core` imports nothing internal and nothing but Node built-ins; `adapters` imports `core`; `agent` imports `core` + `adapters` + the Anthropic SDK; `evals` and `apps/simulator` import all. `core` exports function modules as namespaces (`ledger`, `approval`, `audit`, `flights`, `safety`, `recaps`) and everything else top-level. `Money` uses the field name `amountMinor` (the adapter interfaces and SAFETY.md already use the `*Minor` convention; VOICE §5's `amount` is the same value). The adapter interfaces now import primitives (`Money`, ids, ISO types, `Clock`, `ContentTag`, `ConsentLookup`, `ParsedReceipt`) from `@trav/core`; adapter-only shapes (`AdapterInfo`, `ApprovalProof`, `AdapterError`, `Result`) stay in `adapters/interfaces/common.ts`. The adapters' Plaid-shaped row is renamed `ProviderTransaction` so core's `Private<CardTransaction>` keeps the SAFETY name.
- **Alternatives:** A separate `types` package (one more package for no gain); letting adapters keep duplicate primitives (two `Money` types to convert between).
- **Consequences:** Builders in `core` can't reach for an adapter; the simulator and evals are the only composition points.

## D-004: `BookingExecutor` lives in `packages/agent/src/booking/executor.ts` (2026-10-22, architect)

- **Context:** SAFETY §2.1 requires exactly one call site for provider `purchase`/`createOrder`/`book` and payments `charge`, re-checking the grant and writing audit/ledger in order.
- **Decision:** The executor is `createBookingExecutor(deps)` in `packages/agent/src/booking/executor.ts`. Core stays pure (it supplies `approval.checkGrant`, `deriveIdempotencyKey`, repositories); adapters supply providers; the executor is the only importer of their money-moving methods. The architectural grep test (T-054) asserts that `.purchase(`, `.createOrder(`, `.book(` and `.charge(` each have exactly one non-test call site, in that file. `ApprovalHandler` (`agent/approval/handler.ts`) is the only caller of `execute()`.
- **Alternatives:** Executor in `core` (would force I/O into core); executor in `adapters` (adapters would need policy knowledge).
- **Consequences:** Flow 2 in ARCHITECTURE.md is the spec for T-009; providers export factories only.

## D-005: Default `paidBy` is `member_card` (2026-10-22, architect)

- **Context:** VOICE §4.1 defaults to "charged to Dean's card, split 5 ways on the tab"; the alternative is charging each attendee's mock card.
- **Decision:** v0 default for tickets, lodging and transport is `{ kind: 'member_card', memberId: requestedBy }`: one mock charge to the requester, an `Expense` split among `payers` on the ledger. `{ kind: 'per_person_cards' }` remains in the `PaidBy` union and is the default for `flight` (each on their own card, "nothing to split"; the ledger records nothing). Both proposal and receipt cards carry `paidBy`.
- **Alternatives:** Per-person cards everywhere (no ledger activity, weaker demo); a group pot (no such thing in v0).
- **Consequences:** The Razzmatazz flow exercises ledger split + settle-up; the flights flow exercises `each_payer` approval without ledger entries.

## D-006: Offline mode keys and replays scripted model responses (2026-10-22, architect)

- **Context:** All agent logic must run deterministically with `TRAV_OFFLINE=1` and no key; new scenarios should still produce sensible behavior without hand-authored scripts.
- **Decision:** One `ModelClient` (`agent/model/client.ts`) with `complete()` and `classify()`. Offline lookups use `deriveScriptKey = sha256(model, systemPromptId, normalized last user text, sorted tool names)` against `fixtures/scripts/*.json`; misses go to ordered rule-based `FallbackResponder`s (mention rules, "looks shared" heuristics, booking-intent regex, receipt fixture lookup, roast blocklist), then a fixed "not sure" reply plus a line in `.trav/offline-misses.jsonl`. Live calls go through a spend guard writing `.trav/spend.json` and refusing past `TRAV_LIVE_BUDGET_USD`. Any request with an `<untrusted` block and non-empty tools throws in both modes.
- **Alternatives:** Keying on the full prompt hash (breaks on every prompt tweak); a recording proxy only (no behavior for unscripted inputs); mocking the SDK per test (no shared path to audit).
- **Consequences:** Prompt ids (`systemPromptId`) must be stable strings; changing a template's id invalidates its scripts on purpose. Scripts are reviewed like code.

## D-007: Private vs group separation is structural (2026-10-22, architect)

- **Context:** SAFETY §2.3 asks for separation enforced by types and stores, not prompts.
- **Decision:** `Private<T>` brand in `core/privacy.ts`; `PrivateStore` methods take `ownerMemberId` first with no list-all (only `countPendingByOwner` crosses owners, returning counts); `GroupContext` is built from unbranded types; `GroupSafe<T>` + `assertGroupSafe()`/`withExtra()` reject branded values at compile time (proved in `core/src/privacy.test.ts`); `promote()` is the single private → group function and strips `STRIPPED_FIELDS`. Ticket QR artifacts are stored in `PrivateStore.ticket_artifacts` (the group store keeps only `TicketRef`s), so a barcode can never be rendered on the group lane. Group memory (`GroupMemoryRepository`, GroupStore) and member memory (`PrivateStore.memberMemory`) are separate modules in `agent/memory`.
- **Alternatives:** One store with a `visibility` column (a missed `WHERE` leaks); prompt instructions (not enforceable).
- **Consequences:** Builders of ingestion flows must mark rows with `markPrivate()` and can only hand the group an `Expense` from `promote()`.

## D-008: One injected `Clock`, one `Scheduler`, no `Date.now()` in domain code (2026-10-22, architect)

- **Context:** Recaps, proposal expiry, holds, offer expiry and nudges must move together under the simulator's "+1 hour" / "next morning" buttons and be deterministic in tests.
- **Decision:** `core/clock.ts` defines `Clock`, `SimulatedClock`, time helpers, `ScheduledJob`/`Scheduler`. Every function needing time takes a `Clock` or an explicit instant. An ESLint `no-restricted-syntax` rule (root `eslint.config.js`) forbids `Date.now()` and `new Date()` under `packages/*/src` and `apps/*/src`, except `clock.ts`, tests and `core/src/storage/**`. The clock owner (simulator, CLI, evals) calls `scheduler.drain(clock.now())` after advancing and feeds jobs to `agent.runScheduled`.
- **Alternatives:** `vi.useFakeTimers` (does not reach the simulator UI or SQLite timestamps); a global mutable clock (hidden coupling).
- **Consequences:** Entry points construct the clock once; mocks and repositories receive it in their factories.

## D-009: Channel lanes, one `ApprovalEvent`, budget guard as a channel decorator (2026-10-22, architect)

- **Context:** VOICE §3.7 needs a group lane and a private DM lane; VOICE §9.3 wants one approval code path for tapbacks, text aliases and buttons; G-03 caps proactive group messages.
- **Decision:** `ChannelAdapter` has `sendGroup(conversationId, OutboundMessage)` and `sendDirect(handle, OutboundMessage)` (both take core `OutboundMessage`; adapters degrade cards to `text`), `react(OutboundReaction)`, and a `lane` on every inbound event. connector-scout's `sendText`/`sendCard` and its own `RichCard` are replaced by core's `Outbound` types. All approval inputs normalize in `agent/approval/events.ts` (`normalizeApprovalEvent` → `ApprovalEvent { kind: ActionId, senderId, via, messageId, cardId?, proposalId? }`) and are consumed by one `ApprovalHandler`. The message-budget guard is a decorator `withMessageBudget(channel, …)` in `adapters/channel/budget.ts` keyed on `OutboundMessage.proactive`/`urgent`, so it is built and tested in T-006 without touching the agent; `screenOutbound` + the voice linter run in the agent's single send path `agent/outbound/send.ts`.
- **Alternatives:** Budget in the agent (couples T-006 to T-007); separate handlers per input kind (three places to get identity wrong).
- **Consequences:** Adapters never see `Private<T>`; a DM-only card handed to `sendGroup` is rejected twice (screen, then adapter).

## D-010: Errors, idempotency and audit naming conventions (2026-10-22, architect)

- **Context:** Builders need one convention per layer.
- **Decision:** Core throws `TravError(code)` for invalid input/invariants and returns domain outcomes as values; adapters return `Result<T>` with `AdapterError` for expected failures; the agent converts both into VOICE §4.10 text at the turn boundary. Idempotency: booking key per SAFETY §2.1 (`approval.deriveIdempotencyKey`), checked before evaluation, in the executor, at the provider and in `BookingRepository.createBooking`; ledger writes unique on `Expense.sourceRef`; grants idempotent per member; inbound dedupe by `messageId`; scheduler jobs replace by `jobId`. Audit events are named `<entity>.<state>` in snake_case and listed in `core/domain/audit.ts`; repositories reject payloads containing `audit.PRIVATE_PAYLOAD_KEYS`. Repositories are synchronous (`node:sqlite` is synchronous; keeps the shared suite simple).
- **Alternatives:** Exceptions everywhere (hides expected provider failures); `Result` in core (noise in pure math); async repositories (no benefit in v0).
- **Consequences:** Adapter tests assert on `error.code`; core tests assert on thrown `TravError.code` or returned decisions.

## D-011: Ids from an injected `IdGenerator`, ulid-like, prefixed (2026-10-22, architect)

- **Context:** Deterministic tests and fixtures; no new dependency.
- **Decision:** `core/ids.ts`: `IdGenerator.next(prefix)` returns `<prefix>_<body>` where the ulid body is 26 Crockford chars and the deterministic body is `<seed><6-digit counter>` (e.g. `mem_bcn000001`, readable in fixtures); `createDeterministicIdGenerator(seed)` (counter per prefix) for tests/fixtures, `createUlidIdGenerator(clock)` (time from the injected clock + `node:crypto` randomness) at runtime. Prefix table in `ID_PREFIXES`.
- **Alternatives:** the `ulid` npm package (one more dependency for 20 lines); `crypto.randomUUID()` inline (non-deterministic tests, unprefixed ids).
- **Consequences:** Snapshot tests are stable; ids are greppable by kind.

## D-012: Roles unify VOICE §6.1 and SAFETY §2.5; "minor" is a predicate (2026-10-22, architect)

- **Context:** VOICE lists `lead | member | guardian | minor`; SAFETY lists `member | guest`.
- **Decision:** `Member.role ∈ lead | member | guardian | guest`. Minority is `safety.isMinor(member, now)` from `birthDate`/`ageBand` (unknown age ⇒ not minor for content, but roast blocked until `settings.allAdultsConfirmed`). `approval.toMemberView()` maps lead/guardian/member → `'member'`, guest → `'guest'`. Minors keep `guardianMemberId` for ticket delivery and the family tab.
- **Alternatives:** A `minor` role (ages change; a role can be forgotten when a birthday passes).
- **Consequences:** One source of truth for every age rule; the T-028 predicates are the only place age is interpreted.

## D-013: Consent map is passed to the album adapter; `ApprovalProof` is derived from the core grant (2026-10-22, architect)

- **Context:** ideation asked for the album adapter to take a consent map rather than own consent; connector-scout's providers require an `ApprovalProof` the core types did not define.
- **Decision:** Consent is stored once in `PrivateStore.consent`; `AlbumAdapter.listPhotos(query, consentLookup)` filters at query time with the lookup passed in (so opt-out hides photos from re-rendered recaps), and `hidePhoto()` implements "drop that one" for any member. `ApprovalProof` stays an adapter-side opaque shape produced only by `toApprovalProof(grant, decision, proposal, grantedAuditEventId)` in the executor (`approvalId = grantId`).
- **Alternatives:** Adapter-owned consent (two sources of truth); passing the core grant to adapters (adapters would import policy types).
- **Consequences:** Album tests inject a consent lookup; provider mocks validate proofs without knowing the policy.

## D-014: Storage is a subpath export, `@trav/core/storage` (2026-10-22, Orchestrator)

- **Context:** T-005 implemented the repositories under `packages/core/src/storage/` using `node:sqlite`. The simulator's browser UI imports `@trav/core` for types and pure functions; `node:sqlite` cannot be bundled for the browser.
- **Decision:** `packages/core/package.json` exports `./storage` → `src/storage/index.ts` separately. Node entry points (agent runtime, CLI, evals, simulator server) import `@trav/core/storage`; the root `@trav/core` export stays free of Node-only modules.
- **Alternatives:** export storage from the root index (breaks Vite bundling of the UI); a separate package (more boilerplate).
- **Consequences:** `createMemoryStores`/`createSqliteStores` are imported from `@trav/core/storage`.

## D-015: TypeScript scripts run with `node --import tsx`, not the `tsx` binary (2026-10-22, Orchestrator)

- **Context:** T-055 found that the `tsx` CLI fails inside the overnight sandbox with `listen EPERM` because it opens an IPC pipe under the temp dir that Seatbelt refuses. `node --import tsx file.ts` loads the same loader in-process and works.
- **Decision:** Every package script that runs TypeScript directly (`audit:verify`, `demo:barcelona`, `sim` server, `eval`) uses `node --import tsx <file>`. Arguments pass through unchanged.
- **Alternatives:** compile scripts with `tsc` first (slower loop); `node --experimental-strip-types` (Node 25 supports it, but workspace `.ts` imports via package `exports` and `verbatimModuleSyntax` make tsx the safer choice for now).
- **Consequences:** Outside the sandbox both forms work; inside, only this one does.

## D-016: Audit hash commits to the payload digest; lifecycle facts live in the hashed header; the chain is anchored externally (2026-10-22, builder T-004/T-055)

- **Context:** SAFETY §2.2 wrote the hash as "sha256(prevHash + canonical JSON of everything above)" and §2.9 said redaction replaces the payload with `{ redacted: true }` while hashes stay as stored. Taken literally, a redacted row can no longer be recomputed, so the verifier would have to trust its stored hash, and then any single-row payload edit to `{ redacted: true }` passes, and a tombstoned `approval.granted` could pass for a complete grant. Review of T-004 round 2 found exactly that.
- **Decision:**
  1. `hash = sha256(prevHash + canonicalJson({ ...header, payloadHash }))` where `header` is every `AuditEvent` field except `payload` and `hash`, and `payloadHash = sha256(canonicalJson(payload))`. This is the one formula; SAFETY §2.2 now states it.
  2. A tombstone is exactly `{ redacted: true, payloadHash }`; `Stores.redactAuditPayloads` / `deleteTrip` write that form, and `verifyAuditChain` re-verifies a tombstone in full against its digest. A bare `{ redacted: true }` is an ordinary payload and therefore a `hash_mismatch`. `sealAuditEvent` refuses to seal a tombstone-shaped payload.
  3. The booking-lifecycle facts the verifier needs are hashed header fields, not payload: `AuditEvent.lifecycle = { outcome }` on `policy.evaluated` and `{ complete }` on `approval.granted` (`proposalId` already was a header field). `sealAuditEvent` derives them from `payload.outcome` / `payload.complete` when a caller omits `lifecycle`, so existing writers are unchanged, and throws `invariant_violation` on a missing or invalid outcome, a non-boolean `complete`, a header that disagrees with the payload, or a header on any other event type. The verifier reads only the header (`unknown_outcome` / `unknown_grant_completion` when it is absent or invalid).
  4. The chain has no secret, so a rewrite of every row from some index on, with hashes recomputed, is undetectable from the file alone. `pnpm audit:verify` prints `HEAD group=<id> events=<n> hash=<sha256>` per group and accepts `--expect-head <groupId>=<hash>` (repeatable; a vanished group fails its anchor). The morning report records the heads.
- **Alternatives:** an HMAC with a key from `.env` (a secret the same attacker can read on a single Mac; and it would make `TRAV_OFFLINE` fixtures key-dependent); hash the whole payload and keep legacy bare tombstones trusted (the flaw above); keep lifecycle facts in the payload and forbid redacting lifecycle events (leaks `policySnapshot` and approver ids past "forget this trip").
- **Consequences:** no schema change (rows are JSON; `lifecycle` is an optional field); events sealed before this decision have no `lifecycle` header and would report `unknown_outcome`, acceptable because no production log exists yet. `@trav/core/storage` no longer exports `REDACTED_PAYLOAD`; use `audit.tombstonePayload(original)`.

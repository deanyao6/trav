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

## D-017: Eval harness policy: `--live` is opt-in, known gaps run and are scored apart, any failing §3 id is hard, deltas are selection-aware (2026-10-22, builder T-020)

- **Context:** T-020 review round 1 found four eval-harness behaviours that were stricter or looser than the docs said, with no recorded decision: when the harness makes live model calls, how scenarios that wait on an unbuilt task are scored, which SAFETY §3 ids fail the run, and which earlier report a run is compared with.
- **Decision:**
  1. **Live is opt-in.** `pnpm eval` is offline unless `--live` is passed AND `TRAV_OFFLINE` is unset AND `TRAV_ANTHROPIC_API_KEY` is present AND the spend guard (`.trav/spend.json`, `TRAV_LIVE_BUDGET_USD`) allows another call. Otherwise it runs offline and the report's Mode line says why. Rubric graders (`TRAV_GRADER_MODEL`) run live only.
  2. **Known gaps.** A scenario marked `pending: "T-xxx"` still runs every step and grader. Its feature failures (and a crash) are scored but not hard. It counts in `overall`, not in `ready`, and is listed under "Known gaps". Its safety graders stay hard. A pending scenario can't also be tagged `regression`, and one that passes everything is flagged so its marker gets dropped.
  3. **Any failing §3 id is hard.** A failing grader result that carries a SAFETY §3 id exits 1, whether or not §3.I lists that id as hard (B3, C5, C7, E5, F3, F4 included). Static architectural check failures (A1, A2, B2, H1, H2) are hard too. A built safety scenario that crashes fails each of its checklist ids. Exit 2 is reserved for harness errors (bad flags, bad scenario files). The root script runs `node --import tsx packages/evals/src/cli.ts` directly (D-015), because a nested `pnpm --filter` would flatten the 2 into a 1.
  4. **Deltas are selection-aware.** Each scenario is compared with the newest earlier summary that contains it. Totals, per-tag scores and "not in this run" are compared only with the newest earlier summary whose selection matches (counts ignored). Static failures are compared with the newest run that ran the static checks. The report says which baseline it used. Held-out scenarios are left out of per-tag scores and the Changes lists, except for safety failures.
  5. **Evidence never quotes a DM.** Grader evidence quotes message text only through `graders/util.ts` `quoteMessage`/`quoteText`, which turns DM text into `[private message, N chars]`. The report's `redact` pass also treats whole DM lines as secrets, as a backstop.
- **Alternatives:** live when a key is present (spends without asking); skip pending scenarios (hides safety regressions in their working steps); hard only on §3.I ids (lets a QR in the group or a minor's roast pass with exit 0); compare with the newest report regardless of selection (a `--filter` run masks the next full run's regressions).
- **Consequences:** CI (`pnpm check`) never spends. A new §3 grader id fails the run as soon as it fires. Reports from filtered runs can sit in `evals/reports/` without corrupting the trend.

## D-019: Approval attempts that do not count are silent; Trav names the approver only when asked; bare text binds to the sender's own proposal (2026-10-25, builder T-007-b)

- **Context:** T-007-b review round 2 found the loop posting "that has to come from Dean. @Dean 👍 to book" for any chat line that named a member next to an approval word, even when nobody was talking to Trav, and tagging an arbitrary member for "everyone's in". VOICE §6.2 says a 👍 from a non-approver is ignored silently (one nudge after 5 minutes at most), SAFETY §2.1 says only the requester's bare "yes" binds, and SAFETY §2.5 says a claim about someone else contributes nothing. The three had never been reconciled into one rule for the loop.
- **Decision:**
  1. **Attempts that do not count are silent.** A 👍 / tap / bound "yes" from a member who is not in the decision's approver set, a bare "yes" / "no" from anyone but the requester, a minor's or guest's attempt, and a claim on someone else's behalf ("Dean said it's fine", "everyone's in") each produce exactly one `approval.invalid_attempt` audit event (`cause`: `not_required_approver`, `not_requester`, `minor`, `guest`, `claimed_for_other`) and no message. The proposal stays pending.
  2. **Trav names the approver only when it was addressed.** If the claim is for Trav (an `@trav` mention, a quote-reply to Trav, or the reply window) and names one member, Trav answers once: "that has to come from Dean. @Dean 👍 to book". An "everyone" claim names nobody, so nobody is tagged. An unaddressed claim in ordinary chat gets no reply, whatever words it carries.
  3. **Binding without a card reference (SAFETY §2.1).** A bare "yes" / "no" binds only to the sender's own pending proposal (two of theirs ⇒ "which one?"); a bare "not me" / "i'm out" binds to the proposal the sender is charged on (an opt-out never spends and only ever yields a fresh card); "everyone's in, book it" is the sender's own attempt and binds only where they are in the approver set. Everyone else must reply to the card, tap it, or name it.
     **Amended by T-066 (2026-10-25): SAFETY §2.1 governs, and a decision entry cannot relax it.** A card-less "everyone's in, book it" binds exactly like a bare "yes": only to the sender's OWN pending proposal (requester), and then only where the requester is in the approver set (else `claimed_for_other`). From anyone else it is `not_requester` (audited with `claimKind: 'everyone'`, silent), even when they are a required approver; it binds only when they reply to the card, tap it, or say it inside the reply window as the normalizer already allows. The requester's own "everyone's in, book it" still counts as their 👍. Two more T-066 refinements: only text carrying an approval word ("book it", "yes", "go ahead", 👍 …) is a claimed approval at all, addressed or not, so "@trav henry's in now too" goes to the roster handler and "@trav everyone's in the lobby, where next?" to the model; and the addressed reply to a named claim tags the named member only when they are in `requiredApprovers`, otherwise the approver the decision still needs ("need a 👍 from @Dean on this one", VOICE §6.2), otherwise nothing.
  4. **The VOICE §6.2 five-minute nudge ("need a 👍 from @Dean on this one") is deferred.** It needs a scheduled job (`approval_nudge`) and `ScheduledJobKind` in `@trav/core` has no such kind; adding it is outside T-007-b's package boundary while T-030's review is open. Until then the only nudge is the addressed answer in (2). The audit trail already records every non-counting attempt, so the job can be added without changing the loop's contract.
- **Alternatives:** keep the immediate @tag (unsolicited, and it tagged the wrong person for "everyone"); bind any member's bare "yes" to the single pending proposal (a "yes" answering someone else's question becomes an approval); treat "everyone's in, book it" as a claim and reject it even from the requester (it is their own consent plus hearsay; the hearsay is simply ignored); post the nudge on the next turn after five minutes (breaks "one group message per turn" and makes timing depend on chat traffic).
- **Consequences:** `identity.gateApproval` has a `not_requester` cause and an intent-aware binding filter; `loop.routeApproval` takes an `addressed` flag; the eval scenario `identity_claimed_approval` (addressed, `@trav`) is unchanged; `fixtures/chats/barcelona.jsonl` msg_bcn_0036 ("henry's at practice, i'll approve for him. go ahead trav") names no member in a consent phrase and is not addressed by the rules, so it is silent, which that fixture allows; a follow-up task should add the `approval_nudge` job kind to core and the 5-minute post to the loop.

## D-020: Provider requests carry `groupId`; payment refunds carry approval and requester; tickets carry a status; one fixture loader per package (2026-10-25, builder T-059)

(D-018 was skipped because it was absent while another builder's D-019 was already in the file. It may be held by an in-flight task.)

- **Context:** The T-008-a review found that `PurchaseTicketsRequest`, `CreateFlightOrderRequest`, `BookLodgingRequest` and `ChargeRequest` had no `groupId`, so a provider could not compare a request with `ApprovalProof.groupId`. Lodging and flights checked the group only when built with `options.groupId`, and tickets and payments never checked it. `BookingPaymentsAdapter.refund(intentId, key, amount?)` took no approval and no caller, unlike `TicketsAdapter.refund`, so the `booking.refunded` audit event (SAFETY §2.2: `providerRef, refundMinor, requestedBy`) had no provider-side identity behind it. `IssuedTicket` had no state, so only the mock's private bookkeeping knew a ticket had been refunded. Fixture files were read by two separate repo-root resolvers in adapters (`flights/fixturePath.ts`, `transactions/fixtureFiles.ts`) and three ad-hoc readers in core tests.
- **Decision:**
  1. **`groupId: GroupId` is required** on all four purchase/charge requests. Every mock checks it through one helper, `checkRequestGroup` in `mock/payments/proof.ts`. A missing or blank `groupId` returns `invalid_request`. A request whose `groupId` differs from `approval.groupId` returns `approval_invalid` (the code the flights interface already documented for "proof for another group"). Both are typed results and nothing throws. This holds whether or not the adapter was built with `options.groupId`, which remains an extra binding. A same-key replay that names another group returns `duplicate`, never the original order. Ticket refunds, and payment refunds, also refuse a proof from a group other than the one the order or charge was made in. Lodging and flights cancellations already did this.
  2. **`BookingPaymentsAdapter.refund(request: RefundChargeRequest)`** takes `{ intentId, amount?, requestedBy, idempotencyKey, approval }`. It is a request object, not positional arguments, because `requestedBy` and `idempotencyKey` are both strings and easy to swap. Rules: a missing or blank `requestedBy` returns `invalid_request`. A missing, malformed or expired proof, a proof for another group, or a `requestedBy` not in `approval.approvedBy` returns `approval_invalid`. A refund above `maxAmount` returns `approval_exceeded`. One approval funds one action, so neither the charge's own approval nor an approval already used for another refund can fund a refund. Replays are idempotent per key and must match intent, amount, approval and requester.
  3. **`booking.refunded` already exists** in `AuditEventType` (`packages/core/src/domain/audit.ts`), with its payload documented in SAFETY §2.2. `@trav/core` therefore needs no change. The executor writes `{ providerRef: intentId | orderId, refundMinor, requestedBy }` with `requestedBy` taken from the refund request.
  4. **`IssuedTicket.status: 'issued' | 'refunded'`** (`IssuedTicketStatus`). A refund rewrites the order's tickets with `status: 'refunded'`. `getTicketForHolder` answers `not_found` for a refunded ticket and never returns one. The executor DMs tickets only from `getTicketForHolder` (the T-009 contract), so a void QR is never DM'd. We chose this over returning the ticket with status `refunded` and relying on the caller to check, because the first design makes the safe behaviour the default.
  5. **One fixture loader per package.** `@trav/adapters` has `src/mock/fixtures.ts` (`loadFixture`, `loadFixtureText`, `listFixtures`, `fixtureExists`, `isSafeFixtureSegment`), which resolves the repo root through `pnpm-workspace.yaml` and validates segments. It replaces `flights/fixturePath.ts` (deleted) and the file-access half of `transactions/fixtureFiles.ts`, which now holds only JSON validators. Tickets and lodging keep their static JSON imports: their hygiene tests forbid `fs`, and that is bundling, not loading. `@trav/core` has the test-only `src/testkit/fixtures.ts` (`loadFixture`, `loadFixtureText`, `loadFixtureJsonl`, `listFixtures`, `fixtureExists`), which is not exported from the index and is used by `fixtures.test.ts`, `flights/fixture.test.ts` and `safety/test-helpers.ts`. Core production code still never reads `fixtures/`.
- **Alternatives:**
  - Keep the group check only in the executor's `checkGrant` (rejected: a single layer, and a mock could be wired without `options.groupId`).
  - A new `'refused'` error code (rejected: `AdapterErrorCode` already has `approval_invalid` for exactly this case, and a new code would ripple into every executor branch).
  - Positional `refund(intentId, approval, requestedBy, key, amount?)` (rejected: two adjacent string parameters).
  - Adding `requestedBy` to `TicketsAdapter.refund` as well (not requested. The executor already knows the requester for a ticket refund. Left for T-009 if it wants symmetry).
  - Making `refundAmount` a field of the stored intent/order (rejected: `getCharge`/`getOrder` would then report the amount of whichever refund happened to be last).
- **Consequences:**
  - The T-009 executor must pass `groupId` on every provider purchase and charge.
  - For a refund it must pass a fresh refund grant's proof plus `requestedBy`. A refund needs its own approval, distinct from the purchase approval.
  - No caller outside `packages/adapters` constructs these requests today (the executor is still a stub), so nothing else changed.
  - `packages/core/src/ledger/family.test.ts` (another builder's in-progress file) still reads its fixture with `readFileSync` and should move to `testkit/fixtures.ts` when that work lands.
  - The executor's `booking.refunded` `refundMinor` comes from the refund result's `refundAmount`.
- **Round 2 (review T-059-r1):**
  - **One approval funds one action in every money-moving mock.** Tickets keeps one `approvalUse` map (`purchase:<key>` / `refund:<key>`), so neither the purchase approval nor a used refund approval can fund a refund. Flights does the same for `createOrder` and `confirmCancellation` (`order:<key>` / `cancel:<key>`). Payments and lodging already did this. A same-key call is an idempotent replay, not a second use.
  - **One proof-validity rule.** Flights now uses `checkApprovalProofValidity` and `checkApprovalCovers` from `payments/proof.ts`, keeping its `options.groupId` binding. `flights/approvalProof.ts` is deleted. Every mock now treats a proof as expired AT `expiresAt`; before this, flights still accepted it at that instant.
  - **Replays check the proof's group.** Every replay (purchase, charge, book, createOrder, and the refund and cancel replays) also requires `approval.groupId` to equal the group of the original action; otherwise it returns `duplicate`. Flights cancellation replays now run the proof shape check and compare the `approvalId`.
  - **Refund results show this refund's amount.** Refund results carry `refundAmount` (this action's amount, i.e. the audit `refundMinor`) next to the cumulative `refundedAmount`. `PaymentIntent.refundAmount?` and `TicketOrder.refundAmount?` exist only on `refund` results and their replays, never on `getCharge`/`getOrder`. `TicketOrder` also gained the cumulative `refundedAmount?`.
  - **Fixture path rules.** Core's segment rule now matches the adapters convention: lowercase only, at most 100 characters. A non-string path or directory is a typed `invalid_argument` in both loaders; before this, a non-string adapters directory threw a `TypeError`.

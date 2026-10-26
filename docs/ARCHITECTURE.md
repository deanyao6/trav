# Trav architecture (v0)

Owner: architect. Builders follow this document; changing a rule here requires a `docs/DECISIONS.md` entry. Skeleton files referenced below already exist and typecheck; every stub body is `notImplemented(...)` and is yours to replace. Spec references: `docs/SAFETY.md` (§), `docs/VOICE.md` (§), `docs/DECISIONS.md` (D-nnn).

One sentence: **the model proposes, pure core code decides, a channel-authenticated human confirms, one executor acts, and everything is written to an append-only audit log; private data lives in a store the group prompt cannot receive.**

---

## 1. Package map

| Package | Owns | May import |
|---|---|---|
| `packages/core` (`@trav/core`) | Domain types, `Money`, ids, clock + scheduler, privacy brand, cards, ledger/splits/settlement, ApprovalPolicy + grants + idempotency, audit hash chain, flight optimizer, safety predicates + outbound screen + voice linter, recap/Wrapped math, repository interfaces and both storage implementations | **nothing internal**; Node built-ins only (`node:crypto`, `node:sqlite`) |
| `packages/adapters` (`@trav/adapters`) | Channel interface + simulator channel + keyword fallback + message-budget decorator; provider interfaces + mock providers (tickets, flights, lodging, payments, settle-up, transactions, email receipts, album, FX); real-adapter stubs | `@trav/core` |
| `packages/agent` (`@trav/agent`) | Model client (live + offline + spend guard), prompts/voice, mention detection, identity gate, tool registry + tools, group context, memory, approval event normalization, **BookingExecutor**, card renderers, single send path, recap/Wrapped/personality rendering, ingestion flows (chat expense, receipt photo, email, card), composition root | `@trav/core`, `@trav/adapters`, `@anthropic-ai/sdk` |
| `packages/evals` (`@trav/evals`) | Scenario runner, deterministic graders, rubric graders (live only), reports, architectural tests (grep-based) | all three |
| `apps/simulator` (`@trav/simulator`) | Vite + React iMessage-style UI, local HTTP server on 127.0.0.1, CLI runner, `pnpm demo:barcelona` | all three |
| `fixtures/` | Synthetic data, by feature (see §8) | n/a |

Rules:
- `core` is pure: no I/O except the `storage/` subtree, no `Date.now()`, no network, no `@trav/*` imports. Everything in it is unit-testable without mocks.
- Dependency direction is strictly core ← adapters ← agent ← {evals, simulator}. ESLint will not stop a wrong import; the reviewer will.
- Packages export `src/index.ts` directly (D-001). Core exports namespaces for the function modules: `ledger.*`, `approval.*`, `audit.*`, `flights.*`, `safety.*`, `recaps.*`; types and `Money`/ids/clock/privacy/cards/repositories are top-level.

### Directory layout (target; create directories as you build)

```
packages/core/src/
  primitives.ts errors.ts money.ts ids.ts clock.ts privacy.ts cards.ts repositories.ts
  domain/{group,trip,expense,approval,booking,audit,consent,memory}.ts
  ledger/   approval/   audit/   flights/   safety/   recaps/        (pure functions)
  storage/memory/*  storage/sqlite/*  storage/repository.suite.ts   (T-005)
packages/adapters/src/
  interfaces/*                       (types only; written by connector-scout, aligned to core)
  channel/simulator/* channel/keywords.ts channel/budget.ts
  mock/{tickets,flights,lodging,payments,settleup,transactions,email,album,fx}/*
  real/{sendblue,whatsapp,telegram,plaid,stripe,duffel,hotelbeds}/stub.ts   (T-025)
packages/agent/src/
  model/client.ts model/offline/{scripts,fallbacks}.ts model/live.ts model/spend.ts
  prompts/*.ts                       (one file per systemPromptId; VOICE lives here as text)
  mention.ts identity.ts untrusted.ts
  tools/registry.ts tools/*.ts       (one file per tool)
  context/groupContext.ts memory/index.ts
  approval/events.ts approval/handler.ts
  booking/executor.ts booking/proposals.ts
  render/*.ts                        (card → text per VOICE §4; receipts from the audit log)
  outbound/send.ts
  expenses/{chat,receipt}.ts ingest/{email,card}.ts
  recaps/{morningAfter,wrapped}.ts personality/*.ts settings/*.ts
  loop.ts compose.ts                 (createTravAgent, createTravRuntime)
packages/evals/src/ runner/ graders/ reports/ arch/   (arch = grep tests, T-054)
apps/simulator/src/ server/ ui/ cli/ demo/
fixtures/<feature>/...                                      (see §8)
```

---

## 2. Data flows

### Flow 1: a chat message arrives → Trav's reply

```
ChannelAdapter.onEvent(InboundEvent)                              adapters
  → TravAgent.handleInbound(event)                                agent/loop.ts
    1. dedupe by messageId; resolve identity: members.getBySenderId(groupId, event.sender)
       → Member | null (null ⇒ guest). Display name is never consulted. (SAFETY §2.5)
    2. if event is reaction/button_tap, or text matching an alias:
         normalizeApprovalEvent(event, pendingCardIndex, memberId, now)     agent/approval/events.ts
         → ApprovalHandler.handle(ApprovalEvent)  (Flow 2 from step 3)      never the model
    3. else mention gate: detectMentionRules → (ambiguous) model.classify('mention_v1') → silence if unsure
       "thanks trav" ⇒ OutboundReaction ❤️, no text.
    4. ctx = buildGroupContext(stores.group, countPendingByOwner, clock)    agent/context/groupContext.ts
       (DM lane: additionally that member's MemberMemory and pending private items; never in the group lane)
    5. prompt = renderGroupPrompt(ctx, voice); tools = registry.specs(lane)
       model.complete({ model:'main', systemPromptId, system, messages, tools })   agent/model/client.ts
       tool loop, max `maxToolRounds` (default 6). Tools read/write stores and write audit events.
       `propose_booking` → booking/proposals.ts: consistency check → policy.evaluate → audit
       `proposal.created`, `policy.evaluated`, `approval.requested` → BookingProposalCard.
       No tool can purchase (tools/registry.ts rejects such names).
    6. drafts: Outbound[] (one group message + N DMs max; VOICE §3.7)
    7. sendTurn(drafts, deps)                                                agent/outbound/send.ts
         screenOutbound (core/safety) → lintVoice → lane routing → audit `message.sent`
         → channel.sendGroup / channel.sendDirect (wrapped by withMessageBudget)   adapters
    8. schedule follow-ups (proposal_expiry at decision.expiresAt) on the Scheduler.
```

Document text (OCR, email bodies, provider descriptions) never enters step 5. It goes through a separate zero-tool extraction call (`wrapUntrusted` + `tools: []` + `jsonSchema`), whose typed result is what the tool loop sees (SAFETY §2.4). The model client throws if a request contains `<untrusted` and has tools.

### Flow 2: booking (proposal → approval → purchase → receipt → ledger)

```
1. proposal   tool `propose_booking` (model) → booking/proposals.ts
              roster = trips.listAttendance(activityId) ⇒ attendees = payers = members 'in' (maybe ⇒ out)
              quote/hold from provider (tickets.hold / flights.getOffer / lodging.recheckRate) → quoteRef, holdExpiresAt
              idempotencyKey = approval.deriveIdempotencyKey({...})         (SAFETY §2.1; excludes who/when asked)
              approval.checkProposalConsistency(...)  problems ⇒ clarifying question, no proposal
              decision = approval.evaluate(proposal, group.spendingPolicy, ctx)  ctx.existingBookingForKey from bookings.getBookingByKey
              audit: proposal.created → policy.evaluated → approval.requested (ids returned to the card)
              deny ⇒ VOICE §4.10/4.12 text; duplicate ⇒ existing receipt. auto_approve ⇒ skip to 4 with a synthetic complete grant.
              grant = approval.createGrant(decision, policyEvaluatedEventId, ids, now); bookings.saveGrant
              post BookingProposalCard (group lane) with actions approve/not_me/decline; schedule proposal_expiry.
2. approval   InboundReaction 👍 | InboundButtonTap approve | text alias  →  normalizeApprovalEvent → ApprovalEvent
              ApprovalHandler: sig = { memberId (from senderId), senderId, via, messageId, at }
              approval.applyApproval(grant, decision, sig, members, now)
                'ignored' ⇒ audit approval.invalid_attempt{cause}, silence (VOICE §6.2)
                'accepted' ⇒ audit approval.granted{complete}; if !complete ⇒ wait
              not_me ⇒ proposal.superseded + new proposal (back to 1); decline ⇒ approval.rejected, proposal rejected
              roster/price/policy change before execution ⇒ approval.invalidateGrant + audit approval.invalidated + re-propose
3. execute    grant.complete ⇒ executor.execute(proposalId, grantId)        agent/booking/executor.ts  (THE call site)
              checkGrant → key lookup (duplicate ⇒ booking.duplicate_suppressed) → audit booking.attempted
              → re-price → provider purchase(quoteRef, idempotencyKey, toApprovalProof(...)) → bookings.createBooking
              → audit booking.completed → expenses.create(Expense{ source:'booking', sourceRef:{kind:'booking', id} }, entries)
              → audit ledger.written → tickets → PrivateStore.putTicket(holder, TicketArtifact)
              failure ⇒ audit booking.failed, result { kind:'failed', moneyMoved:false }; double 👍 / retry ⇒ 'duplicate'
4. receipt    render/receipt.ts builds ReceiptCard FROM the audit events + booking + expense (never free text from the model)
              group lane: ReceiptCard; DM lane: one TicketCard per attendee from PrivateStore.listTickets(holder, bookingId)
              (minor ⇒ deliveredTo guardian). Henry (out) gets nothing. QR payloads never appear in a group message.
5. ledger     already written in 3 (idempotent on sourceRef). Balances: ledger.computeBalances; shown in the next settle-up/recap.
```

Invariants with tests: exactly one `.purchase(`/`.createOrder(`/`.book(`/`.charge(` call site (T-054 grep); purchase counter = 1 after double approval + retry (T-009); audit order `policy.evaluated` → `approval.granted` → `booking.completed` is enforced by `audit.verifyAuditChain` (`completed_without_evaluation` / `completed_without_grant` / `duplicate_completion`), and `booking.attempted` → `booking.completed` → `ledger.written` by the T-009 integration test (`packages/agent/src/booking/executor.test.ts`); extending the verifier to `ledger.written` is T-063.

### Flow 3: daily recap (Morning After + settle-up)

```
Simulator "next morning" / CLI / eval driver:
  clock.nextMorning(trip.timeZone, 10) → scheduler.drain(clock.now()) → for each job: agent.runScheduled(job)
runScheduled('morning_after'):
  window = recaps.lastNightWindow(now, tz)
  signals = { nightlifeBooking, expenseAfter22, photoAfter23, chatAfterMidnight, balancesChanged }   (stores + album)
  mode = recaps.decideRecapMode(signals, familyMode)   silent ⇒ TurnResult.silent, no message
  sections: last night (activities + expenses in window) → money (ledger.totalSpent, allocateEqual) → tab
            (ledger.computeBalances + ledger.settle) → today (activities today) ; VOICE §4.7 order
  photos: album.listPhotos({ from, to }, consentLookup) → recaps.scoreHighlights(…, 3)
  roast lines (only if safety.roastAllowed for each target and classifier + blocklist pass) → else neutral
  → RecapCard (embeds SettleUpCard) → sendTurn (screenOutbound strips roast lines when any gate fails)
  → audit roast.generated / roast.suppressed / content.suppressed ; reschedule next morning_after.
'daily_settle' runs the same path with mode 'quiet'; 'wrapped' on the day after the last departure (T-016).
```

The job kinds and the scheduler interface are in `core/clock.ts`. Jobs are rescheduled by the agent itself (idempotent `jobId`), so "next morning" pressed twice does not double-post.

---

## 3. State and privacy layout

Two stores, one facade (`core/repositories.ts`), both implemented twice (in-memory and `node:sqlite`, one shared test suite):

| Store | Tables (repositories) | May reach the group chat? |
|---|---|---|
| `GroupStore` | groups, members, trips, activities, attendance, expenses + ledger entries, proposals, decisions, grants, bookings (ticket **refs** only), audit events, group memory | yes |
| `PrivateStore` | card_transactions, email_receipts, receipt_scans, pending_private_items, consent, member_prefs, member_memory, ticket_artifacts (QR payloads) | **no**; only via `promote()` (field-stripped) or as a per-owner COUNT |

Structural enforcement (D-007):
1. Every `PrivateStore` method takes `ownerMemberId` first; there is no list-all. The one cross-owner method, `countPendingByOwner(groupId)`, returns counts.
2. Private rows are `Private<T>` (branded). `GroupContext`, every `RichCard`, every tool result and `OutboundMessage.text` are built from unbranded types; `assertGroupSafe()` / `withExtra()` reject branded values at compile time (`packages/core/src/privacy.test.ts` proves it with `@ts-expect-error`).
3. `promote(item, ownerConfirmation, ctx)` in `core/privacy.ts` is the only private → group path: it checks `confirmation.senderId === ctx.ownerSenderId`, strips `STRIPPED_FIELDS`, returns an `Expense` with `sourceRef: { kind:'private_item', id }` (idempotent in the repository) and the caller writes `private.item_promoted{strippedFields}`.
4. Group memory (`agent/memory` → `GroupMemoryRepository`, GroupStore) and member memory (`PrivateStore.memberMemory`) are separate modules; a member fact is mentionable in the group only if `sourceLane === 'group'`.
5. The group prompt renderer is scanned at runtime for `PRIVATE_PROMPT_MARKERS` across all fixtures (T-007-a).
6. Audit payloads are checked on append against `audit.PRIVATE_PAYLOAD_KEYS`.

Roles (D-012): `Member.role ∈ lead | member | guardian | guest`; "minor" is the `safety.isMinor(member, now)` predicate, never a role. `approval.toMemberView()` collapses lead/guardian/member to `'member'` for the policy.

Where runtime state lives on disk: `.trav/trav.sqlite` (gitignored), `.trav/spend.json`, `.trav/offline-misses.jsonl`. Tests use `':memory:'` or the in-memory store.

---

## 4. Offline mode (`TRAV_OFFLINE=1`)

Implemented in `packages/agent/src/model/` (D-006). The default for every test, `pnpm check`, `pnpm demo:barcelona` and the simulator unless a key is present and `TRAV_OFFLINE` is unset.

- `ModelClient` has two methods: `complete(req)` (main/fast/grader, optional tools, optional `jsonSchema`) and `classify(req)` (fast model, labels, zero tools).
- Script key: `deriveScriptKey(req) = sha256(model \n systemPromptId \n normalize(lastUserText) \n sortedToolNames.join(','))`; normalize = lowercase, trim, collapse whitespace, strip `<untrusted … id="…">` ids; images contribute their sha256. Classify uses `classifierId` as the prompt id and `input` as the text.
- Scripts: `fixtures/scripts/<scenario>.json`, arrays of `ScriptedResponse { key, model, systemPromptId, lastUserText, toolNames, response }`. `lastUserText` is for humans; lookup is by `key` only. The same request always replays the same response.
- Miss handling: registered `FallbackResponder`s in order (`mention_v1` regex rules, `looks_shared_v1` heuristics on merchant/time/category, `booking_intent_v1` regex extractor for "@trav get the N of us X tickets", `receipt_extract_v1` fixture lookup by image hash, `roast_guard_v1` blocklist). If none answers, `complete` returns `"i'm not sure what you mean, say it again with the thing you want booked or logged"` with `source: 'fallback'` and appends `{ key, systemPromptId, lastUserText, toolNames }` to `.trav/offline-misses.jsonl` so a builder can author the script. Tests may assert `source === 'script'` where determinism matters (Razzmatazz).
- Live mode: `@anthropic-ai/sdk` via `TRAV_ANTHROPIC_API_KEY`; the spend guard (`createFileSpendGuard`) records usage and estimated USD per model to `.trav/spend.json` before returning, and refuses (`TravError('budget_exhausted')`) once the estimate reaches `TRAV_LIVE_BUDGET_USD`. Optional P1: `TRAV_RECORD=1` writes every live response as a script entry.
- Invariant in both modes: `hasUntrustedBlock(req) && req.tools.length > 0` ⇒ `TravError('untrusted_with_tools')`.

---

## 5. Clock and scheduler

`core/clock.ts` (D-008). `Clock { now(), nowMs() }` is injected into every function that needs time; `SimulatedClock` adds `set/advanceMs/advanceHours/nextMorning(tz)`. ESLint forbids `Date.now()` and `new Date()` under `packages/*/src` and `apps/*/src` except `clock.ts`, tests and `core/src/storage/**`. Only `apps/*` entry points and live scripts construct `createSystemClock()`. Mocks read the clock for hold/offer expiry; the policy reads `ctx.now`; audit events get `ts` from the repository's clock.

`Scheduler` is a time-ordered queue of `ScheduledJob { jobId, groupId, tripId, kind, runAt, payload }`; `schedule` replaces by `jobId`, `drain(now)` returns due jobs. Whoever owns the clock (simulator top bar, CLI, eval runner) advances it and drains. `createInMemoryScheduler()` is the only v0 implementation (T-056).

Time helpers (`localDate`, `localHour`, `tripDayNumber`, `formatTime`, `addMinutes`, `isAfter`) take explicit instants and the trip's IANA zone; use `Intl.DateTimeFormat`, no date library.

---

## 6. Errors, idempotency, audit naming

Errors (D-010): core throws `TravError(code)` only for invalid input and invariant violations; domain outcomes (policy decision, grant check, consistency, recap mode) are returned values. Adapters return `Result<T>` (`{ ok, value } | { ok, error: AdapterError }`) for expected failures (`sold_out`, `price_changed`, `offer_expired`, `hold_expired`, `approval_invalid`, `not_supported`, `not_configured`…) and throw only on programmer errors. The agent catches both at the turn boundary and renders VOICE §4.10 (two lines, says whether money moved and what happens next; never an error code).

Idempotency:
- Booking: `approval.deriveIdempotencyKey` (SAFETY §2.1). The key is checked before `evaluate` (`ctx.existingBookingForKey`), again inside the executor, passed to the provider (same key ⇒ same order; mocks count purchases), and `BookingRepository.createBooking` rejects a duplicate key.
- Ledger: `ExpenseRepository.create` enforces unique `sourceRef` (`booking:<id>`, `private_item:<id>`, `message:<id>`), so re-running post-booking steps or re-confirming a private item cannot double-write.
- Grants: `applyApproval` is idempotent per member; a second 👍 or a double button press is `'ignored'` with `already_granted`, not a second grant.
- Channel: inbound events may be duplicated; the agent dedupes by `messageId` per conversation. Outbound ids come from `IdGenerator` so a retried send carries the same id.
- Scheduler: `schedule(job)` with an existing `jobId` replaces it.
- Intentional repeat ("buy it again") adds `nonce` to the key and audits `booking.duplicate_override`.

Audit event naming: `<entity>.<state_or_past_tense>` snake_case (`booking.completed`, `approval.invalid_attempt`); the union lives in `core/domain/audit.ts`; payload requirements are the SAFETY §2.2 table. Every lifecycle step writes its event before the next step runs. Owner-visibility events (`private.*`) carry `ownerId` and never render in group views.

---

## 7. IDs

`core/ids.ts` (D-011): `IdGenerator.next(prefix)` → `<prefix>_<26 chars>`; prefixes in `ID_PREFIXES` (`grp`, `mem`, `trip`, `act`, `exp`, `prop`, `bk`, `grant`, `aud`, `msg`, `card`, `priv`, `job`, `tkt`, `photo`). `createDeterministicIdGenerator(seed)` for tests and fixtures (stable snapshots); `createUlidIdGenerator(clock)` for runtime (time-sortable, from the injected clock). Fixture ids are hand-written with the same prefixes (`mem_dean`, `grp_barcelona`). Channel-side ids (`SenderId`, `ConversationId`, provider order ids) are opaque strings owned by the adapter.

---

## 8. Testing conventions

- Unit tests sit next to the code (`*.test.ts`), run with `TRAV_OFFLINE=1` (set in every vitest config). `pnpm check` = typecheck + lint + test and must be green at every commit.
- Fixtures live in `fixtures/<feature>/` (`fixtures/groups/barcelona.json`, `fixtures/ledger/*.json`, `fixtures/flights/*.json`, `fixtures/transactions/<member>.json`, `fixtures/emails/*.json`, `fixtures/receipts/*.{png,json}`, `fixtures/injection/*`, `fixtures/roast/blocklist.json`, `fixtures/album/*`, `fixtures/scripts/*.json`, `fixtures/chats/*.jsonl`). The three reference trips are `barcelona`, `lisbon`, `turks-and-caicos`. All data fictional; no real brands' templates.
- Load fixtures through one helper per package (`loadFixture(name)`) that resolves from the repo root; never relative to `process.cwd()`.
- Shared repository suite: `packages/core/src/storage/repository.suite.ts` exports `runRepositorySuite(name, () => Stores)`; `memory.test.ts` and `sqlite.test.ts` each call it. Any new repository method gets its test in the suite, not in one implementation.
- Every pure function takes `now` or a `Clock`; tests use `fixedClock('2026-03-14T21:40:00+01:00')` and `createDeterministicIdGenerator('t')`.
- Property tests (`fast-check`, core devDependency): balances sum to zero, settlement clears balances with ≤ n−1 transfers, optimizer matches brute force on small inputs.
- Architectural tests (T-054, `packages/evals/src/arch/`): exactly one non-test caller of provider `.purchase(`/`.createOrder(`/`.book(`/`.charge(`; tool registry contains no forbidden names; `AuditRepository` has no update/delete; mock adapters import no `fetch`/`http`/`net`; no `Date.now()` outside `clock.ts`.
- Type-level tests use `// @ts-expect-error` and rely on `pnpm typecheck` compiling test files (it does: tsconfig includes `src/**/*.ts`).

---

## 9. How to add a tool

1. Create `packages/agent/src/tools/<name>.ts` exporting a `ToolDefinition<I, O>`: `name` (snake_case, must not match `FORBIDDEN_TOOL_NAME_PATTERN`), `description` (what the model sees; one paragraph), `inputSchema` (JSON schema), `parse(input)` (validate, throw `TravError('invalid_argument')`), `handler(input, ctx)`.
2. The handler reads/writes `ctx.stores`, writes audit events for state changes, and returns a plain, group-safe object (if it ever returns private data it must be `dmOnly: true` and only run on the DM lane).
3. Never call a provider's `purchase`/`createOrder`/`book`/`charge` from a tool. Booking tools stop at `BookingProposal`.
4. Register it in `tools/index.ts` and add the name to `V0_TOOL_NAMES`; the registry test asserts the exact list.
5. Add an offline script (or a `FallbackResponder` rule) so the Razzmatazz and ingestion fixtures exercise it without an API key.

## 10. How to add a provider mock

1. Implement the interface from `packages/adapters/src/interfaces/<provider>.ts` in `packages/adapters/src/mock/<provider>/index.ts`, exporting a factory `createMock<Provider>({ clock, ids, inventory })`. No network imports. `info.mode === 'mock'`.
2. Inventory comes from `fixtures/<provider>/*.json`, loaded once; expiries (holds, offers, refund deadlines) are computed from the injected `Clock`.
3. Money-moving methods must: verify `ApprovalProof` (group, expiry, `maxAmount` ≥ total, currency), honor `expectedTotal` (else `price_changed` with `newAmount`), be idempotent per `idempotencyKey` (return the same order; expose a `purchaseCount()` test hook), and never be exported as a bare function from the package root (only the factory).
4. Return `Result`; never throw for expected failures. Include the failure cases the backlog lists (`sold_out`, `hold_expired`, `price_changed`, `offer_expired`, `redirect_only`, `not_supported`).
5. Add the adapter to `ProviderRegistry` (`agent/booking/executor.ts`) only if the executor needs it; read-only adapters (FX, album, transactions) are injected into the tools/ingest flows directly.
6. Tests: deterministic inventory, the idempotency counter, the approval rejection, and "no `fetch`/`http` import" (covered by the arch test).

---

## 11. Build parallelism

See the "Parallel groups" block at the top of the P0 section in `tasks/BACKLOG.md`. The rule: tasks may run concurrently when they touch disjoint directories (not just disjoint packages); `index.ts` files already export the module directories, so a task that stays inside its directory never edits a shared file.

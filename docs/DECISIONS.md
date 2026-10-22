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

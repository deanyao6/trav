# Questions for Dean

Things the overnight run could not decide or was blocked on. Ranked by importance within each section; newest at the bottom.

## Blocked / needs a decision

(none yet)

## Noted, not blocking

- pnpm 12 needs `XDG_RUNTIME_DIR` pointed inside the repo to work in the sandbox (see `docs/DECISIONS.md` D-002). `scripts/overnight.sh` now sets it; the currently running overnight loop already started, so this session's agents set it per shell. If you run pnpm yourself outside the sandbox, nothing changes.
- The guard hook's "dumping environment variables" rule also matches any command that mentions `.env` followed by a pipe (e.g. `cat .env | wc -c`). Harmless, but the orchestrator avoids touching `.env` entirely.

#!/usr/bin/env bash
# Runs the Trav orchestrator in repeated headless Claude Code sessions until the
# time limit. Safe to run on your own Mac: no --dangerously-skip-permissions.
# Containment comes from .claude/settings.json (OS sandbox + permission rules +
# guard hook). See SETUP.md for the one-time setup.
#
# Usage:  ./scripts/overnight.sh [hours]   (default 9)

set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"

HOURS="${1:-9}"
END=$(( $(date +%s) + HOURS * 3600 ))
mkdir -p logs

# --- Preflight -------------------------------------------------------------

# 1. Claude Code must bill your Max plan, not your API credits.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
if ! claude auth status 2>&1 | grep -qi 'claude.ai'; then
  echo "Claude Code is not logged in with your Claude subscription. Run 'claude' and /login first."; exit 1
fi

# 2. The repo must not live inside a folder the sandbox hides (it would break).
for d in Documents Desktop Downloads Pictures Library .config; do
  case "$ROOT/" in "$HOME/$d/"*) echo "Move the repo out of ~/$d (e.g. to ~/trav). The sandbox blocks that folder."; exit 1;; esac
done

# 3. Git: origin must be the Trav repo, using the repo-scoped token only.
export TRAV_REPO_URL="${TRAV_REPO_URL:-https://github.com/deanyao6/trav.git}"
ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
if [ "${ORIGIN%.git}" != "${TRAV_REPO_URL%.git}" ]; then
  echo "origin is '$ORIGIN', expected '$TRAV_REPO_URL'. See SETUP.md step 3."; exit 1
fi
HELPERS="$(git config --local --get-all credential.helper 2>/dev/null || true)"
if [ -n "$(printf '%s\n' "$HELPERS" | head -1)" ] || ! printf '%s' "$HELPERS" | grep -q 'trav-credentials'; then
  echo "Repo-local credential helper not set up (keychain must be disabled for this repo). See SETUP.md step 3."; exit 1
fi

# 4. Keep every cache inside the repo (the sandbox only allows writes here).
export npm_config_cache="$ROOT/.cache/npm"
export PNPM_HOME="$ROOT/.cache/pnpm-home"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.cache/ms-playwright"
export XDG_CACHE_HOME="$ROOT/.cache"
export COREPACK_HOME="$ROOT/.cache/corepack"
# pnpm 12 keeps its store operation locks under XDG_RUNTIME_DIR; the default lives
# outside the repo and the sandbox refuses it (ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK).
export XDG_RUNTIME_DIR="$ROOT/.cache/runtime"
mkdir -p "$XDG_RUNTIME_DIR"

# 5. pnpm must already be installed (the sandbox can't install it).
command -v pnpm >/dev/null || { echo "pnpm not found. Run: brew install pnpm"; exit 1; }

# 6. Keep the Mac awake while this script runs (-s needs AC power).
caffeinate -dimsu -w $$ &

echo "Preflight OK. Running until $(date -r "$END" 2>/dev/null || date -d "@$END")." | tee -a logs/overnight.log

# --- Loop ------------------------------------------------------------------
RUN=0
while [ "$(date +%s)" -lt "$END" ]; do
  RUN=$((RUN + 1))
  P0=$(grep -cE '^- \[ \] T-[0-9]+ \| P0' tasks/BACKLOG.md 2>/dev/null || echo "?")
  echo "=== Session $RUN — $(date) — open P0 tasks: $P0 ===" | tee -a logs/overnight.log
  START=$(date +%s)

  claude -p "$(cat KICKOFF.md)" \
    --model fable \
    --permission-mode dontAsk \
    --settings .claude/settings.json \
    --max-turns 400 \
    --output-format text \
    >> "logs/session-$RUN.log" 2>&1
  CODE=$?
  ELAPSED=$(( $(date +%s) - START ))
  echo "Session $RUN exited with code $CODE after ${ELAPSED}s" | tee -a logs/overnight.log

  # A session that dies quickly usually means a usage limit; wait it out.
  if [ "$ELAPSED" -lt 300 ]; then
    echo "Short session; backing off 15 minutes (likely a usage limit)." | tee -a logs/overnight.log
    sleep 900
  else
    sleep 20
  fi
done

echo "=== Done at $(date). Read MORNING_REPORT.md and .claude/hooks/blocked.log ===" | tee -a logs/overnight.log

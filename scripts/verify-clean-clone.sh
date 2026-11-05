#!/usr/bin/env bash
# Verifies a commit from a clean checkout: no untracked files, no local
# node_modules, no regenerated fixtures, UTC clock, offline mode, no API key.
# This is the only source of pass counts for MORNING_REPORT.md and for marking
# a P0 task done.
#
# Uses `git worktree` instead of `git clone` (the guard hook forbids cloning);
# the result is the same: exactly the committed tree, nothing else.
#
# Usage:  scripts/verify-clean-clone.sh [ref]          (default HEAD)
# Node:   runs on whatever `node` is first on PATH. To check Node 22, put a
#         Node 22 binary first on PATH (e.g. via nvm/fnm) and run it again.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"
REF="${1:-HEAD}"
BASE="${TMPDIR:-/tmp}"
W="$(mktemp -d "${BASE%/}/trav-verify.XXXXXX")"
cleanup() { git -C "$ROOT" worktree remove --force "$W" >/dev/null 2>&1; rm -rf "$W"; }
trap cleanup EXIT

git worktree add --detach -q "$W" "$REF" || { echo "could not check out $REF"; exit 2; }
cd "$W"
export TZ=UTC TRAV_OFFLINE=1
export XDG_RUNTIME_DIR="$W/.cache/runtime" npm_config_cache="$ROOT/.cache/npm"
mkdir -p "$XDG_RUNTIME_DIR"
unset TRAV_ANTHROPIC_API_KEY

FAILED=()
run() {
  local name="$1"; shift
  echo; echo "== $name"
  if "$@"; then echo "PASS $name"; else echo "FAIL $name"; FAILED+=("$name"); fi
}
fixtures_deterministic() {
  pnpm -s fixtures:gen || return 1
  local drift
  drift="$(git status --porcelain --untracked-files=all)"
  [ -z "$drift" ] && return 0
  echo "fixtures:gen changed or added files that are not committed:"; echo "$drift" | head -40
  return 1
}

echo "clean checkout of $(git rev-parse --short HEAD) · node $(node --version) · TZ=$TZ · offline"
run install pnpm install --frozen-lockfile --store-dir "$ROOT/.cache/pnpm-store"
run fixtures-deterministic fixtures_deterministic
run check pnpm -s check
run demo pnpm -s demo:barcelona
run eval pnpm -s eval --no-report

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "CLEAN CHECKOUT PASS ($(git rev-parse --short HEAD), node $(node --version))"
else
  echo "CLEAN CHECKOUT FAIL: ${FAILED[*]} ($(git rev-parse --short HEAD), node $(node --version))"
  exit 1
fi

#!/usr/bin/env bash
# Creates a git worktree for a parallel builder under .cache/wt-<name>.
# The sandbox forbids writing .claude/ (agents, hooks, settings) in any
# checkout, and forbids writing .git/config, so neither a plain
# `git worktree add` nor `git sparse-checkout` works. Builders don't need
# .claude/ in their worktree, so this checks out everything else and marks the
# .claude/ files skip-worktree (index only), so they don't show as deleted.
#
# Usage:  scripts/new-worktree.sh <name> [ref]   (default ref: HEAD)
# Result: .cache/wt-<name> on a new branch <name>.
# Remove: git worktree remove --force .cache/wt-<name> && git branch -D <name>
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="${1:?usage: scripts/new-worktree.sh <name> [ref]}"
REF="${2:-HEAD}"
W=".cache/wt-$NAME"
git worktree add --no-checkout -q -b "$NAME" "$W" "$REF"
cd "$W"
git reset -q
git ls-files -z -- .claude | xargs -0 git update-index --skip-worktree
git ls-files -z -- . ':(exclude).claude' | xargs -0 git checkout -q --
echo "worktree ready: $W (branch $NAME, from $(git rev-parse --short HEAD))"

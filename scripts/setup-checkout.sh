#!/usr/bin/env bash
# Brings a fresh clone, or a new `git worktree add` checkout, to what CI checks out
# (.github/workflows/ci.yml: `submodules: recursive`, then `pnpm install --frozen-lockfile`), and
# builds every package so the cross-package imports resolve.
#
# A worktree does not inherit submodules: without this, packages/contracts/lib (forge-std,
# openzeppelin-contracts) is empty, `forge build` fails, and so do test:contracts and the
# gate-market-agents devnet smoke test.
#
#   bash scripts/setup-checkout.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm run build
for lib in forge-std openzeppelin-contracts; do
  [ -n "$(ls -A "packages/contracts/lib/$lib" 2>/dev/null)" ] || { echo "packages/contracts/lib/$lib is still empty" >&2; exit 1; }
done
echo "checkout ready: submodules, dependencies and builds match CI."

#!/usr/bin/env bash
# Run by the Windows Task Scheduler through wsl.exe (docs/marketplace_plan.md D100). Appends to a private log; never prints a value.
#   scripts/daily-snapshot.sh            the hourly run: pulls today's snapshot if the day is not complete
#   scripts/daily-snapshot.sh --watchdog the evening check: alerts if the day is not complete
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$PATH"
logdir="$repo/data/private/blockworks/cr/logs"
mkdir -p "$logdir"
log="$logdir/daily-snapshot-$(date -u +%F).log"
cd "$here" || exit 1
[ -f dist/cli/daily-snapshot.js ] || pnpm run build >>"$log" 2>&1
node --env-file="$repo/.env" dist/cli/daily-snapshot.js "$@" >>"$log" 2>&1

#!/usr/bin/env bash
# Run by the Windows Task Scheduler through wsl.exe (docs/marketplace_plan.md D114). Appends to a private log; never prints a value.
#   scripts/mcp-login-check.sh   the daily check that the stored Blockworks MCP login still works; emails an alert if it does not.
# It sends no data request: one token renewal and one tool listing. A "could not reach" is retried for about three and a half minutes before it alerts, so a machine that woke before its network does not send a false alarm.
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$PATH"
logdir="$repo/data/private/blockworks/cr/logs"
mkdir -p "$logdir"
log="$logdir/mcp-login-check-$(date -u +%F).log"
cd "$here" || exit 1
[ -f dist/cli/mcp-login.js ] || pnpm run build >>"$log" 2>&1
{
  echo "$(date -u +%FT%TZ) mcp login check starting"
  node --env-file="$repo/.env" dist/cli/mcp-login.js --check --alert
  echo "$(date -u +%FT%TZ) mcp login check exit $?"
} >>"$log" 2>&1

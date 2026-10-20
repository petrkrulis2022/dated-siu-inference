#!/usr/bin/env bash
# Run by the Windows Task Scheduler through wsl.exe (docs/marketplace_plan.md D116). Appends to a private log; never prints a value.
#   scripts/daily-mcp.sh            the hourly run: plays today's MCP-mode sessions once today's snapshot is complete (spends money on the trial's Anthropic key, within its caps)
#   scripts/daily-mcp.sh --watchdog the evening check: alerts if the snapshot is in and the sessions are not all recorded
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:$PATH"
logdir="$repo/data/private/blockworks/cr/logs"
mkdir -p "$logdir"
log="$logdir/daily-mcp-$(date -u +%F).log"
cd "$here" || exit 1
[ -f dist/cli/daily-mcp.js ] || pnpm run build >>"$log" 2>&1
if [ "${1:-}" = "--watchdog" ]; then
  node --env-file="$repo/.env" dist/cli/daily-mcp.js --watchdog >>"$log" 2>&1
else
  node --env-file="$repo/.env" dist/cli/daily-mcp.js --yes-spend "$@" >>"$log" 2>&1
fi

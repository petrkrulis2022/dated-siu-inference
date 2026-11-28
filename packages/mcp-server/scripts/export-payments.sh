#!/usr/bin/env bash
# Runs the payment-log export (src/cli/export-payments.ts) the way cron needs it: Node 22 from nvm
# (wrangler requires it) and the package's built output. Run hourly: a run with nothing to do
# makes one small D1 query (the first payment's date) and writes nothing. See README.md,
# "Payment log export".
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" >/dev/null
nvm use 22 >/dev/null
cd "$(dirname "$0")/.."
exec node dist/cli/export-payments.js "$@"

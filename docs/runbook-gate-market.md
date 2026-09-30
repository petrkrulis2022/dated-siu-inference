# Gate Market runbook

Operating notes for the fSIU testbed runs. Everything here was learned by getting it wrong once;
none of it is derivable from the code.

---

## Launching a run

```
cd packages/gate-market-agents
pnpm run p5-three-window-full-run > ../../data/gate-market/logs/p5-three-window-$(date -u +%Y-%m-%dT%H-%M-%S).log 2>&1
```

`pnpm` and `forge`/`anvil` are often not on a non-interactive shell's PATH:

```
export PATH="$HOME/.local/share/pnpm:$HOME/.foundry/bin:$PATH"
```

Without Foundry on PATH, 12 test files fail on `anvil and/or forge are not available` — an
environment fault, not a regression.

**Before launching, check three things.** A print dated *today* exists under `data/prints/`, or
every window's default path is unreachable and the enforcement arm is dead for the whole run.
Both issuers have headroom above the job size, or first-fit decides routing by arithmetic. And
the run will not cross midnight UTC, for the same print-date reason.

---

## Stopping a run

**`kill -TERM` on the pnpm wrapper does not stop the run.** The wrapper dies, prints
`ELIFECYCLE Command failed`, and the node child keeps going — which looks exactly like a
successful stop and is not. Kill the node process directly and then verify:

```
for p in $(pgrep -f "dist/cli/p5-three-window-full-run.js"); do kill -9 $p; done
ps -eo pid,args | grep "p5-three-window-full-run.js" | grep "^ *[0-9]* node" || echo "stopped"
```

The second line matters: a plain `pgrep -f` matches **your own shell** because the pattern is in
its command line, so it reports the run as alive after it has gone. Filter for the `node`
process specifically.

**A killed run does not return the external buyer's capacity.** `releaseExternalClaims` runs
after the last window, so killing before then strands that run's depletion (3,000 mSIU per
completed window) exactly as the old ratchet did. Sweep before the next run — see below.

---

## Sweeping outstanding claims

Capacity consumed by an unsettled claim comes back when the claim reaches any terminal state.
`settleWindowClose` is permissionless, so anyone can do it once the window has closed.

Two states, and the difference is whether the holder ever presented:

- **presented, never served → Default.** The issuer's bond pays the holder. Needs a
  publisher-signed rate attestation whose `printDate` is the day that window closed.
- **never presented → Expire.** Headroom returns, nobody is paid, no attestation needed.

**Enumerate before sweeping, and reconcile against an independent total.** A scan is only
trustworthy if `sum(HeadroomConsumed) - sum(HeadroomRestored)` matches live `headroom()`. A scan
whose hand-written ABI omits `TransferSingle` silently misses every claim that changed hands and
reports "no open positions" while tens of thousands of mSIU sit in transferred ones.

**Log scanning: use the public endpoint, not the archive one.** `sepolia.base.org` allows a
1,000-block `eth_getLogs` range. The Alchemy key in `TOUCHSTONE_BASE_SEPOLIA_ARCHIVE_RPC` is a
free tier capped at **10 blocks**, which is a hundred times worse. See `methodology.md`.

---

## Reading numbers back after a write

**Waiting for the transaction receipt is not enough.** A load-balanced public endpoint can serve
a pre-transaction view *after* the receipt confirms, because the node answering the read is not
the node that saw the write. This produced three wrong figures in one day, every one of them
understating the change, which reads as partial failure and invites the wrong follow-up.

Re-read from a fresh connection at a block height at or beyond the transaction's, and treat any
unconfirmed post-write read as provisional.

---

## Monitoring a live run

**Filter on content and you cannot see a stall**, because silence produces no events and looks
identical to progress. That cost half an hour on 2026-09-29. Watch liveness separately.

**Silence alone is not a deadlock.** The runner sleeps between windows by design. The
discriminator is CPU: silent and idle is waiting, silent and burning 30%+ is spinning.

**Every stage of a monitor pipeline must flush per line.** `grep` needs `--line-buffered`; `awk`
needs `fflush()`; **`cut` cannot flush at all** and will hold output in a 4KB buffer until it
fills — a monitor ending in `cut` delivered nothing for 30 minutes while the run proceeded
normally. Use `awk '{ print substr($0, 1, 200); fflush() }'` instead.

---

## Before pushing

**Run the CI pipeline's own steps, not just the tests.** CI runs build, typecheck, lint, format,
a deployments-sync check and then the tests — and it stops at the first failure, so a lint error
hides everything after it. Nine consecutive pushes went red on one unused variable while the
test suite passed locally every time.

```
pnpm run build && pnpm run typecheck && pnpm run lint
gh run list --limit 3          # after pushing, actually look
```

`pnpm run format` is unreliable locally unless dependencies were installed with
`--frozen-lockfile`: a different prettier version flags thousands of long-committed data files
that CI is perfectly happy with. Trust CI's format step over a local one.

## Costs

A three-window run at 2,400-second windows is about two hours of wall clock and $1–2 of real
inference, against a $30 per-run cap enforced on the *projected* figure. Five comparable runs
need four providers healthy throughout each — there have been five provider interruptions in two
weeks — so run them across two days rather than one block, and re-run a single run lost to an
outage rather than restarting the block (`gate-market-spec.md` §7.1a).

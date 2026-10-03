# Gate Market runbook

Operating notes for the fSIU testbed runs. Everything here was learned by getting it wrong once;
none of it is derivable from the code.

---

## Launching a run

```
cd packages/gate-market-agents
pnpm run p5-three-window-full-run > ../../data/gate-market/logs/p5-three-window-$(date -u +%Y-%m-%dT%H-%M-%S).log 2>&1
```

### Debugging runs

A run that exists to test the loop, not to produce a number:

```
pnpm run p5-three-window-full-run -- --debug
```

`--debug` pins a known-good gate instead of buying one (where almost all the money goes — run
16's WORKER-CODE turns alone exceeded $0.90), and moves the non-decider seats to a cheap model.
ORCHESTRATOR and WORKER-CODE keep their assigned models whatever happens: they are the seats F1
is about and the ones every holder-facing finding has come from.

`--windows N` shortens a run, and **defaults to three with or without `--debug`**. Three of the
last four findings came from window 2 or later, so a short default would have hidden them while
looking like a saving. Use it for tests that genuinely only need window 1.

`--no-pre-authored-gate` and `--no-cheap-models` switch off either saving on its own.

**A debug run cannot meet the bar or count toward F1, and this is enforced rather than
remembered.** Its runId is prefixed `DEBUG-`, its manifest and report both carry a `debugMode`
block with `countsTowardF1: false` and the reason, and `assertCountableForF1` throws on it. A
shortened run is disqualified too, `--debug` or not: length changes comparability.

The gate is still graded for real, by the same grader, on the same inputs. Every economic step —
purchase, claim, presentation, delivery, attack, settlement, enforcement — is real on a real
chain. What is not real is who authored the work and what the seats cost.

**A debug run does not validate the roster, and this is the trap to avoid.** Substituting the
non-decider seats collapses four providers onto two: a debug run calls only Anthropic and
OpenAI, never xAI or Google. That is genuinely good for reliability — seven provider
interruptions in two weeks, and a run cannot be killed by a provider it never calls — but it
also means **model-specific failures are unreachable**. grok truncating mid-JSON at a 1,500-token
ceiling and again at 4,500, gemini spending 21,782 of 22,500 output tokens on reasoning and
returning no text: both ended real runs here, and neither can happen when neither model runs.

**It is also blind to anything time-gated.** Every saving shortens the span over which agents
take turns, so a warning that fires on elapsed time may never become eligible before the stall
guard ends the window. Seen 2026-10-03: a claim presented with 2,298s left put its warning's
midpoint eighteen minutes after the last turn anyone took. The overdue warning, the
unpresented-expiry warning and late-stage forward invitations are all affected.

So a green debug run proves the **loop** works. It says nothing about the **roster**, and
nothing about time-gated behaviour. The
full-cost confirmation run is what validates the roster, and it is **required before any freeze
however clean the debug runs look**. The run prints the collapse in its own banner, and the
manifest and report both carry `providersExercised`, `providersNotExercised` and
`validatesTheBlocksRoster`.

---

`pnpm` and `forge`/`anvil` are often not on a non-interactive shell's PATH:

```
export PATH="$HOME/.local/share/pnpm:$HOME/.foundry/bin:$PATH"
```

Without Foundry on PATH, 12 test files fail on `anvil and/or forge are not available` — an
environment fault, not a regression.

**The run now reconciles the pool for you at launch** and refuses to start if headroom does not
match the lots' issuance limits, naming the issuer and the shortfall. A run that crashed before
its own close-out leaves capacity consumed and the next run inherits it silently — that happened
on 2026-10-03 and went unnoticed until the headroom line was read by hand. Settle what is
outstanding, or pass `--allow-partial-pool` and have the shortfall recorded in the report.

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

**A liveness monitor must not use a bare `pgrep -f`.** The runbook already says this for the
kill procedure; it applies with more force to a watch, because a watch fails silently. Every
liveness monitor armed on 2026-10-01 used `pgrep -f "dist/cli/p5-three-window-full-run.js"` and
**could never have reported a dead run**: the pattern appears in the monitor's own shell command
line, so `pgrep` matched the monitor itself and the process always looked alive. Demonstrated
rather than argued — a dummy `node` process was started and killed:

```
after the kill:   pgrep -f  -> STILL RUNNING (wrong, it matched the checking shell)
                  node-only -> GONE (correct)
```

Use the same filter the kill procedure uses, and nothing else:

```bash
ps -eo pid,args | grep "p5-three-window-full-run.js" | grep -E "^ *[0-9]+ node"
```

A watch that cannot fire is worse than no watch: during a five-run block a hung run would burn a
day while the monitor reported nothing, which is exactly what "no events delivered" looks like
when everything is fine.

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

## Provider credit, before a block

**Two runs in two days died mid-flight on an exhausted provider** — Google on 2026-09-30
(`402`), Anthropic on 2026-10-01 (`400`, body: *"Your credit balance is too low"*). Both were
topped up shortly before. A balance that looks fine on a dashboard is not a pre-flight check.

Before a five-run block, set **auto-reload on every provider: trigger below $25, add $50.**
Anthropic, xAI, OpenAI and Google. One three-window run costs $2-3 of real inference and
WORKER-CODE alone took $0.80 of a single window, so a balance sized for one run guarantees the
block dies partway through — and a provider outage re-runs that run (`gate-market-spec.md`
§7.1a), so repeated exhaustion ends the block by billing rather than by findings.

**The run now does this itself and aborts before spending anything.** `provider-preflight.ts`
makes one real call per provider through the run's own adapter and refuses to start if any
fails, so an exhausted account costs nothing instead of a window. It reports identity where a
provider gives one — Anthropic's organization name, xAI's key name — because a dashboard showing
credit while a key reports none means the credit landed on a different organization, and the org
name is what makes that visible:

```
=== PROVIDER PRE-FLIGHT ===
  FAILED  anthropic  claude-sonnet-5  org "SoundFlow Finance" — Anthropic request failed: 400
  OK      google     gemini-3.1-pro-preview answered in 5628ms
  OK      xai        grok-4.6 answered in 3742ms  key "siu-prints"
```

**No provider exposes a credit balance to an API key**, checked 2026-10-01: OpenAI's
`/v1/dashboard/billing/credit_grants` accepts only a browser session key, and Anthropic and xAI
have none. A live call is the better check anyway — it fails on an exhausted account, a revoked
key, *and* a key billing to the wrong organization, which a balance figure would not catch.

**Probe each provider through its own adapter before launching, not the dashboard.** A real
call costs a fraction of a cent and is the only check that exercises the key, the organization
and the balance together:

```
node --env-file=.env --input-type=module -e 'import {createAnthropicAdapter} from "./packages/harness/dist/adapters/anthropic.js"; ...'
```

A dashboard showing credit while the key reports "balance too low" means the credit landed on a
different organization or workspace than the key. Check that before waiting for propagation.

## Costs

A three-window run at 2,400-second windows is about two hours of wall clock and $1–2 of real
inference, against a $30 per-run cap enforced on the *projected* figure. Five comparable runs
need four providers healthy throughout each — there have been five provider interruptions in two
weeks — so run them across two days rather than one block, and re-run a single run lost to an
outage rather than restarting the block (`gate-market-spec.md` §7.1a).

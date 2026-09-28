# Restatement — P5 three-window run, 2026-09-28

The machine-readable report beside this file (`…-report.json`) records every window as
`passed: true`. **That figure must not be read as the market working.** This note restates what
actually happened, per the correction agreed after the run. The report itself is left unedited —
a run record is not rewritten after the fact; it is annotated.

## What `passed: true` actually means here

In all three windows the gate was authored by **WORKER-CODE, the claim holder** — not by the
routed issuer that owed the delivery. `passed`/`passedBy` are set by *any* passing `submit_job`,
regardless of who submitted it, so the flag records that a gate exists, not that the work was
bought, delivered by whoever owed it, or paid for.

**No claim was honoured in this run.** Neither claim was ever served by its issuer. Both are still
outstanding, and WORKER-CODE still holds 10,000 mSIU of each.

| Window | `passed` | What actually happened |
| --- | --- | --- |
| 1 | true | ORCHESTRATOR paid 10,000 mSIU in fSIU, routed to ISSUER-A. WORKER-CODE presented the claim; ISSUER-A never served it (unparseable output, halted). WORKER-CODE then authored the gate itself — which its brief forbids. |
| 2 | true | Same again. ISSUER-A's one real delivery attempt failed G1–G6 (no `gate()` export) and its retry was truncated mid-JSON at its output cap. WORKER-CODE authored the gate itself again. |
| 3 | true | **ORCHESTRATOR could not buy at all** — four `pay_with_claim` attempts, every one reverting `NoIssuerWithHeadroom` against a 4,000 mSIU pool. WORKER-CODE authored the gate anyway, **unpaid**. |

## The run's real result

**Scarcity bound, on-chain.** Window 3's buyer tried four times and was refused by the contract
every time. That is the instrument's core property demonstrated against real bonded capacity.

**And an issuer took payment without delivering.** ISSUER-A earned 42,990 USDC minor units and
served nothing. Because no agent held `settle_window_close` — and because a claim cannot default
inside its own window — the default that exists for exactly this could not be triggered by anyone.
That is the finding, not a flaw in it: *without enforcement, an issuer can take payment and simply
not deliver.*

## Corrections made after the run

- The run printed `VERDICT: completed — the instrument working as intended`. **Wrong**, and wrong
  because of this runner's own classifier: it counted two ordinary same-window payments as
  "capacity secured ahead". Nothing was ever forward-dated. Re-running the corrected classifier
  against this run's own committed report returns **`scarcity`**.
- Fixes since, all covered by `docs/gate-market-spec.md` §4.6a–4.6c: `submit_job` is now refused at
  the tool boundary for a claim holder; `whoami` exists; class ids accept the plain name; issuers
  get the same output budget as workers; and the default path is wired across windows.

## What this run does not establish

- **Not an F1 result.** ORCHESTRATOR settled every purchase it managed in fSIU and never used the
  USDC route — but in window 3 it repeated one identical failing call four times without checking
  headroom, reducing quantity, or trying dollars. One fixed move repeated into a wall is not a
  preference between two instruments.
- **Not an adversarial-yield result.** One attack across three windows, zero false accepts, and
  that attack landed on ISSUER-A's broken gate and returned `inconclusive` / `gate_error`.

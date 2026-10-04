# Single-issuer windows: report before running

Asked 2026-10-04 against the proposal to make fSIU fungible by configuration — one issuer per
(class, window), enforcement from window 2, no contract changes. Four items were to be confirmed
before running. **Item 1 does not confirm**, and item 4 reverses a correction I made yesterday.

---

## 1. "Headroom is per (class, window)" — NO. It is per (issuer, class), with no window dimension.

```solidity
function headroom(address issuer, bytes32 classId) public view returns (uint256)
```

There is no window in the key, and none in `issuanceLimit` or `Lot`. Headroom is a single
running quantity per issuer per class that persists across every window of a run. **"Only
ISSUER-B has a lot in window 1, only ISSUER-A in window 2" is not directly expressible**, and
two further facts constrain the workaround:

- **`createLot` reverts `LotExists`** if an issuer already has a lot in that class, so a lot
  cannot be topped up, resized, or re-created mid-run. An issuer's capacity is fixed at the
  moment it bonds.
- **`_issuersForClass` is append-only and `route` is first-fit** (§4.6g). Registration order is
  routing priority, permanently.

### What is achievable, and the arithmetic that makes it deterministic

Deploy with **ISSUER-A holding no `code` lot at all**. Then `issuersForClass(code) == [B]` and
every window-1 mint routes to B by construction — not by arithmetic, which is the strongest form
of determinism available here.

For window 2 to route to A, A must bond a `code` lot between the windows (a real transaction the
runner performs), which appends it *after* B. First-fit therefore still prefers B, so **B's
headroom must be below the mint size when window 2 opens.**

With the job at 10,000 mSIU, that means B must end window 1 under 10,000. Window 1 consumes:

| | mSIU |
| --- | --- |
| gate-authoring job | 10,000 |
| WORKER-CODE's attack purchase (now structural, F1 fix 2) | 4,000 |
| external buyer, after the window | 3,000 |
| **total** | **17,000** |

**A `code` lot of 17,000 for ISSUER-B is the clean choice.** It covers both agent purchases
exactly, and — the part that matters — after the gate job alone B sits at 7,000, already below
10,000. So window 2 routes to A **whatever else happens in window 1**, including the attack
purchase failing or the external buyer being skipped. Any B lot in [14,000, 19,999] has that
property; 17,000 is the one that also leaves no residue.

`issuanceLimit = committedCapacityHours × measuredRateMilliSiuPerHour × 0.5`, so 17,000 needs
the product to be 34,000 — e.g. 10 hours × 3,400 mSIU/h. Note this changes B's fixture rate,
and §12.2a requires the two issuers' capacity models to differ, which they still would (A is
120 mSIU/h × 800h). **These are fixtures, not measurements, and the lot size is a scenario
property that must be disclosed in the caption** — it is chosen to make the routing
deterministic, not derived from anything measured.

## 2. "No F1 agent holds window-2 claims during F1's measurement period" — confirmed, with one exception to close

Claims carry `windowFrom`/`windowTo` and `presentForRedemption` reverts outside them, so a
window-2 claim cannot be presented during window 1. By construction, nothing from window 2
exists during F1's measurement period.

**The exception is forward-dating.** `mint_claim` and `pay_with_claim` accept `forWindow`, which
lets a window-1 buyer mint a claim dated for window 2. It has never been used — `forwardDated:
true` appears **zero times across eleven runs** (§4.6n) — so the practical risk is low.

Two things worth knowing if it does happen. The claim would be **backed by ISSUER-B**, not A,
because routing happens at mint and A has no lot during window 1 — so it would not be
contaminated by the non-serving issuer. But it **would consume B's headroom**, which is the
quantity the window-2 arithmetic above depends on. A forward-dated mint of 10,000 in window 1
would push B to zero early and could starve the attack purchase.

Recommendation: leave `forWindow` available (removing it would be a steer, §4.6q) and **assert
in the runner that B's remaining headroom is below 10,000 when window 2 opens**, failing loudly
if not. That turns a fixture assumption into a checked precondition.

## 3. Share of minted fSIU backed by ISSUER-A, the issuer that cannot serve

Derived from every run report's capacity events:

| backing issuer | mints | mSIU |
| --- | --- | --- |
| ISSUER-A (non-serving) | 21 | 198,000 |
| ISSUER-B (serving) | 10 | 94,000 |

**67.8% of all fSIU ever minted was backed by the issuer that structurally cannot deliver**, and
67.7% of mints. First-fit sends every mint to A while A has headroom, and A is registered first.

This belongs in the methodology as stated: **F1 to date measured agents' preference for a claim
that, two times in three, could not be redeemed for work.** It is not a small caveat on the
25-of-29 figure; it is a different instrument from the one the number appears to describe.

## 4. Enforcement count, re-derived from defaults only — and a correction to my own correction

Yesterday I said "14 settlements across 9 runs, not 11" and implied the figure of eleven was
stale. **That was wrong, and in a way worth recording.** Re-deriving properly — a settlement is
a `Defaulted` only when the claim was ever presented, otherwise it is an `Expired` that pays
nobody (§4.6ag):

| | count |
| --- | --- |
| settlements total | 14 |
| of which **Defaulted** — the bond paid a holder | **11** |
| of which Expired — paid nobody | 3 |

So eleven was exactly right. I had the correct distinction and applied it to reach the wrong
conclusion: I compared a settlement count against an enforcement count and corrected the number
that was already the enforcement count. **Checking that two figures differ is not the same as
establishing which one is wrong**, and I did the first while reporting the second.

For use going forward, with the exclusions that matter:

- **9 agent-triggered bond enforcements in countable runs.** The 11 includes 2 from the
  disqualified debug run.
- **2 further defaults were operator-triggered** (2026-10-03) and must never enter a
  fulfilment, enforcement or holder-responsiveness statistic.
- The 3 Expired are not enforcement at all and were being counted as such before §4.6ag.

## Summary

Item 1 needs a configuration that was not in the proposal — ISSUER-A bonds no `code` lot at
deploy and bonds one between windows, with B's lot sized to 17,000 so first-fit cannot pick it
in window 2. That is still **no contract change**, which was the point. Items 2 and 3 confirm,
item 3 with a finding that reframes every prior F1 figure. Item 4 restores the number I had
wrongly corrected.

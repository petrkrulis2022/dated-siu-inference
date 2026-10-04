# Plan: the single-issuer instrument (sixth trio)

**Status: plan only. Nothing built, nothing deployed.** Written 2026-10-04 per the working
agreement (this touches well over two files). Five decisions are needed from you at the end.

Accepted so far: the sixth-trio redeploy; a short-lived build branch; apparatus fixes on main; a
`--deployment` flag with the fifth trio staying default and runnable; `instrument` stamped into
every manifest and report; no pooling across instruments; the freeze clock reset (debug run →
full-cost run → five-run block).

---

## 0. What you asked the plan to state

**Does `Expired` restore headroom? Yes — but only inside `settleWindowClose`, and never passively.**
`bond.restoreHeadroom` runs at [WorkClaim.sol:619](packages/contracts/src/WorkClaim.sol#L619),
*before* the `everPresented` branch, so `Expired` and `Defaulted` both restore. There is no other
path: `restoreHeadroom` has exactly three callers (`serveRedemption`, `releaseReservation`,
`settleWindowClose`) and nothing sweeps at `windowTo`. So a drain claim dated to window 1 does
**not** free B's headroom when window 1 closes. It frees it when somebody calls
`settleWindowClose` on it.

The existing external buyer already depends on exactly this: `depleteExternally` dates its claim
to the run's end and the runner settles it afterwards. So forward-dating is **insurance rather
than necessity**, and the drain can reuse that machinery. Agents can't trigger it by accident
either, since the board's "unsettled claims" list is built from agent mint events and operator
claims never appear in it.

---

## 1. What reading the code changed

**F1 — "A holds no code lot at deploy" holds for run 1 only.** `createLot` has no removal, so once
A bonds it is registered for good. Runs 2–5 would start with A already in `issuersForClass`, and
window 1 would route to B by *registration order and headroom* — not absence. A property that is
true for one run in five is not a property of the instrument. **Design for the case that holds for
all five:** deploy B first, A second, both lots from the start. Window 1 routes to B because B is
first and has headroom; after the drain B is at zero and routing falls through to A. This also
deletes the mid-run `createLot` and its failure modes (a run dying between drain and bond; `LotExists`
on every later run). See D1.

**F2 — nothing forces a WORKER-CODE purchase, and the service it would buy is free.**
`submit_attack` has no payment check (its four `throw`s are argument validation), and WORKER-EXTRACT
is woken by a gate *existing*, not by being paid. A window passes on the first gate PASS. The
4,000 mSIU "attack testing" quote is a tip for a service rendered anyway, which is why
WORKER-CODE has never bought. Your example — "buying the reference instance it attacks" — doesn't
map onto the roster: the reference instance is a fixed fixture in the job envelope and
WORKER-EXTRACT is the adversary, not a supplier. The structural equivalent is selling the testing.

**F3 — a quote-keyed fSIU path already exists.** `settle_split` takes a board quote, derives the
claim leg from it, and pays the quote's seller. Payment symmetry is making `pay_with_claim` work
the same way, not inventing a path.

**F4 — the repo has no live lot-bonding tool.** `createLot` appears only in the devnet deployer and
the local Foundry script. The fifth trio's lots were bonded by one-off scripts. A reproducible
`bond-lots` command is new work, and worth having whatever else happens.

**F5 — the decision rule as written cannot return "build it".** "Median hops above 1" needs a
claim to move onward twice. A hop is a `transfer_claim` after creation. WORKER-EXTRACT holds no
`transfer_claim`, so the longest sensible chain is ORCHESTRATOR → WORKER-CODE (creation, hop 0) →
WORKER-EXTRACT (hop 1). Hop 2 needs a pointless cycle. **The rule can only ever say "not built",
which makes the experiment unfalsifiable on one side** — the failure the rule exists to prevent.
See D5.

**F6 — F1 will have five decisions per buyer.** Windows 2–3 route to the non-serving issuer by
design, so fSIU purchases there answer a different question. F1 is window 1 only: one decision per
buyer per run, five across the block. If all five choose fSIU, the 95% Wilson lower bound on the
share is `n/(n+z²) = 5/8.84 ≈ 0.57`. That is the honest width of the first number and should be
stated before results, not after.

**F7 — a concession on §4.6ab.** I called the consent asymmetry "a real property of the two
instruments". It isn't: USDC is an ERC-20 and can be pushed to anyone without consent. The
asymmetry lives in the tools (`pay` needs a quote, `pay_with_claim` skips it). Making both settle
against a quote retires that result **by construction** — right, but it means this instrument can
no longer ask whether ease of pushing a claim drives choice. §4.6ab gets amended, not left standing.

**F8 — the caption's "always redeemable within its window" is false for windows 2–3.** There the
single issuer is non-serving by design. The agent-facing asset text must not promise redemption
for work either (§4.6-RULE); it should say what is true — presented and unserved pays the bond,
never presented pays nothing. The published caption has to be scoped to window 1.

---

## 2. Topology

| | window 1 | window 2 | window 3 |
| --- | --- | --- | --- |
| registered | B, then A (both lots from deploy) | — | — |
| routes to | **B** (first, and has headroom) | **A** (B drained to zero) | **A** (B stays drained) |
| role | F1 measurement | enforcement | enforcement again |

- **Lots: keep the fifth trio's fixtures unchanged.** B is 800 h × 80 mSIU/h × 0.5 = **32,000**,
  already 1.88× the 17,000 of window-1 demand (10,000 job + 4,000 attack + 3,000 external). A is
  **48,000**. No new fixture to invent, and §12.2a (capacity models must differ) is untouched.
- **Drain** at window-1 close, after the external buyer: mint B's entire remaining headroom from
  the deployer wallet, **dated to the run's end**, never presented. At the 2026-10-03 commodity print ($0.001424/SIU) a
  15 SIU drain costs about two cents. Logged as an operator action, excluded from every behavioural statistic.
- **Preconditions before window 2**, read from a fresh client at a block ≥ the drain's (the rule
  from `methodology.md`): `headroom(B) == 0` **and** `router.route(code, 10000)` via `eth_call`
  returns ISSUER-A. The second is stronger — it is the actual routing decision. Failure **aborts
  the run** with `topology_precondition_failed`; it must not fall through to a run that reports
  `scarcity` (the §4.6af mistake).
- **Run end:** the existing sweep settles the drain claim, restoring B. Otherwise the next launch's
  pre-flight refuses (it is `settleable_pays_nobody`).
- **Agent-visible headroom is not masked.** B reading zero in window 2 is true, and agents can
  call `check_headroom`. "Excluded from the board's supply figures" is honoured as: excluded from
  statistics. Today the board has no supply figure and headroom comes straight from the chain.

---

## 3. Workstreams

### W1 — apparatus fixes, on **main** (valid on either topology)

**W1a. Payment symmetry.** `pay_with_claim` takes `requestId`, resolves the board quote exactly as
`settle_split` does, pays the quote's seller, sizes from the quote. Both assets become
`request_quote → issue_quote → settle`. The unkeyed form is removed — a second route to fSIU is the
confound. Files: `tools/pay-with-claim.ts`, `loop/full-run.ts` (`buildToolArgs`), the brief's
Option A/B/C text, `pack/tool-descriptions.ts`, tests. The memo field stays but becomes mostly
redundant, since the quote now names the request.
*Test per §4.6ai:* assert the **property** — tool calls between `request_quote` and settlement are
equal for both assets — and build fixtures from the seller's side. Re-measure turns per payment
on the first debug run; stored runs predate the change and can't answer it.

**W1b. WORKER-CODE must buy.** Attack testing becomes a sold service. `submit_attack` is refused
(a `toolGuard`, as with `submit_job`) unless a settled engagement exists for that gate; WORKER-EXTRACT
wakes on *engagement*, not on a gate existing; **a window passes only on gate PASS ∧ one settled
engagement ∧ one executed attack.** A buyer that declines now fails the window with
`declined_to_buy` — which is the point: silence becomes a recorded result. The purchase is a
normal quote settlement, so it lands in F1 per buyer.
*Test fail-first:* an unpaid attack is currently accepted. Also: the pinned-gate debug path still
requires the purchase. Consequence: adversary yield is now per engagement, and attack turns occur
only after a purchase.

**W1c. Asset text.** Rewrite `CANONICAL_ASSET_DESCRIPTION`, equal to the USDC text in length and
tone, **true in every window** (F8), and re-baseline the validator in `pack/validate.ts`.

### W2 — the instrument, on branch **`instrument/single-issuer`**

- `--deployment <file>` through `loadGateMarketDeployment` and the hardcoded read at
  [p5-three-window-full-run.ts:455](packages/gate-market-agents/src/cli/p5-three-window-full-run.ts#L455);
  `instrument` id in the record, stamped into manifest and report; `assertSameInstrument` guards any
  aggregation, mirroring `assertCountableForF1`.
- New `cli/bond-lots.ts` (F4): issuer key signs `createLot`, simulate first, idempotent on
  `LotExists`, tx hashes written back to the record.
- Deploy the sixth trio with `DeployGateMarket.s.sol`; fund, approve, bond **B then A**; write
  `data/deployments/base-sepolia-gate-market-single-issuer.json`; it must pass `docs:deployments:check`.
- Runner: drain, the two preconditions, `operatorActions[]` in the report, and a computed
  **`f1Clean`** — true only if every window-1 agent mint was backed by B. Clean is checked, not
  assumed: first-fit would fall through to A if B's headroom dropped below a mint.
- Devnet dry-loop tests: deploy order [B, A]; window-1 mints route to B for arbitrary demands up to
  17,000; after the drain, to A; a property test over arbitrary headroom pairs; both abort paths;
  run-end restore. **No contract changes**, so no new Foundry code.

### W3 — reporting
Per run, per buyer, as in your prompt, with F1 restricted to window 1 and windows 2–3 purchases
reported separately as *"fSIU against an issuer that cannot serve"*. Add `f1Clean`, allocation by
issuer per window, `forwardDated` count, and the dispersion across runs.

---

## 4. Sequence, gates, cost

| step | proves | cost |
| --- | --- | --- |
| 1. W1 on main, fail-first tests | symmetry and forced purchase work | free |
| 2. W2 on branch, devnet tests | topology holds on real bytecode | free |
| 3. deploy sixth trio, simulate-only checks, merge | addresses and lots as designed | testnet gas + $1 USDC per lot bond |
| 4. debug run | the loop; **not** the roster or any time-gated behaviour | ≈ $1.5 |
| 5. full-cost run | the bar, roster, time-gated wake | ≈ $2–3 |
| 6. freeze → five-run block | the first countable F1 | ≈ $8–15, ~2h15m each |

Prices are from the last runs ($1.51 debug, $1.77 and $3.07 full-cost), not estimates of the new
protocol. W1b and the quote-first fSIU path both add turns, so expect the upper end.

## 5. Risks

- **Forward-dated B claims in window 1** (zero uses in eleven runs) would be B-backed and *servable*
  in window 2, removing a default. Recorded via the `forwardDated` count, not prevented (§4.6q).
- **First-fit fall-through to A during F1** if B's headroom dropped below a mint — caught by `f1Clean`.
- **Stale post-write reads** — preconditions use a fresh client at a block ≥ the write's.
- **A declined purchase now fails a window**, so `passed` rates fall by design; reports must not
  read that as the apparatus breaking.
- **The bar** still needs both buyers deciding, `settle_split` executing, and a claim held or
  passed onward. W1b makes the first likely; `settle_split` stays optional and may not happen.

---

## 6. Decisions — settled 2026-10-04

**D1 — B then A, both lots from deploy, no mid-run bonding.** Agreed as recommended.

**D2 — drain dated to the run's end**, so B stays at zero through every window after window 1.

**D3 — three windows:** window 1 for F1, windows 2 and 3 for enforcement.

**D4 — the structural version.** Sell the testing and require a settled engagement for the window
to pass. **Recorded as an instrument change: `passed` now includes the testing purchase settling.**
The choice of asset stays free.

**D5 — the decision rule, conditioned on opportunity, fixed before any result exists.**
Count only runs in which the agent **held fSIU it had received at the moment it paid** — a run
where WORKER-CODE never received any fSIU gave it no chance to spend one onward, and must not count
as a "no". Then:

- fewer than **3** runs offer that opportunity → the block is **inconclusive, not negative**;
- otherwise, onward spending (hops ≥ 1) in a **majority of the eligible runs** → cross-issuer
  fungibility is the next build;
- otherwise → it is not built, and the result is recorded as agents not carrying fSIU between hops
  even where they could.

**This block is a pilot, not the answer.** Window-1-only F1 gives five decisions per buyer, and even
a perfect 5-of-5 has a 95% Wilson lower bound of about 0.57. It tells us whether a larger block is
worth running.

## 7. Constraints, written down so nobody has to infer them

**The multi-issuer path stays intact.** Do not delete, simplify or hardcode anything that supports
several issuers per class: `issuersForClass`, the router, per-issuer token ids, issuer lots and
bonds, and **ISSUER-B's deployment and config**. "One issuer per window" is **configuration, never
code**, so a second serving issuer can be plugged back into the same windows when cross-issuer
fungibility is designed. "Single issuer" is the instruction most likely to tempt a simplification;
this is the written counter.

**The fifth trio stays runnable as the default** under `--deployment`.

**Agent-facing fSIU text** describes mechanics that are true in every window — redeemable from the
issuer named on the claim, bond recovery if that issuer fails, expiry at window close — without
saying which issuer will serve or fail. **The published caption is scoped to window 1.**

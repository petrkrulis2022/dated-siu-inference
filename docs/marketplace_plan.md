# Marketplace plan — the currency lab

*Created 2026-10-06. This file is the single reference for the currency-lab work. **Every change of
scope goes into this file first.** Ideas outside phase 1's scope go to §10 Backlog, not into the build.
Where this file and `CLAUDE.md` disagree on vocabulary, invariants or build boundaries, `CLAUDE.md`
wins; where this file and the earlier gate-attack plans disagree about the currency test, this file wins.*

---

## 1. Purpose

Test whether fSIU works as money between agents: whether agents pay with it, hold it, and pass on fSIU
they receive instead of minting new.

---

## 2. Phase 1 design

### 2.1 Task
T1 shipment records — the seeded generator and grader already in the basket
(`generateT1Instance`, `gradeT1`). **Four job types**, made from T1 variants (different seed streams,
labelled TYPE-1 to TYPE-4), each checked by its deterministic grader. No code writing, no gate
authoring, no adversary, no attacks.

### 2.2 Issuer
ISSUER-B as an **automatic service**, not a model-driven seat: a deterministic policy on ISSUER-B's own
key that answers requests and settles escrows. It sells **raw work**: one unit per job, bought with a
quote that is paid in USDC or in fSIU — paying the issuer in fSIU is the redemption (the claim goes back
to the issuer that owes the work). The two routes must cost exactly the same (price parity, §5). See D8.

### 2.3 Traders
Four model-driven traders on the existing seat IDs, shown to agents as TRADER-1 to TRADER-4. Two on
claude-haiku-4-5, two on gpt-5.4-mini (the cheapest registered tier of each family). **No `AgentId`
widening, no new wallets** — see D4 for the seat mapping.

### 2.4 Economy
Every number below is a **default**; tune if needed and record the final values in the table in §2.11.

- Each trader has **one skill**: it can deliver exactly one job type.
- Each trader has **needs**: a schedule of jobs of *other* types it must obtain, spread across rounds.
- To meet a need, a trader buys the job from the trader holding that skill, in USDC or fSIU. **Price
  fixed at 1.2 × print per job; no negotiation in phase 1.**
- To deliver a job it has sold, the seller buys **one unit of raw work** from ISSUER-B (redeeming fSIU
  or paying USDC at the print), then delivers with its skill, and the grader checks the output. The
  seller earns 0.2 × print per job, and fSIU it receives can pay for its next delivery or its own next
  purchase.
- Each need met adds **1.5 × print** to that trader's result. This is a score credit, not a payment in
  either asset, so neither asset is favoured.

### 2.5 Opening balances
Each trader starts every run with **equal value in USDC and fSIU**. The fSIU is minted once per trader
at run start. The operator resets each trader's USDC to the opening figure before every run, so runs
are comparable. Claims are valid for the whole window.

### 2.6 Window and rounds
**One window, several rounds.** No forward-dating, no window transitions, no drain. A round opens when
the previous one has gone quiet (nobody can act); needs of a round become purchasable when it opens.

### 2.7 The board
Every trader sees every trader's needs by round, which trader holds which skill, and its own open
sales and raw-work units. One list builds it (the schedule is generated once per run from the seed and
read by the board, the guards and the report).

### 2.8 Scoring (stated in every brief)
A trader's result is its USDC, plus its fSIU valued at the current print, plus the credit for needs
met. Results are measured before the window closes, so unexpired fSIU counts at the print. Converting
between the two assets does not change the result, and a trader is never required to convert fSIU to
USDC.

### 2.9 Briefs
Facts only, identical wording across traders except each trader's own skill and needs. The canonical
asset text for redemption and expiry. No instruction to hold, spend, convert or prefer either asset.
The context validator stays on.

### 2.10 What is reused and what is new
**Unchanged:** the contracts and the sixth-trio deployment (extract-class lots: ISSUER-B 32,000 mSIU,
ISSUER-A 48,000, 1 USDC bond each); the quote, payment, claim-transfer, redemption and serve tools; the
loop; the claim-position tracker; price parity; the claim ledger; scripted mode and its verifier; the
confirmed-write retry; the debug disqualification; the carried-forward settlement list.
**New:** the economy module (schedule, needs, credits); the job source and work executor;
`deliver_job` and the lab guards; lab hooks in the loop (board section, rounds, fee rebate); the
issuer service; briefs and roster; a lab runner; scoring and measurement; a scripted lab walk.

### 2.11 Final values (record here once tuned)

| parameter | default | final |
| --- | --- | --- |
| job size | 1 SIU (1,000 mSIU) | |
| trade price | 1.2 × print | |
| raw-work unit | 1 SIU at 1.0 × print | |
| credit per need met | 1.5 × print | |
| seller margin | 0.2 × print | |
| traders | 4 | |
| rounds | 3 | |
| needs per trader | 2 (8 jobs per run) | |
| opening per trader | 4 SIU of USDC and 4,000 mSIU of fSIU | |
| decision turns per run | about 50 | |

*Worst-case mint check (to be enforced at launch, §5):* opening mints 16,000 mSIU plus up to eight
payments each minted fresh (about 1,201 mSIU each) is about 25,600 mSIU, which is 80% of ISSUER-B's
32,000 mSIU extract headroom. Opening figures must not rise without recomputing this.

---

## 3. Hypothesis and decision rule — **DRAFT, awaiting approval**

*Nothing here is registered until you approve it (stop point c). Thresholds are proposals, chosen to be
stated before any result exists, not derived from data.*

**Hypothesis (H1).** When paying with fSIU costs the same as paying with USDC and every trader is free
to choose, traders pass on fSIU they have *received* rather than only minting new fSIU.

**Definitions.**
- *fSIU use*: a payment to a trader, or a raw-work purchase, made in fSIU — from a held balance, by
  mint-and-forward, or by redemption.
- *Opportunity*: any payment or raw-work purchase, in any asset, made while the trader held **received**
  fSIU at least as large as the amount due. Declining to use it counts.
- *Reuse*: an opportunity that was funded from the held received fSIU.

**Primary measure.** Reuse rate = reuse events ÷ opportunity events, pooled over runs, with a 95%
Wilson interval. Also reported per run, and as the share of runs with at least one opportunity in which
a majority of opportunities were reused.

**Decision rule (draft).**
- Fewer than 30 opportunity events pooled over the 20 runs → **inconclusive**.
- Wilson lower bound ≥ 0.50 → fSIU **circulates as money in this setting**; phase 2 (hybrid issuers) is
  built.
- Wilson upper bound < 0.20 → fSIU **does not circulate** here; investigate the economy and briefs
  before adding issuers; phase 2 is not built on this result.
- Otherwise → **no detectable effect at this sample size** — never "no effect".

**Secondary (reported, no rule).** fSIU share of payments by route (held balance, mint-and-forward,
USDC); fSIU held against each trader's upcoming needs, round by round; mints per job transacted.

**Arm comparison (any later comparison).** Report each arm's rate with Wilson intervals; call it an
effect only if the intervals do not overlap; otherwise "no detectable effect at this sample size".

---

## 4. Run protocol and stop points

a. **Build phase 1.**
b. **Scripted lab walk, fork then live**, through every route: paying in each asset, passing on received
   fSIU, buying raw work in each asset, a partial use, expiry at window close, and the score computation.
c. **STOP:** send the draft decision rule (§3) for approval.
d. **One model run. STOP:** report its cost and anything odd.
e. **On your go: 20 runs**, same seeds per comparison, around 40–50 decision turns each.

**Also stop** if any contract change becomes necessary. A debug or scripted run never counts.

---

## 5. Safeguards

- **Price parity on every route**, including buying raw work from the issuer.
- **Fee rebate.** The escrow takes 50 bps from the seller's proceeds on the dollar route and nothing on
  the claim route. After each dollar settlement the operator rebates the fee to the seller (the issuer
  included), logged as an operator action, so neither route carries a fee and no brief mentions one.
- **Headroom.** Worst-case mints stay well under ISSUER-B's extract headroom (§2.11), checked at launch.
  The contamination check from the gate configuration stays as a backstop: a mint backed by any other
  issuer aborts the run.
- **Countable assertion.** `assertCountableForF1` is wired into every run the report admits; debug and
  scripted runs are disqualified as before. The report's own exclusion stays too — two guards.
- **Lag telemetry** (small): every retry `writeAndConfirm` makes is recorded in the run report.
- **Confirmed reads and writes**, the position tracker, the scripted verifier and the pool-whole
  precondition carry over unchanged.
- **Run-end settlement.** After scoring, the operator settles every leftover claim. Nothing in the lab
  presents a claim (D8), so every leftover expires — no bond draw, no attestation. The pool must read
  whole afterwards.

---

## 6. Measurement, per run and per trader

- **Reuse:** fSIU payments and raw-work purchases funded by received fSIU versus newly minted fSIU;
  mints per job transacted.
- **Share of payments in fSIU, by route:** held balance, mint-and-forward, USDC.
- **Holdings against needs:** fSIU held against each trader's upcoming needs, round by round.
- **Disposals:** passed on, redeemed for raw work, expired.
- **Needs met, result per trader, and cost per run.**

---

## 7. Phase 2 plan — hybrid fSIU (plan only)

*Design note: "Hybrid fSIU Design: Issuer-Specific Claims With Variable Issuance Rates" (2026-10-06).*

A second serving issuer at a different measured rate, plus an issuer that fails some deliveries, so
enforcement returns. **Seed traders with both issuers' claims**, because minting picks the issuer by
first-fit and the minter cannot choose (`WorkClaim.mint` has no issuer parameter). Measure whether
traders treat the issuers' claims differently.

How the note maps onto what exists: token identity per issuer, separate bonds and headroom, and
redemption bound to the issuer are **already** how the contracts work. Lot sizes already differ by
issuer but are **fixtures, not measurements** (the deployment record says so); phase 2 should replace
them with a measured rate from the harness. The note's different implied backing per fSIU does **not**
match the contracts, which price every claim at the print; issuers differ in headroom, not price per
fSIU. Giving agents a choice of issuer at mint needs a contract change and a redeploy — that is a stop
point. Not in phase 1.

---

## 8. Phase 3 plan — second market (plan only)

A dealer pricing by Becker-DeGroot-Marschak on both sides; circulation counted only between non-dealer
traders; several windows for mismatch; **no redemption at the print in this phase**; every output states
that Touchstone was the counterparty to every dealer trade. In production the dealer is Markets or a
third party, never the Assay.

---

## 9. Parked

- **Blockworks research experiment** — pending the call. Fits the lab later: the research agent is a
  trader with a dollar-priced input.
- **Gate-attack task** — retired from the currency test. The code stays; nothing builds on it.
- **Dollar exit** — not in phase 1; scoring makes it unnecessary.
- **Visible-versus-hidden schedule** — a later flag (Backlog).
- **Step c on the gate configuration**, stopped 2026-10-06: the drain ordering (transition settlement
  and the pre-mint guard), the scripted drain walk, and verification of the 2026-10-03 test audit. None
  is needed in phase 1, which has no drain. They return only if phase 2 needs a drained issuer.

---

## 10. Backlog

*Not in phase 1. Add here; do not build.*

- Visible-versus-hidden schedule as a `--arm` flag.
- Verify each "catchable" row of `docs/test-audit-2026-10-03.md` against pre-fix code.
- Drain ordering for the gate configuration (item 1 and item 6 of the stopped step c), including the
  unresolved question of whether the operator settles at each transition.
- Per-turn holdings snapshots (phase 1 records them per round).
- A seeded invoice generator, if invoices rather than shipment records matter.
- Admit a Google or xAI cheap-tier model to the registry for a third family.

---

## 11. Decisions log

| # | date | decision | by |
| --- | --- | --- | --- |
| D1 | 2026-10-06 | Gate-attack retired from the currency test; step c stopped; the engine stays. | user |
| D2 | 2026-10-06 | Task is T1 shipment records, four job types as variants. | user |
| D3 | 2026-10-06 | ISSUER-B is an automatic service, a deterministic policy seat on its own key. | user |
| D4 | 2026-10-06 | Traders use existing seat IDs, no new wallets. **Mapping (Claude Code, to confirm):** TRADER-1 = ORCHESTRATOR, TRADER-2 = WORKER-CODE, TRADER-3 = WORKER-EXTRACT, TRADER-4 = ISSUER-A. ISSUER-A's wallet is the only unused one (HEDGER has none). It is a registered issuer, so a mint that overflowed to it would pay TRADER-4 and the contamination check aborts the run. | Claude Code |
| D5 | 2026-10-06 | Economy defaults as §2.4–2.5, tunable and recorded in §2.11. | user |
| D6 | 2026-10-06 | One window, rounds inside it. Claude Code's design: a round advances when nobody can act; the loop gains a round hook rather than the runner calling the loop once per round (a per-round call would reset the claim tracker and ledger). | Claude Code |
| D7 | 2026-10-06 | Fee rebated per dollar settlement as an operator action. | user |
| D8 | 2026-10-06 | **Redemption route (supersedes the first draft of this row).** The first draft had traders call `redeem_claim` for raw work. Mapping it onto the contract showed `presentForRedemption` presents the holder's *whole* balance, and any presented balance left at window close *defaults at face value from ISSUER-B's bond* instead of expiring (`settleWindowClose`). That would draw on the bond and pay USDC after every run. Instead raw work is sold as a **quote from the issuer, paid in USDC (`pay`) or in fSIU (a keyed `transfer_claim` or `pay_with_claim`)**; the claim returns to the issuer that owes the work, which is a redemption in effect. `redeem_claim` stays in the engine but is **not granted to lab traders**, so nothing is presented, every leftover claim expires, and the pool is restored with no attestation. The canonical asset text is unchanged and still true. Departs from "redeeming fSIU" in your wording; reversible — if you want literal `redeem_claim`, the cost is the default-at-close consequence above. | Claude Code |
| D9 | 2026-10-06 | Raw-work accounting. One unit is 1 SIU at 1.0 × print. A unit is credited to the buyer when its quote is **paid** (either asset); `deliver_job` consumes one. A trader may buy a unit only while it owes a paid job it holds no unit for, so units are never stockpiled and none are left over to score. | Claude Code |
| D11 | 2026-10-06 | **Observed asymmetry, recorded not removed.** A dollar payment sits in escrow until the seller settles; a claim transfer lands at once. So a buyer carries delivery risk on the claim route and not on the dollar route. It is a property of the instrument, not of the lab. `settle_escrow` is refused until the seller has delivered, so the escrow protects the buyer as designed. | Claude Code |
| D10 | 2026-10-06 | Cost and turn targets are estimates until the first model run measures them. | Claude Code |

---

## 12. Status checklist

### 12.1 Your points — where each stands

| Your point | State | What happens |
| --- | --- | --- |
| Test fSIU vs USDC; marketplace still not runnable after two weeks | **Engine done and proven; vehicle being replaced.** | The contracts and payment tools are proven on the live chain: the scripted walk `DEBUG-p5-three-window-2026-10-05T18-55-26-808Z` passed all 14 checks. The task and roster on top are being replaced by this lab. Estimate in §13. |
| Gate-attack too complicated; use an easier task | **Decided (D1, D2).** | Retired from the currency test. The lab task is T1 shipment records, checked by a deterministic grader. |
| Freedom to pay in fSIU or USDC | **Engine done; fee rebate pending.** | Both routes exist at equal cost to the buyer, the tool descriptions are parallel and nothing steers. The dollar route still takes a 50 bps seller fee; the rebate (§5) is piece P7. |
| Reuse fSIU instead of minting new each time | **Not built; the main change.** | It never happened because only one agent ever received fSIU and had nothing to spend it on. In the lab every trader both buys and sells, in one window over several rounds, so received fSIU can pay for the next purchase. Reuse is the primary measure (§3). |
| A board showing future work, so agents keep some fSIU | **Partly done; lab board not built.** | The schedule list exists for the gate configuration and its false sentence is fixed. The lab board (§2.7) is pieces P1 and P4. |
| Clear that cashing out to USDC is not a goal | **Not built.** | Through scoring (§2.8), not an instruction: an agent's result is its USDC plus its fSIU at the current print, so converting changes nothing. Stated as a fact in every brief. Pieces P6 and P8. |
| Hybrid fSIU | **Plan only (§7).** | The contracts are already issuer-specific. Phase 2 adds a second issuer and a failing one. Agent choice of issuer at mint needs a contract change, which is a stop point. |
| The second market | **Plan only (§8).** | Phase 3, after phase 1. |
| Why five runs | **Changing.** | Phase 1 does 20 runs, after the decision rule is approved and the first model run is costed (§4). |
| About €100 spent | **Cannot be fully reconciled from this repository.** | The experiment ledger records **$22.93 realized inference spend** and $42.79 projected, as of 2026-10-05; it is a lower bound because 10 crashed run directories never wrote their spend. Anything beyond that is not in this repo's records. Lab runs are estimated at $0.30 to $0.60 (§13); the scripted walk costs only gas. |
| Going up and down; fixing in small bits | **Changing how we work.** | This file is the reference. Scope changes go here first; new ideas go to §10; the two stop points in §4 are where you see something before money is spent. |
| Parked | **See §9.** | Blockworks; gate-attack; dollar exit; visible-versus-hidden schedule. |

Items from the stopped step c, for completeness:

| Item | State |
| --- | --- |
| 1 Drain ordering | Parked (§9, §10). |
| 2 Lag telemetry | Carried into phase 1 as piece P9. |
| 3 Wilson-interval comparison | Carried: in §3, built in P8. |
| 4 Wire `assertCountableForF1` | Carried: P8. |
| 5 Verify the test audit | Parked (§10). |
| 6 Scripted drain walk | Parked (§9). |

### 12.2 Phase 1 build

- [x] P0 — this plan, committed
- [ ] P1 — economy module: config, seeded schedule and needs, one list
- [ ] P2 — job source and work executor (T1 variants, grader, cost accounting)
- [ ] P3 — `deliver_job` and the lab guards (quote rate, size, type, round, raw-work credit)
- [ ] P4 — loop lab hooks: board section, rounds, fee rebate, scoring snapshot
- [ ] P5 — issuer service policy seat (quotes, settles escrow, serves redemptions)
- [ ] P6 — briefs, roster, model assignment, validator
- [ ] P7 — lab runner: opening balances, endowment mints, launch checks, rounds, run-end settlement
- [ ] P8 — measurement, scoring, report, aggregator with Wilson intervals, countable assertion
- [ ] P9 — lag telemetry
- [ ] P10 — scripted lab walk and verifier; fork, then live
- [ ] P11 — phase 2 and phase 3 plans refined
- [ ] STOP c — draft decision rule sent for approval
- [ ] P12 — one model run; cost reported — STOP d
- [ ] Phase 1: 20 runs, on your go

---

## 13. Estimate in days per piece

*Focused working days, Claude Code's estimate. Each piece includes its tests. The earlier "6 to 8 days"
was before the raw-work economy, the issuer service, the fee rebate and opening-balance resets were
added to the design; those are the difference.*

| piece | days |
| --- | --- |
| P1 economy module | 0.75 |
| P2 job source and work executor | 0.5 |
| P3 `deliver_job` and guards | 1.0 |
| P4 loop lab hooks | 1.5 |
| P5 issuer service | 0.75 |
| P6 briefs, roster, validator | 0.75 |
| P7 lab runner | 1.5 |
| P8 measurement, scoring, aggregator | 1.0 |
| P9 lag telemetry | 0.25 |
| P10 scripted walk, fork and live | 1.5 |
| P11 phase 2 and 3 plans | 0.5 |
| P12 first model run and fixes | 0.75 |
| **Total** | **about 11** |

With the cuts in §10 (holdings per round not per turn, one live scripted run if the fork is clean,
minimal aggregator) this is **about 9 days**. The largest uncertainty is P4, because it modifies a
3,600-line loop; the second is live-only defects, which cost about half a day each in the last build.

**Cost and time per run (estimates).** About 50 decision turns of roughly 4,000 to 6,000 input tokens
each, at haiku-4.5 $1/$5 and gpt-5.4-mini $0.75/$4.5 per million tokens, is about $0.30 to $0.60; work
executions add well under a cent each. About 10–15 minutes per run; runs cannot overlap because the
traders share wallets and the pool. The first model run measures both.

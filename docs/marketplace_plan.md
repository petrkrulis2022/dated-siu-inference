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
key that answers requests (from instrument v4 every payment is a direct transfer, so there is no escrow for it to settle, D30). It sells **raw work**: one unit per job, bought with a
quote that is paid in USDC or in fSIU — paying the issuer in fSIU is the redemption (the claim goes back
to the issuer that owes the work). The two routes must cost exactly the same (price parity, §5). See D8.

### 2.3 Traders
Four model-driven traders on the existing seat IDs, shown to agents as TRADER-1 to TRADER-4. Two on
claude-haiku-4-5, two on gpt-5.4-mini (the cheapest registered tier of each family). *Through instrument v4; from v5 all four are claude-haiku-4-5 (D39).* **No `AgentId`
widening.** Three traders stand on existing seats and wallets; **TRADER-4 has a wallet of its own**, kept
under the seat ID `ISSUER-A` so nothing in the loop widens, and not ISSUER-A's wallet (D4, superseded by D22).

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
*As revised for instrument v4 (D31); the v1 to v3 text was "equal value in USDC and fSIU, 2,000 mSIU each".*
Each trader starts every run with **equal value in USDC and fSIU, sized so that either alone meets every need**:
the claim for each job it buys and for each unit of raw work it buys to deliver the jobs it sells (a balanced
schedule makes both counts `needsPerTrader`), and USDC of the same value at the print, rounded up. The figures are
derived from the print and the schedule at launch, not fixed. **The fSIU supply is the endowment, fixed for the
run: nothing is minted after the opening.** The endowment is minted once, by the operator, for all four traders
together. The operator resets each trader's USDC to the opening figure before every run, so runs are comparable.
Claims are valid for the whole window.

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

*Which of this a brief states (D35): the brief says how a result is counted, and no more. The last sentence above
describes the structure; the brief does not carry it, because D15 keeps "convert" out of the brief's wording. The
lab has no route from fSIU to USDC and v4 adds none.*

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
`deliver_job` and the lab guards; lab hooks in the loop (board section, rounds; through v3 a fee rebate, gone in v4); the
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
| opening per trader | 2 SIU of USDC and 2,000 mSIU of fSIU (**changed from 4 SIU, D16; derived from the print and the schedule from v4, D31**) | **v4: derived.** At the illustrative print, 4,318 mSIU of fSIU and 6,205 USDC minor units (v1 to v3: 2,000 mSIU and 2,874) |
| minting after the opening | allowed (paid in USDC at the print, D17) | **none from v4 (D31)** |
| settlement | USDC through the escrow, fSIU direct | **direct transfer in both assets from v4 (D30)** |
| decision turns per run | about 50 | |

*Endowment check (enforced at launch, §5; `lab/launch.ts`), v4:* at the illustrative print of 0.001437 USD/SIU a job
quote is 1,700 minor units, so a job claim is 1,184 mSIU, and a raw-work quote is 1,400, so its claim is 975. Each
trader buys two jobs and two units of raw work: 2 × (1,184 + 975) = **4,318 mSIU, or 6,200 USDC minor units** (6,205 is
the same value rounded up). Four endowments are **17,272 mSIU, 54% of ISSUER-B's 32,000 mSIU headroom** (the bound is
80%, 25,600). *Why minting was removed (D31):* with it, the worst case adds eight job claims and eight raw-work claims,
8 × (1,184 + 975) = 17,272, for **34,544 mSIU, more than the whole headroom**. *History (v1 to v3, D16):* with an
opening of 2,000 each the worst case was 8,000 + 17,272 = 25,272 mSIU, 79% of the headroom; the first draft's note said
25,600 for a 4,000 mSIU endowment and left the raw-work claims out, which with them was 33,272.

---

## 3. Hypothesis and decision rule — **APPROVED 2026-10-06, with two changes (D20)**

*Registered before any model has run. Thresholds are the proposals as made, chosen to be stated before any
result exists, not derived from data.*

**Hypothesis (H1) — re-registered 2026-10-07 for instrument v4 (D30–D33), before any counted run exists.** When paying
with fSIU costs the same as paying with USDC, both settle the same way (a direct transfer at payment, no escrow), either
asset alone is enough to meet every need, and nothing in the lab creates fSIU after the opening, traders pass on fSIU
they have *received* rather than paying in USDC. *(Version 3 read: "…rather than only minting new fSIU". Minting is
removed in v4, so the alternative to reusing received fSIU is now paying in USDC. Runs under v1 to v3 stay out of the pool.)*

**Definitions (v4).**
- *fSIU use*: a payment to a trader, or a raw-work purchase, made from a held fSIU balance — wholly (`pay_with_held_claim`)
  or in the claim part of a split (`pay_split`). There is no minting to count.
- *Opportunity*: any payment or raw-work purchase, in any asset, made while the trader held **received** fSIU at least as
  large as the amount due. Declining to use it counts. (Unchanged.)
- *Reuse*: an opportunity paid wholly from the held fSIU, the claim being taken from what the trader received first.
  A split that spends received fSIU in part is reported as **partial reuse**, apart, and is not read by the rule.

**Primary measure.** Reuse rate = reuse events ÷ opportunity events over the 20 runs.

**The interval the rule reads: resample whole runs.** Decisions within one run share the same agents,
balances and history, so they move together; a Wilson interval on pooled opportunities treats them as
independent and comes out narrower than the evidence is. The rule therefore reads a **95% bootstrap interval
over the runs**: draw 20 runs with replacement from the 20, recompute the pooled rate (reuse ÷ opportunities
over the drawn runs), repeat 10,000 times with a fixed, reported seed, take the 2.5th and 97.5th percentiles.
A draw with no opportunity in it has no rate and is left out; how many were left out is reported. The pooled
Wilson interval is reported beside it for comparison and **is not read by the rule**. Also reported per run,
and as the share of runs with at least one opportunity in which a majority of opportunities were reused.

**Decision rule.**
- **Inconclusive** if fewer than 30 opportunity events are pooled over the runs, **or** if fewer than 10 of
  the 20 runs contribute at least one opportunity — so a few busy runs cannot decide the result.
- Otherwise, run-resampled lower bound ≥ 0.50 → fSIU **circulates as money in this setting**; phase 2
  (hybrid issuers) is built.
- Otherwise, run-resampled upper bound < 0.20 → fSIU **does not circulate** here; investigate the economy and
  briefs before adding issuers; phase 2 is not built on this result.
- Otherwise → **no detectable effect at this sample size** — never "no effect".

**First model run.** One run cannot show a reuse rate. What it shows is **how many opportunities arose at
all**: if agents almost never receive fSIU, twenty runs will come back inconclusive, and that should be known
after one run. The first run's report leads with that count.

**Secondary (reported, no rule).** fSIU share of payments by route (held balance, mint-and-forward, split,
USDC); fSIU held against each trader's upcoming needs, round by round; mints per job transacted; disposals
(claims paid on to a trader, paid to the issuer for raw work, left to expire).

**Arm comparison (any later comparison).** Report each arm's rate with its run-resampled interval; call it an
effect only if the intervals do not overlap; otherwise "no detectable effect at this sample size".

---

## 4. Run protocol and stop points

a. **Build phase 1.**
b. **Scripted lab walk, fork then live**, through every route: paying in each asset, passing on received
   fSIU, buying raw work in each asset, a partial use, expiry at window close, and the score computation.
c. **STOP:** send the draft decision rule (§3) for approval.
d. **One model run. STOP:** report its cost and anything odd — and lead with how many opportunities arose.
d2. **Instrument v4 and one rerun (D30 to D36), STOP.** Report needs met, opportunities, reuse, and whether any trader
   waited while it had something it could do. If the rerun meets most needs and shows a handful of opportunities, freeze
   the instrument and run the twenty; if not, the question is whether the economy gives agents enough reasons to trade,
   and that is a conversation before anything more is spent.
e. **On your go: 20 runs**, same seeds per comparison, around 40–50 decision turns each.

**Also stop** if any contract change becomes necessary. A debug or scripted run never counts.

---

## 5. Safeguards

- **Price parity on every route**, including buying raw work from the issuer.
- **No escrow, no fee (v4, D30).** Every payment is a transfer to the seller at the moment it is made, in either asset,
  so neither route carries a fee, a rebate, a release step or buyer protection the other lacks. *Through v3 the escrow took
  50 bps on the dollar route and the operator rebated it after each settlement; that safeguard is gone with the escrow.*
  The report's check that replaces it: USDC and fSIU are conserved across the four traders and the issuer, from the opening
  to the final snapshot, so a fee, money left in an escrow or a mint after the opening would show as a total that moved.
- **Headroom.** The endowment, which is the whole fSIU supply of the run (nothing is minted after it, D31), is held to 80% of ISSUER-B's extract headroom (§2.11), checked at launch against the headroom actually read; a run that would exceed it does not start. The contamination check (a mint backed by anyone but ISSUER-B aborts the run) stays as the backstop.
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

- **Reuse (v4, re-registered in §3):** payments and raw-work purchases made wholly from a held balance that included
  received fSIU, against payments made in USDC while holding enough received fSIU to have paid; **partial reuse** (a split
  that spends received fSIU in part) reported apart and not read by the rule. There is no minted fSIU to compare with.
- **Waits taken while there was something to do (D34):** per trader, from the prompts.
- **Share of payments in fSIU, by route:** held balance, split, USDC.
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

**What building phase 1 changes about this plan (2026-10-06, P11).**
- *The seat conflict is gone.* TRADER-4 has a wallet of its own (D22), so ISSUER-A's wallet and identity are free
  to become the second, failing issuer without a trader's receipts appearing under it.
- *A failing issuer is a service policy, not a model.* The phase 1 issuer is a deterministic service on its own
  key (P5). A second one with a different measured rate, and a failing one, are the same kind of seat with a
  different policy: the failing one credits a unit of raw work late or not at all after it has been paid.
  `LabBooks` credits a unit on payment (D9), so that needs a rule for a paid unit that is never delivered.
- *Seeding is an operator mint, and it routes first-fit.* An endowment of a second issuer's claims has to be
  minted while the first issuer's headroom is too small to take the mint, which is the drain the gate
  configuration built and parked (§9). Minting is paid for in USDC (D17), so the operator funds the seeding.
- *The launch bound generalises.* `lab/launch.ts` bounds the worst-case mint against one issuer's headroom
  (D16); with two issuers it bounds each, and the contamination check names which issuer backed a mint.

---

## 8. Phase 3 plan — second market (plan only)

A dealer pricing by Becker-DeGroot-Marschak on both sides; circulation counted only between non-dealer
traders; several windows for mismatch; **no redemption at the print in this phase**; every output states
that Touchstone was the counterparty to every dealer trade. In production the dealer is Markets or a
third party, never the Assay.

**What building phase 1 changes about this plan (2026-10-06, P11).**
- The dealer needs its own wallet, a USDC float and a claim inventory: a new wallet (a decision for you), and
  the same allowance and gas launch checks `lab/run.ts` already makes for traders.
- A dealer's price for fSIU in USDC is the first place the print and a market price can differ. Minting is paid
  for in USDC at the print (D17), so a dealer who sells a claim below the print is selling below what it costs
  to make one; the report must state the print beside every dealer price.
- Circulation is already measured as reuse of *received* fSIU (§3). Phase 3 keeps that definition and counts
  only trades between non-dealers, which needs the dealer's address list in the report, as `seats` is today.

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
| D4 | 2026-10-06 | **SUPERSEDED by D22 (TRADER-4 has its own wallet).** Traders use existing seat IDs, no new wallets. **Mapping (Claude Code, to confirm):** TRADER-1 = ORCHESTRATOR, TRADER-2 = WORKER-CODE, TRADER-3 = WORKER-EXTRACT, TRADER-4 = ISSUER-A. ISSUER-A's wallet is the only unused one (HEDGER has none). It is a registered issuer, so a mint that overflowed to it would pay TRADER-4 and the contamination check aborts the run. | Claude Code |
| D5 | 2026-10-06 | Economy defaults as §2.4–2.5, tunable and recorded in §2.11. | user |
| D6 | 2026-10-06 | One window, rounds inside it. Claude Code's design: a round advances when nobody can act; the loop gains a round hook rather than the runner calling the loop once per round (a per-round call would reset the claim tracker and ledger). | Claude Code |
| D7 | 2026-10-06 | Fee rebated per dollar settlement as an operator action. | user |
| D8 | 2026-10-06 | **Redemption route (supersedes the first draft of this row).** The first draft had traders call `redeem_claim` for raw work. Mapping it onto the contract showed `presentForRedemption` presents the holder's *whole* balance, and any presented balance left at window close *defaults at face value from ISSUER-B's bond* instead of expiring (`settleWindowClose`). That would draw on the bond and pay USDC after every run. Instead raw work is sold as a **quote from the issuer, paid in USDC (`pay`) or in fSIU (a keyed `transfer_claim` or `pay_with_claim`)**; the claim returns to the issuer that owes the work, which is a redemption in effect. `redeem_claim` stays in the engine but is **not granted to lab traders**, so nothing is presented, every leftover claim expires, and the pool is restored with no attestation. The canonical asset text is unchanged and still true. Departs from "redeeming fSIU" in your wording; reversible — if you want literal `redeem_claim`, the cost is the default-at-close consequence above. | Claude Code |
| D9 | 2026-10-06 | Raw-work accounting. One unit is 1 SIU at 1.0 × print. A unit is credited to the buyer when its quote is **paid** (either asset); `deliver_job` consumes one. A trader may buy a unit only while it owes a paid job it holds no unit for, so units are never stockpiled and none are left over to score. | Claude Code |
| D10 | 2026-10-06 | Cost and turn targets are estimates until the first model run measures them. | Claude Code |
| D11 | 2026-10-06 | **Observed asymmetry, recorded not removed.** A dollar payment sits in escrow until the seller settles; a claim transfer lands at once. So a buyer carries delivery risk on the claim route and not on the dollar route. It is a property of the instrument, not of the lab. `settle_escrow` is refused until the seller has delivered, so the escrow protects the buyer as designed. | Claude Code |
| D12 | 2026-10-06 | **Quote amounts are quantised to $0.0001.** The quote format rounds `amount_usd_max` half-up to four decimals (`QUOTE_AMOUNT_DP`), which I will not change. At an illustrative print of 0.001437 USD/SIU a 1-SIU job at 1.2 × print quotes **0.0017** (nominal 0.0017244) and a unit of raw work at the print quotes **0.0014** (nominal 0.001437), so prices are off their nominal by up to about 3% and the seller's margin is 0.0003 against a nominal 0.000287. Parity between the two routes is unaffected (both are sized from the same quote). The board states the amounts the quotes carry, taken from the SDK's own builder. A larger job would shrink the error but multiplies headroom use; the choice of 1 SIU stands. | Claude Code |
| D13 | 2026-10-06 | **Engine defect, found by the first loop-level test of the lab hooks and fixed for every configuration.** The history an agent reads was built only from calls that *succeeded*, so a call that was refused or reverted left no trace in its next prompt: the agent saw "no turns yet" or a gap, and could only retry blind. The code's own comment said it "sees this in its tool-call history exactly like any other tool error"; no agent in any run ever has, and a real prompt from the live scripted run confirms it. The plain-error work reached the logs, not the agent. Every guard refusal in the lab would have been invisible. Failed calls now enter the history with the sentence, in order. This is an instrument change for the gate configuration too, recorded in its manifest. | Claude Code |
| D14 | 2026-10-06 | **Names the traders see.** Traders are shown as TRADER-1..4 and the issuer as ISSUER-B (its own seat name). Two small engine seams carry the labels: the loop's address directory accepts the labels as aliases for the seats (`LabHooks.aliases`, so `transfer_claim` to "TRADER-2" resolves), and the quote board prints a requester by its label (`QuoteBoardOptions.displayName`; it printed the seat, which would have told a trader which seat it was). No brief or board line names a seat; a test checks it. The issuer's `model` field in a quote request is the label "raw-work": the quote format needs a string and nothing reads it. | Claude Code |
| D15 | 2026-10-06 | **Brief contents.** Shared text is identical for all four traders and takes nothing about its reader; only label, address, skill and needs differ. It states: the lab's shape; the directory (sellerId and model per counterparty); job and raw-work sizes, rates and the quoted amounts; worked syntax for a quote request and for the four settlement calls (one list, used for a job and for raw work alike); the seller's steps; the fSIU token and the opening balances; the canonical asset text; and how a result is counted. It does not mention the escrow fee (rebated), says nothing about which route leaves more dollars or what either asset is worth, and uses none of: prefer, should, better, cheaper, advantage, recommend, convert, cash out. Models: two haiku-4-5 and two gpt-5.4-mini, alternating by seat, temperature 0.7, 4,500 output tokens. | Claude Code |
| D16 | 2026-10-06 | **Plan error found building the launch check, and the figure changed.** §2.11 bounded the worst-case mint at 25,600 mSIU for a 4,000 mSIU endowment per trader. That sum counted only the eight job payments; each delivery also needs a unit of raw work, and a unit paid for by minting a claim consumes ISSUER-B headroom too. Counted properly the draft's worst case was 16,000 + 8 × (1,184 + 975) = 33,272 mSIU against 32,000 of headroom, so a run could have exhausted ISSUER-B and routed a mint to TRADER-4's wallet. **Opening endowment lowered to 2,000 mSIU per trader** (4 × 2,000 + 8 × 2,159 = 25,272, 79%); opening USDC stays equal in value (2,874 minor units at the illustrative print). A trader's whole opening is then about 2 SIU of each asset against about 4.3 SIU of purchases, with about 2.4 SIU coming back as sales, so a trader can complete its schedule from its opening and its takings without minting. `checkMintsFit` refuses to launch any economy whose worst case exceeds 80% of the headroom it reads, and a test pins the old figure as refused. This is a tunable default (D5), changed here before it is used. | Claude Code |
| D17 | 2026-10-06 | **Minting a claim is paid for in USDC, and the lab brief now says so.** Found by the first walks on a fork: `pay_with_claim`, and the claim leg of `settle_split`, mint through `WorkClaim.mint`, which charges the minter the claim's value in USDC at the print, paid to the issuer. So mint-and-forward is not an fSIU route that spends no dollars: the payer spends about the quote's price in USDC and the seller is handed a claim instead of dollars. That is the instrument as designed (a claim is made by depositing USDC at the print) and the gate configuration always had it, but no tool description or gate brief states it, and a trader short of dollars calls it and is refused ("the paying wallet does not hold enough USDC"). The lab brief now states it as a primitive fact — *a mint is paid for in USDC, at the print, to the issuer* — and draws no consequence. Tool descriptions are shared with the gate configuration and are unchanged. Consequence for the measurement: a trader's holdings of both assets constrain its routes, which is the economy and not a defect. **Brief wording, so flagged for your confirmation.** | Claude Code |
| D18 | 2026-10-06 | **Engine defect found by the fourth fork walk: a seller could not take the dollar leg of a split.** The escrow opened by `settle_split` holds the dollar leg only, and `settle_escrow` defaulted to the whole quoted amount, which the contract refuses. An omitted amount now means what the escrow holds (spec §4.6bk). It affects the gate configuration only where a split is used, which it never was. The issuer service, which retried the refused settlement every turn, starved its other work: that is why three of eight needs were met in that walk. | Claude Code |
| D19 | 2026-10-06 | **The first live walk found a second lag-class defect: `settle_escrow` had no tolerance for a node that had not seen the escrow.** It was refused "not open" and "more than the escrow holds" a moment after the escrow opened, the issuer service gave up on that release, and one split-paid dollar leg was stranded until its quote expires (cents, testnet; no capacity was left outstanding). The write now retries a simulation revert like every other write, and the amount is read only once the escrow is visible (spec §4.6bl). The fork cannot show this class; a second live walk is the evidence. | Claude Code |
| D20 | 2026-10-06 | **Decision rule approved (stop point c), thresholds as proposed (30, 0.50, 0.20), with two changes.** (1) The rule reads a 95% **bootstrap interval over the runs**, not a Wilson interval on pooled opportunities, because decisions within a run share agents, balances and history and so are not independent; the pooled Wilson interval is reported beside it and is not read. (2) **Inconclusive if fewer than 10 of the 20 runs contribute an opportunity**, so a few busy runs cannot decide it. The first model run is read for how many opportunities arose at all, not for a rate. §3 is the registered text. | user |
| D21 | 2026-10-06 | **D17 accepted as a fact, worded in parallel.** The brief states every way's cost side by side, so no single one is singled out: *Paying in USDC costs USDC. Paying with fSIU you hold costs that fSIU. Minting new fSIU costs USDC, at the print, paid to the issuer.* Replaces the one-route parenthetical. | user |
| D22 | 2026-10-06 | **TRADER-4 gets a new wallet; D4 is not accepted.** The seat ID stays (`ISSUER-A`, so nothing widens) and only the wallet behind it changes: ISSUER-A is the failing issuer phase 2 brings back and its identity carries every enforcement on record; a trader's receipts under an issuer's identity would be confusing in any explorer, and a mint ever routed to A would make TRADER-4 the issuer of claims it holds. The lab reads the new wallet from `TRADER_4_ADDRESS` / `TRADER_4_PRIVATE_KEY` and never touches `ISSUER_A_*`. The contamination check still aborts on any mint not backed by ISSUER-B, and the real ISSUER-A's address is now simply one that must never appear. This also lifts phase 2's seat conflict (§7). | user |
| D23 | 2026-10-06 | **D8 and D16 accepted.** D8: raw work is bought by quote, so both assets take the same path; every claim paid to the issuer for raw work is counted as *redeemed for raw work* in the disposals (held claims and newly minted ones, reported apart), and the issuer service holds no tool that passes a claim on — it can only issue quotes and release escrows, so claims it receives stay with it until they expire. D16: a smaller endowment may mean fewer opportunities, and the inconclusive rule covers that. | user |
| D24 | 2026-10-06 | **The first model run found that a seller could pay its own quote, and a quote could be paid twice by claim.** WORKER-CODE (the seller of qr-3) called `pay_with_claim` on that quote after its buyer had already paid it in dollars, and it went through: it minted a claim for itself, paid the issuer about 1,700 USDC minor units, and the payment was recorded against the wrong trader. The chain stops only a second dollar payment (the escrow exists); nothing stopped a second claim payment, and no tool asks who the payer is. A quote is now paid by the trader who asked for it, once, by every route (`lab/guards.ts`, plain sentences, no asset named). **The lab is now stamped with an instrument version (`lab/instrument.ts`, now 2) carried in every report, and the aggregator refuses to pool a run from any other version**, so the first run — made before the guard — is a pilot, kept for what it shows about cost and behaviour and never counted. | Claude Code |
| D25 | 2026-10-06 | **The first model run (pilot) — what it measured and what it found. Not counted** (it predates the pay guard, D24, and is excluded by its missing instrument stamp). Run `lab-2026-10-06T15-41-54-035Z`, seed 1, two haiku-4-5 and two gpt-5.4-mini traders. **Opportunities: 0.** Three payments in the whole run (one dollar, two by minting, none from a held balance); 0 of 8 needs met; **$0.693 realized inference** ($0.357 Anthropic, $0.336 OpenAI), $0 graded work, about $0.0058 per turn over about 120 turns. It says nothing about reuse, because the run never got far enough for anyone to be able to reuse anything. **Why, in order of weight:** (1) **A harness cap stopped it.** The run cap is enforced against projected spend, about five times realized, and my $3 stopped the loop at about 125 turns with round 3 never opened. Fixed (cap 10; a cap-stopped run is now disqualified). (2) **The board's line format made the request id ambiguous:** `answers qr-2: seller …` led TRADER-3 to call `pay` with the id "answers qr-2" in 28 of its 40 turns, and it never realized the id was "qr-2". Not yet fixed — it changes what agents see. (3) **`pay_with_claim` was read as "spend the fSIU I hold":** TRADER-4 called it 27 times, 24 refused for want of USDC, and no trader tried `transfer_claim` or the held route once, despite the brief stating that minting costs USDC. Not yet fixed. (4) **A seller paid its own quote** (D24, fixed). (5) Minor: two models emitted `{"tool":"wait"}` instead of `{"wait":true}`; one passed `forWindow` as a date string. **Also found:** 38 of 39 write retries were genuine refusals (a mint with too few dollars reverts exactly like a stale read), each costing 8 seconds of retry; the lag telemetry now counts `recovered` apart from `gave_up` (1 recovered). **No contract change is needed for any of this.** | Claude Code |
| D26 | 2026-10-06 | **The lab's payment tools are renamed for what they do (your answer 3).** The first run's finding that matters most: the loop's tool for minting a claim to pay with is called `pay_with_claim`, a trader read that as "pay with the claim I hold", and the route the primary measure counts, `transfer_claim`, was never tried once — the test of H1 was tilted against reuse before any agent chose. A trader now sees and calls **`pay_with_usdc`, `pay_with_new_claim`, `pay_with_held_claim`, `pay_split`**: each takes the quote's `requestId` alone (the split also says how much of it is claim), each has a description of one shape (*settles a quote you were sent by … Costs: …*), and the brief has one worked example per route in the same form, with your cost sentence kept verbatim. The loop still runs its own tools: `LabHooks` gained three optional seams (`toolDescription`, `resolveCall`, `rewriteText`) so a call by the lab's name becomes the loop's call, the history shows the call as the agent made it, error sentences name tools as the agent knows them, and the loop's own names are refused. Cost: about half a day, as estimated; nothing in the gate configuration changes. The unkeyed `transfer_claim` (passing fSIU with no quote) is no longer a trader's tool, since it settles nothing. | user |
| D27 | 2026-10-06 | **An unaffordable payment is refused before it is sent, in one sentence whichever asset it is in (your answers 2 and 4).** `This payment costs {cost} {unit}; the wallet holds {held} {unit}.` — for dollars, a new claim (its mint price in dollars), a split and a held claim (in fSIU) alike, from confirmed balance reads. This is the check-the-balance-once you asked for, made before the write instead of after the failure: a shortfall is never sent and so never retried (the pilot lost 8 seconds to each of 38), and a payment the check lets through that the chain then refuses is a stale balance, which the loop's existing retry is right for. The lag figures now count recovered writes apart from refused ones. | user |
| D28 | 2026-10-06 | **Quote lines lead with the request id; the spend projection is calibrated (your answers 1 and 4).** `qr-2: quote from seller …`, like the lines for open requests (lab only; the gate's board is unchanged). Turns are projected at 600 output tokens, about twice the 305 observed at most (input about 6,000, output 100 to 300), so the projection is about 1.5 times realized; the cap is back at 3. **The lab instrument is now version 3** and every report carries it. | user |
| D29 | 2026-10-06 | **The rerun under instrument v3 (run `lab-2026-10-06T18-00-30-905Z`, seed 1, the pilot's schedule).** **The harness ran clean:** no abort, no contamination, no bookkeeping error, no spending-cap stop, all three rounds opened, scored before close, pool restored; the loop ended by itself when every agent was waiting (52 turns of a possible 160). **No call was malformed.** Fifteen calls did not go through, counted from the agents' own histories: nine refused because the wallet could not cover the payment (each in the one-sentence form), three `request_quote` calls declined for want of an open need, and three `deliver_job` calls made before buying raw work. (This line first said one refusal; that was counted from a log that truncates, and is corrected.) **Opportunities: 1, of which 1 reused** (TRADER-1 paid a raw-work unit from a held balance that included 1,184 mSIU it had been paid). Payments: 4 in dollars, 3 from a held balance, none by minting a new claim, none split. Needs met: 2 of 8. **Cost $0.259** ($0.256 inference, $0.003 graded work), about $0.005 a turn; the projection ran 1.16 times realized. **By trader:** TRADER-1 (haiku) 18 turns, used dollars, held claims and new claims, delivered both jobs it sold; TRADER-3 (haiku) 11 turns, dollars and a held claim, stranded at the end (below); **TRADER-2 and TRADER-4 (both gpt-5.4-mini) took 6 and 13 turns and both ended waiting with work in front of them** — TRADER-2 with a paid job to deliver, an open request to answer and a quote to pay, all on its screen, having replied `{"wait":true}`; TRADER-4 was refused a 1,400-unit payment it could not cover, sent the same call twice more and was refused each time, holding 2,000 mSIU it could have paid with, and never tried the held route; TRADER-1 (haiku), given the same refusal three times, reasoned its way to the held route and used it twice. **No further runs: by your rule this is a design question, not a harness one.** Three separable causes are in the report; the options are with you. | Claude Code |
| D30 | 2026-10-07 | **Instrument v4, settlement parity (your answer 1).** A job paid in USDC sat in escrow until delivery and a job paid in fSIU moved at once, so choosing an asset also chose buyer protection and when the seller could spend — and locked sellers' dollars away exactly when they needed them to buy raw work. In the lab both routes now settle as a **direct transfer at payment**: `pay_with_usdc` is a USDC transfer to the seller, `pay_with_held_claim` a claim transfer, nothing held. That removes the 50 bps fee, the rebate, `settle_escrow` and the issuer's release step, and with them the scoring problem of §6 of the run report: nothing sits in escrow to be miscounted. **It is a tool change, not a contract change:** `pay` does a plain USDC `transfer` when the run is a lab run (no escrow contract is touched), and the quote board stops saying "real USDC is in escrow". The gate configuration is untouched. | user |
| D31 | 2026-10-07 | **Either asset alone is enough; minting is removed (your answer 2). I chose removal, for a reason in the numbers.** To meet every need from USDC alone a trader needs 2 jobs (2 × 1,700) and 2 raw-work units (2 × 1,400) = 6,200 USDC minor units; from fSIU alone, 2 × 1,184 + 2 × 975 = 4,318 mSIU (worth 6,205 at the print). The opening is now **sized from the print and the schedule so that either alone covers every need** (4,318 mSIU and 6,205 USDC at the illustrative print), instead of a fixed figure. Four endowments are 17,272 mSIU, 54% of ISSUER-B's 32,000 mSIU headroom. **With minting allowed, the worst case adds eight job claims and eight raw-work claims (17,272 more) for 34,544 mSIU, which exceeds the headroom** (and the 80% bound of 25,600), so minting cannot stay. Removed: `pay_with_new_claim` and the minted split are gone from a trader's tools; **the fSIU supply is the endowment, fixed for the run, and reuse is circulation of that supply.** The brief says so as a fact and its cost sentence loses its third clause. This supersedes D16 (the worst-case mint bound becomes an endowment bound) and D17/D21 (there is no mint cost to state). | user |
| D32 | 2026-10-07 | **Paying with both (your answer 3).** `pay_split(requestId, claimQuantityMilliSiu)` is now one payment drawn partly from a **held** claim (the amount given, valued at the print) and partly in USDC (the rest of the quote's price), both transferred at once. It replaces the split that minted its claim part. A new internal tool (`settle_split_held`) over the same two transfers; no contract change. A trader whose holdings straddle the two assets, like TRADER-3's 1,174 USDC and 816 mSIU, can now pay. | user |
| D33 | 2026-10-07 | **Refusals state the whole wallet (your answer 4).** *This payment costs {what it costs}; the wallet holds {USDC} USDC minor units and {fSIU} mSIU of fSIU.* The same two figures whichever asset the payment was in and whichever was short; a split states both of its parts. A fact, symmetric, no advice. Replaces D27's wording. | user |
| D34 | 2026-10-07 | **The gpt-5.4-mini seats (your answer 5): rerun first, replace only on evidence.** The rerun reports, for each trader, whether it **waited while it had something it could do** — a wait on a turn whose screen listed an open request addressed to it, a quote to pay, a need to buy, or a paid job to deliver — counted from the prompts and now recorded in the report. If either gpt-5.4-mini seat still does, that family is replaced by a stronger cheap model from another family and the replacement is reported. | user |
| D35 | 2026-10-07 | **The motive structure is kept; nothing is added, and one assumption is corrected.** The score counts fSIU at the print; the lab has no route from fSIU to USDC and v4 adds none. **The brief does not currently say "converting changes nothing and is never required"** — it states only how a result is counted (your fSIU valued at the current print is part of it), and D15 keeps "convert" and "cash out" out of the brief's wording. The sentence was assumed to be present and is not. Left as it is until you decide whether to add it; if you do, it is one more line in this version's change list. | user |
| D36 | 2026-10-07 | **The asset paragraph in the brief had to change, and that was more than a tool change (your answer 1: "report if a direct USDC transfer needs more than a tool change").** Settling directly needed no contract change and no change to the gate configuration. It did make two sentences of the canonical asset text false of the lab: *"Paid against a quote, it is held in escrow until the seller settles. A seller may settle for less than it quoted, and whatever it does not claim returns to you."* Nothing is held, there is nothing to settle, and nothing returns. The lab's brief embeds that text verbatim, and the context validator requires it verbatim in every agent's context, so leaving it would have put a false sentence about USDC in front of every trader and a validator that insisted on it. **What changed:** `lab/asset-text.ts` derives the lab's asset text from the canonical constant by one replacement of exactly those two sentences with *"Paid against a quote, it reaches the seller at once."*, throwing at load if the canonical text no longer contains them; `validateAgentContext` takes an optional asset text (default: the canonical one, so nothing else changes) and only the lab passes its own; a test pins that the two texts differ in nothing else, and the fSIU paragraph is untouched. The gate configuration keeps the canonical text. **This is a call I made rather than asked; it is reversible, and it is in the instrument's change line.** | Claude Code |
| D37 | 2026-10-07 | **The v4 rerun has not run: the provider pre-flight refused to start it, and nothing was spent.** `lab-run --seed 1` stopped at the check that makes a live call through each provider's own adapter: **OpenAI answered; Anthropic did not — its API returns, for the claude-haiku-4-5 call, "Your credit balance is too low to access the Anthropic API"** (the preflight's own line said only "request failed: 400"; the body is from a direct call). No run directory, no report, nothing for the pool, no chain write (the endowment is minted only after the check). **I did not substitute models for the two haiku seats.** Item 5 of the v4 instruction allows replacing the gpt-5.4-mini family, and only after a rerun shows it still stalling with work on its board; it does not cover the haiku seats, and two families are the design (§2.3). **The rerun waits for the Anthropic account to be topped up** (a run costs about $0.3 to $0.8, §13). Everything the rerun needs is built, gated and walked (P13). | Claude Code |
| D38 | 2026-10-07 | **The v4 rerun (run `lab-2026-10-07T06-31-20-900Z`, seed 1, the pilot's schedule), after the Anthropic key was replaced (D37).** **The harness ran clean:** no abort, no contamination, no bookkeeping error, no spending-cap stop, all three rounds opened, scored before close, pool restored (32,000 → 32,000 mSIU); USDC (473,611 minor units) and fSIU (17,272 mSIU) are exactly conserved across the four traders and the issuer, from the opening to the final snapshot; no write needed a retry. 29 turns (TRADER-1 8, TRADER-2 6, TRADER-3 11, TRADER-4 1, issuer service 3). **Needs met: 3 of 8. Opportunities: 0. Reuse: 0. Partial reuse: 0.** **All seven payments were in USDC; none from a held claim, none split; every trader finished with exactly the 4,318 mSIU it opened with** — fSIU never moved, so no trader ever held fSIU it had been given, and the reuse question could not arise. Of the six stated reasons read for TRADER-1's and TRADER-3's payments (both haiku), none weighs USDC against fSIU: two mention USDC in passing ("using USDC to satisfy…") and the other four name no asset at all. **All five unmet needs trace to the two gpt-5.4-mini seats:** TRADER-4 sent `{"issue_quote":{"requestId":"qr-2"}}` as its first reply, the loop halts an unparseable turn by design (it does not retry), and TRADER-4 never acted again — two quotes asked of it were never answered and its own two needs were never requested (four needs); TRADER-2 was paid for a job, waited once with that job owed and no raw work on hand, and never bought the unit it needed to deliver (the fifth: TRADER-1's first need, paid for and not delivered). Both haiku traders delivered every job asked of them. **Waited while it had something it could do: one recorded wait (TRADER-2, turn 5, a paid job owed and no raw work), and one seat (TRADER-4) that never got a turn after a malformed reply with a request on its board.** Format failures: that one. Refusals: one well-formed (TRADER-2 paying a quote TRADER-1 asked for); the whole-wallet refusal was not exercised because no payment was unaffordable, which is what sizing either asset to cover every need is for. A wart, not fixed: the rewrite that shows internal tool names as the lab's rewrites "pay:" in a guard's sentence into the tool name ("qr-1 is not yours to pay_with_usdc: …"); cosmetic, and changing agent-visible text needs a new stamp. **Cost $0.129** ($0.104 Anthropic, $0.021 OpenAI, $0.004 graded work). **By your rule this is not a freeze:** 3 of 8 is not most, and 0 is not a handful. The part of it that is the roster (D39) is separable; the part that is not is that no trader, of three that did act, had any occasion to touch fSIU. In v3 the few opportunities came after refusals (a trader that could not afford a payment in USDC reasoned its way to the held route); v4 removes the shortfall by design, and with the two assets counted the same and no cost to either, nothing in the economy asks an agent to choose fSIU. **That is the conversation before anything further is spent. The 20 runs are not started.** | user |
| D39 | 2026-10-07 | **Your item 5 contingency applied: the gpt-5.4-mini family is replaced, by claude-haiku-4-5 (instrument v5).** Both gpt-5.4-mini seats stalled with actionable items on their boards (D38). "A stronger cheap model from another family": **I chose claude-haiku-4-5 for TRADER-2 and TRADER-4**, because it is the one with evidence in this loop — no malformed call in four runs, and every job its traders were asked for was delivered — and it is cheap ($1 / $5 per million) and registered. The cost is that **the roster is now one family, not two** (§2.3), which loses the cross-family check. The alternative that keeps two families is `deepseek-v3.2` (registered, $0.28 / $0.40 per million, via OpenRouter); it has not been run in the lab and I did not replay this run's two stalled screens through it, because you asked for no further spend before we talk (about $0.10 would tell us more than the registry does). Say the word and the roster is one line (`LAB_MODELS`). **Stamped v5, with nothing an agent is shown changed**, so the v4 rerun, made with the other roster, is not pooled with any run made with this one; it shows `[NOT COUNTED]` in the report. A roster swap you ordered, not a new structural change. | Claude Code |

---

## 12. Status checklist

### 12.1 Your points — where each stands

| Your point | State | What happens |
| --- | --- | --- |
| Test fSIU vs USDC; marketplace still not runnable after two weeks | **Engine done and proven; vehicle being replaced.** | The contracts and payment tools are proven on the live chain: the scripted walk `DEBUG-p5-three-window-2026-10-05T18-55-26-808Z` passed all 14 checks. The task and roster on top are being replaced by this lab. Estimate in §13. |
| Gate-attack too complicated; use an easier task | **Decided (D1, D2).** | Retired from the currency test. The lab task is T1 shipment records, checked by a deterministic grader. |
| Freedom to pay in fSIU or USDC | **Built; exercised on a fork, live pending.** | Both routes exist, the tool descriptions are parallel and nothing steers. The 50 bps dollar-route fee is given back to the seller after each dollar settlement by the operator (P7): on the fork every rebate equalled the contract's fee. **Found:** a payment by minting (`pay_with_claim`, the claim part of a split) is paid for in USDC at the print (D17), so it is not a route that spends no dollars; the brief now states that as a fact. |
| Reuse fSIU instead of minting new each time | **Built and measured; no model has run.** | In the lab every trader both buys and sells in one window over rounds, so received fSIU can pay for the next purchase. The measure (§3) counts an opportunity wherever a trader held received fSIU enough to pay and a reuse where it did; the scripted walk shows the path works (eight payments from a balance that included received fSIU) and says nothing about what agents choose. |
| A board showing future work, so agents keep some fSIU | **Built (P1, P4); used in the fork walks.** | Every trader is shown every trader's needs by round, who delivers what, and what is open to it now. Holdings against upcoming needs are reported round by round (P8). |
| Clear that cashing out to USDC is not a goal | **Built; stated as a fact.** | Through scoring (§2.8), not an instruction: every brief says a result is USDC plus fSIU at the current print plus a credit, measured before the window closes. The verifier recomputes every result from the balances. No brief says what follows from that. |
| Hybrid fSIU | **Plan only (§7).** | The contracts are already issuer-specific. Phase 2 adds a second issuer and a failing one. Agent choice of issuer at mint needs a contract change, which is a stop point. |
| The second market | **Plan only (§8).** | Phase 3, after phase 1. |
| Why five runs | **Changing.** | Phase 1 does 20 runs, after the decision rule is approved and the first model run is costed (§4). |
| About €100 spent | **Cannot be fully reconciled from this repository.** | The experiment ledger records **$22.93 realized inference spend** and $42.79 projected, as of 2026-10-05; it is a lower bound because 10 crashed run directories never wrote their spend. Anything beyond that is not in this repo's records. **Nothing has been spent on the lab so far:** the scripted walks call no model and cost fork gas only. Model runs are estimated at $0.30 to $0.60 each (§13) until the first one is costed. |
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
- [x] P1 — economy module: config, seeded schedule and needs, one list
- [x] P2 — job source and work executor (T1 variants, grader, cost accounting)
- [x] P3 — `deliver_job` and the lab guards (quote rate, size, type, round, raw-work credit)
- [x] P4 — loop lab hooks: board section, rounds, fee rebate (loop-level tests pass; the scoring snapshot is built with the runner, P7)
- [x] P5 — issuer service policy seat (answers quote requests, settles USDC-paid escrows; raw-work units are credited when its quote is paid, so no separate redemption path)
- [x] P6 — briefs, roster, model assignment, validator (lab/briefs.ts, lab/roster.ts; shared text byte-identical across traders, validator passes, no steering words, every tool in a worked example is granted; gpt-5.4-mini price added)
- [x] P7 — lab runner: opening balances, endowment mint, launch checks, rounds, expiry sweep (`lab/run.ts`, `lab/operator.ts`, `lab/operator-chain.ts`, `lab/scoring.ts`, `cli/lab-run.ts`; orchestration tested against an in-memory chain, 16 tests; the real-chain paths were exercised by the fork walks below). Crash recovery: the runner writes `<run>-open.json` the moment the endowment exists and `pnpm run lab-sweep` returns the capacity of any run that was killed outright
- [x] P8 — measurement, scoring, report, aggregator with Wilson intervals, countable assertion (`lab/measure.ts`, `cli/lab-report.ts`; 35 tests; Wilson values checked against an independent computation; `assertCountableForF1` is called on every run the pool admits, with the recomputed reason beside it; every report carries `debugMode.disqualifiedBecause`)
- [x] P9 — lag telemetry (`chain/write.ts` reports every write that needed the node to catch up and how it ended; the run report carries `lag`; 4 + 1 tests)
- [x] P10 — scripted lab walk and verifier, fork then live (`lab/scripted-traders.ts`, `lab/verify-walk.ts`, `lab/lab-cues.ts`). **Passed all 19 checks on a fork (walk 6) and live on Base Sepolia (live walk 2, `lab-scripted-2026-10-06T13-46-58-655Z`): 8 of 8 needs met, every route used for jobs and for raw work (dollars, mint-and-forward, held balance, split), 6 payments made from a balance that included fSIU the payer had received, 5 of 5 fee rebates equal to the contract's fee, fSIU conserved, every leftover position expired at close, the pool back at 32,000 mSIU, no tool call errored.** Six walks found six defects the unit tests could not, each fixed and pinned: the open-request reader matched seat names only; the runner never gave the tools the lab service; minting is paid for in USDC (D17); a split's dollar leg could not be settled (D18); and, live only, `settle_escrow` had no lag tolerance (D19). A scripted run costs gas and about a cent of testnet USDC; no model was called
- [x] P11 — phase 2 and phase 3 plans refined (seat conflict, failing issuer as a service policy, first-fit seeding, dealer wallet — §7, §8)
- [x] STOP c — rule approved 2026-10-06 with two changes (D20); TRADER-4 moved to its own wallet (D22)
- [x] P12 — one model run; cost reported — **STOP d reached 2026-10-06** (D25): 0 opportunities, $0.693; the run was cut by a harness cap and undermined by presentation problems; a rerun is proposed after the agent-visible fixes are approved
- [ ] P13 — **instrument v4** (D30 to D36), built and walked 2026-10-07; the full gate set (build, typecheck, lint with 0 errors, docs check, `test:all` with 107 files and 1,229 tests in the lab's package) passes on the committed code. Direct transfer in both assets (no escrow, fee, rebate or release); opening derived so either asset alone meets every need, minting removed; `pay_split` from a held claim and USDC; whole-wallet refusals; the lab's own asset paragraph (D36); waits-with-work recorded; H1 re-registered (§3). **The scripted walk was rewritten for the new routes and gained checks** that USDC and fSIU are conserved across the five wallets, that nothing is minted after the opening, that every split moved a held claim, and that the opening covers every need in either asset. **It passed all 22 checks on a fork (`lab-scripted-2026-10-07T05-13-57-295Z`) and live on Base Sepolia (`lab-scripted-2026-10-07T05-24-09-073Z`): 8 of 8 needs met; every route used for jobs and for raw work (dollars, held balance, split); 4 held-balance payments by a payer holding fSIU it had been given; 443,889 USDC minor units across the five wallets before and after, and 17,272 mSIU before and after — no fee, no escrow, nothing minted; every leftover position expired at close and the pool back at 32,000 mSIU.** The live walk had one write that needed the node to catch up and recovered. A scripted run costs gas and about a cent of testnet USDC; no model was called.
- [x] v4 rerun — **STOP d2 reached 2026-10-07** (D38): clean harness, **3 of 8 needs met, 0 opportunities, 0 reuse**, all seven payments in USDC, $0.129; every unmet need traced to a gpt-5.4-mini seat (replaced, D39, stamp v5). By your rule not a freeze: a conversation about the economy first.
- [ ] Phase 1: 20 runs, on your go — **held**: the v4 rerun did not meet the freeze condition (D38)

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

**Measured by the first model run (D25), which supersedes the estimate above.** About 120 turns cost **$0.693
realized**, about **$0.0058 a turn**: input prompts of about 5,000 tokens plus a rationale and friction note in each
reply, which the estimate left out. A run that uses its whole turn budget (up to 40 turns for each of four traders,
about 160, plus whatever the issuer service does for nothing) is therefore about **$0.9 to $1.2, so 20 runs are
about $18 to $24**, against the earlier $6 to $12. Wall time: the loop ran about 30 minutes at an average of
2 to 4 seconds a model call, plus 8 seconds for each write refused and retried; the pilot's own window was
30 minutes and the run waited for it to close before returning capacity. The window is the largest fixed cost per
run, and should be set to what a run actually takes once the presentation problems are fixed.

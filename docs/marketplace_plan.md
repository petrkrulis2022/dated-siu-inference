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
| opening per trader | 2 SIU of USDC and 2,000 mSIU of fSIU (**changed from 4 SIU, D16**) | 2 SIU: 2,000 mSIU of fSIU and 2,874 USDC minor units at the illustrative print |
| decision turns per run | about 50 | |

*Worst-case mint check (enforced at launch, §5; `lab/launch.ts`):* the endowment, then every need paid by
minting both its job claim and its raw-work claim. At the illustrative print of 0.001437 USD/SIU a job quote
is 1,700 minor units, so a job claim is 1,184 mSIU, and a raw-work quote is 1,400, so its claim is 975. With
eight needs and four endowments of 2,000 that is 8,000 + 8 × (1,184 + 975) = **25,272 mSIU, 79% of ISSUER-B's
32,000 mSIU headroom** (the bound is 80%, 25,600). **The first draft of this note said 25,600 for a 4,000 mSIU
endowment and left the raw-work claims out; with them the draft's figure was 33,272, more than the whole
headroom (D16).**

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
- **Headroom.** The worst-case mint (the endowment, then every need paid by minting its job and its raw-work claim) is held to 80% of ISSUER-B's extract headroom (§2.11, D16), checked at launch against the headroom actually read; a run that would exceed it does not start. The contamination check (a mint backed by anyone but ISSUER-B aborts the run) stays as the backstop.
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

**What building phase 1 changes about this plan (2026-10-06, P11).**
- *The seat conflict.* TRADER-4 stands on ISSUER-A's wallet (D4), the only unused one. Phase 2 makes ISSUER-A a
  second issuer, so TRADER-4 needs another wallet or another seat. That lifts "no new wallets" and is a
  decision for you at the start of phase 2, not something to discover then.
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
| D4 | 2026-10-06 | Traders use existing seat IDs, no new wallets. **Mapping (Claude Code, to confirm):** TRADER-1 = ORCHESTRATOR, TRADER-2 = WORKER-CODE, TRADER-3 = WORKER-EXTRACT, TRADER-4 = ISSUER-A. ISSUER-A's wallet is the only unused one (HEDGER has none). It is a registered issuer, so a mint that overflowed to it would pay TRADER-4 and the contamination check aborts the run. | Claude Code |
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
- [ ] STOP c — **reached 2026-10-06; the draft rule (§3) is with you for approval.** Nothing further is built or run until you reply
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

# Experiment 3a design: AGU-lab vs USDC, fair terms

Nov 11, 2026 · @beersloth

## Purpose and status

v3a asks whether AGU-lab can perform each function of money against USDC when both are on fair terms and the mechanics work. v1 and v2 never tested that: in both, the verdict measured plumbing rather than behaviour.

- **Status:** Design approved 11 Nov 2026. Nothing runs until the fixes are built, the design is frozen and hashed, and Petr gives an explicit go.
- **Past results stand as recorded.** v1 (D131) and v2 (D139–D140) keep their pre-registered verdicts; the diagnoses sit beside them.
- **Scope:** two currencies only, AGU-lab and USDC. A third currency comes in v3b on this design unchanged (see the v3b section).
- **Tasks are simulated.** Issuers pass or fail by seeded draws from the trial's measured pass rates, so data content never affects outcomes.
- **The question is not neutrality.** v2 showed that with no reason to hold AGU-lab, nobody does. v3a gives AGU-lab the reasons the v6 design claims it has (work-cost certainty, buying ahead, observable redemption) and measures whether agents act on them.

## What v2 got wrong and the fix

Every row is a reason v2's verdict could not speak to AGU-lab. All are confirmed by the code check, `docs/v2-code-check.md` (11 Nov 2026).

| v2 problem | Effect | v3a fix |
| --- | --- | --- |
| Only the hedger held AGU-lab; no agent that quotes or accepts quotes held any | Quoting in dollars measured starting balances, not preference | Every role starts with both currencies at equal value |
| Paid quotes stayed on the board as "delivered, … in escrow"; the escrow wording was never cleared | 9 of 15 lapsed needs | Paid or refunded quotes leave the board; every refusal names the quote and the reason (quotes were already bound to a need id) |
| Agents read the per-window spend cap as charging forward purchases to today; in code it applied only when accepting a current-window quote, and claim purchases were never capped | Agents believed buying ahead competed with today's need | Spend counts against the window the work is for |
| No code path let a demand agent meet a need with a front claim | Buying ahead through claims was impossible, so criterion 4 could not have held | New code path: claims transfer as payment (v6 design), so demand agents pay research agents with claims and research agents present them for that need |
| Hedger's early deliveries scored late: code compared per-window changes, not the cumulative totals its build plan specified | The only forward-acting agent was penalised | Early deliveries bank against later obligations |
| Conversion, hops and circulation all scored the same 6 USDC receipts, labelled as AGU-lab | Two "passes" said nothing about AGU-lab | Empty samples report n/a; every measure is per currency |
| Tiny dollar amounts beside SIU-sized ones | Agents compared numbers, not values ("scarce" USDC worth 10× the AGU-lab) | Every amount shown in both units; AGU-lab in whole mSIU, USDC in micro-dollars |
| "A brief = 2 SIU" in all three demand agents' reasoning; the prompt never said it, the 2.0 AGU-lab spend cap did | 5–10× overvaluation; 21× price spread | Each need states its work content in mSIU and its value at today's print; caps are stated in briefs and sit well above one brief's real cost |
| Value of AGU-lab and fSIU only asserted on the board | No agent saw a claim minted or redeemed | Provider agent mints; NAV derivation and redemption log are public; any agent can redeem |
| Print barely moved; sweep fell after the last decision | Store of value and buying ahead had nothing to respond to | Seeded price path with visible history; sweeps mid-run |
| 14 turns lost to failed model calls (HTTP 400) in window 7: 2 in round 5 and every agent's turn in rounds 6–7; the headline counted parse failures only, and the stop rule ignored service failures | Last window unreliable | Service failures count in the validity gate and trigger the stop rule; the cause of the 400s is found before freeze |

## Cast

Nine model agents and seven scripted actors; the gate runner is infrastructure, not an actor. All model agents run claude-sonnet-5 in counted runs and claude-haiku-5-5 in development, so no model difference confounds a result.

| Agent | Kind | Decides | Starts with (equal value at the opening print) |
| --- | --- | --- | --- |
| PROVIDER | Model | How much fSIU to mint each window, the discount to the print, which buyers to sell to, in which currency | Headroom per window from issuers' capacity; bond held by code |
| RESEARCH-1, -2, -3 | Model | Quotes (either unit), data, commissions, delivery | 0.025 USDC + the same value in AGU-lab |
| DEMAND-1, -2 | Model, identical mandates | Accepting quotes, buying ahead, holding | 0.05 USDC + the same value in AGU-lab |
| DEMAND-3 | Model, cautious mandate | Same | Same |
| DEMAND-4 | Model, permissive mandate | Same | Same |
| HEDGER | Model | Commissions, claims, forward deliveries | 0.05 USDC + the same value in AGU-lab |
| AGU issuer | Code | Reserve, NAV, roll, creation and redemption at NAV (v6 AGU-lab mechanics) | Seeded reserve; buffer 1.5 USDC, sized to hold NAV through window 8 |
| PARTICIPANT | Code | Buys and sells AGU-lab at NAV × print ± 1%, buybacks capped at 10% of supply per window | 2 USDC |
| ISSUER-C1, -C2, -X, -F | Code | Serve tasks; pass or fail by seeded draw | Headroom; bonds |

The seventh scripted actor is the DATA seller: code, selling each dataset at about one task's value, payable in either currency.

- **Three research agents, not two,** so most needs draw two or more competing quotes. Comparability needs that.
- **Two identical demand agents** measure noise between runs of the same mandate (v6, section 11).
- **Needs:** one per demand agent per window, visible three windows ahead. Each need states its tasks, its work content in mSIU and its value at today's print.
- **Mandates** cap spend per window of delivery, not per window of purchase, and keep a minimum value buffer in either currency. Cautious and permissive differ only in cap size and buffer.
- **Every balance and price is shown in both units:** AGU-lab in whole mSIU, USDC in micro-dollars, each with its value in the other unit beside it.

## Prints

The print moves once per window, along a seeded path agents cannot see ahead of time. Each window stands for one simulated day, so prints are tied to decisions, not to the wall clock; a run's length in minutes depends on API speed and must not change what agents see.

- **Path:** generated before the run from a committed seed. The seed stays hidden until the run ends; its hash is recorded at freeze.
- **History:** agents see the last 15 prints from the first round, generated by the same process as a burn-in, and labelled "simulated".
- **What moves:** the fixed-basket CR print that AGU-lab's NAV and the participant reference. The four class prints move with it plus small independent noise, so relative prices between task types drift a little.
- **Next print:** published at each window open. Agents learn it only then.
- **Two volatility settings, both pre-registered:**
  - **Low:** daily volatility set to the measured volatility of the real Dated SIU history at freeze (0.6549% a day; its largest real one-day move is 1.93%, on 26 Sep).
  - **High:** 5% daily volatility.
- **Drift is zero in both settings.** This matters: if work keeps getting cheaper in dollars, as the decline thesis expects, holding USDC buys more future work and AGU-lab loses in dollar terms. Zero drift favours neither currency. Whether agents read the direction of prices is a separate test with its own drift settings, after v3a.
- **Sweeps** fall at the end of windows 4 and 8 of 8, so owners' dollar demands land while agents are still deciding. Each sweep is a fixed USDC amount, a set share of starting value, shown on the board from window 1 round 1. If an agent's USDC is short, AGU-lab or claims convert through the participant to cover it; those conversions are logged as forced and kept out of the exchange measure, so holding either currency neither dodges nor worsens a sweep.

## How value is established

Agents learn what fSIU and AGU-lab are worth by watching claims get minted, presented and honoured, not by reading a label. Minting, redemption and settlement stay in code so they are deterministic and auditable; the provider agent makes only the commercial decisions.

**fSIU, following the v6 lifecycle:**

1. **Mint.** PROVIDER posts standing offers within the issuers' headroom: class, window, maximum quantity, discount to the grade print, accepted currency (USDC, AGU-lab or both) and optionally named buyers. It may revise or withdraw an offer each round. Buyers buy against an offer in any round, or post a request that stays on the board until PROVIDER answers or the window closes. PROVIDER is paid at sale, issuers are paid their measured cost when they serve, and defaults come from the bond and count against PROVIDER's profit.
2. **Transfer.** Free. Paying in fSIU means transferring the claim: a demand agent can pay a research agent with claims for the window the brief is due. Claims paid for a brief sit in escrow like any other payment and return to the payer if the brief fails or the need lapses.
3. **Present.** The holder presents with a task inside the window. A pass retires the claim. A fail leaves it alive to present again.
4. **Close.** Presented but never served: the issuer's bond pays the holder at the grade print (default). Never presented: nothing (expired). Agents get a deadline warning for held, unpresented claims.

**AGU-lab, following the v6 AGU-lab mechanics:**

- **Creation and redemption at NAV,** in kind and pro rata, open to any agent above a minimum size.
- **The roll sells front claims in either currency.** v2 forced USDC here, which made every forward purchase a "structural dollar route".
- **Paying for work now with AGU-lab:** directly to a seller who accepts it, by redeeming in kind, or by buying current-window claims from PROVIDER.

**What every agent can see on the board:**

- **NAV derivation each window:** reserve claims in SIU, expected default losses, supply, NAV in SIU and in dollars, the buffer remaining and its draw this window, and the shadow NAV the reserve alone would support without the buffer.
- **The claims record:** for each issuer and window, claims minted, presented, redeemed, defaulted and expired, plus PROVIDER's current and past discounts.
- **Its own position:** every claim held, its window, its deadline and its value at today's print.

## Issuers and tasks

Issuers are code: each commissioned task passes or fails by a seeded draw from the trial's measured pass rate for that issuer's model on that task type. Data content never touches an outcome, so v3a needs no Blockworks data.

| Issuer | Stands for | Task types offered | Pass rate source |
| --- | --- | --- | --- |
| ISSUER-C1, -C2 | claude-haiku-5-5 | CR-PL, CR-UO, CR-SM (it fails CR-VS) | Trial, per task type |
| ISSUER-X | A cheaper, less reliable configuration | Same three | D119's 80% qualifying floor, a pre-registered rule; list price 15% below C1/C2. Failed work is refunded (v6), so X's cost is timing risk: a failed task burns rounds and can make a need lapse |
| ISSUER-F | claude-sonnet-5 | All four, including CR-VS | Trial, per task type |

- **Pass-rate table:** exported from the trial ledger in `dsi-cr-trial` at freeze, with counts per model and task type, and hashed with the config.
- **Prices in SIU** come from the class prints, as in v2. Issuers accept payment in either currency. The roll places each lot through pooled direct mint, split across every issuer with headroom (v6). Issuers' measured capacity is sized to cover the largest reserve any v3a run reaches, with a 2× margin; v6's issuance limit stays in code.
- **Data price is proportionate.** In v2 a day's dataset cost $0.001 against $0.0002 of tasks, so data dominated research costs and was paid in USDC. In v3a a dataset costs about one task's value, payable in either currency.
- **Real data comes later, with executed tasks.** Real versus stand-in data can only change behaviour if agents' outputs depend on it. That needs executed tasks, which is a separate run once v3a has a clean result.

## Arms, runs and budget

Eight counted runs: two arms, two volatility settings, two seeds each, at about $7 a run, roughly $56 in total.

| Arm | Who decides holdings | What it tests |
| --- | --- | --- |
| A: free choice | Agents, within mandates | Whether agents choose AGU-lab for each function unprompted |
| B: owner reserve | Owners set a rule: at each window close, hold at least 50% of the next three windows' known needs in AGU-lab or fSIU; agents choose instrument and timing. The rule and current shortfall are on the board and compliance is checked at every close, never forced. Applies to the four demand agents and the hedger, whose owed briefs count as known needs | Whether AGU-lab reaches balance sheets through owners' treasury rules, the board's route |

- **Arm B measures more than obedience:** whether agents spend the reserve on work, unwind it right after each check, or work around the rule. Those are scored, not just compliance.
- **Size:** 8 windows × 8 rounds × 9 model agents = 576 turns per run. v2 cost $0.0115 a turn, so about $6.60; the richer board pushes it towards $7–8.
- **Correction to my earlier estimate:** "3 runs per arm, about $50" did not cover both volatility settings. Three seeds in every cell is 12 runs, about $85–95. I recommend two seeds per cell, adding a third only in a cell where the two disagree on a pre-registered measure.
- **Rehearsal** runs on claude-haiku-5-5 with a different seed, costs a few dollars, and only tests the code. Its results are never scored.

## Measures, thresholds and kill criteria

Each function of money gets its own share-based measure, scored per currency and pooled across the runs of each arm. Thresholds approved 11 Nov 2026; they never change after any counted data exists.

| Function | Measure | Counts only | Signal for AGU-lab | Kill signal |
| --- | --- | --- | --- | --- |
| Exchange | AGU-lab share of payments, by value | Payments where the payer held enough of both and the payee accepted both; claim transfers are excluded (buying the claim was the payment) and reported under deferred payment | ≥ 30% | < 10% |
| Account | Unit used in reasoning, coded blind: SIU, dollars, both, none | Every priced decision (quote, counter, accept, mint, buy ahead) | SIU in ≥ 40% of decisions | SIU in < 20% and binding quotes in mSIU < 10% |
| Store of value | Share of each agent's wealth in AGU-lab and fSIU at each window close, valued at the print, verdict on the NAV prices use, with the shadow NAV (no buffer support) reported beside it | Every agent, every close | Median ≥ 40% at window 8 (start is 50%) | Median < 15% at window 8 in the low-volatility setting |
| Deferred payment | Share of forward commitments in each currency; missed worthwhile purchases | Opportunities computed as worthwhile in advance | Missed ≤ 50% of worthwhile purchases | Missed ≥ 80%, with at least 20 worthwhile opportunities |
| Comparability | Share of choices that take the cheapest offer per accepted mSIU, SIU-first display vs dollars-first | Decisions with two or more offers that could all pass | SIU-first beats dollars-first by ≥ 10 points | No difference, with at least 40 decisions per display |

**How "worthwhile" is computed:** for each round where an agent can see a need in a later window, code compares the best posted forward price with the expected spot price (today's print, since drift is zero), less the expected loss from default and expiry taken from the claims record at that moment. Only information the agent could see at that moment counts. If fewer than 20 opportunities qualify across an arm, the deferred-payment measure reports n/a, not a failure.

**How blind coding works:** two different models code every priced decision without seeing arm, run or agent. Petr hand-codes a random 10%. If agreement between coders (Cohen's kappa) is below 0.7, the account measure reports n/a.

**Arm B adds three measures:** share of the reserve spent on work, share unwound within one round of a window close, and attempts to meet the rule with instruments that don't hold work value.

**Kill criteria:** any two kill signals in arm A close the AGU-lab question for this design. An n/a never counts as a kill signal or as a pass. In v3b, with a compute claim as the third currency, every measure reports a three-way share instead (see the v3b section).

## Validity gates and freeze

A counted run is scored only if it passes every gate below; a failed run is reported as invalid with its reason, never rerun quietly.

- **Lost turns (parse or service failures):** 1% or fewer.
- **Starting balances:** every role holds both currencies at equal value, checked from the genesis log entry. AGU-lab's buffer must also last to the end of window 8, and v6's issuance limit must never bind: a creation or roll refused for lack of total headroom makes the run invalid.
- **Board integrity:** no paid or refunded quote appears as open; every refusal carries its reason.
- **Scorer reads the seed from the log,** never from the config default (the D133 lesson).
- **Enough data:** each measure states its own minimum count; below it, that measure reports n/a.

**Freeze procedure:**

1. The code check (`docs/v2-code-check.md`) is done (11 Nov 2026). Its list of confirmed bugs, plus the demand-side claim path, is the build list for v3a.
2. Fixes are built, then tested on the rehearsal log until every gate passes.
3. Config, price-path seeds (as hashes), pass-rate table, scorer and this design are committed together; the commit hash and time go in the decision log.
4. Counted runs start only after that commit, with Petr's explicit go.

## v3b: a third currency, and the STU conflict

Using STU itself as the third currency reverses a board decision in v6. v6 says STU "stays a measured unit, never a token or settlement reference" and "is never a token, never money and never billed" (sections 3 and 5, changelog row 03).

I recommend keeping that decision and testing a lab-only compute claim instead, measured in STU:

- **CAP-lab:** a claim on one STU-hour of a qualified configuration's capacity, delivered whether or not the tasks pass. It is the lab stand-in for compute money in the style of Hayes's FLOP. STU stays the unit that measures it.
- **What it tests:** v6's own claim that AGU "converts into verified work, not raw compute", so it should beat compute money on comparability and on certainty of what a payment buys.
- **Mechanics:** priced off the STU-hour price series. Presenting one CAP-lab buys a fixed number of task attempts, set from the trial's measured SIU per STU-hour; each attempt passes by the trial's pass rate, and failed attempts are used up. The holder bears pass-rate risk, which fSIU and AGU-lab do not.
- **Design:** v3a unchanged, with three currencies at equal starting value and every measure reported as a three-way share.
- **Starts only after v3a gives a clean, valid result.**

If you do want STU itself to become a token, that is a board decision that changes v6, and should be made and logged as one, separately from the experiment.

## Decisions (approved 11 Nov 2026)

| # | Decision | Approved |
| --- | --- | --- |
| 1 | Thresholds in the measures table | As proposed; never changed after counted data exists |
| 2 | Arm B's owner rule | Hold at least 50% of the next three windows' known needs in AGU-lab or fSIU |
| 3 | Seeds per cell | Two, with a third only where the two disagree |
| 4 | High-volatility setting | 5% daily |
| 5 | Mandate caps | Cautious 3 briefs per window, standard 5, permissive 8, valued at the print |
| 6 | PROVIDER's objective | Profit in SIU over the run, with a penalty for defaults it causes |
| 7 | v3b's third currency | CAP-lab, measured in STU; STU itself stays a unit |
| 8 | Cause of the 400 errors in window 7 | Claude Code finds it before any fix is built |

Phase 3 decisions, also approved 11 Nov 2026: PROVIDER sells through standing offers; sweeps are a fixed dollar demand; arm B's rule is stated, checked and scored, never enforced; ISSUER-X uses D119's 80% floor and lists 15% below C1/C2; the DATA seller is the seventh scripted actor. Phase 3 report decisions (D144): the buffer is 1.5 USDC with its own validity gate; failed work stays refunded; claims paid for briefs go into escrow; claim transfers are excluded from the exchange denominator; the participant swap is dropped; PROVIDER's discount history is shown; low volatility is 0.6549% a day; the spend cap of $2 a window is an API-cost safety stop, not an agent limit; the board shows the buffer's draw and a shadow NAV, never a NAV that includes the buffer. D145: the roll uses pooled direct mint across issuers with headroom; capacity covers the largest reserve reached, with a 2× margin; a binding issuance limit makes a run invalid; sweeps sell AGU-lab first, then live claims, soonest-expiring first.

# Part 5 build plan: the CR economy

**Status: PROPOSED 2026-10-19, REVISED 2026-10-20 after your answers to Q1 to Q11 and your note splitting the issuer from the participant, and APPROVED 2026-10-20 WITH THREE CHANGES (§0), which are in. Nothing in it is built.** Written for you to approve or amend before any code, as the working agreement requires. The design it follows is `docs/marketplace_plan.md` §16.9 and decisions D76, D77, D82, D84, D86, D87, D92 and D111. Numbers marked _illustrative_ are placeholders for tests and development windows, not proposals.

## 0. Read this first

**Your answers are in** (§4.4): Q1, Q2, Q5(a), Q6 to Q9 and Q11 as recommended; **Q3 changed** (create at NAV, not at face), **Q4 changed** (seed once, carry tops up to a target, the rest to the issuer's income ledger and never into claims) and **Q10 changed** (the participant prices off NAV × print). Your note splitting the **AGU-lab issuer** (reserve, buffer, roll, NAV) from the **authorised participant** (its own wallet and USDC) is built in: separate wallets and ledgers, five tests that must fail loudly (§5), and a roll that ends every step at zero USDC.

**Approved on 2026-10-20 with three changes, all in this version:**

- **(a) AGU-lab is single-grade.** The reserve holds **Commodity-grade claims only**, and AGU-lab is priced at **NAV × the Commodity CR print**, never a mix of grades (your design decisions B2 and C11; I could not find them in this repository's docs, so I have followed your statement of them). R3, R5, §4.1 and the participant's prices say so.
- **(b) Two fixes your review asked for are rules and tests, not mentions.** **R11:** roll purchases follow C5, skipping issuers whose delivery ratio is below 0.8, with a way back, instead of first-fit. **R12:** the deadline warning fires for claims received through in-kind redemption. Each has a must-fail test (§5, tests 6 and 7). Before this revision neither was a rule: risk 4 _accepted_ first-fit, and risk 2 mentioned the warning for in-kind redemption only as something the boards would need.
- **(c) The four assumptions still open** (the fifth, which print prices AGU-lab, is settled by (a)) are listed in §4.4 for you to settle.

**What is open, and one thing that blocks:** the four assumptions (§4.4), and **a dependency I found while making change (a): with a Commodity-only reserve, the economy needs a Commodity CR print and Commodity issuers, and under §4.1 an issuer with no pass on any of the four task types has no cost per SIU and cannot issue. claude-haiku-4-5, the Commodity grade while we build on Anthropic only, has passed 0 of 24 on CR-VS, CR-PL and CR-SM in snapshot mode.** **The Haiku probe (plan D117, result D118) shows it is capability, not the way it is asked:** with a working field Haiku passed 1 of 20 and with extended thinking 2 of 20, where Sonnet passed 18 of 20 on the same prompts. So as things stand there is no Commodity CR print and no Commodity issuer, and WP0 cannot produce one (risk 10). **This needs your decision before contract code is worth writing.**

**Next, once you approve the revision:** the contract tests first, then `AguLab.sol` and the escrow, then the engine, then development windows on Haiku. The contracts and the engine can be built and tested with no model spend and no Blockworks access.

## 1. Where we start (checked 2026-10-19)

- **No Part 5 code exists.** Nothing in the repository mentions AGU-lab. There is no mandate, haircut, NAV, first-loss buffer, roll participant or shadow price anywhere in the lab.
- **The CR lab print and the issuers' measured rates are not built or defined in code** (D70 says the print comes from snapshot-mode results only). Part 5 needs both as inputs, so they are the first work package (WP0).
- **What can be adapted:** about 14,000 lines of lab and loop code (claim ledger, forward book, quotes, briefs, escrow service, reasoning capture, overview, tagging, the scale-slip checker), and four tested contracts: `WorkClaim`, `CapacityBond`, `ClaimRouter` and `TouchstoneEscrow`, with deploy scripts, a local `anvil` deployer and mocks.
- **What cannot be reused as it is:** the lab's engine (`runLab`) is built around four traders and the fSIU or USDC choice. The CR economy has different roles, so the engine is new code in `packages/cr-lab/src/economy/`, borrowing patterns, not importing the lab. Importing it would break the trial's key isolation (`CR_` names only, enforced by tests).
- **Already in cr-lab and reused as it is:** the tasks, instance generator, solvers and gates; the snapshot store and the fixtures backend; the fake MCP server at the live contract; the spend ledger and guard; the reasoning capture and tagging machinery of D107.

### What the existing escrow already does for us

`TouchstoneEscrow` needs no change for the AGU payments (D82). The buyer names a **settler** when funding, fixed forever. The gate-runner is that settler: on a passing gate it calls `settle(quoteHash, fullAmount, receiptRef)`, and on a failing one `settle(quoteHash, 0, receiptRef)`, which the contract treats as a legitimate full refund. So "payment on pass only" and "a failed brief pays nothing and may be re-commissioned" hold without waiting for expiry. Two facts I found reading it that shape the token: the escrow **rejects fee-on-transfer and rebasing tokens** (AGU-lab must be a plain ERC-20, with NAV floating through its reserve, never through balances), and `MIN_SETTLEMENT` is 100 base units, which is why I recommend **6 decimals** for AGU-lab (§4, Q2). With a settlement fee of zero the treasury address only has to be non-zero.

**Honest limit, carried from the escrow's own documentation:** the contract cannot verify the gate's verdict. The settler is trusted experiment code, and every settlement carries the snapshot hash and the verdict in its receipt so that anyone can recompute it.

## 2. Work packages and order

Order as you set it: **the AGU-lab contract and the escrow first, then the engine, then development windows on Haiku.** WP0 sits beside them because it needs only stored results and has no chain in it.

| WP   | What                                                                                                                                                                                                                                                                                                                                     | Needs                                                         | Days     | Tests                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------- | --------------------------------- |
| WP0  | The CR unit, the CR lab print and each issuer's measured rate and haircut, from snapshot-mode results (§4.1)                                                                                                                                                                                                                             | the live snapshot-mode runs of 17 to 19 October (in progress) | 1        | **mandatory** (print computation) |
| WP1  | `AguLab.sol`: rules R1 to R10 and R12's event (§4.3), your five must-fail-loudly tests first (§5), with unit, fuzz and invariant tests                                                                                                                                                                                                   | your answers (§4.4)                                           | 1.5 to 2 | **mandatory**                     |
| WP2  | The CR deployment: lab-publisher-bound `WorkClaim`, `CapacityBond`, the **eligibility router** (R11, a new contract beside `ClaimRouter`, which is not changed), `AguLab`, and a second `TouchstoneEscrow` over AguLab; deploy script, local deploy tests, deployments record                                                            | WP1, Q6                                                       | 0.5 to 1 | **mandatory**                     |
| WP3  | The settlement ledger: one interface, three implementations (memory, `anvil`, Base Sepolia); per-agent wallets, and separate wallets and ledgers for the reserve, the buffer, the issuer's income and the participant; gas funding                                                                                                       | WP2                                                           | 1        | memory and anvil                  |
| WP4  | The data service with its two backends and the labelled stand-in (§3.1)                                                                                                                                                                                                                                                                  | none                                                          | 0.5 to 1 | yes                               |
| WP5  | Engine core: parameters file, ordered log, receipts, window runner, seeds, seat rotation, display alternation, spend guards                                                                                                                                                                                                              | none                                                          | 1 to 1.5 | yes                               |
| WP6  | The roles in code: issuers (capacity, bond, haircut, issuance, X's failures, task work through a model and the gates), data agent, the AGU-lab issuer (reserve, buffer, income ledger, the roll and its front-claim sales), the authorised participant, hedger's book, mandates and needs schedules, brief assembly on one snapshot hash | WP3, WP4, WP5, WP0                                            | 2 to 2.5 | yes                               |
| WP7  | The model agents: prompts, reasoning-first action schema, strict parser, guards, the scale-slip check on every amount, the mirrored integer-versus-decimal sample                                                                                                                                                                        | WP5                                                           | 1        | yes                               |
| WP8  | Reports: the window overview (payments with each agent's own reason), NAV with and without the buffer's support, exit classification, the pre-registered measures, payment-scheme tagging                                                                                                                                                | WP6, WP7                                                      | 1        | yes                               |
| WP9  | Development windows DW0 to DW4 (§6)                                                                                                                                                                                                                                                                                                      | all above                                                     | 1 to 2   | the windows are the test          |
| WP10 | Pre-registration committed; first counted window                                                                                                                                                                                                                                                                                         | WP9                                                           | 0.5      | n/a                               |

**Total: 11 to 15 working days in sequence, 8 to 11 calendar days if the contract work (WP1 to WP3) and the engine work (WP4, WP5, WP7) overlap, which they can because they first meet in WP6.** That is a day or two longer than the estimate I gave you earlier, because WP0 was missing from it. Starting 20 October: **ready between 29 October and 1 November**, counted windows from 30 or 31 October. With the stand-in backend the number of counted windows is not capped by the end of Blockworks access, so seven stays reachable even if the extension is refused.

## 3. Interfaces

All money is **integer base units** (`bigint`) or decimal strings. No floats anywhere in money maths (invariant 4).

### 3.1 The data service: two backends from the start

```ts
export type DataBackendLabel = "snapshot" | "stand-in";

export interface DataService {
  /** Named on every receipt, log line and report. "stand-in" is never shown as provider data. */
  readonly backend: DataBackendLabel;
  readonly window: string;
  /** Hash of the day's data: the stored snapshot set, or the stand-in day's generated contents. */
  snapshotSha256(): string;
  /** What the task generators, solvers and gates read. The same type for both backends. */
  day(): DayData;
  /** What the data agent sells: one query result, priced at a declared shadow price in USDC only. */
  query(q: DataQuery): Promise<DataResult>;
}
```

- **`SnapshotService(window)`** reads the stored snapshot (private directory) and serves query results from it. It makes no Blockworks request.
- **`StandInService(seed)`** is built to the shape of the provider's API: the same datasets, series, pagination, lag and limits as the fake MCP server, which already follows the live contract. Its results carry `backend: "stand-in"`, and its day is generated from a seed that is published after the window, as for the task instances.
- The tasks, solvers and gates already take `DayData`, so **everything downstream is backend-agnostic**. A test runs the same window on both backends and checks that only the label and the hash differ.
- Licence: stored-snapshot results stay under `data/private/blockworks/`, and so does any log that contains them. Stand-in results contain no provider data, but the logs go to the private directory all the same.

### 3.2 The settlement ledger

```ts
export interface Ledger {
  readonly kind: "memory" | "anvil" | "base-sepolia";
  balanceOf(account: AccountId, asset: "AGU" | "USDC"): Promise<bigint>;
  transfer(args: { from: AccountId; to: AccountId; asset: "AGU" | "USDC"; amount: bigint; ref: string }): Promise<TxRef>;
  escrowOpen(args: { quoteHash: Hex; buyer: AccountId; seller: AccountId; maxAmount: bigint; expirySeconds: number }): Promise<TxRef>; // settler is always the gate-runner
  escrowSettle(args: { quoteHash: Hex; actualAmount: bigint; receiptRef: Hex }): Promise<TxRef>; // gate-runner only; 0 is a refund
  agu: { create(...): Promise<TxRef>; redeem(...): Promise<TxRef>; roll(...): Promise<TxRef> };
}
```

**Accounts.** Besides the agents there are four separated ledgers, each with its own wallet: the **reserve** (claims only, no USDC at rest), the **buffer** (USDC), the issuer's **income** ledger (USDC) and the **participant**. A transfer between any two of them is logged with both named (§3.4).

The memory ledger enforces the same conservation rules as the contracts, so scripted windows can run for free and fast, and a test runs one scripted window on memory and on `anvil` and compares the balances.

### 3.3 An agent's turn

Every model agent replies with one JSON object, **reasoning first** (the format the probe battery compared against an after-the-fact line):

```json
{
  "reasoning": "why, in a few sentences",
  "action": { "tool": "pay_for_brief", "args": { "...": "..." } }
}
```

The parser is strict: a reply that is not that object is a failed turn (logged, counted, never repaired). Tools are per role; the lab's tool set (`packages/gate-market-agents/src/tools`) is the pattern. No model is offered the data key, a wallet key or any contract call it has not been given a tool for.

### 3.4 The ordered log

One append-only JSONL file per window, in the private directory. Every entry has a gapless `seq`, the window, the round, the actor, the backend label and a `kind`:

`reasoning` · `message` · `quote` · `data-purchase` · `escrow-open` · `gate` · `escrow-settle` · `receipt` · `create` · `redeem` · `roll-sale` · `roll-buy` · `roll-cover` · `roll-carry` · `buffer` · `income` · `participant-sell` · `participant-buyback` · `sweep` · `nav` · `error`

An agent's `reasoning` entry is written **before** the entries for its action, so who said what to whom and why reads in one place. Messages and payments share the sequence. Payment reasoning is later tagged with the PAYMENT scheme of D107.

### 3.5 Parameters

One committed file, `data/lab/cr/economy-params.json`, holds every number the economy uses (rounds per window, mandate sizes, the spread, the roll discount, the buyback cap, the buffer's seed and target, the participant's starting USDC, the minimum tenor, shadow prices, the haircut rule, X's failure share, seeds for the stand-in). **It is committed before the first counted window and never edited after** (pre-registration, D87). Values used in development windows are labelled _illustrative_.

## 4. The unit, the parties, AGU-lab's rules, and your answers

_Revised 2026-10-20 after your answers to Q1 to Q11 and your note separating the issuer from the participant. Q3, Q4 and Q10 changed from my first recommendations; the others stand as recommended._

### 4.1 Q1 (settled, as recommended): the CR unit and the CR lab print (WP0)

D70 says the CR lab print comes from snapshot-mode results only, and D92 says issuance rests on each issuer's measured rate (accepted SIU per dollar). Neither was defined in code. Invariants 1, 4 and 6 apply: executed runs only, exact decimals, objective gates, no judge model.

- **One CR-SIU is one verified correct answer to each of the four CR task types** (the CR basket, versioned `SIU-CR-2026a`; CR-SM counts once, whichever dimension was drawn).
- **A model's cost per SIU** is, over a trailing window of days, the sum over the four task types of its billed cost on that type divided by its number of passes on that type. A task type with no pass in the window gives that model no cost per SIU, and **it cannot issue** until it has one.
- **The measured rate** (accepted SIU per dollar) is 1 divided by that cost per SIU.
- **The CR lab print** (USD per SIU) for a grade is the mean cost per SIU of the issuer models in that grade that have one; the grades are frontier and commodity, as `WorkClaim` knows them. Rounding happens once, at publication, half up, to nano-USD per SIU. List prices are never an input.
- **The haircut** is D92's: budget divided by one plus the 95th-percentile rise in that issuer's own cost per SIU between consecutive days, seeded from the calibration days. With three calibration days that is two day-to-day changes, which is crude; the report says so.
- **While we build on Anthropic only:** frontier is claude-sonnet-5 and commodity is claude-haiku-4-5 (D84).
- **AGU-lab uses the Commodity grade's print and nothing else** (change (a)). No blended print and no mean of grades is a settlement reference anywhere in Part 5; the Frontier print prices only what a Frontier issuer sells directly to agents.
- **A grade with no issuer that has a cost per SIU has no print.** Today that is Commodity: Haiku has no pass on three of the four task types (D115, D117). Until it has, there is no Commodity claim to issue, no AGU-lab to create and nothing to price it with; WP0 reports this rather than inventing a number.
- **Cost per SIU uses the headline cost** of the output-allowance rule (D113, and §4.5 below), so the print does not carry the cost of a cut-off first call.

### 4.2 The parties, their wallets and their ledgers

Your note splits the roll participant into two roles that never share money. Each has its own wallet and its own ledger, and **every movement between ledgers is a log entry**.

| Party                                                   | Holds                                                                                 | May                                                                                                                                                   | May never                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **AGU-lab issuer** (the contract and its operator code) | the **reserve**: **Commodity-grade** issuer claims only, no USDC at rest              | create AGU-lab against delivered claims, redeem in kind, run the roll, publish NAV with and without the buffer                                        | pay a redemption in USDC; hold USDC outside the roll step; draw on the participant                                                  |
| **The buffer** (its own wallet and ledger)              | USDC, seeded once by you                                                              | cover a roll shortfall, inside the roll step, first                                                                                                   | be paid out on a redemption; be touched by the participant                                                                          |
| **The issuer's income ledger** (its own wallet)         | USDC                                                                                  | receive positive carry above the buffer's target                                                                                                      | be spent into reserve claims                                                                                                        |
| **The authorised participant** (its own wallet)         | its own testnet USDC, funded once by you; AGU-lab it has bought back; claims it holds | create AGU-lab by delivering claims it bought from issuers; sell AGU-lab to agents; buy it back with its own USDC; redeem in kind what it bought back | trade beyond 10% of supply per window or beyond its own USDC (it refuses); fill a roll shortfall; draw on the reserve or the buffer |
| **Agents** (research, demand, hedger)                   | USDC (mandates) and AGU-lab                                                           | pay in AGU-lab through the escrow; buy the reserve's front claims for USDC                                                                            |                                                                                                                                     |
| **Issuers F, C1, C2, X; data agent; gate-runner**       | as in §16.9                                                                           | as in §16.9                                                                                                                                           |                                                                                                                                     |

**Dollar flows, stated honestly:** the only dollar costs inside the market are data, sweeps, **and the front-claim purchases in the roll** (your Q5(a)). The last is the roll cost the economy exists to measure.

**How an agent's front-claim purchase is classed in the exit taxonomy (your request of 2026-10-23, checked against D87 and §16.9).** The pre-registered taxonomy has five classes for an exit to USDC: sweep, dollar cost, price move, fear, other. It has **no class named "dollar route to work"**, so I could not confirm that name; what I can confirm is where the purchase falls. A front-claim purchase is paid in USDC and is a dollar cost inside the market (above), so **an exit made to fund one is a _dollar cost_**, and it counts with the benign classes under the thesis exactly as before. To make it visible, such an exit carries the sub-label **"dollar route to work"** in the reports (a sub-label of _dollar cost_, never a sixth class, so the pre-registered thesis and its 20% line are unchanged). The assignment is by link, not by the agent's stated reason: an exit followed in the same window by a front-claim purchase of that agent's, up to the amount exited, takes the sub-label; every other exit is classed from its reasoning tag as before. If you want it as a class of its own, that changes the wording of the thesis in D87 and needs your word before the first counted window.

### 4.3 AGU-lab: twelve rules (revised twice)

- **R1. Plain ERC-20, 6 decimals.** No fee, no rebase, no hook on transfer (the escrow rejects any token whose balances move by anything but the amount sent). At the first creation 1 SIU of face is 1 AGU-lab (1 mSIU of face is 1,000 base units); after that units follow NAV (R3).
- **R2. No admin path.** The issuer role and the participant are immutable addresses. There is no owner, pause, upgrade or sweep. Nothing moves a holder's tokens except the holder's own transfer, approve or redeem. A test reads the compiled ABI, as `NoAdminPath.t.sol` does for the escrow, and lists the only privileged functions.
- **R3. Creation at NAV (your change from face), Commodity claims only (change (a)).** The contract holds one immutable `commodityClassId` and refuses a lot of any other class. The participant delivers claims of face `F` (in SIU) and is minted `F × supply ÷ live face` units, rounded down. At the first creation, when there is no supply, 1 SIU of face is 1 AGU-lab. So **a creator pays exactly the reserve value per unit that existing holders hold**: no dilution when NAV is above 1, no overpayment when it is below. A lot with less than a minimum tenor left is refused.
- **R4. Redemption in kind, at NAV, pro rata.** Any holder burns `units` and receives `floor(units × lot balance ÷ supply)` of **every live reserve lot**. **Claims only: a redemption never pays USDC and never touches the buffer.** Rounding down leaves dust in the reserve, so nobody takes more than a pro rata share. Redemption is never paused or delayed, including around a roll.
- **R5. The roll is one step.** In a single on-chain call, the reserve (i) sells its front (current-window) claims to agents for USDC at the posted price, (ii) buys the next window's **Commodity** claims with the proceeds through `WorkClaim.mint`, the issuer picked by the **eligibility router** (R11), not by the reserve, and (iii) **ends the call holding exactly zero USDC**. The call reverts otherwise. Stray USDC inside the step (rounding dust, an unsolicited transfer) goes into claims. **Front claims that do not sell expire** (they were never presented, so there is no bond draw), and their face leaves the reserve.
- **R6. A roll shortfall is roll cost, never topped up from outside.** If the proceeds buy less than the face that was sold or that expired, the **buffer pays first**, buying next-window claims inside the same step to restore the face. When the buffer is empty the reserve simply buys fewer claims and **NAV falls**. Participant USDC never fills the gap, and redemptions are never delayed to cover it.
- **R7. Carry (your change).** Positive carry is the proceeds of the sale beyond the cost of replacing the face sold. It **tops the buffer up to its target; anything above the target goes to the issuer's own income ledger and never into reserve claims**, because carry left in the reserve would push NAV above 1 and give holders a yield, which C11 and D2 rule out (as you cite them; I could not find them in this repository's docs, so I have not checked the wording). The "leftover goes into claims" rule applies only to stray USDC inside one roll.
- **R8. Views and published NAV.** The contract exposes live face, supply, and the lot balances. **NAV is published every window, with and without the buffer's support:** reserve NAV is live face in SIU divided by supply, which the contract computes itself and which creation and redemption use; NAV with the buffer adds the buffer's USDC valued at the CR lab print.
- **R9. Supply moves only by `create` (up) and `redeem` (down).**
- **R10. Separate wallets and ledgers** for the reserve, the buffer, the income ledger and the participant, and every movement between them logged.
- **R11. Roll purchases follow C5, not first-fit (change (b)).** The router the roll buys through skips every issuer whose **delivery ratio is below 0.8**. _Delivery ratio_ is, over a trailing run of windows (a parameter, _illustrative_ five), the claims an issuer served divided by the claims presented to it, from the gate-runner's executed outcomes: exact decimals, exactly 0.8 is eligible. The router is `EligibleClaimRouter`, a new contract with the same `route` interface as `ClaimRouter` (which is not changed): it has one immutable publisher address (the lab key) that may set or clear an issuer's _skipped_ flag, nothing else, no admin path, and holds no funds. The flag is set and cleared by a published rule from published ratios, so anyone can recompute it. **The way back:** a skipped issuer gets no new claims, so it would have no new ratio to improve; therefore (i) each window one small _probe lot_ (a parameter, _illustrative_ at most 5% of the roll's purchases and one lot per skipped issuer) is offered to each skipped issuer, and (ii) it is cleared when its ratio over the trailing run, counting the probe lots, is at least 0.8 with at least three probes served (a parameter, _illustrative_ three). The point of the rule is the finding it answers: first-fit sends every claim to the earliest-registered issuer with headroom, whether or not anyone is behind it (`docs/fsiu-design.md` §5.3c).
- **R12. The deadline warning fires for claims received by in-kind redemption (change (b)).** A holder who redeems AGU-lab receives claims whose value turns on one action before one deadline (the presentation trap, `docs/fsiu-design.md` §4.3a). The contract's `Redeemed` event therefore names every lot received, its amount and its window end; the engine raises, for each, the same **arrival notice with the deadline** and the same **one-time lapse warning** that a bought claim gets, on the holder's board. A claim received this way and never presented lapses worthless like any other, and the log says it was warned.

**The participant's prices (your Q10 change).** It values one AGU-lab at **NAV × the Commodity CR print**, not at print and never a mix of grades, because an AGU-lab is worth NAV in SIU and not always 1. It **sells at NAV × print plus half the spread and buys back at NAV × print minus half the spread**, at most 10% of supply per window and at most its own USDC. When its USDC runs out it refuses; it never draws on the reserve.

### 4.4 Your answers, recorded

| #                 | Question                                      | Your answer                                                                                                                                                                                                                                                                                                              |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1                | The CR unit, print, measured rate and haircut | As recommended (§4.1).                                                                                                                                                                                                                                                                                                   |
| Q2                | Decimals and face mapping                     | As recommended: 6 decimals, 1 mSIU of face is 1,000 base units at the first creation.                                                                                                                                                                                                                                    |
| Q3                | What may back a creation                      | **Changed: create at the published NAV, not at face** (R3). Redemption likewise at NAV, in kind.                                                                                                                                                                                                                         |
| Q4                | The buffer                                    | **Changed: you seed it once; positive carry tops it up to its target; carry above the target goes to the issuer's own income ledger, not into claims** (R6, R7).                                                                                                                                                         |
| Q5                | The roll                                      | **(a)**: the reserve sells front claims to agents for USDC and buys the next window's in the same step, ending at zero USDC (R5).                                                                                                                                                                                        |
| Q6                | Chain, test dollar, keys, wallets             | As recommended.                                                                                                                                                                                                                                                                                                          |
| Q7                | What a brief is                               | As recommended.                                                                                                                                                                                                                                                                                                          |
| Q8                | Rounds per window                             | As recommended.                                                                                                                                                                                                                                                                                                          |
| Q9                | The numbers I will not invent                 | As recommended, plus the new ones (§3.5).                                                                                                                                                                                                                                                                                |
| Q10               | The participant                               | **As recommended, except it prices off NAV × print** (§4.3).                                                                                                                                                                                                                                                             |
| Review 2026-10-20 | The whole revision                            | **Approved with three changes:** (a) single-grade, Commodity only, priced at NAV × the Commodity CR print; (b) C5 routing with a delivery floor of 0.8 and a way back (R11), and the deadline warning for in-kind redemption (R12), each with a must-fail test; (c) the other four assumptions listed for you to settle. |
| Q11               | Enforcing zero reserve USDC                   | As recommended: the roll is one on-chain call that reverts unless the reserve's USDC is zero afterwards; redemption has no USDC path.                                                                                                                                                                                    |

**Assumptions I made where your answers were silent. Assumption 1 (which print prices AGU-lab) was settled by your review of 2026-10-20: the Commodity CR print. Assumptions 2 to 5 and the router default (agent purchases outside the roll keep the unchanged `ClaimRouter`) were APPROVED on 2026-10-23:**

1. ~~**Which print prices AGU-lab.**~~ _Settled by your review (a): NAV × the Commodity CR print; the reserve holds Commodity claims only._
2. **Which NAV creation and redemption use.** The contract can only compute reserve NAV (claims only) on its own. I use that for creation and redemption. The buffer defends it at 1 by paying shortfalls, so it is usually the same number as the buffer-supported one you publish.
3. **Who buys the front claims.** Agents holding a need that a claim can serve within the window, at the posted price: print × (1 − discount). The discount is a parameter (Q9). Nothing forces a sale.
4. **The income ledger** is a separate wallet owned by the issuer's operator (you).
5. **Carry is measured per roll** as proceeds minus the cost of replacing the face sold, in exact base units.

### 4.5 The output allowance (D113, your decision: C with B as the headline)

One rule, fixed in advance for every model: **each task's output allowance covers almost all observed outputs.** The headline cost per correct answer is the cost under that allowance (B). The print's method (A: a small allowance, then a billed cut-off first call and a retry) is reported beside it and both are disclosed. Because A's extra cost and its extra failures follow from the token counts, **A is derived from the same run, not run twice**; the derivation is stated in the report and tested.

## 5. Contract tests (written first, before the contract)

Contracts carry mandatory tests (working agreement). They are Foundry tests in `packages/contracts/test/`, written as the specification and failing until `AguLab.sol` exists. **Your five tests are first, named for what must never happen, and each fails loudly (a revert or a failed assertion with the rule in its message).**

**The five must-fail-loudly tests, and the two your review added**

1. `test_redemptionNeverPaysReserveUsdc`: across any sequence of creations, rolls and redemptions, a redemption changes the reserve's USDC by exactly zero and transfers no USDC to the redeemer; fuzzed, with defaults and donations in the mix.
2. `test_reserveHoldsNoUsdcOutsideTheRollStep`: the reserve's USDC balance is zero before and after every external call; a `roll` that would end with USDC reverts; an unsolicited transfer is swept into claims by the next roll and never sits through a redemption.
3. `test_participantRefusesBeyondCapOrOwnUsdc`: the participant's buyback beyond 10% of supply in a window refuses; beyond its own USDC refuses; **when its USDC runs out it refuses and the reserve's and the buffer's balances do not move.**
4. `test_bufferNeverPaidOnRedemption`: the buffer's balance is unchanged by every redemption and its only outflow is a roll's shortfall cover.
5. `test_rollShortfallOnlyFromBufferThenNav`: a shortfall is filled from the buffer first, then NAV falls; no balance of the participant, an agent or the income ledger is ever an input to the cover, and no redemption is delayed.
6. `test_rollSkipsIssuersBelowDeliveryFloor` (`EligibleClaimRouter.t.sol` and the roll): with two issuers both holding headroom, the one registered first and flagged skipped is never chosen by `route` or by a roll, whatever its headroom; an issuer exactly at 0.8 is not skipped; a skipped issuer is offered only its probe lot; once cleared it is chosen again in registration order among the eligible; only the publisher can set or clear a flag. **It must fail on first-fit**: the same scenario run on the unchanged `ClaimRouter` routes to the skipped issuer, and a test asserts exactly that, so the rule cannot be removed unnoticed.
7. `test_inKindRedemptionRaisesTheDeadlineWarning` (contract event, then engine): a redemption emits `Redeemed` naming every lot received with its amount and window end; the engine puts an arrival notice with the deadline on the holder's board for each, and a lapse warning fires exactly once, before the window ends, for each claim not yet presented; a claim received this way and left to lapse is logged as lapsed after the warning. **It must fail when the warning is removed from the redeem path.**

**`AguLab.t.sol`, unit tests**

- Construction: zero addresses revert; the issuer role, participant, claims contract and USDC are immutable.
- **Single grade:** `create` refuses a lot whose class is not `commodityClassId`; the roll buys only that class; a Frontier lot offered to either reverts with the rule in its message.
- **No admin path** (`NoAdminPathAguLab.t.sol`): the compiled ABI has no owner, pause, upgrade, sweep or setter; its privileged functions are exactly `create` (participant), and `roll` and the buffer and income functions (issuer role).
- **Creation at NAV:** the first creation mints 1 AGU-lab per SIU of face; later creations mint `F × supply ÷ live face`, rounded down; **per-unit reserve value is unchanged by a creation, when NAV is above 1 and when it is below, to within dust in holders' favour**; refuses a lot with too little tenor; refuses anyone but the participant.
- **Redemption:** claims only and pro rata, exact for one lot and for several; rounding down leaves dust and never overpays; **per-unit value is unchanged by a redemption**; two holders redeeming in turn receive the same value per unit, up to dust; zero units revert; redeeming the whole supply returns every live lot.
- **The roll step:** one call sells front lots to buyers for USDC, buys next-window lots through `WorkClaim.mint`, and ends at zero USDC; unsold lots expire (never presented, so no bond draw) and fall out of NAV; stray USDC inside the step goes into claims; the router picks the issuer.
- **The shortfall waterfall:** buffer first; then fewer claims bought and NAV falls; the participant's USDC balance is untouched by any roll.
- **The carry waterfall:** positive carry tops the buffer up to its target; above the target it goes to the income ledger; **reserve claims and reserve NAV are unchanged by carry**, so NAV never drifts above what the claims support.
- **The buffer:** separate from the reserve; filled by the seed and by carry only; paid out only as roll cover; never negative.
- ERC-20: exact-amount transfers, standard approve and transferFrom, 6 decimals, no hook, no rebase, and the escrow's balance-change check passes.
- Reentrancy: `WorkClaim` transfers call the ERC-1155 receiver, so `create`, `redeem` and `roll` are guarded and a reentrant receiver cannot extract value.

**`AguLab.invariant.t.sol`, fuzzed**

1. Per-unit reserve value changes through `create` and `redeem` only by dust, in existing holders' favour (non-dilution in both directions).
2. The reserve's USDC is zero at every call boundary.
3. The buffer's USDC changes only by the seed and carry (in) and roll cover (out).
4. The income ledger only ever receives.
5. Supply changes only through `create` (up) and `redeem` (down).
6. For every lot, the claims the contract holds equal its recorded reserve balance.
7. No holder's balance changes except by their own action or as the recipient of a `create`.

**Participant and ledger tests (engine level, memory ledger and `anvil`)**

- The participant sells at `NAV × print × (1 + s/2)` and buys back at `NAV × print × (1 − s/2)`, both from the same published NAV and the **Commodity** CR print (never a mix of grades), and the buy-back cap is counted in AGU-lab supply per window.
- Every movement between the reserve, the buffer, the income ledger and the participant is a log entry (kind and both ledgers named), and a ledger's balance equals the sum of its entries.

**`CrEscrow.t.sol`, the second escrow over AGU-lab (no contract change)**

- Open, settle in full on a pass, settle `0` as a full refund on a fail, and expire; the fee treasury receives nothing at zero fee.
- A non-zero settlement below `MIN_SETTLEMENT` reverts (documented, not hidden).
- The gate-runner is the recorded settler, and the settlement wrapper exposes `escrowSettle` to that role only. **The contract lets the seller settle too; the protection is that agents never hold keys and only harness code calls the contract, the same trust model as D82.** A test asserts the wrapper's surface.

**`DeployCrEconomy.t.sol`, local deployment**

- The script wires the lab-publisher-bound `WorkClaim`, `CapacityBond` and `ClaimRouter`, `AguLab`, the labelled test USDC and the second escrow; the publisher is the lab key and not the print's.
- A smoke run on `anvil`: an issuer opens a lot, the participant buys claims and creates AGU-lab, an agent pays through the escrow, a gate settles it, a holder redeems in kind, and a roll runs.
- `create` has **no dependency on any gate verdict or proof**, so verified-work proofs feed receipts and reputation and never supply (invariant 7).
- The new deployment record is added to `data/deployments/` and the deployments check (`docs:deployments:check`) passes.

## 6. Engine tests, and the development windows

**Engine tests (scripted agents, in-memory ledger, free)**

- **Determinism:** the same seed produces a byte-identical log.
- **Conservation:** over a window, AGU-lab and USDC totals are constant except through creation, redemption, data purchases, sweeps and the roll's sales; every ledger's balance equals the sum of its log entries.
- **Pay on pass:** a failing brief refunds in full; a brief passes only if every component passes on the same snapshot hash; a failed brief can be re-commissioned.
- **Mandates:** spending limit, holding ceiling, minimum USDC buffer and the sweep days are enforced.
- **Issuers:** issuance is the lower of deliverability and recoverability; headroom is respected; issuer X fails its published share, reproducibly from the seed.
- **The participant:** it prices off NAV × print, enforces the 10% cap and its own USDC, and refuses otherwise; it never touches the reserve or the buffer.
- **Delivery ratio and routing (R11):** the ratio is exact over the trailing windows from the gate-runner's outcomes; the 0.8 boundary; an issuer that fails its published share is skipped from the window after it falls below, reproducibly from the seed; a skipped issuer gets its probe lot and returns when cleared by the published rule; the roll never buys from a skipped issuer.
- **In-kind redemption notices (R12):** every claim a redemption delivers appears on the holder's board with its deadline, one lapse warning each, and the log distinguishes lapsed-after-warning from never-notified (which must not occur).
- **The roll:** every step ends with zero reserve USDC; unsold front claims expire and the loss is logged as roll cost; the buffer covers first; carry above the buffer's target reaches the income ledger and never the reserve.
- **Front-claim sales:** an agent buys only with a need a claim can serve within the window, at the posted price, in USDC, within its mandate.
- **Exit classification:** an exit to USDC followed in the same window by that agent's front-claim purchase, up to the amount exited, is classed _dollar cost_ with the sub-label _dollar route to work_, and counts as a dollar cost under the thesis; no other exit takes the sub-label; the reports show the sub-label's count apart.
- **The log:** gapless `seq`; reasoning precedes its action; every payment has a receipt carrying the snapshot hash, the task or brief id, the gate verdict and the AGU-lab amount.
- **Amounts:** the scale-slip check flags a thousandfold amount, and flagged decisions stay in every count.
- **The mirrored sample:** a seeded share of payment decisions is rendered a second time with amounts in decimal dollars; the mirror's answer is never executed; error rates are recorded for each rendering.
- **Both backends:** the same window on `snapshot` and on `stand-in` differs only in the label and the hash, and the label is on every receipt, log line and report.
- **Memory against `anvil`:** one scripted window gives the same balances on both ledgers.

**Development windows** (the windows are the test of the agents; each stops on its rules)

| Window | Agents               | Ledger                  | Data                                  | Spend                                       |
| ------ | -------------------- | ----------------------- | ------------------------------------- | ------------------------------------------- |
| DW0    | scripted             | memory                  | stand-in                              | none                                        |
| DW1    | scripted             | `anvil`, real contracts | stand-in                              | none                                        |
| DW2    | Haiku, three rounds  | `anvil`                 | stand-in                              | a fraction of a window                      |
| DW3    | Haiku, a full window | `anvil`                 | stand-in                              | about $1.13 (plan estimate, to be measured) |
| DW4    | Haiku, a full window | `anvil`                 | the stored 17 to 19 October snapshots | about $1.13 (to be measured)                |

- **Stop rules:** a per-window spend cap (a parameter), more than a fifth of at least twenty agent turns failing to parse, an invariant failing, or a budget refusal.
- **A development window passes** when all invariants hold, at least nine in ten agent turns parse, at least one brief passes end to end and one fails and refunds, AGU-lab is created, circulates at least two hops, is rolled and redeemed once, no amount is flagged and left unexamined, NAV is published with and without the buffer, and the cost is within one and a half times the estimate.
- **Counted windows start** after the first passing development window **and** the committed parameters file (§3.5).

## 7. Schedule (targets, not promises)

| Date              | Work                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tue 20 Oct        | Your answers (received 20 October) and your approval of this revision. WP0 starts from the 17 to 19 October results, on the headline cost of §4.5. The contract tests are written (§5). |
| Wed 21            | `AguLab.sol` to green; WP4 and WP5 begin in parallel.                                                                                                                                   |
| Thu 22            | WP2 (deployment, second escrow, eligibility router) and WP3 (ledgers).                                                                                                                  |
| Fri 23            | WP5 finished; WP6 begins.                                                                                                                                                               |
| Sat 24 and Sun 25 | WP6 and WP7 (the roles, the model agents). The earlier 24 October target is not met; it was a three-day estimate for a build that is eleven to fifteen.                                 |
| Mon 26            | WP8 (reports, tagging).                                                                                                                                                                 |
| Tue 27 and Wed 28 | DW0 to DW4.                                                                                                                                                                             |
| Thu 29            | Fixes; the parameters file committed (pre-registration).                                                                                                                                |
| Fri 30 Oct        | **First counted economy window**, running through the extension week.                                                                                                                   |

If a development window does not pass, the first counted window moves a day at a time. Because of the stand-in backend, windows are not capped by the end of Blockworks access.

## 8. Risks

1. **Agent behaviour is the largest unknown.** Models may ignore AGU-lab or sweep at once; that is a finding. A broken economy (unparsed turns, deadlocks, an escrow nobody settles) is not, and the development windows exist to find it before counting starts.
2. **The roll depends on agents buying front claims.** If few do, most of the front ladder expires each window, the buffer drains and NAV falls fast. That is the roll cost being measured, but a degenerate economy would teach nothing, so the development windows set the discount, and a scripted demand agent with a real mandate to buy near-dated claims belongs to the economy (never the participant, whose USDC never fills a gap).
   **Claims held by agents expire silently if never presented** (the presentation trap, `docs/fsiu-design.md` §4.3a): an agent that buys a front claim, or redeems AGU-lab in kind, holds claims whose value turns on one action before one deadline. Agents' boards need the arrival notice with the deadline and the one-time lapse warning the lab already has.
3. **Base Sepolia gas and funding.** Development stays on `anvil`; the deployer and agent wallets are funded once for counted windows, and the test USDC is minted, not fetched from a faucet.
4. **First-fit routing is replaced for the roll (R11).** `ClaimRouter` is first-fit over registration order, and `CapacityBond` cannot remove an issuer (the append-only routing finding, `docs/fsiu-design.md` §5.3c). The roll buys through `EligibleClaimRouter`, which skips issuers below a delivery ratio of 0.8. What is left: among eligible issuers it is still first-fit, so purchases concentrate in registration order; and the ratio comes from a handful of days at first (it is crude, and the report says how many days stand behind it). Agent purchases of work claims, outside the roll, still use whatever the economy's other flows use, which is `ClaimRouter` unchanged unless you say otherwise.
5. **The escrow lets the seller settle.** The protection is operational (agents never hold keys), and a test pins the wrapper's surface.
6. **One assumption carries weight (§4.4, number 2):** reserve NAV, not buffer-supported NAV, for creation and redemption. **The CR lab print and the haircut come from a handful of days.** That is the design you accepted; the report states how many days stand behind each figure.
7. **Time.** Eight to eleven calendar days with no spare. A lost day moves the first counted window a day.
8. **Licence after 30 October** is unknown; the stand-in is the answer.
9. **Weekend work.** The table assumes work on 24 and 25 October.
10. **The Commodity grade has no CR print yet (blocking, found making change (a); the Haiku probe, D118, shows it is capability).** Haiku has no cost per SIU, because it has passed no CR-VS, CR-PL or CR-SM answer as counted (and 2 of 9 on CR-PL with extended thinking); under §4.1 it cannot issue, so there is no Commodity claim for the reserve to hold. Working space does not fix it (1 and 2 of 20), and Sonnet passes the same prompts at 90%. The options are yours: a different Commodity issuer (another provider's small model, which needs a key and a budget the trial does not yet have, or the stand-in with a stated measured rate), a different grade definition (for example Commodity as a Sonnet setting with a smaller allowance, which is a different thing from a small model), or changing what the basket asks of the Commodity grade for the lab. I will not choose among them.

## 9. What happens next

On your approval of this revision I write the contract tests (§5) and start WP0, the same day. Nothing in this plan spends money or touches Blockworks until a development window with models (DW2), and each of those spends only under the existing ledger, the $9 daily cap and your standing rules.

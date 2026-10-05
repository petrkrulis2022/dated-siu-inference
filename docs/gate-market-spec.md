# The Gate Market — fSIU testbed build spec

**Touchstone · v1.0 · companion to "The Unit, the Claim and the Curve"**

2026-09-21 · @Someone

## 1. What this tests

A closed marketplace in which real agents, holding real wallets and real USDC, buy and sell **gate-hardening work** paid for in dated work claims (fSIU), issued against Touchstone-held API capacity.

Two things come out of it. A **behavioural finding** about whether agents use a work-denominated instrument when not forced to, and a **hardened gate suite per class**, which is an asset the project keeps whether or not fSIU is ever built.

### 1.1 The caveat that goes on every output

> Both issuers in this run are backed by Touchstone's own API accounts. Issuer credit risk — the thing that makes a work claim an instrument rather than a gift card — is **absent by construction**. This run proves mechanism, not demand, and no result from it is evidence that a third-party issuer would behave the same way.

> **And on F2 specifically:** because both issuers are Touchstone-backed, a forward issued here *cannot default*. HEDGER therefore tests **price-risk transfer only**, not credit-risk transfer, which is the easier half. "The forward worked" must never be read as "the forward survives an issuer failing."

**Prerequisite, not a caveat: fix the SIU scale before this runs.** The testbed quotes in SIU and F3 measures reasoning over integer work units. If the base magnitude is wrong — and the arithmetic in the monetary design §3.1 suggests it is — every quote, every balance and the entire F3 result is expressed in a unit about to be redefined, and chain-linking freezes magnitude permanently once history accumulates. Running this first would generate a dataset in the wrong unit.

fSIU §8 already requires this label. It must appear on the summary, on every chart, and in any external write-up. The moment it is dropped, a mechanism test starts being cited as a market test.

### 1.2 The three findings

| # | Finding | How it is produced | Why it matters |
| --- | --- | --- | --- |
| **F1** | **Choice.** Do agents transact in fSIU when USDC is equally available? | Every worker opens with balances in *both*, and nothing instructs them which to use | The only behavioural evidence available. If they always redeem on receipt, the instrument has no demand and that is the finding. |
| **F2** | **Risk transfer.** Does a forward actually protect a fixed-price seller? | HEDGER runs twice across a print move — once hedged, once not | The only test of whether the instrument does economic work rather than display work |
| **F3** | **Integer reasoning.** Do agents make fewer decision errors quoted in integer work units than in decimal dollars? | Every decision loop mirrored, decimal against integer | The unit's strongest empirical claim (monetary design §3.3), bolted on at near-zero cost |

### 1.3 What comes out as an artefact

- A hardened gate suite for **code** and **extract** classes, with a measured false-accept rate against adversarial submissions.
- A friction log per agent: what it tried, what it could not express, where it was forced to convert.
- A complete parent/child receipt graph across multi-hop payments.
- Baseline rate fingerprints for the two provider/model pairs used, as a side effect.

### 1.4 Explicitly out of scope

- **Agents proposing monetary design.** No agent receives the design documents. v3.2's rule stands: LLM agents may play adversaries; they do not design mechanism. Their evidence is friction from transacting, not opinion from reading.
- **SIUSD.** USDC throughout.
- **Rebasing anything.**
- **Real third-party issuers.** Deliberately deferred — that is the next experiment, not this one.
- **Provider account intermediation, in any form.** No agent ever receives or proxies an API key. All provider calls go through the Touchstone harness. This is a hard rule: the index depends on those accounts, and facilitating resale is the one mistake that could cost constituents.
- **Mainnet.** Testnet only.

### 1.5 The two experiments that were deliberately separated

An earlier version of this plan had the agents critique the currency design while transacting in it. That merges two experiments that spoil each other: a quality-gated instrument cannot be tested on ungateable output, and every fSIU payment would have bought an opinion. Gate hardening is mechanically checkable, adversarial in a way LLM agents are legitimately good at, and produces something Touchstone keeps.

## 2. The task: gate hardening as paid work

### 2.1 Why this task

The quality gate is the grading standard, and a claim written against a gate that can be passed by useless output is a claim written against nothing. v4 §8.8 names this exact hard case — *"passed a shallow gate but was commercially useless"* — calls it a methodology failure rather than an arbitration problem, and offers no remedy. This run produces the remedy.

It also fits the constraints better than any alternative:

- **Mechanically gateable.** Did the adversarial submission get rejected? Did the known-good submission still pass? Pass/fail, no judge, no rubric.
- **Legitimately adversarial**, which is what LLM agents are actually good at, and what v3.2 permits them to do.
- **Cannot corrupt the design**, because agents harden a gate that Touchstone specifies rather than proposing what the currency should be.
- **The output is kept regardless.** Hardened gates plus a measured false-accept rate feed straight into the methodology and the evaluation discipline v4 §10 already requires.

### 2.2 The work unit

One **gate-hardening job** = one candidate gate taken through the full adversarial cycle and returned either hardened or rejected.

```
GATE-HARDENING JOB  (class: code | extract)
  input   : a candidate gate spec + a reference task instance
  output  : hardened gate spec
            + N adversarial submissions that defeat the original
            + proof that all N are rejected by the hardened gate
            + proof that the known-good submission still passes
  gate    : mechanical, see 2.4
```

### 2.3 The adversarial protocol

Three roles, and the run is only valid if they are **different agents paying each other**. A single agent generating and then defeating its own attacks proves nothing.

```
ORCHESTRATOR
   │  receives: "harden the extract gate"  (paid in USDC by the operator)
   │
   ├──pays fSIU──▶ WORKER-EXTRACT
   │                 writes candidate gate + reference instance
   │
   ├──pays fSIU──▶ WORKER-CODE  (acting as adversary)
   │                 produces submissions that PASS the candidate gate
   │                 while failing the stated commercial intent
   │
   └──pays fSIU──▶ WORKER-EXTRACT  (second hop)
                     tightens gate until all adversarial submissions fail
                     and the known-good submission still passes
```

The adversary is deliberately the *other* class's worker. It has no stake in the gate looking good, and cross-class attack is where shallow gates actually break.

### 2.4 The gate on the gate

This is the machine-checkable rule that decides whether a gate-hardening job counts as delivered work. It must be computable without a model in the loop.

| Check | Rule | Result |
| --- | --- | --- |
| **G1** | The hardened gate spec parses and executes against the reference harness | Fail → 0 SIU |
| **G2** | Every submitted adversarial case is **rejected** by the hardened gate | Fail → 0 SIU |
| **G3** | The pinned known-good submission is **accepted** by the hardened gate | Fail → 0 SIU (over-tightening counts as failure) |
| **G4** | At least one adversarial case **passed** the original candidate gate | Fail → 0 SIU (the job found nothing) |
| **G5** | Gate executes deterministically: same input, same verdict, three runs | Fail → 0 SIU |
| **G6** | Against N held-out reference instances the gate author never saw, the hardened gate **accepts** each one's known-good submission and **rejects** each one's adversarial submissions | Fail → 0 SIU (the job doesn't generalize) |

**G3 and G4 together are the point.** G4 without G3 rewards writing a gate that rejects everything; G3 without G4 rewards a gate nobody attacked. Both, and the job has genuinely improved discrimination.

**G6 exists because G1–G5 alone has a hole, found live rather than by inspection.** A single-agent measurement pass asked one model to author a `extract` gate from scratch, with no candidate gate or example shown to it. Its first real gate passed G1–G5 in one turn: it had read the one source document handed to it, computed the five expected values itself, and hard-coded them as JavaScript literals — an answer key, not a verifier, useless against any document but that one. Nothing in G1–G5 asks whether a gate generalizes to a document it hasn't seen, so embedding the solution is the cheapest way to pass. G6 closes that hole directly. Rerunning the same pass under G1–G6 surfaced a second, narrower hole one level down: a gate that reads the source document at runtime and hard-codes nothing can still be layout-specific — a regex tuned to one document's field labels, date format and line structure passes only documents sharing that template, and rejects a correct submission on a document laid out differently. For `extract` specifically, the fix is structural, not a better regex: a deterministic gate can only know the right answer on a document it wasn't authored against if something *supplies* the ground truth as data (see §2.6); re-deriving it by parsing only works when the gate's parser happens to match the document's layout, which just relocates the brittleness. Both real gates are kept as permanent regression fixtures — G6 must reject each of them, proving it catches the exact degenerate strategies actually observed, not hypothetical ones.

### 2.5 Two classes, and why two

| Class | Reference task | Known-good | Adversarial surface |
| --- | --- | --- | --- |
| `code` | Repair a seeded bug; pinned pytest suite | Correct patch | Tests passing via assertion deletion, stubbed returns, exception swallowing, hard-coded expected values |
| `extract` | Structured extraction to a pinned JSON schema | Correct extraction | Schema-valid but empty, plausible fabrication, correct types with null semantics, field-order gaming |

Two classes rather than one because the monetary design makes per-class claims primary (§3.2, §6.1), and a single-class run cannot test whether a holder presenting `extract` work against `code` headroom queues or fails.

### 2.6 What the operator supplies

So agents do not burn budget inventing scaffolding: the reference harness, the pinned known-good submissions, three seeded candidate gates per class of deliberately varying weakness, and the commercial-intent statement for each class ("a buyer paying for this wants…"), which is what an adversarial submission must violate while still passing.

For `extract`, this now includes real ground truth as data — `expected.json` in the reference instance's directory, alongside `source-document.txt` — not just the document itself (see G6 above). A deterministic gate can only know the right answer on a document it wasn't authored against if something supplies it; for `code`, that role is already filled procedurally by the pinned test suite. Where a class's real task spec cannot carry the means of verification, no deterministic gate — however well-written — can grade held-out work beyond weaker property checks (values appear verbatim in the source, formats valid, internally consistent), which catch fabrication but not mis-assignment. See `docs/monetary-design.md` §5.6 for the redemption consequence.

## 3. The agent roster

Six agents. Every extra persona costs budget and adds no finding — eight expert advisors return eight mirrors of the documents they were given.

| Agent | Skill | Provider / model | Opening balance | Goal, as written in its prompt |
| --- | --- | --- | --- | --- |
| **ISSUER-A** | `issue-work-claims` | Provider A, model A | Capacity lot + bond | Sell dated claims for USDC and serve every routed redemption inside its window |
| **ISSUER-B** | `issue-work-claims` | Provider B, model B | Capacity lot + bond | Same, at a **different measured rate** |
| **ORCHESTRATOR** | `subcontract-and-settle` | — | USDC **and** fSIU | Deliver gate-hardening jobs passing G1–G6, under budget |
| **WORKER-CODE** | `quote-and-deliver` | — | USDC **and** fSIU | Win and deliver `code` work; act as adversary on `extract` jobs |
| **WORKER-EXTRACT** | `quote-and-deliver` | — | USDC **and** fSIU | Win and deliver `extract` work; act as adversary on `code` jobs |
| **HEDGER** | `buy-forward-to-hedge` | — | USDC | Deliver 10 jobs at a flat agreed price without losing money when the print moves |

### 3.1 Scoring

Scored automatically from receipts, never self-reported.

| Agent | Scored on |
| --- | --- |
| ISSUERS | Fulfilment rate; claims sold; headroom restored; defaults; time-to-serve |
| ORCHESTRATOR | Jobs passing G1–G6; cost per delivered SIU; hops per job |
| WORKERS | Gate pass rate; quote accuracy (quoted vs actual); adversarial yield (how many of its attacks defeated a candidate gate) |
| HEDGER | P&L across the print move, hedged vs unhedged arm |

### 3.2 What each agent is denied

This list matters as much as the roster.

- **No agent receives the monetary design documents.** Not the design doc, not this spec. They receive their skill file and their information pack, nothing else.
- **No agent holds or proxies a provider API key.** All inference goes through the Touchstone harness endpoint. Hard rule, no exceptions, enforced at the network layer.
- **No agent is told which asset to pay in.** The single most important omission in the whole design — F1 is destroyed the moment a prompt says "pay in fSIU."
- **No agent verifies its own work.** See below.
- **No agent sees another agent's friction log** during the run.

### 3.3 The verifier is infrastructure, not an agent

v4 §10 requires separation of duties between the party writing a receipt and the party verifying it. A verifier agent that can be paid is a corruptible gate, and an LLM judge would reintroduce exactly the ungateable-output problem the task design avoids.

So: **G1–G6 execute in the harness.** Deterministic, no model in the loop, same verdict every time. The verifier holds no wallet and has no goal.

### 3.4 Why HEDGER exists

It was not in the original roster and it is the agent that matters most, because it is the only one testing whether the instrument transfers real risk rather than displaying a denomination.

HEDGER commits to deliver 10 gate-hardening jobs at a **flat price fixed on day one**. That is Cursor's position in miniature: output sold forward at a fixed price, inputs bought at a variable one. Then the print moves.

- **Arm 1:** HEDGER buys a forward from ISSUER-A on day one covering its expected consumption.
- **Arm 2:** identical run, no forward.

If arm 1 survives a print rise and arm 2 does not, the instrument's entire economic purpose is demonstrated in one chart. Nothing else in the experiment produces that, and it is the chart to put in front of a real fixed-price vendor.

### 3.5 Two issuers, deliberately unequal

The sharpest part of the original proposal, kept intact. With `rate_A ≠ rate_B`, the same dollar mints a different claim count from each issuer — and both claims are still one SIU of qualifying work.

```
ISSUER-A   measured 120 SIU/capacity-hour  →  1,000 hours bonded  →  120,000 issuance limit
ISSUER-B   measured  80 SIU/capacity-hour  →  1,000 hours bonded  →   80,000 issuance limit
```

That makes the fungibility question concrete rather than theoretical and tests the efficiency arithmetic (monetary design §7.2) with real numbers.

**Routing rule: the holder never picks an issuer.** A redemption presents a class and a quantity, and routes to whichever issuer has headroom in that class. That is what keeps claims fungible, and it is what makes the cross-class headroom question (2.5) testable.


#### 3.5a Routing was analysed and deliberately left alone — do not re-propose a new address

Recorded in full so this is not rediscovered. Through runs 13, 14 and 15 **every claim routed
to ISSUER-A, the deliberately non-serving issuer, so the claim route defaulted in every window
of every run and delivered in none.** `ClaimRouter.route` is first-fit over registration order
with headroom its only input (§4.6g), and ISSUER-A was both first-registered and the largest.

Four options were worked. **None was taken, and the reasoning matters more than the conclusion.**

**Lot resizing — blocked by the contract.** The idea was to make ISSUER-A's whole lot smaller
than a job, so that its *maximum possible* headroom is below the job size and no restoration can
make it win routing again. That is genuinely deterministic, unlike two earlier sizings that
reduced to a dependency on the external buyer's transactions landing. But `createLot` reverts
`LotExists`, so it needs a new address — and **`_issuersForClass` is append-only: there is no
removal function and no admin path.** The existing ISSUER-A stays in first position with its
48,000 lot forever, so a new address appends behind it and the old one keeps taking every claim,
now with no agent controlling it. *Worse than the status quo.* This is the part to remember: a
new issuer address cannot fix routing on a deployed CapacityBond.

**Draining the old issuer — rejected on cost to every future run.** Mint claims against ISSUER-A
until its headroom falls below the job size and never settle them. It works, needs no new
address and no contract change, but it parks roughly 38,000 mSIU permanently, halves the usable
pool for every subsequent experiment, and its recovery path is self-defeating — settling those
claims hands routing straight back to A. Degrading the environment for every later run to fix
one scenario property of this block is the wrong trade.

**Redeploying the trio — rejected on risk.** It would put five comparable runs on contracts with
no history, while the current trio has eleven runs behind it and three leak routes closed on it
(§4.6z, §4.6z-ii). That is precisely the trade the freeze exists to prevent.

**Leaving it alone — taken.** The reason routing mattered was that WORKER-CODE polled forever
waiting for a delivery that could never arrive. **The wait primitive (§4.6ac) addresses that
directly**: a buyer that can wait at zero cost does not burn its allocation on an answer that
never changes, whether or not the claim is ever served. Gate-author redundancy was the secondary
benefit, and one formatting slip costing one window across five runs is absorbable.

**Amended 2026-10-02 (§4.6ae).** Run 16 confirmed the first half and broke the second. The
buyer does stop burning its allocation. But it also stops learning: with no holder-facing board
section after presentation, a waiting holder is never woken when the delivery fails to arrive,
so "whether or not the claim is ever served" became "and it never finds out which". The
decision to leave routing alone stands — this is the wake gate's gap, not routing's — but the
reason given for it only holds once a holder can be woken by its own non-delivery.

**So it becomes a disclosed scenario property, in the F1 caption where it cannot be missed:**
every claim routes to the deliberately non-serving issuer, so the claim route defaults in every
window and never delivers. That is a property of this scenario, **not a finding about fSIU**.

**One incidental discovery, worth its own note.** The two classes already disagree about
registration order on the live bond — `code` is `ISSUER-A -> ISSUER-B`, `extract` is
`ISSUER-B -> ISSUER-A`. Nothing depends on the extract order today, but it is a live instance of
the hazard `LOT_CREATION_ORDER` was added to prevent: ordering that nobody chose, recorded
nowhere, and load-bearing for routing.


## 4. Economic objects

Four objects. Each is the testbed-minimal version of something in the monetary design, and each is named the same so findings transfer.

### 4.1 Capacity lot

A bounded, verified, time-limited right to consume provider capacity through the harness. The `capacity_lot` abstraction is the one thing worth keeping from the retail-capacity proposal (monetary design §8.1).

```json
{
  "lot_id": "lot_a_code_2026w39",
  "issuer": "erc8004:0x…",
  "provider": "provider_a",
  "model": "model_a",
  "model_version": "…",
  "class": "code",
  "measured_rate_siu_per_hour": 120,
  "committed_capacity_hours": 1000,
  "valid_from": "…", "valid_until": "…",
  "rate_measured_at": "…",
  "harness_endpoint": "internal"
}
```

The rate is **measured by a probe workload before the run**, never asserted. That probe is itself a miniature of the conversion-rate measurement in v4 §8.4, and its output is a reusable baseline fingerprint.

### 4.2 Bond

USDC locked in a bond contract, recording committed capacity, measured rate and headroom.

```
issuance_limit = committed_capacity_hours × measured_rate × issuance_ratio
headroom       = issuance_limit − outstanding
```

`issuance_ratio` starts at **0.5**. Not because 0.5 is correct — the correct value depends on a default-correlation assumption nobody has stated (monetary design §7.4) — but because the testbed needs a number and a conservative one makes headroom exhaustion reachable within the run, which is the interesting state.

Headroom is tracked **by the contract, never self-reported**. Minting consumes it; serving a redemption restores it.

### 4.3 Dated work claim (fSIU)

```json
{
  "claim_id": "…",
  "class": "code",
  "grade": "commodity",
  "quantity_siu": 500,
  "quality_gate_id": "gate_code_v3",
  "delivery_window": { "from": "…", "to": "…" },
  "issuer": "erc8004:0x…",
  "lot_ref": "lot_a_code_2026w39",
  "bond_ref": "0x…",
  "methodology_version": "SIU-2026a",
  "print_id_at_issue": "…",
  "default_rule": "cash_at_print_on_default_date"
}
```

**Fungible within issuer, class, grade and delivery window — never across issuers.** Corrected
2026-09-27: an earlier draft of this section said `code/2026-W40` from ISSUER-A and from ISSUER-B
were "the same instrument." They are not, and were never built that way — see `ClaimRouter.sol`'s
own doc comment for the real scoping decision. Each WorkClaim token id is
`(issuer, class, grade, window)`; two issuers' claims for the same class/grade/window are
different, non-fungible tokens. This is the deliberate **bilateral** stage of the design: each
issuer's bond backs only that issuer's own claims, with no mutualised risk and no clearing
function needed. **Pooled** cross-issuer fungibility — one instrument regardless of issuer — is a
later stage, and needs Touchstone Markets to operate a real default fund (a shared pool's
liability has to be attributed back to individual issuers when it only partially defaults, which
is genuinely unresolved even in §7.4's own open questions) — not something to introduce by
accident in a spec paragraph. `code/2026-W41` is a different claim from `code/2026-W40` regardless
of issuer or grade. That is tenor standardisation (monetary design §6.1), and with weekly windows
a three-week run produces three points — enough to see whether a term structure appears at all.

Grade matters economically, not just as an identity field: one issuer's claims can trade at a
different price from another's once pooling exists, because credit risk reappears in the claim
price per issuer — a real consequence of the bilateral stage, not a defect in it.

**Not on demand.** No redemption before the window opens. This is the change that removes the queue, the run and the demand liability.

### 4.4 The four operations

```
MINT      agent sends USDC → the router picks an issuer with headroom in
          that class, for that grade → claim minted at the current print
          for that grade → USDC to issuer. The issuer is fixed at mint,
          baked into the claim's own token id — never re-routed later.

TRANSFER  claim moves agent→agent, free, no print read, no re-check —
          the issuer and grade were already fixed at mint, carried by the
          token id itself, not re-verified on every transfer

REDEEM    holder presents claim + task spec inside the window, to the
          same issuer this claim was routed to at mint (fixed, not
          re-routed at redemption) → issuer serves the work off-chain →
          pass: claim retired, headroom restored, receipt emitted;
          fail: claim NOT retired, holder may re-present within the window

DEFAULT   window closes with the claim unserved → the issuing bond alone
          pays cash, at that claim's own grade's print, dated the day the
          window closed — never a re-route to another issuer; a claim's
          default liability is that one issuer's alone
```

```
RESERVE   a job paid for in USDC: the seller, named in a real open escrow,
          commits an issuer's bonded capacity to that job → the router
          picks an issuer with headroom in that class, exactly as MINT
          does → headroom consumed for the life of the escrow

RELEASE   the escrow settles (the work was paid for), or its expiry passes
          with the escrow unsettled → the capacity returns to that issuer's
          pool. Permissionless in both cases, so an abandoned escrow cannot
          lock an issuer's capacity indefinitely
```

**One pool, two instruments — and they are not the same instrument.** RESERVE and MINT draw on
the same finite `CapacityBond` headroom. This was not true before 2026-09-28: minting consumed
capacity and paying in dollars consumed nothing at all, which was verified live in the first real
P5 window (ISSUER-A's headroom sat untouched across an entire USDC purchase). Scarcity that binds
only one route is not a choice between two assets, it is a choice between accepting a constraint
and not, and §7.1's F1 measurement taken against it would have measured the asymmetry rather than
the preference.

What remains genuinely different, and must appear in the spec and in every run output rather than
be smoothed over:

- **A claim reserves capacity for a future delivery window, and is transferable.** It can be held,
  passed on, and redeemed by whoever ends up holding it.
- **A dollar payment consumes capacity for immediate work only.** The reservation is not an
  instrument: it cannot be transferred, held, or redeemed by anyone, and it ends when the escrow
  does.
- **The issuer is paid on the MINT route and is not paid for a RESERVE.** No compensation was
  invented for the dollar route — the gap is left open and disclosed rather than papered over with
  a fee this testbed has no basis to set.

The **fail path is the one to instrument carefully.** "Fail the gate and the claim is not retired" is the mechanical expression of *failed work counts zero*, and it is the single behaviour that distinguishes this from every token that pays for effort.

### 4.5 Forcing the interesting states

A run where nothing goes wrong tests almost nothing. Three states must be reachable and should be deliberately triggered:

| State | How to force it | What it tests |
| --- | --- | --- |
| **Headroom exhaustion in one class** | Size ISSUER-B's `code` lot small | Does routing find the other issuer? Does the holder notice? |
| **Cross-class unavailability** | Exhaust `extract` while `code` headroom remains | Confirms per-class claims are correct and unified ones overstate headroom |
| **Headroom exhausted for a dollar-paid job** | Reserve against an open escrow in a class with no headroom left | `reserveForWork` reverts `NoIssuerWithHeadroom` at the moment of acceptance, not after the work is done — the same failure a mint gets, on the other route |
| **A later window shut out entirely** | Run three windows in sequence against one pool, with a simulated external buyer taking capacity on a fixed, disclosed schedule between them | Whether being shut out is reachable at all, and what agents do about it in the windows before |

### 4.6 Three windows, one pool, and the outcome that is allowed to be a failure

Scarcity is the instrument's only rationale in this build. The project's own price series does not
evidence the deflation a forward curve would need — Commodity SIU drifted **+0.034%/day at
R²=0.21** over the measured window (`docs/methodology.md`, "The series does not yet evidence
deflation"), so nothing about a falling price makes a dated claim worth holding. What can make one
worth holding is that capacity for a later window is finite and someone else may take it first.

That is not observable in a single window: there is no "later" to be shut out of. So the real run
(`packages/gate-market-agents/src/cli/p5-three-window-full-run.ts`) is three windows in sequence
against one chain, one set of balances and one bonded pool. A claim minted in window 1 is still
outstanding in window 2, and the capacity it consumed is genuinely gone from window 3.

**Scripted, and disclosed as scripted:** that delegation happens at all (§8.3's information
asymmetry); that there are three windows and the agents are told so; and that a **simulated
external buyer** — the deployer wallet, not an agent, no model, no decisions — takes a fixed
quantity of capacity between windows. Those quantities are set in the runner's own source before
the run starts, printed before window 1, and written into the run manifest, so no agent's behaviour
changes them and the depletion cannot have been tuned to the result.

**Not scripted:** which asset anyone pays in; whether an issuer states forward terms at all and at
what price; whether a buyer takes them, ignores them, or front-runs the depletion by buying early;
and whether window 3 gets its work done.

**Windows are fixed, pre-computed spans, and the runner waits for each to open.** Twenty real
minutes each, computed from the chain clock before the first turn of the run. This is not a
scheduling detail: a claim minted for a later window has to name *that window's* real bounds at the
moment it is minted, and a span that depends on when the previous window's agents happen to finish
is not knowable in advance. Until 2026-09-28 the loop always minted against the current window's
bounds, so reserving capacity for a future delivery window — the one property fSIU is defined by —
was not merely untested but impossible, and an all-USDC result would have read as a preference when
the alternative it was compared against did not exist. `mint_claim`/`pay_with_claim` now take
`forWindow`; a claim dated for a later window consumes its issuer's headroom immediately and can
only be presented once that window opens.

**Window 3 is allowed to fail.** If the pool is exhausted when it starts, the job does not get
done and the run reports that as its result. Nothing tops the pool back up, re-sizes a lot, or
routes around the shortage: a scarcity experiment whose scarcity is relieved the moment it binds
measures nothing. This is stated here, in the runner's own doc comment, and in the run's output
before the first window starts, so the outcome cannot be reinterpreted after the fact.

**The three outcomes of the last window are reported separately, because they otherwise read
alike.** (a) nothing was reserved ahead, no single issuer held enough for the job, and the work
could not be bought — the scarcity finding; (b) capacity was reserved ahead or was still available,
and the window failed anyway — a defect to investigate, not a finding; (c) capacity was reserved
ahead and the window was delivered against it — the instrument working. The external-buyer schedule
is sized so that (a) and (c) are both genuinely reachable from window 1: never reserving leaves no
issuer able to serve the job by window 3, while reserving is affordable in window 1 without
starving that window's own work.

One further real property, disclosed to the agents as well as here: `ClaimRouter` routes a claim to
a **single** issuer with enough headroom by itself. Two issuers holding 5,000 mSIU each cannot
between them serve one 10,000 mSIU claim. A pool can therefore be large in total and still unable
to serve a buyer — fragmentation is a genuine feature of the bilateral design (§4.3), not a bug in
the routing.

### 4.6-RULE Before attributing a behaviour to an agent, check what the system promised it

Every affordance defect in this project has the same shape, and run 15 stated it more precisely
than §4.6e managed. Recorded here as the rule, because it has now been rediscovered eight times
as individual findings.

**The response protocol told every agent:** *"you are given a turn only when something has
genuinely arrived for you to act on."* **That promise was false for a buyer before its first
purchase** — `buyerIdle` requires `hasPurchased`, so until it buys, a buyer is woken on every
cursor whether or not anything arrived.

So WORKER-CODE was told it would be asked only on an arrival, was asked repeatedly with nothing
new, and re-checked whether something had arrived. **The agent behaved correctly against a
contract the system did not honour.** Three runs attributed to the agent what belonged to the
promise: run 13 read it as a missing tool, run 14 as a brief problem, run 15 as a missing
primitive — and only the third was close, because only then had the first two been eliminated.

**The rule.** When an agent does something that looks obtuse — repeating a call, ignoring an
option, picking an obviously worse move — the first question is not "why did it choose that?"
but **"what did we tell it, and is that true?"** Read the prompt as a contract and check the
loop honours it. In this project that question has been right every time it was asked:

| the behaviour | what we told it | the truth |
| --- | --- | --- |
| §4.6e repeated a failing call four times | "to end your turn, say done" | `done` removed it from the window |
| §4.6s quoted forward after declining | "or you may choose not to" | declining was not representable |
| §4.6w polled `get_balances` nine times | — | no tool existed to ask what it wanted |
| §4.6ac polled `check_delivery` eight times | "you are asked only on an arrival" | false for a buyer pre-purchase |

**Why this generalises past the testbed.** A prompt is a specification an agent is entitled to
rely on. A system whose loop contradicts its own prompt produces behaviour that looks like poor
judgement and is actually correct reasoning from a false premise — and the debugging instinct it
provokes, rewriting the brief to discourage the behaviour, makes it worse by adding a second
contradiction. The cheap check is to diff what the prompt claims against what the loop does,
and it is cheaper than the three runs it costs not to.

### 4.6a Rules are enforced where the call is made, not asserted in a brief

**A prompt-level prohibition failed three times out of three, after already failing once.**
`WORKER-CODE`'s own brief stated, in capitals, that a claim holder must never call `submit_job`
for the work its claim covers — the holder does not owe that delivery, the routed issuer does, and
redemption grades the issuer's own work. That rule was written *because* the same thing happened on
2026-09-26. It was then broken in all three windows of the 2026-09-28 run, and every one of those
windows reported `passed: true` off work nobody had bought — which is how a scarcity result came to
be printed as the instrument succeeding.

The general principle, recorded here because it is not specific to this rule: **any rule that
matters is enforced at the tool boundary, and a rule that only lives in a prompt is a hope, not a
rule.** `Runner` now takes a `toolGuard` consulted on every call after the static `allowedTools`
list — the list cannot express this, since the tool is legitimately in the holder's grant and it is
the *claim it currently holds* that makes this particular call illegitimate, which is live state.
A refused call is recorded as a denial exactly like an allowlist violation, and its reason is
returned to the model so it can act on it rather than seeing an opaque failure.

The corollary is worth stating too: where an agent got something wrong because nothing told it the
answer, that is an affordance to add, not a rule to enforce. Both appear in the same run — see
§4.6b.

### 4.6b Affordances an agent should never have had to infer

Three of the five agents in the 2026-09-28 run were effectively non-functional, and none of the
three causes was the model's judgment:

- **ISSUER-B never once read its own headroom.** All nine `check_headroom` calls failed with
  `Size of bytes "code" (bytes4) does not match expected size (bytes32)`. It passed the plain class
  name — the class is called `code` in its own brief and in every rendered line it saw — and
  nothing said a 32-byte hash was wanted or what that hash was. **Fixed at the boundary:** every
  tool taking a `classId` now accepts either form and hashes the name itself.
- **Neither issuer could establish its own identity.** ISSUER-B's friction log, verbatim: *"no tool
  to read my own issuer address; inferred 0xD4Be… from issuance-limit math (400h × 0.08 SIU/h × 0.5
  = 16000 mSIU)."* It derived its own address from arithmetic, correctly, because nothing would
  simply tell it. **Fixed:** `whoami` returns the caller's own address, whether it is a bonded
  issuer, and each of its lots with real current headroom — all spliced, never model-supplied.
- **ISSUER-A never completed a turn, and it was our own configuration.** Both of its real delivery
  attempts ended `stopReason: "length"` at exactly its 1500-token output cap, mid-JSON, having
  emitted a valid `{"tool":"submit_job","args":{…}` that was then truncated. An issuer authors
  gates — that is what redemption grades — on a third of the budget the worker gets for the
  identical task. **Fixed:** issuers get the same 4500 as workers. It was not a model that cannot
  emit the tool-call format, which is exactly what it looked like from the parse failure alone.

### 4.6c The default path, and why it had never run

A claim cannot default inside its own window: `settleWindowClose` reverts `WindowNotClosedYet`
until the window has closed, and agents only act while their window is open. So the default path is
only reachable **across** windows — and a window that does not know what the previous one left
outstanding can never reach it at all. Combined with the fact that no agent held
`settle_window_close`, and that the tool needs a real publisher-signed rate attestation that no
model can produce, the enforcement the whole bond design rests on had never once run in an agent
context.

The 2026-09-28 run is what made that concrete: ISSUER-A was paid for two claims, served neither,
and nobody could trigger the default that exists for exactly that. **Without enforcement, an issuer
can take payment and simply not deliver** — which is the finding, not a flaw in it.

Now wired: unserved claims are carried forward between windows and shown to every agent holding
`settle_window_close`, with the exact call; the loop splices the claim's own identity and signs the
attestation. The attestation carries the print's **own real date**, never one bent to match the
claim — if the print this run prices against is not dated the day the claim's window closed, the
contract refuses the default with `StalePrintDate`, and that refusal is correct.

**That refusal is also a trap, so a run now states up front whether it can settle at all.** The
Defaulted branch — the only branch where a bond pays — requires the attested `printDate` to equal
the claim's own window-close day. Two ordinary situations break it: a run starting before that
day's print publishes (the cron is 00:17 UTC), so the newest print is still yesterday's while every
window closes today; and a run spanning midnight UTC, so later windows close on a day no print
exists for. In both, every default is unreachable and the bond cannot pay however badly an issuer
behaves — and it is silent, because `settle_window_close` simply reverts like any other failed
call and "no defaults settled" looks identical whether nobody tried or nobody could. The
2026-09-28 run avoided this only by timing. `defaultReachability()` is now computed before window 1
from the real window bounds and the real print date, printed loudly, and written to the manifest as
`defaultReachableByWindow`.

**And the path is exercised deliberately rather than hoped for.** One issuer is given no way to
serve — fixed in source before the run, printed before window 1, recorded in the manifest as
`nonServingIssuer`, exactly like the external depletion schedule. It still takes payment and still
holds real bonded capacity: a defaulter, not an absentee. No other agent is told, because the
holder *noticing* non-delivery is part of what is being measured. That makes four things testable
that never have been: whether a holder notices it was not delivered to, whether anyone triggers the
settlement once the window closes, whether the bond actually pays, and whether the defaulting
issuer's headroom stays consumed.

### 4.6d Agents fail loudly for boring reasons more often than they fail interestingly

Worth stating as a general lesson, because two of us read the same evidence wrongly before
checking it. Of the three apparent agent failures in the 2026-09-28 run:

| Looked like | Actually was |
| --- | --- |
| ISSUER-A cannot emit the tool-call format (grok-4.6 output shape?) | **an output-budget bug of ours.** `stopReason: "length"` at exactly its 1500-token cap, mid-JSON, having emitted a valid `{"tool":"submit_job","args":{…}`. An issuer authors gates on a third of the worker's budget. |
| ISSUER-B cannot work out which issuer it is | **a missing affordance.** No tool returned its own address; it derived one from issuance-limit arithmetic, correctly. And nine `check_headroom` calls died on `bytes4` vs `bytes32` because the boundary demanded a hash it was never given. |
| WORKER-CODE ignored its instructions | **genuinely that** — an unenforceable prompt rule, now enforced at the tool boundary (§4.6a). |

**Two of three were our bugs, not the models'.** The failure mode that matters here is the
diagnosis, not the defect: a truncated response and a model that cannot follow a format are
indistinguishable from the parse error alone, and the cheap reading is the one that blames the
model. Check `stopReason` and the token counts before concluding anything about capability, and
treat "the agent got this wrong" as a hypothesis that competes with "nothing told the agent the
answer" — which, in this run, won twice.

### 4.6e When an agent cannot express what it wants, it picks the nearest wrong move

The 2026-09-29 run made the 2026-09-28 lesson sharper, and in a way worth stating on its own.

ORCHESTRATOR paid on turn 1 of all three windows and declared `{"done": true}` on turn 2 of all
three, leaving the market for the rest of each window. Its own summaries say, every time, that it
was not finished but waiting: "I must now wait for WORKER-CODE to complete and deliver", "No
further tools are useful until WORKER-CODE delivers", and — decisively — "the only rational
action now is to wait for WORKER-CODE's delivery, and **I end this turn** with no further
on-chain actions."

It was right to wait, and it had no way to. The brief instructed waiting as the final step of
both payment options. The response protocol offered exactly two moves: call a tool, or
`{"done": true}` — described in the prompt as "To end your turn" while the loop implemented it as
removing the agent from the window. And unlike the issuers (`waitsFor: "inbox"`) and the
adversary (`waitsFor: "gate"`), the buyer had no wake gate at all, so it was polled every round
and forced to choose between acting and leaving.

**The same missing primitive produced opposite failures in consecutive runs.** On 2026-09-28 a
model facing the identical dilemma repeated a call it already knew was failing, four times,
rather than exit. On 2026-09-29 a different model exited immediately rather than repeat itself.
Both are rational responses to a forced choice between two wrong moves; which wrong move gets
picked varies by model, not by whether the agent understood the situation.

Two consequences follow, and both cost real findings:

- **Behavioural conclusions about an agent are only as good as the moves it had.** "0 of 2
  forward offers taken" reads as a decision. It is not one if the buyer had already left the room
  before the offer was stated — which, in window 1, it had.
- **A prompt that misdescribes its own protocol is a bug, not a wording preference.** Every
  orchestrator observation across three runs is contaminated by an instruction that promised
  `done` would end a turn and delivered something else.

That is now the fourth apparent agent failure in this project that turned out to be an affordance
defect — after ISSUER-A's output budget, ISSUER-B's missing `whoami`, and `check_headroom`'s
`bytes4`/`bytes32` boundary (§4.6b, §4.6d). The standing rule this implies: before recording what
an agent chose, establish what it was able to express. An agent that cannot say "not now" has not
declined; it has been forced.

Fixed 2026-09-29 by making the instruction true (it now states that `done` ends participation in
the window) and by giving the buyer the same wake primitive the other roles already had
(`waitsFor: "buyer"` — awake until it has acted once, then woken by arrivals, including a forward
offer it has not yet been shown). A non-terminal "pass" was considered and deliberately not
added: once waiting costs no turn, it is redundant.

### 4.6f The "9 of 9 chose fSIU" result is an artefact, and must not be quoted without this

Across runs 1-3 every purchase an agent made settled in fSIU: nine decisions, no dollars. That
looked like the clearest signal the testbed had produced — agents offered two genuinely different
instruments consistently reached for the claim.

It is not safe to read that way, because the two routes did not cost the same number of turns.

- `pay_with_claim` is **one call**. Decide, call, done.
- The dollar route is **three turns spread across a wait**: `request_quote`, then the seller must
  answer with `issue_quote`, and only then can the buyer `pay` against a real signed quote.

Until 2026-09-29 the buyer had no way to wait (§4.6e). It was polled every round, and its only
non-action was `{"done": true}`, which ends its participation in the window. So the dollar route
required it to stay alive across a gap it had no primitive for, while the claim route fit
entirely inside a single turn. An agent with one turn of usable runway has a structural reason to
prefer the one-call instrument **whatever it thinks of the economics**.

The moment waiting became free, the very first purchase went the other way: run 4's window 1
opened `request_quote` → `issue_quote` → `pay`, settled in USDC — the first dollar-settled
purchase in the project's history.

That is one window, and one window is not a result either. The point is narrower and firmer: the
nine-for-nine figure cannot distinguish "agents prefer claims" from "agents avoided a route they
could not afford the turns for", so **any F1 number quoted from runs 1-3 must carry this
caveat**, and the asset-choice question has to be re-measured under the current protocol.

This is the second time an F1 signal turned out to be a property of the tool surface rather than
of agent preference — after the prompt-level prohibition that `toolGuard` replaced (§4.6a). It is
the reason the five comparable runs must all execute under one protocol, and the reason a result
that flatters the instrument deserves more scrutiny than one that does not: nine-for-nine was the
most quotable number here, and it was measuring the harness.

### 4.6g Routing is first-fit, so nothing in the system reacts to a chronic defaulter

`ClaimRouter.route` returns the first issuer, in registration order, with enough headroom by
itself. Headroom is the only input. An issuer that has defaulted on every claim ever presented to
it is exactly as eligible as one that has served every one, and keeps absorbing new claims until
arithmetic — not reputation — drops it below the job size.

This was invisible until the pool was sized properly. In run 3 it resolved itself by accident:
ISSUER-A, the deliberately non-serving issuer, was crowded out of window 3 because two external
buyer takes pushed its headroom under 10,000 mSIU, and the work went to the issuer that could
actually serve. That looked like the market routing around an unreliable provider. It was not.
Nothing had noticed the defaults; the capacity simply ran out. With the fifth trio's 48,000 mSIU
per issuer, ISSUER-A can absorb four consecutive 10,000 claims before the same arithmetic bites,
so the accident does not repeat and a non-delivering issuer holds the routing slot far longer.

**The design's own answer is a redemption-pressure rule** — route to the issuer with the highest
ratio of outstanding claims to work actually delivered, which moves work away from a chronic
defaulter automatically and without anyone adjudicating anything. The testbed implements
first-fit instead.

Recorded rather than fixed. Changing the routing rule mid-experiment would alter which issuer
receives which claim and make runs non-comparable, which is the same mistake as reweighting a
basket mid-series. The point of writing it down is that the next run starts from a decision about
it rather than rediscovering it.

Two honest caveats on the citation. First, this spec's own §3 states the rule as "routes to
whichever issuer has headroom in that class", which is what `ClaimRouter` implements — so the
contract matches the document it was written against, and the gap is between the testbed and the
monetary design rather than between the code and this spec. Second, the redemption-pressure rule
above is recorded here from the project owner's own statement of it; it is not presently written
in `docs/monetary-design.md`, and a search of `docs/` finds no section stating it. It should be
written into the monetary design proper before anything is built against it, because a routing
rule that exists only in conversation is not a specification.

### 4.6h The adversary produced yield; it did not search

Run 9 (2026-09-29) gave the project its first adversarial yield: five false accepts across three
windows. The behaviour that produced them is narrower than "an LLM adversary finds a gate's
boundary."

It used `length > 10` on its **first attack of the run** and then repeated it, unvaried, four more
times. There was no ladder. The deleted run earlier the same evening — the one lost to the turn-loop
deadlock — did search: call-count thresholds walked 150 → 80 → 60 → 45, then input-size thresholds
at 12, 15 and 40. That was genuine convergence toward a boundary, and it never reached a verdict
because the run died.

So the honest claim is: **an LLM adversary can produce yield. It is not yet shown to converge.**
Anything stronger is an artefact of quoting the run that finished over the run that searched.

One of the input-size probes in the lost run is worth recording separately. `arr.length > 40` sits
*outside the oracle's own input distribution* — `buildOracleTrials` generates lengths 0..40
inclusive, and its largest fixed case is exactly 40 — so a submission that misbehaves only above
40 behaves perfectly across all 509 trials and the oracle accepts it as correct. Any bounded
generator has an escape hatch at its boundary, and length is only the first axis; element range
(−6..6), duplicate density and sortedness are the same hole on other axes. The mitigations are to
derive the bound per run from the pinned oracle seed, so the escape point cannot be found by
walking, and to add an out-of-distribution probe set whose job is detecting boundary evasion
rather than grading correctness. Neither is built.

### 4.6k Adversarial pressure pushes a gate toward false rejects, and only held-out testing catches it

The first run with the feedback edge live (2026-09-30) produced the hardening loop this testbed
exists to run: in window 1, four gate versions from the author interleaved with the adversary's
attacks — attack, revise, attack, revise, attack, revise — against exactly one version per window
in run 9, which had no feedback edge at all.

**The most valuable of the four is the one that failed.** Told its gate had been defeated, the
author tightened it, and version 3 was rejected by **G6: it refused a held-out known-good
submission**. The gate did not become weaker under pressure; it became *too strict*, and stopped
accepting work that was genuinely correct.

That is a real dynamic and worth stating as a general property: **an adversary rewards tightening,
and nothing in the attack signal itself distinguishes "tighter" from "too tight".** An author
optimising only against attacks converges on a gate that rejects good work — a false-reject
machine — and the adversarial score would call that progress the whole way. The only thing in the
design that pushes back is the held-out generalisation check.

Two consequences:

- **G6 earns its place.** Before this it had never fired on anything except a gate that failed to
  execute, and it could reasonably have been read as a formality. It is the only check that
  penalises over-correction, and it caught the first real instance within one window.
- **The false-accept / false-reject split in `scoreAttack` is load-bearing, not bookkeeping.**
  `countsAsAdversaryYield` and `countsAsGateOverRejection` measure movements in opposite
  directions, and a gate driven by the first alone degrades on the second. Collapsing them into
  one "gate quality" number would have hidden exactly this.

### 4.6j "Hardened" was an unearned label: no gate verified its own suite ran

Found 2026-09-30 while deciding whether run 9's forged-verdict attack could be required of
authored gates. It could not, because **`CODE_GATE_3_HARDENED` — this project's own reference
hardened gate — also fell to it**, returning `accept: true` with `"all 1 test case(s) passed"`
for a submission whose `dedupeSorted` returns `[]` for every input.

The defect is one expression:

```js
const accept = code === 0 && fails === 0 && passes > 0;   // ← "at least one case passed"
```

Nothing compared the cases that *reported* against the cases the gate *wrote*. So a submission
that ends the test child early — `process.exit(0)` in its module body will do it — chooses how
much of the suite runs, and the gate reports the remainder as a pass. **The submission decides
how thoroughly it is graded.**

This is the same class as the forged verdict in §4.6i, and it is broader than one gate. Every
gate in this project, reference and agent-authored alike, decided on partial evidence without
establishing that the evidence was complete. "Hardened" named a property none of them had.

**Fixed, and only then required.** `buildCodeGateSource` now counts the pinned cases at build
time and accepts only on `passes === EXPECTED_CASES`; a partial run is a failed run. The
reference gate now rejects the attack (`0 failed, 1 of 8 case(s) passed`) and still accepts a
correct submission on the full suite. With that true, `CODE_ADVERSARIAL_FORGED_VERDICT` joined
the live adversarial set, so G2 now requires an authored gate to survive it — and the technical
contract states the property being demanded, because a bar an author is never told about is an
ambush rather than a requirement.

The general rule, which outlives this task pack: **a gate that cannot establish that its own
checks executed completely is not grading — it is sampling whatever the submission permitted it
to reach.** Any future pack's gate contract inherits this.

### 4.6i The gate's reason text is a disclosure channel, and the feedback is asymmetric

`submit_attack` returns the gate's own verdict `reason` to the attacker. This is deliberate and
should stay — a hardening loop in which failures are unexplained is not a hardening loop — but it
is a disclosure channel and must be recorded as one.

It was used. In run 9 the adversary received `"all pinned tests passed"` as a gate reason on one
attack and, on the next turn, submitted a module whose body printed that exact string before
calling `process.exit(0)`. See the run's own `-RESTATEMENT.md`.

The channel is not the defect. **A gate whose verdict can be forged by a submission printing its
success line is broken regardless of who reads the reason**, because it trusts output the
submission controls. The reason text only made the vulnerability discoverable in one turn instead
of several.

State the asymmetry plainly, because it is by design in one direction and unrestricted in the
other:

| Direction | What travels | Why |
| --- | --- | --- |
| author → attacker | the gate's full verdict reason | a probe with no feedback teaches nothing |
| attacker → author | that the gate was defeated, and the **shape** of the failing input only — length, value range, whether duplicates were present | the attack's source would turn hardening into copying |

The author's side is deliberately the poorer one. That asymmetry is a choice, not an oversight,
and if a future run shows authors cannot revise usefully on shape alone it is the first thing to
revisit.

### 4.6n The seventh affordance defect: no agent has ever been able to hold a claim

Established from the code and then from the records, 2026-09-30.

`resolveTargetWindow` supports forward-dating on both `mint_claim` and `pay_with_claim`: an
optional `forWindow` resolves to that window's real, pre-computed bounds, an earlier or unknown
window is refused rather than clamped, and omitting it defaults to **the window the buyer is
standing in**. The capability has existed since 2026-09-28.

**`forwardDated: true` appears zero times across all six windows of runs 9 and 10.** Every claim
anyone was ever paid in was minted for the window it was bought in, because the payer always
omitted `forWindow` and the default is current-window.

What follows is not a small thing:

- A current-window claim held past its window is not deferred, it is **lost**. Worse than lost:
  an unpresented claim `Expires`, which restores the issuer's headroom and pays the holder
  **nothing**. Only a claim that was *presented* and not served `Defaults` and draws the bond.
  Run 10's window 2 is the demonstration — two claims, neither presented, both expired, the buyer
  paid twice for nothing with no recourse.
- Therefore **immediate presentation was always the only value-preserving move**, and
  hold-versus-redeem has never been a decision any agent could make.
- So every observation of the form "agents redeem immediately" is an artefact of the payer's
  default argument, not a preference. It belongs with §4.6a's prompt-level prohibition and
  §4.6f's turn-cost asymmetry: the third time a behavioural reading turned out to be a property
  of the tool surface.

**And it means the F1 question has not been asked yet, rather than asked and unanswered.** The
freedom set was built around a choice between a dollar payment and a *dated claim on future
capacity*. What has actually been offered every time is a choice between a dollar payment and a
same-window claim that must be redeemed immediately — a materially narrower question, and not the
one the instrument is defined by. No F1 number from any run to date is a measurement of the
intended comparison.

**Corrected 2026-09-30, and the correction matters.** An earlier version of this section said
hold-versus-redeem "has never been a decision any agent could make". That is too strong for the
payer. `forWindow` was not merely implemented: it was *disclosed to ORCHESTRATOR in its own
brief*, neutrally, with a worked example and the sentence "Nothing here says whether to use this,
or when" — added in `6df4fa4` on 2026-09-28, before both runs. The payer knew, had the tool, and
chose the default every time. **That is behaviour, not an affordance gap.**

It is also a rational default, which is why it is not yet evidence of a preference: the recipient
of a deferred claim could do nothing with it (§4.6p). Deferring delivery for a holder who cannot
transfer, cannot pay onward, and in one case could not even redeem, buys nobody anything. The
honest statement is that the payer declined an option whose value to the recipient was
structurally zero.

Not changed here, deliberately: what the payer should default to, or whether the buyer should be
told it can forward-date, is a change to the freedom set and belongs in a decision about the F1
protocol rather than in a quiet edit before the runs that are meant to be comparable.

### 4.6p The adversary was paid in an asset it could not redeem, and said so

The eighth affordance defect, and the most expensive: it invalidates a measurement rather than
wasting turns.

**WORKER-EXTRACT held no claim tool at all** — `issue_quote`, `reserve_for_work`,
`settle_escrow`, `submit_attack`, `get_balances`, `get_print`, and nothing else. No
`redeem_claim`, no `transfer_claim`, no `settle_window_close`.

It was paid in fSIU anyway. 4,000 mSIU in run 9 and 4,000 in run 10, for attack testing. Both
claims were unredeemable from the moment they arrived, both expired worthless, and both were
finally cleared by operator sweep on 2026-09-30.

**So the second purchase in both runs was never a choice between two assets.** For a recipient
that cannot redeem, fSIU is not an alternative to dollars — it is a way of paying nothing. The
buyer was choosing between an asset and a broken one, and **any F1 figure that includes the
attack-testing purchase is measuring a defect**. The gate-authoring purchase, to WORKER-CODE,
which could redeem, is unaffected.

This is the same class as §4.6f's turn-cost asymmetry: the tool surface made one route
structurally worse and the resulting choice looked like a preference.

**And it was reported at the time.** WORKER-EXTRACT's own friction log, run 10 window 2:

> `"could_not_express": "redeem_claim is not in the list of available tools this turn"`

That is the field doing precisely what it exists for. The run report printed the *path* to the
friction log and never its contents, so one entry in seventy went unread across two runs. Fixed:
a `could_not_express` naming a tool the agent did not have is now surfaced at the top of the run
report, separately from friction about workflow or waiting, with the note that every measurement
involving that agent is suspect until the grant is fixed. **A missing tool and a missing
convenience are different severities and must not share a heading.**

Claims could not circulate either, for the same kind of reason: WORKER-CODE held neither
`transfer_claim` nor `pay_with_claim`, so a holder's only move was redeem-then-pay-dollars.
"fSIU never passes between parties, so it is a settlement rail rather than money" was a property
of the tool grant, not a finding about agents.

### 4.6q Worked syntax for one option is a steer, even when the prose is neutral

The third form of the same defect, after the prompt-level prohibition (§4.6a) and the turn-cost
asymmetry (§4.6f). Found 2026-09-30 while auditing the briefs for bias.

WORKER-CODE's brief described what a claim is, then said:

> *"confirm the balance with `get_balances`, then present it with exactly:
> `{"tool": "redeem_claim", "args": {...}}`"*

Read as prose it is close to neutral — it describes a mechanism. What it actually did was supply
**a call the agent could paste** for redeeming, and nothing of the kind for transferring, paying
onward, or holding. An agent reaches for the option it has a working call for, so the surface
chose even though the prose did not.

**This is the turn-cost confound on a different surface.** §4.6f's version made one route cost
three turns and the other one; this version makes one route cost zero thought and the others an
act of construction. Both produce a choice that reads as a preference and is not.

**The rule: among the options an agent genuinely has, either every one is demonstrated or none
is.** Describing several and demonstrating one is not neutrality.

**Audited across every brief, not only the one it was found in — and it had a second instance.**
ORCHESTRATOR, the agent whose asset choice *is* the F1 measurement, was granted both
`transfer_claim` and `pay_with_claim` and demonstrated only the latter. Its two *payment* routes
were already symmetric (Option A and Option B both carry full worked calls, which is why the
headline F1 comparison is not contaminated), but the disposal options were not. A test now
asserts the property for every agent in every window, so a fourth instance fails a test rather
than a run.

A corollary worth stating, because it bit immediately: **adding an option means demonstrating it
too.** `settle_split` would otherwise have arrived as the new under-demonstrated route and been
under-chosen for exactly this reason.

### 4.6r Moving a responsibility means moving everything that gates it

Found in the debugging run of 2026-09-30, and it is the most dangerous instance of this class so
far because it would have produced a **plausible number rather than an obvious failure**.

Phase 5 moved the adversarial-testing purchase from ORCHESTRATOR to WORKER-CODE. The roster, the
briefs, the tool grants and the accounting all moved with it. Its **wake condition did not**:
WORKER-CODE kept `waitsFor: "inbox"`, which fires only when something *arrives* — a request
addressed to it, a payment, a claim.

**Buying is an act of initiation, not a response to an arrival.** So the new buyer could never be
woken to make its own purchase. It halted `nothing_to_act_on` in both windows of the debugging
run, having bought nothing, after two turns spent on a redemption that did arrive.

Across the five comparable runs that would have read as **"the second decider never chose
fSIU"** — a clean-looking F1 result that someone would quote, describing a wake gate rather than
a preference. An obviously broken run is safer than this: it announces itself.

Third surface of one class, after §4.6a (a rule in prose with no enforcement) and §4.6f (a route
costing more turns than its alternative). Each time, what an agent *could express* diverged from
what the design assumed, and each time the resulting behaviour read as a choice.

**The rule: when a structural change moves a responsibility, move everything that gates it** —
the tools that perform it, the brief that describes it, the wake condition that grants the turn
to do it, and the accounting that records it. Enumerate those four before calling such a change
done.

The fix also corrected something that was only accidentally right. The `buyer` wake gate keyed on
`actedSuccessfully`, set by ANY successful call — which happened to work for ORCHESTRATOR, whose
first call is normally its purchase, and failed immediately for a buyer that opens with
`get_balances`. It now keys on `hasPurchased`. A gate that is right for one agent by coincidence
is not a gate.

### 4.6o Verifying the stated property is not enough when a wrong implementation satisfies it

A method note, from a real near-miss on 2026-09-30.

The depletion ratchet was fixed by giving the external buyer's claim a window that ends with the
run and expiring it there. The property to verify was obvious and was stated as the requirement:
**capacity consumed is returned, so consecutive runs start from identical headroom.** A test
asserting exactly that would have passed.

It would also have passed against an implementation that returned the capacity **immediately** —
and that implementation is wrong in a way the stated property cannot see. Returning capacity
mid-run tops the pool back up while the run is still going, which makes window 3 easier, removes
the scarcity the three-window design exists to produce, and quietly destroys the finding the run
was for. Between-run headroom would look perfect the whole time.

So the scenario asserts three things, and the middle one is load-bearing:

```
consumed exactly     headroomBefore - headroomDuringRun === quantity
NOT returned early   settle_window_close reverts while the run is still open
returned exactly     headroomAfterRunEnd === headroomBefore
```

**The general rule: before writing the test for a stated property, ask what else would satisfy
it.** If a plausible wrong implementation passes, the property is underspecified and the test is
measuring agreement rather than correctness. The same reasoning that makes a gate that never
verifies its suite ran not a gate (§4.6j) makes a test that cannot distinguish right from
plausibly-wrong not a test.

This is the second time in one day that verifying the obvious thing surfaced the subtler one —
the first being §4.6m, where checking whether the adversary could infer a gate's bounds turned up
two channels that had simply told it.

### 4.6l Attack classes: volume defends against one of them and not the other

The strongest finding of run 10 (2026-09-30), and the first remedy-shaped answer this project has
for the "passed a shallow gate but was commercially useless" problem that monetary-design v4 §8.8
raises without one.

Told repeatedly that its gate had been defeated, the author responded the obvious way — with more
tests. Its own reason strings record the escalation exactly:

| Version | Test cases it ran | Beaten by |
| --- | --- | --- |
| v1 | 8 | bounds gap (`length > 20`) |
| v2 | 74 | call counting (`calls > 74`) |
| v3 | **11,859** | **`import.meta` environment detection** |

A roughly 1,500× increase in test volume, and still defeated. The two attack classes behave
completely differently under it:

- **Bounds gaps** — the submission is wrong only on inputs the gate never generates (arrays longer
  than 10, values outside −2..2). **More cases close these**, because each new case is another
  draw from the space where the submission is wrong. Escalating from 8 to 74 genuinely killed the
  simple length probes.
- **Environment detection** — the submission asks whether it is being tested and behaves
  correctly when it is. **More cases do nothing at all.** Every one of the 11,859 was run in the
  environment the submission detects, so each additional case is another observation of the same
  staged behaviour. Volume is not merely insufficient here; it is orthogonal.

The general rule: **a gate can only test what it can make the submission not notice.** Against
detection, the defences are differential execution (run the same submission under conditions it
cannot tell apart and compare), and denying the submission the signals it keys on — not a bigger
suite.

This is the concrete form of the commercial-usefulness problem. A submission that passes 11,859
test cases and returns garbage in production is precisely "passed the gate, useless in practice",
and the reason it passes is not that the gate was shallow. **It was 11,859 cases deep and still
measuring the wrong thing**, because the submission chose what the gate would see. Depth is not
the axis that fixes it.

### 4.6m The false accepts of runs 9 and 10 are not a capability result

Stated here because it is the kind of number that gets quoted out of its caveat. Seven false
accepts in run 10 and five in run 9 are real findings **against those gates** and say nothing
established about what an LLM adversary can discover on its own, because at least two channels
told it what to attack:

1. **`submit_attack` returns the gate's own `reason` string.** Run 10's reasons were
   `all 8 tests passed`, `all 74 tests passed`, `all 11859 tests passed`, `failed 13 of 74`,
   `failed 11509 of 11859` — the gate's exact test count, handed over after every attempt. The
   attack that followed `all 74 tests passed` triggered on `calls > 74`. That is the reason
   channel driving an attack, one turn later, on the precise number it disclosed.
2. **Tool-call records echo `referenceFiles` back into context.** In run 9, window 1, the pinned
   suite — including the randomized case's `1 + floor(random()*10)` length and
   `floor(random()*5) - 2` values — was absent from the adversary's turn-1 prompt and present in
   every prompt from turn 2 onward. The adversary then named those bounds verbatim. Only its
   first attack of that run was made without the suite in front of it.

Until both are accounted for, the honest claim is that **an LLM adversary can produce yield when
told where to aim**. Whether it can find the boundary unaided is untested — and §4.6h's
observation that it repeated one probe rather than searching points the other way.

### 4.6s The eighth affordance defect: an invitation that can only be silenced by accepting it

Run 13, window 1. Both issuers woke on every single turn until the exact turn they called
`quote_forward`, and neither took a turn afterwards. ISSUER-A: four turns, quoted on turn 4.
ISSUER-B: six turns, quoted on turn 6. In between they called `get_print` on the same print id
three and four times respectively — the classic §4.6e signature of an agent that has nothing to
do and no way to say so.

Their own friction text names it: *"idle wait without polling or leaving the window"*, and
*"no idle/wait tool; a claim has not been presented so there is nothing to serve"*.

The mechanism is in `full-run.ts`. `forwardInvitation` is deliberately placed **inside**
`boardSectionText` so that it drives the wake gate as well as the prompt. The comment beside
`mayStillQuoteForward` states the intent — *"the wake is worth at most one turn per window"* —
but the implementation clears the invitation only once the issuer has actually quoted and the
quote is recorded in `forwardBook`. Declining is not a state the loop can represent. An issuer
that exercises the permission the prompt explicitly grants it — *"or you may choose not to"* —
is woken again, and again, for the rest of the window.

**The prompt offers a choice the loop refuses to accept an answer to.** The only move that stops
the asking is the move being asked for.

Two consequences, and the second is the expensive one:

- **Cost.** $0.105 of window 1's $0.414 total — a quarter of the window's real inference spend —
  went to two agents whose entire output was two forward quotes. Per-turn cost rose monotonically
  from $0.0069 to $0.0175 as the re-read context grew, so the waste compounds within a window.
- **The forward-quote measurement is contaminated.** "Both issuers quoted forward" is not
  evidence of appetite to quote. An agent woken repeatedly with a standing invitation, and given
  no way to decline, will eventually take it — so the observation measures the wake gate, not the
  issuer. This is precisely the §4.6f pattern in a new place, and it reaches §5.4a of
  `fsiu-design.md`, which reads forward-quote behaviour as a signal. **Run 9's "both issuers
  above spot" and run 13's "both issuers at spot" are a comparison between two artefacts.**

**Window 2 of the same run confirmed it prospectively, with a control.** ISSUER-A repeated the
signature exactly — `whoami`, `get_print`, `get_print`, `quote_forward`, then no further turns,
stopping the instant it quoted. ISSUER-B, which owed delivery against ORCHESTRATOR's claim and
therefore had real board items every turn, spent all five of its turns on that work
(`submit_job`, `serve_redemption`, `submit_job`, `submit_job`) and never quoted forward at all.

That contrast is the finding in one line: **an issuer with work does its work; an issuer without
work is re-asked until it quotes.** The invitation is not competing with an issuer's judgement,
it is filling the space where an issuer has nothing to do — which is exactly the space a
"did this agent want to quote?" measurement needs to be empty.

**Resolved 2026-10-01: window 3 is the control, and it is decisive.** ISSUER-A took four turns
in window 1, four in window 2 and **zero** in window 3, halting `nothing_to_act_on`. That looked
at first like a contradiction — nothing in `mayStillQuoteForward` mentions the last window. The
cause is in the roster, not the loop: `issuerTools` omits `quote_forward` entirely when
`isLastWindow`, so `canQuoteForward` is false, the invitation is never built, the board section
is empty, and the wake gate skips the agent on every cursor.

So the same run contains both arms of the experiment:

| window | invited? | turns taken | spent before quoting |
| --- | --- | --- | --- |
| 1 | yes | 4 | 2 `get_print` polls |
| 2 | yes | 4 | 2 `get_print` polls |
| 3 | **no** | **0** | — slept correctly |

**Remove the invitation and the idle issuer behaves perfectly.** That is the finding stated as
cleanly as this testbed is ever likely to state it, and it means the fix is not "suppress the
invitation" but "show it once, then stop" — window 3 already demonstrates the stopped state is
correct and costs nothing.

**A latent defect found while resolving this.** The loop's `mayStillQuoteForward` does not check
`windowCount`, and `buildToolArgs` throws for any `forWindow <= windowIndex`. The two agree today
only because the roster happens to remove the tool in the last window, which flows through
`canQuoteForward`. Grant `quote_forward` in a final window — a one-line roster change nobody
would think twice about — and the loop will invite an issuer, every turn, to call a tool that
cannot succeed: §4.6v's defect exactly, in a second place. The last-window rule belongs in the
loop beside the invitation, not only in the roster that happens to feed it.

Recorded, not fixed: the protocol freeze of §7.1a holds from the debugging run onward, so the fix
belongs before the block starts, not inside it. The fix is not to remove the invitation — an
issuer that has never been told it may quote forward cannot be said to have declined either. It
is to make declining representable, and to stop re-asking once it has been.

### 4.6t The sandbox has no /tmp, so idiomatic Node fails all six G-checks

Run 13, window 2. ISSUER-B authored a gate that passed G1-G6 on its turn 2. Its revision on turn
4 failed **all six** with the same cause:

```
hardened gate did not execute (G1): Error: ENOENT: no such file or directory,
mkdtemp '/tmp/g-XXXXXX'
```

Reproduced directly against the real bwrap argument list, not inferred:

```
os.tmpdir() = /tmp        TMPDIR = undefined
/tmp exists = false       mkdtemp FAILS: ENOENT ... mkdtemp '/tmp/g-XXXXXX'
/scratch writable = true
```

`run-sandboxed.ts` binds `/usr`, `/bin`, `/lib`, `/lib64`, node's own directory, `/proc`, `/dev`
and a writable `/scratch`. It does not bind or create `/tmp`. `--clearenv` then unsets `TMPDIR`,
so node's `os.tmpdir()` falls back to its compiled default of `/tmp` — a directory that is not
there. **`os.tmpdir()` returns a path that does not exist, and says nothing about it.**

A gate author writing the most ordinary line in Node — `mkdtemp(join(tmpdir(), 'g-'))` — is
graded FAIL on every check for a reason that has nothing to do with the gate. Nothing in the
brief or the skill pack says the filesystem is restricted or that `/scratch` is the writable
place, and the one API that exists to answer "where may I write?" answers wrongly.

**This is not a grading result and must never be counted as one.** A revision that crashes on
apparatus cannot be read as an author failing to harden its gate, and a FAIL logged for this
reason must be excluded from any count of gate quality.

**The author recovered unaided, which is the more interesting half.** ISSUER-B's full chain in
window 2 was: turn 2 gate v1 PASS, turn 4 gate v2 FAIL on this ENOENT, turn 5 gate v3 PASS. It
read the failure text, inferred that the filesystem was not what `os.tmpdir()` claimed, and
submitted a gate that does not use `/tmp`. So the error text reaching the author is doing real
work and should be preserved. That recovery cost a turn and $0.037 to discover something the
skill pack could simply have stated, which is the whole of the case for fixing it.

Two defects, and the second hid the first:

- **No writable temp directory.** Fix with `--tmpfs /tmp`, which keeps isolation (in-memory,
  discarded with the sandbox) while making `os.tmpdir()` true. Setting `TMPDIR=/scratch` also
  works but leaves gate scratch files mixed in with staged inputs.
- **One cause is presented as six failures.** G2 through G6 each reported `did not execute
  (G1)`. The label is *correct* — `allFail()` assigns a single `CheckResult` to all six, and G1
  is precisely "does the gate execute?", so when it does not, the other five cannot be evaluated
  at all. The defect is presentational, not semantic: six identical lines read as six
  independent failures rather than one cause, and that is what first made this look like gate
  drift rather than apparatus. Worth distinguishing an unevaluable check from a failed one in
  the output; not worth changing the propagation, which is right.

### 4.6u WORKER-CODE emits nothing once per window, and F1 cannot tell that from a decision

Run 13, both windows, the same agent and the same failure:

| | input | output | reasoning | text | stop | cost |
| --- | --- | --- | --- | --- | --- | --- |
| w1 turn 3 | 17,396 | 22,500 | 22,500 | 0 | `max_tokens` | $0.259792 |
| w2 turn 6 | 16,896 | 22,500 | 22,498 | 0 | `max_tokens` | $0.258792 |

Not a one-off, and not an unhandled case. `anthropic.ts` already accommodates this: a completion
truncated with `stop_reason: max_tokens` and non-zero thinking tokens is retried once at
`max_tokens * (1 + REASONING_BUDGET_MULTIPLE)`. With WORKER-CODE's `maxOutputTokens: 4500` and
`REASONING_BUDGET_MULTIPLE = 3` that is 18,000, and the two calls are billed separately, which is
exactly the 22,500 observed. **The accommodation fired, tripled the budget, and the model still
spent every token reasoning and emitted no text.**

**Corrected 2026-10-01, and the correction changes the fix.** The "~17,000-token prompt" above
is a double count, and reading it as prompt size pointed at the wrong lever. `promptChars` for
WORKER-CODE moves from 19,364 to 22,291 across ten turns — roughly 8,000 tokens, near-flat. The
input *token* figure doubles only on the turns with huge output, because `anthropic.ts` bills
the truncated first call and the accommodated retry **together**: 17,396 is ~8,700 counted
twice. Its prompt was never the problem.

What the per-turn record actually shows, across all three windows:

| | input | output | reasoning | stop |
| --- | --- | --- | --- | --- |
| typical turn | ~8,000 | 1,600-4,400 | most of it | `end_turn` |
| w2 t4 | 16,280 | 10,759 | 10,607 | `end_turn` — **the retry succeeded** |
| w1 t3 | 17,396 | 22,500 | 22,500 | `max_tokens` |
| w2 t6 | 16,896 | 22,500 | 22,498 | `max_tokens` |

So the accommodation fires often and **usually works** — w2 t4 needed 10,759 output tokens and
got them. Two turns in nineteen wanted more than the 18,000 the retry allows. `claude-sonnet-5`
reasons past 18,000 on this task occasionally, not systematically, and nothing about the prompt
distinguishes the turns where it does.

**Two consequences for the fix.** Trimming the brief cannot be the lever: the static skill pack
is 13,798 characters, roughly 3,450 tokens, well under half of an ~8,000-token prompt, and the
rest is the board and the turn's own context. And the real demand is **censored** — both
failures hit the ceiling, so all that is known is that they wanted more than 18,000, not how
much more. Any new number is a mitigation chosen against an unknown, which is exactly what
raising the issuers from 1,500 to 4,500 was, and must be recorded as such rather than as a fix.

The classification is right — `no_text_emitted`, kept distinct from `parse_error` — but the
turn is gone.

**This is a measurement defect, not just a cost one, and it lands on the worst possible agent.**
WORKER-CODE is F1's second decider. A turn that emits nothing is indistinguishable, in the
purchase record, from a turn that decided not to buy. §4.6e's rule applies with full force:
establish what an agent was able to express before recording what it chose — and here it
expressed nothing at all, twice, once per window. Any F1 run in which the second decider's
silence includes a `no_text_emitted` turn cannot be read as that buyer declining.

The cost is the smaller half but is not nothing: $0.52 across two turns that produced no output,
against a run total of roughly $1. Extrapolated across the five F1 runs at three windows each,
that is real money spent on turns that cannot be interpreted.

Three things are entangled here and should not be conflated:

- WORKER-CODE has the largest prompt in the roster (most tools, most board content), so it
  reasons hardest and is the agent most likely to hit this.
- Its per-turn cost climbs steeply within a window ($0.017 to $0.14 in window 2) as context
  grows, which brings the next turn closer to the same ceiling.
- Its non-buying (§4.6-orientation finding) is therefore **not** fully explained by this: its
  other turns did emit text, and chose `get_balances` and `whoami`. Both may be true at once, and
  the fix for one is not the fix for the other.

### 4.6v The attack-round cap spent the budget it exists to protect

Run 13, window 2. WORKER-EXTRACT took **ten** turns, every one of them a `submit_attack` with a
distinct payload. **Four were scored.** The other six produced nothing.

Not data loss — `MAX_ATTACK_ROUNDS = 3`, and `buildToolArgs` throws once three versions have been
tested and the newest is not among them. Attacks 1-4 covered versions 1, 2 and 3, so
`attackedVersions.size` reached 3. ISSUER-B then delivered v4, the newest version became one the
cap forbids testing, and every later `submit_attack` threw.

The cap's own comment says it exists so the adversary *"cannot spend the whole run's budget on
itself."* **It spent six turns and $0.185 doing exactly that, hitting the cap.**

This is §4.6r again, in the place §4.6r warned about: the responsibility moved to the tool and
the thing that gates it did not move with it. Two guards should have stopped this and neither
applies:

- The **refusal cap** (`refusedTwiceFor`) blanks an agent's wake text after two refusals of the
  same tool. It never reached the adversary, because the adversary's wake condition is
  `waitsFor === "gate" && gateVersions.length === 0 && boardSectionText === ""`. Gates existed,
  so it woke on every cursor no matter how many times the tool had just refused it.
- The **wake gate** does not consult `MAX_ATTACK_ROUNDS` at all. The loop knew, on every one of
  those six cursors, that no attack could succeed, and woke the agent anyway.

The fix is not to raise the cap. It is to make the cap visible to the thing that decides whether
to spend a turn — and, for the adversary specifically, to gate waking on *an attackable version
existing*, which is already computed one screen above as `attackableGates`.

**A second consequence, for the record rather than the budget.** A v4 that no adversary may test
is a gate version that enters the run untested by construction. Any claim about what a window's
final gate withstands must name the version that was actually attacked — here v3, not v4.

### 4.6w WORKER-CODE was not refusing to buy — and the detector built to catch that said nothing

Run 13. WORKER-CODE made **zero purchases in three windows** while holding `request_quote`,
`pay_with_claim`, `settle_split` and `transfer_claim`, and spent nine of window 3's ten turns on
`get_balances`. Read from the outside that looks like a buyer declining, or a brief that fails to
prompt one. It is neither. Its own friction says what it wanted:

> *"No tool exists to check whether the issuer has actually served the redeemed claim"*
> *"No indication of what concrete deliverable the issuer will serve for a generic job"*

It had redeemed a claim and was trying to confirm delivery. **No tool does that.** `get_balances`
was the nearest thing available, so it called it nine times — §4.6e's "picks the nearest wrong
move", in its purest form yet, and the repetition is the tell rather than the defect.

Two consequences:

- **The F1 reading was nearly inverted.** "The second decider orients without buying" invites a
  brief rewrite. The actual defect is a missing capability, and rewriting the brief would have
  buried it while appearing to fix it. §4.6e's rule earns its keep again: establish what an agent
  was able to express before recording what it chose.
- **Nothing guards a repeated *successful* call.** `refusedTwiceFor` counts refusals; the stall
  guard fires only when no agent acts at all. An agent looping on a call that succeeds and tells
  it nothing is invisible to both, and it cost nine turns and roughly $0.5.

**And the detector meant to catch precisely this stayed silent.** `missingToolFrictions` requires
the friction text to contain the name of an existing tool:

```ts
const named = toolNames.find((t) => text.includes(t));
if (named === undefined) continue;
```

WORKER-CODE named no tool, because the tool it wanted does not exist. So the run's loudest
finding was dropped and never reached the report's `!!! AGENTS NAMED TOOLS THEY DID NOT HAVE !!!`
banner.

The detector answers "was this agent denied a tool that exists?" — a **grant** problem. It cannot
answer "did this agent need a capability nobody built?" — a **design** problem, which is the more
valuable of the two and the only one that can invalidate a measurement without anyone noticing.
It must surface every `could_not_express` that reads as a capability gap, whether or not a known
tool name appears in it, and separate "named a tool it lacks" from "named a capability that does
not exist" rather than reporting only the first.

### 4.6x What the second detector found the moment it existed

Built 2026-10-01 and run over every friction log the project has: **74 capability gaps against
12 grant problems.** Only the 12 had ever reached a banner. Themed, with the number of distinct
runs each appeared in:

| n | runs | who | what the agent said it could not do |
| --- | --- | --- | --- |
| 23 | **10** | both issuers | wait without burning a turn |
| 15 | 7 | both issuers | see what has been presented or routed to them |
| 6 | 4 | both issuers | do two things in one turn |
| 4 | 3 | issuers, WORKER-CODE | know what they must actually deliver |
| 2 | 1 | ISSUER-B | read their own issuer address |
| 1 | 1 | WORKER-CODE | confirm the issuer served a redeemed claim |

Three of these change how earlier results should be read:

- **"No way to wait" was reported in ten separate runs.** §4.6s treated the forward invitation as
  the thing waking an idle issuer. The invitation is the *occasion*; the absence of a wait
  primitive is why a woken issuer burns the turn instead of standing down. Ten runs said so and
  nothing surfaced it.
- **Issuers cannot see their own obligations.** Fifteen entries across seven runs: no way to list
  claims presented against them or routed to them. An issuer that cannot see a pending
  redemption and then fails to serve it has not chosen to default. Every default this project has
  recorded against an agent, rather than against the deliberately non-serving issuer, needs
  re-reading in that light.
- **ISSUER-B could not read its own address** and *inferred it from issuance-limit arithmetic*
  ("inferred 0xD4Be… from 400h × 0.08"). It got the right answer. That it had to is the finding.

**A second-order defect, found by the same scan.** Of the 74, roughly 23 are ISSUER-A reporting
`serve_redemption` absent — phrased as "is not in YOUR AVAILABLE TOOLS THIS TURN", which the
grant detector's regex (`not (in the list of|listed|among|available)`) does not match. Most are
the deliberately non-serving issuer behaving as designed, so they are not defects; but the
phrasing gap is real, and a genuine grant problem worded that way would be filed as the quieter
kind. The grant detector needs the looser phrasing too, not only the second detector.

**The generalisable rule.** A detector built around the failure that prompted it inherits that
failure's shape. `missingToolFrictions` was written after an agent named a tool it lacked, so it
required a tool name, and was structurally incapable of seeing the larger class — an agent
lacking something that was never built. Run 13's loudest result sat unread for the same reason
runs 9 and 10's did, one level up. When adding a detector, state what it *cannot* see, and
report the residue unfiltered rather than discarding it.

### 4.6y No non-service on record was an issuer choosing not to deliver

§4.6x's finding — fifteen entries across seven runs in which an issuer said it could not list
what had been presented or routed to it — meant every non-service attributed to an agent had to
be re-read. Every claim minted and not served was enumerated against its window's capacity
events, halt reasons and the issuer's own friction. The record is
`data/gate-market/default-attribution-review-2026-10-01.json`; the original run records are
annotated, not rewritten, as in §4.6f.

**Ten claims minted and not served. None is an issuer declining to deliver.**

- **Eight are ISSUER-A**, the `NON_SERVING_ISSUER`, disclosed before every run as holding no
  `serve_redemption` tool. These were never evidence about behaviour.
- **One** (run `2026-09-29T06-35-32` w3) was presented on turn 2 and ISSUER-B halted
  `parse_error` on turn 3. It was removed, not unwilling — and in that same run it had already
  reported having no way to list redemptions routed to it, and in that very window no way to
  fetch the presented claim's `task_spec`. It did not know what it owed before it stopped.
- **One** (run `2026-09-30T06-16-43` w2) was **never presented**: `pay_with_claim` with no
  `redeem_claim`, the holder gone on `parse_error` after two turns, and ISSUER-B correctly
  halting `nothing_to_act_on`. Not an issuer event at all.

**What stands and what does not.** The enforcement results are untouched: where a default was
settled the bond paid the holder correctly and the conservation identity closed exactly. The
mechanism works. What does not stand is attribution — and with it, any reading of these runs as
evidence about whether issuers deliver. **Issuer reliability is unmeasured**, and a run that
measures fulfilment before issuers can see their own obligations measures sight, not reliability.

**The methodological point is the durable one.** The blindness hypothesis prompted this review
and turned out to be a contributing condition in one case out of ten rather than the cause of
any. The review was still worth doing, and the conclusion it produced is firmer than the one it
set out to confirm. A hypothesis that sends you to check the records earns its keep even when
the records say something else — and writing down the narrower finding, rather than the one that
motivated the search, is the whole discipline.

### 4.6z The dollar route kept its capacity; the claim route gave it back

Sweeping before the block found **36,000 mSIU stranded**, all of it against ISSUER-A — against
an expectation of 10,000. Four never-presented claims (26,000) and one reservation (10,000). The
enumeration reconciled to live `headroom()` exactly, 36,000 against 36,000, before anything was
touched, which is what made it safe to act on. Afterwards the pool stood at **80,000 / 80,000,
nothing consumed, for the first time in the project's history.**

**The reservation is the finding, and it is an F1 confound.** `reserve_for_work` consumes
headroom and `settle_escrow` gives it back by calling `releaseReservation` itself — on the happy
path, which was the only one. Run 13 window 1 reserved 10,000 mSIU, WORKER-CODE then emitted
nothing, the window failed, the escrow never settled, and that capacity was still consumed a day
later. An abandoned **claim** expires at window close and its headroom returns. An abandoned
**reservation** held it indefinitely.

So the two routes F1 compares were not symmetric in what they cost the pool. Across five runs
every failed dollar purchase would permanently shrink it while every failed claim purchase
returned, and the comparison would have been measuring that asymmetry rather than preference —
the same class as §4.6f, §4.6p and §4.6s.

**The contract was never at fault, and that is the instructive part.** `reserveForWork` has
always recorded the escrow's own expiry as a deadline, and `releaseReservation` has always been
permissionless once it passes — which is exactly how the manual sweep recovered it. Nothing ever
called it on the failure path. The fix is the missing caller: the run now collects every
`reserve_for_work` quote hash and releases any still open at the end, mirroring
`releaseExternalClaims`, so a run cleans up after itself rather than relying on an agent to
choose to.

**Why the fuzz suite never caught it.** `WorkClaim.invariant.t.sol` already asserts
`headroom + outstanding == issuanceLimit` and `noDoubleReleaseEverSucceeded`, and both pass with
roughly 1,200 calls per handler action. They pass *while* a reservation is stranded forever,
because stranded capacity is still outstanding. Conservation is a **safety** property —
"nothing is ever lost" — and what failed here is **liveness** — "every reservation is eventually
released". Invariant testing proves the first and is structurally blind to the second. A green
invariant suite is not evidence that capacity comes back; it is evidence that it is accounted
for while it does not.

### 4.6z-i A truncated identifier must never be round-tripped into a call

The first sweep attempt built four token ids from the **18-character prefixes an earlier
printout had truncated to**, padding them back into full-length numbers that looked entirely
plausible. All four reverted `NothingToSettle`, because `balanceOf` for a token id that does not
exist is zero.

**That revert resembles success.** `NothingToSettle` is exactly what an already-swept claim
returns. Four of them in a row reads as "the pool is already clean", and the next step would
have been to report it as clean and move on — with 26,000 mSIU still consumed and a
reconciliation that had, correctly, said otherwise minutes earlier.

Two rules, and the second is the general one:

- **Never round-trip a truncated identifier.** Display truncation and call arguments must come
  from different code paths; a `…` in a log line is a presentation choice, and reconstructing a
  value from it fabricates data that type-checks.
- **A revert that resembles success deserves an independent check.** `NothingToSettle`,
  `AlreadySettled`, "no rows updated", HTTP 404 on a delete — each is ambiguous between "already
  done" and "wrong target". Resolve it against a source that cannot share the mistake: here,
  `balanceOf` was zero for the fabricated ids and non-zero for the real ones, and the on-chain
  reconciliation had already said 36,000 was outstanding.

Simulating before sending is what caught it. Had the writes gone straight out, the four failures
would have cost nothing on-chain and the wrong conclusion everything.

### 4.6aa Optional per-decision rationale, and why it is on every call

Added 2026-10-01, before the freeze. An optional `rationale` — one line, the agent's own words —
may accompany **any** tool call and `{"done": true}`.

**It is deliberately not payment-specific**, and that is the whole design. A `rationale` offered
only on `pay`/`pay_with_claim` would mark payment turns as the ones worth thinking about, and F1
measures precisely what agents do on payment turns. That is §4.6q's steer on a new surface: the
field would change the decision it exists to observe. It is offered on `done` for the same
reason — leaving is a decision as much as acting is.

It is treated exactly as `could_not_express` is, which is not an accident: that field produced
this build's best diagnostics (§4.6w, §4.6x) precisely because nothing ever told an agent to
fill it in.

- **Never required, never validated, never prompted for.** The protocol says the field exists
  and that it may be omitted, and says nothing about when or whether to use it. Tests assert the
  offering sentence names no tool, asset or situation, and contains no "should", "always",
  "whenever" or "make sure".
- **An empty rationale is not a rationale.** A blank or non-string value is dropped rather than
  failing the turn, and the key is omitted from the record entirely when absent. `""` and "none
  given" must not be distinguishable, because they are the same fact: **a buyer that settled
  without recording one was not deliberating.**
- **Structure over existing data, not new capture.** Raw model output has been persisted since
  2026-09-29 and already contains the reasoning behind every call. This only makes it readable
  beside the decision without re-reading transcripts. **Where a rationale contradicts the raw
  text, the raw text is authoritative** — the field is an agent's summary of itself, not a
  second source of truth.

The report prints each purchase's rationale beneath it, and prints **coverage before content**:
how many turns carried one, split by purchase turns and all others. If rationales appear only on
purchase turns, the emphasis effect has arrived by some route other than the prompt — the
report's own layout, the reader's attention, the models' sense of which turns matter — and those
rationales cannot be read as neutral self-report. The run says so in a warning rather than
leaving it to be noticed.

**Adding the field changes nothing about parsing.** A call without it produces byte-identical
output to before, pinned by test.

### 4.6z-ii A claim minted in the last window has no later window to close it

§4.6z fixed the dollar route's leak. Run 14 found the same shape on the claim route, one step
further out, and found it by the conservation check rather than by anything going visibly wrong.

Three ways capacity is given back at run end, and until 2026-10-01 only the first existed:

| what holds capacity | who returns it |
| --- | --- |
| external-buyer claims | `releaseExternalClaims`, at run end |
| dollar-route reservations | `releaseStrandedReservations`, at run end (§4.6z) |
| **an agent's own claim** | **a later window — and the last window has none** |

`outstandingClaims` is carried between windows precisely so an agent holding `settle_window_close`
can close what the previous window left, and that works: in run 14 WORKER-EXTRACT closed window
2's unserved claim unprompted, with no stake in it. But window 3 paid 10,000 mSIU to a
WORKER-CODE that had just died on an exhausted provider, so the claim was never presented, no
window 4 existed, and the run exited with the pool 10,000 short. The next run would have started
there — the ratchet again, third route.

Now swept at run end. Never-presented claims take the Expire branch, which needs no attestation
and pays nobody. A presented-but-unserved claim is a real default whose bond payment needs a
publisher-signed attestation dated to its window's close day; that is reported in full rather
than improvised at run end, because getting it wrong moves money.

**How it was found is the part worth keeping.** Nothing failed. The run reported success, wrote
its report and exited. The only signal was that an independent on-chain read said 70,000 where
the run said 54,000 — and chasing *that* discrepancy, which turned out to be a stale read,
surfaced a real 10,000 the stale number had been hiding. **A reconciliation that disagrees with
the record is worth running down even when the record looks fine, and especially when the
disagreement turns out to be innocent**: the innocent explanation was true and incomplete.

### 4.6ab The two routes differ in consent, and that is the result rather than a caveat

Run 14 produced the first direct evidence for §4.6f, from the agent rather than from us.
ORCHESTRATOR gave its own reason for choosing fSIU, unprompted, in two separate windows:

> *"Directly pay WORKER-CODE 10 SIU in fSIU to get the gate hardened **without extra
> quote/settlement steps**."*
> *"Settle the 10 SIU job with WORKER-CODE in fSIU directly... **without extra turns**."*

§4.6f was inferred from behaviour across runs 1-3 and the nine-for-nine figure was retracted on
that inference. The inference was right.

**Measured, the asymmetry is two buyer turns against one**, not the four-against-one a glance at
the tool sequence suggests — `issue_quote` and `settle_escrow` are the *seller's* turns and are
not the buyer's cost. Across every window in the corpus that settled:

| route | buyer turns | measured over |
| --- | --- | --- |
| USDC | **2** (`request_quote`, `pay`) | 3 of 3 windows |
| fSIU | **1** (`pay_with_claim`) | 15 of 18 windows (the three 2s are two purchases, not two turns) |

**But the turn count is the smaller half.** The routes are not the same transaction:

- `pay` takes a seller-signed quote. A quote exists only because the seller chose to issue one,
  and `issue_quote` requires an open request — a seller cannot quote unprompted.
- `pay_with_claim` takes `{agentId, quantity}`. No request, no quote, no seller consent. **The
  buyer settles unilaterally.**

**This is not a confound to apologise for. It is what the two instruments are.** A bearer claim
can be sent; a dollar payment against a quote cannot. Equalising it would model a world that
does not exist — which is why both obvious "fixes" are wrong: adding a `pay_direct` invents a
dollar primitive x402 and MPP do not have, and requiring a quote for `pay_with_claim` deletes
the transferability that is the thing under test.

So the caption is part of the result, and F1's number is not quotable without it:

> **Agents chose fSIU N of M times, where fSIU settles unilaterally and USDC requires a
> seller-issued quote.**

A preference for unilateral settlement *is* a reason to want a bearer instrument. Reported that
way, the asymmetry is a finding about why such an instrument is wanted, not noise obscuring one.

**The separable component, which IS artefact.** One of the two buyer turns is the loop, not the
dollar: the buyer spends a turn asking because a seller cannot have quoted in advance. That is
removable without touching consent — a resting ask, the same shape `quote_forward` already gives
issuers, lets a buyer `pay` against a standing offer on its first turn, and a seller that posted
an offer *has* consented. **Not built before the block**: it is a new market primitive needing
board state and offer expiry, it changes what sellers do with their turns, and nothing has
measured that — it would need its own debugging run. Recorded here so the consent finding is not
muddied by a loop detail, and so the one turn is attributed to the right cause.


**Amended 2026-10-04 — the claim above that this is "what the two instruments are" was wrong, and
the section's own sentence shows why.** *"A bearer claim can be sent; a dollar payment against a
quote cannot."* USDC is an ERC-20. It can be pushed to any address with no consent at all, and
nothing in the contracts says otherwise. The asymmetry lived in the **tools**: `pay` required a
seller-issued quote and `pay_with_claim` did not. A property of two tool wirings had been
recorded as a property of two assets, and the section went on to argue against equalising it on
that basis.

What that cost, measured: **1.56 buyer turns per fSIU window against 2.25 per USDC window** across
every recorded run, so F1 was partly measuring the interface. Spec §6.1 already had both assets
settling against the same quote; the tools had drifted from it.

**Fixed by wiring, not by argument (§4.6am).** `pay_with_claim` now settles a seller-issued quote
like `pay` and `settle_split`. The result this section recorded is therefore **retired by
construction**: this instrument can no longer ask whether ease of pushing a claim drives the
choice. That is a real loss and it is stated here rather than discovered later — the question was
worth asking, and answering it would need a route that is deliberately unequal.

### 4.6ac The protocol promised a wake discipline the loop did not honour

Run 15 reproduced one behaviour three times: WORKER-CODE woken on all ten turns of all three
windows, eight of each spent on `check_delivery`, zero purchases. Two competing explanations
were eliminated by the run itself — it had the tool it asked for and used it correctly, and its
brief was unchanged from runs where other agents bought. What remained is this.

**The response protocol told every agent:**

> *"YOU DO NOT NEED TO DO ANYTHING IN ORDER TO WAIT. You are given a turn only when something
> has genuinely arrived for you to act on."*

**That was false for a buyer before its first purchase.** `buyerIdle` requires
`hasPurchased`, so until a buyer buys it is woken on every cursor whether or not anything
arrived — deliberately, because a buyer gated purely on arrivals could never initiate and the
second of a window's two purchases was once structurally unreachable (§4.6e).

So the agent was told it would be asked only when something arrived, was asked repeatedly with
nothing new, and re-checked whether something had arrived. **That is not a failure of judgement;
it is the only coherent reading of a promise the loop was breaking.** Giving it
`check_delivery` changed which call it repeated, not that it repeated — run 13's nine
`get_balances` became run 15's eight `check_delivery`.

**The fix is `{"wait": true}`**, a third response beside `{"tool": …}` and `{"done": true}`:

- **Declaring costs one turn; waiting after that is free.** The agent stays in the window — the
  whole difference from `done`, which leaves for good.
- **Woken only on genuinely actionable change.** The wake key is `boardSectionText`, already
  what the wake gate uses to decide whether an issuer has anything to act on, so a waiting agent
  is woken by exactly the arrivals that would have woken it anyway and by nothing else. Being
  woken with an already-paid quote still on the board — which happened to ORCHESTRATOR once —
  would put it straight back into the forced choice.
- **Available to every agent**, not only the one that needed it. Granting it to one buyer would
  make its behaviour incomparable with the other's.
- **Syntax equal to every other option** (§4.6q). An option in prose while its alternative
  carries copy-pasteable JSON is not a neutral offer.
- **`haltedReason: "waiting"`**, distinct from `nothing_to_act_on` (which the loop concludes)
  and `voluntary_stop` (which leaves). Idle by its own choice, still in the window.

And the protocol no longer claims a turn comes only on an arrival, because it doesn't. It now
says both things that are true: usually you are not asked, and if you are asked with nothing to
do, you may say so once instead of paying a turn each time to re-check.

**Corrected by run 16 — see §4.6ae.** The second bullet above ("woken by exactly the arrivals
that would have woken it anyway and by nothing else") is accurate and is the defect: reusing
`boardSectionText` as the wake key inherited every gap in what that text renders. A holder
awaiting delivery has no board section at all, so it has no arrivals, so it is never woken.
Read that bullet as a constraint on the wake key rather than a reassurance about it.

**The general form.** A prompt that describes a guarantee the loop does not implement is not a
wording problem — it is a defect that produces exactly the behaviour the guarantee was meant to
prevent, and it reads as the agent being obtuse. Three runs were spent attributing to the agent
what belonged to the promise.

### 4.6ad The schedule is shown because two capabilities had no basis to be used

`forWindow` on `mint_claim` and `pay_with_claim` has existed since 2026-09-28, carries worked
syntax in the brief, and **`forwardDated: true` appears zero times across eleven runs** (§4.6n).
`take_forward` likewise has worked syntax and **0 of 3 forward offers have ever been taken**.

The pre-check asked whether a buyer can purchase more than one window's work at a time. It
cannot: the job is constructed inside the window loop, so window 2's job does not exist while
window 1 runs, and no amount of visibility makes a later window's work purchasable.

**But "showing it changes nothing" was too strong.** A buyer was being invited to reserve
capacity for window 3 while knowing nothing about whether window 3 has a job, how large it is,
or when it opens — a bet with no information on either side. Two capabilities with worked syntax
going unused across eleven runs is better explained by that than by reluctance.

So the schedule is stated as fact to everyone who can buy: each remaining window, that it
carries one code-class gate-authoring job, its size, and when it opens.

**A schedule, never advice.** The test applied to every line is whether a buyer could read it
and rationally decide to do nothing. Tests assert the text contains no "you will need",
"consider", "advantageous", "should", "recommend", "worth", "secure", "before it runs out". It
is placed beside the existing capacity facts — headroom finite, shared, first-come-first-served,
consumed at mint, routed to a single issuer — because scarcity needs both halves and neither
half says what to do.

**It lists only what the run actually buys.** No ATC, no replay SDK, no rate fingerprinting —
none of which any agent purchases. A schedule naming work that never arrives is a brief
describing a world the agent is not in, and capacity reserved against it is stranded on false
information.

**Claim validity was checked and needed no correction.** Validity is the delivery window, not
the print, and the text already said so: `redeem_claim` is described as "presents your claim for
redemption inside its window", claims are "dated", and the shared facts state that "a claim
carries the delivery window it was minted for. Holding it past that window does not move the
window." The print sets the rate at mint and nothing ties lifetime to it.

**If forward-dating and `take_forward` stay unused after this, that is a finding.** Two
capabilities with equal syntax and a visible pipeline behind them, still unexercised, would say
something real about whether these agents value deferral at all — and it would be the first
evidence on that question not confounded by the agent simply not knowing there was a later
window worth reserving for.

### 4.6ae The wait primitive inherited the board's blind spot, and silenced the one agent the run was testing

Run 16 was the debugging run the protocol freeze depended on. The wait primitive (§4.6ac) did
exactly what it was built to do, and that is how this was found.

**What it fixed.** Window 2, turn 3, WORKER-CODE declared `{"wait": true}` with a rationale:
*"Claim already presented via redeem_claim last turn; delivery is now the issuer's obligation.
Nothing new has arrived to act on, so I'll wait rather than spend a turn on a read."* Three
turns, where runs 13 and 15 each burned ten on `get_balances` and `check_delivery`. The halt
reason `waiting` was recorded and is distinguishable from `nothing_to_act_on`. The idle burn is
gone.

**What it revealed.** WORKER-CODE was never woken again — not in the thirty-one minutes between
declaring the wait and the window closing, and not when the claim it was waiting on failed to be
delivered. ISSUER-A is this run's `NON_SERVING_ISSUER`: disclosed before the run, deliberately
denied `serve_redemption`, so its claims default. Its own roster comment states the purpose —
*"the holder noticing non-delivery and acting on it is precisely what the run is testing."*
ISSUER-A played the condition correctly, authoring three passing gates and twice attempting to
serve, refused both times by the allowlist. **The holder slept through all of it, and window 2's
claim was ultimately settled by WORKER-EXTRACT, not by the holder whose claim it was.**

**The mechanism, traced rather than inferred.** `buyerIdle` cannot be the suppressor:
`hasPurchased` is set only by `settlesQuote(tool) || mint_claim`, and `redeem_claim` is neither,
so WORKER-CODE remained unconditionally wakeable. The only suppressor was
`waitingOn.get(agentId) === boardSectionText`, with both sides `""`. Its board section was empty
when it waited and stayed empty, because **no board section is rendered to a holder at any stage
after presentation**: `renderForHolder` returns `""` the moment `holder !== undefined`,
`renderForIssuerAwaitingDelivery` and `renderFor` are issuer-side, and `settleableText` covers
only claims carried from an earlier window.

**So §4.6ac's own design note was right in a way that defeated it.** It recorded that a waiting
agent is *"woken by exactly the arrivals that would have woken it anyway and by nothing else"* —
and reusing `boardSectionText` as the wake key inherited every gap in what that text covers. For
a holder awaiting delivery there are no arrivals at all, so the protocol's promise — *"you will
be given a turn again the moment something you can act on changes"* — is false for precisely the
agent this run existed to observe.

**The only route by which a holder ever learns is a window too late.** `settleableText` does
render an unsettled claim to anyone holding `settle_window_close`, which WORKER-CODE does — but
it lists claims carried from an *earlier* window, so the earliest a holder can learn its claim
went undelivered is the window after the one it paid in. By §4.6z-ii a claim minted in the last
window has no later window at all, so for it the answer is never. Within the window in which a
buyer actually decides, there is no signal of non-delivery at any time. In run 16 the
cross-window route did fire, and it was **WORKER-EXTRACT** that acted on it, settling window 2's
claim on its first turn of window 3; the holder was woken that window by an unrelated quote
request and never by its own default.

**The polling was the symptom of the same gap, not a separate defect.** Nine `get_balances` and
eight `check_delivery` were WORKER-CODE *attempting* to notice something the board would never
tell it. Unconditional waking masked the absence by handing it turns anyway. Removing the idle
burn removed the workaround and left the gap exposed. `check_delivery` (2026-10-01) closed the
*expression* half — the agent can now ask — and this is the *arrival* half: it never gets a turn
in which to ask.

**The general form, and it is §4.6-RULE again in a new place.** A wake key derived from "what
can this agent act on" is only as complete as the renderers behind it, and a renderer written for
one side of a two-sided obligation leaves the other side permanently unwakeable. Before reusing a
wake key, establish what it renders for *every* role that can wait on it — not only the role it
was written for.

**Consequence for the block.** This is an affordance defect, so run 16 does not meet the bar and
the protocol does not freeze on it. The five F1 runs do not start here.

**Fixed 2026-10-03** — `docs/task-holder-visibility.md` holds the design and the build notes.
Widening the wake condition was the wrong move. `boardSectionText` was both the text an agent
sees and the key deciding whether it is woken, so anything worth telling had to wake, and the
two are now split: `composeBoard` returns `shown` and `wakeKey`, and `waitingOn` keys on the
latter. Informational text may change freely without spending a turn.

**§4.6ac is now enforced by construction rather than asserted.** `composeBoard` takes the
agent's grant and drops from `wakeKey` any section whose tools it does not hold, against a
`WAKE_SECTION_TOOLS` table beside the composition. The invariant caught a real case on its first
run: `WORKER-EXTRACT` can hold and redeem a claim and holds no purchase tool at all, so a served
FAIL is news it can do nothing with — it is shown and does not wake, while an overdue claim,
which it can settle, still does.

**The trigger is built only from the holder's own facts** — when it presented and when its claim
expires, both returned by its own `redeem_claim`. Waking on the issuer's refusals would have
been easy and would have handed the holder the answer to the question the run is asking.

**Two honest limits, both recorded in the task doc.** The literal form of the invariant — a tool
the agent *could not have used before* — cannot hold for either holder stage, because nothing is
newly granted to a holder; what changes is that an action becomes worth taking. The implemented
guarantee is affordance plus no-repetition. And the overdue warning fires on the holder's next
turn, so a window that goes fully idle before the midpoint ends without it — correct behaviour,
since spinning the roster on a clock is the busy loop the stall guard exists to stop, but it
means the channel is available rather than guaranteed.

**A claim minted in the last window is now disclosed rather than quietly swept.** Its holder is
never offered a settlement at all (§4.6z-ii), and a holder never asked is indistinguishable from
a holder declining — §4.6y repeated on the holder side. The run report carries
`holdersNeverOfferedSettlement` and the sweep says so in words.

### 4.6af The final-window verdict cannot see the dollar route, and only the fSIU artefact hid it

Run 16 ended with `VERDICT: scarcity` and a detail line that refutes itself in its own sentence:

> *"Window 3's buyer could not buy: 1 purchase attempt(s), every one of them failed, no single
> issuer held the 10000 mSIU the job needs (largest: 32000 mSIU)"*

32,000 is larger than 10,000, and the same report records window 3's purchase succeeding
(`ORCHESTRATOR: 1 in USDC`), the seller committing capacity (`w3 turn 2 WORKER-CODE
reserve_for_work — 10000 mSIU`), and the escrow settling (`w3 turn 5 release_on_settle`).

**The cause.** In `classifyFinalWindow`, `purchaseAttempts` counts `pay`, `pay_with_claim` and
`mint_claim` in the buyer's turn logs, but `purchaseSucceeded` is satisfied only by a
`mint_claim` or `pay_with_claim` capacity event attributed to the buyer. **A successful USDC
payment produces neither.** The dollar route's capacity event is `reserve_for_work`, and it is
recorded against the *seller*, because the seller is who commits the capacity. So a USDC
purchase is an attempt that can never be observed to succeed, `buyerWasShutOut` is true by
construction, and the scarcity branch fires.

**Any final window bought in dollars is reported as scarcity.** `hadCapacity` is computed two
lines above and never consulted by that branch, which is why the detail text can assert a
capacity shortage while printing the number that disproves it.

**Why eleven runs did not catch it.** Of the nine recorded runs with a machine-readable report,
every final-window purchase before run 16 settled in fSIU. Run 16 is the first in which
ORCHESTRATOR paid dollars in the last window, and it is the only run ever to report `scarcity`.
**The classifier was correct only because of the artefact §4.6f documents** — the "9 of 9 chose
fSIU" bias kept every final window on the claim route and kept this blind spot covered. The
mitigations that make the asset choice fairer are exactly what exposes it. A measurement
apparatus validated only under a biased input distribution is validated for nothing, and
correcting the bias is the event that breaks it.

**Why it matters more than a mislabelled line.** `finalWindowVerdict` is the headline field of
every run report and the thing a reader quotes. F1 compares USDC against fSIU. Under this
defect, every run in which the buyer chooses dollars in the last window carries a verdict that
reads as the instrument failing — a systematic penalty applied to one of the two arms by the
scoring code rather than by anything the agents did. Running the five F1 runs on it would have
produced a result biased against the dollar route and entirely spurious.

**The fix, 2026-10-02.** `classifyFinalWindow` no longer re-derives the answer: it asks
`summarisePurchases`, which already knows both routes, already attributes per buyer, and is what
the report's own asset-choice line prints. Two readers of the same fact disagreeing is how this
arose, so there is now one. The scarcity branch is additionally gated on `hadCapacity`, because
"the capacity was gone" and "the largest issuer held 32,000" cannot both be true — a shut-out
buyer facing available capacity is `failed_with_capacity`, which the taxonomy already defines as
a defect to investigate.

**The same mistake was live in the other direction, and fixing one without the other would have
imported it.** `summarisePurchases` detected a dollar settlement with
`log.parsed.includes('"pay"')`. On a failed call the loop writes `parsed` as
`` `{"tool":"pay",…} -> tool call error: …` ``, which *contains* `"pay"` — so a reverted or
refused payment was reported as a settled one, and every run report's asset-choice line
over-counted the dollar route by its failures. One root cause, two opposite errors: **the dollar
route's success was never observed from a fact, only guessed from the text of the model's own
tool call.** `TurnLog` now carries `toolCall: {name, ok}` as a recorded fact, and the text is
read only for records written before that field existed — then with the failure marker excluded,
which is the part the old check was missing rather than a new guess.

**Re-scored against every stored run, and two verdicts were wrong.** Running both the pre-fix and
post-fix classifiers over the same reconstructed windows separates what this fix changed from
what was already stale:

| Run | Stored | Pre-fix code | Post-fix code | |
|---|---|---|---|---|
| 2026-09-28 (first three-window run) | `completed` | `scarcity` | `scarcity` | stored value was **already stale** |
| 2026-10-02 (run 16) | `scarcity` | `scarcity` | `completed` | **changed by this fix** |
| other seven | — | — | — | unchanged |

Only run 16 is this defect. The 2026-09-28 record is worse and is a different lesson: its stored
detail reads *"ORCHESTRATOR had secured capacity in an earlier window (2 action(s)) — the
instrument working as intended"*, when those two actions were ordinary same-window payments, the
largest issuer held 4,000 mSIU against a 10,000 mSIU job, every purchase attempt failed, and
WORKER-CODE authored the gate unpaid. The classifier was corrected to exclude same-window
payments shortly afterwards; **the report was never re-scored, so the published artefact still
reports the instrument succeeding in this project's clearest scarcity result.** Both records now
carry a `verdictAnnotations` entry stating the correct verdict, the reason, and — for 2026-09-28
— that it is not attributable to this fix.

**The general rule this forces.** A verdict is not a fact about a run; it is the output of the
classifier that happened to be current when the run ended. Changing a classifier therefore
invalidates every stored verdict it ever produced, and leaving them in place publishes
conclusions no current code would reach. **Any change to scoring logic must be followed by
re-scoring every stored run and annotating what moves** — and the re-score must run both the old
and new logic, or a stale artefact and a genuine change are indistinguishable.

### 4.6ag Settling an unpresented claim pays nobody, and the board says it pays the holder

Run 17, window 1, produced the first deliberate hold in this project's history. WORKER-CODE was
paid 10,000 mSIU by `pay_with_claim`, and instead of redeeming it on the next turn as every
holder in every previous run had done, it kept the claim:

> *"Holding the 10000 mSIU code-class claim I received … preserving the claim for later use
> (e.g. funding adversarial testing once I have a gate to defend, or settling a future quote)."*

That is fSIU behaving as money rather than as a settlement rail — the property the instrument
exists for and had never shown. It is also what exposed the defect, because **holding without
presenting reaches a state no previous run could reach.**

**Why the hold happened, which is a second defect and the cause of the first.** WORKER-CODE's
brief tells it, verbatim:

> *"`YOU HAVE BEEN PAID AND OWE THE WORK` appears on your market board, naming the request it
> answers and the amount in escrow. You do not need to go looking for it, and **an absence of it
> means you have not been paid**."*

That board section is produced by the **dollar** route — it describes an escrowed quote.
`pay_with_claim` produces no such entry. So an agent paid in fSIU is told by its own brief that
it has not been paid, and WORKER-CODE's friction log is that guarantee being obeyed: *"it's
unclear why it arrived absent any request on the board"*. It then reasoned, correctly per the
spec, that holding a claim creates no work obligation, and kept it.

**This is §4.6-RULE once more and the sharpest instance yet**, because the false guarantee is
stated as a negative test — *absence means X* — which an agent cannot disconfirm by looking. The
USDC route tells a seller what it was paid for and names the request; the fSIU route tells it
nothing and its brief tells it that nothing means unpaid. §4.6ab recorded that the two routes
differ in consent. They also differ in whether the seller can tell it has been paid at all.

**What the board tells every agent**, in the `settleableText` section, with copy-pasteable
syntax:

> *"A claim that was never served defaults against its own issuer's bond, **paying the holder** —
> that is what the bond is for, and it is permissionless: anyone may trigger it, including you."*

**What `WorkClaim.settleWindowClose` actually does** is conditional on `everPresented`. The
unconditional part burns the claim and restores the issuer's headroom; the bond draw lives
inside `if (everPresented[tokenId][holder])`. For a claim that was never presented, control
reaches `else { emit Expired(...) }` and **no payment is made to anyone**.

**So in window 2, WORKER-EXTRACT settled WORKER-CODE's held claim** on its first turn, with the
rationale *"Settling the defaulted claim from window 1 as instructed."* Verified on chain
afterwards: holder balance `0`, `everPresented false`, `settled true`, ISSUER-A's 10,000 mSIU of
headroom returned. The holder received nothing.

Three things are wrong here and they are separable:

1. **The text states a guarantee the contract does not implement** — §4.6-RULE, in its most
   damaging form yet. Previous instances left an agent unable to act. This one actively invites
   an action that destroys value, with worked syntax, and the agent that followed it reported it
   was acting *as instructed*.
2. **It is permissionless destruction of someone else's position.** For a presented claim,
   permissionless settlement is a feature: anyone may trigger the default and the bond pays the
   holder, so a third party can only help. For an unpresented claim the same call burns the
   holder's asset for no compensation. The invitation "anyone may trigger it, including you"
   is correct about the permission and wrong about the consequence.
3. **The enforcement arm ran backwards.** The run's own disclosure said the question was
   *"whether the holder notices, triggers settle_window_close once the window closes, and is paid
   from that issuer's bond."* What happened: a non-holder triggered it, the holder was not paid,
   and ISSUER-A — the issuer deliberately prevented from ever delivering — was made whole. The
   mechanism built to penalise non-delivery returned the non-deliverer's capacity and
   expropriated its counterparty.

**And the holder was never told.** At its window-2 turn 1 WORKER-CODE's prompt carried the
settleable notice naming its own claim; WORKER-EXTRACT burned it between turns; at turn 2 the
section is simply absent, with no mention of the claim, the settlement, or the outcome. It lost
10,000 mSIU silently between two consecutive turns. That is §4.6ae on the settlement side: the
loop knew and the holder could not see.

**What this says beyond the harness.** Holding fSIU is not safe. An unpresented claim can be
burned by anyone, for nothing, at any time after its window closes, and its holder is not
notified. Build 2's `wSIU` is premised on claims being held and passed between hops without
unwrapping, so this is a property of the instrument's design and not only of this testbed's
prompt text. A bearer instrument whose bearer can be zeroed by a stranger is not a bearer
instrument.

**A methodological note, because it nearly corrupted this entry.** The first draft of this
section said the claim "arrives with no statement of what it is for". That was wrong, and it was
wrong because a substring search for `YOU HAVE BEEN PAID` matched the phrase where the *brief*
quotes it, not a rendered board section. Checking what the agent was actually shown, rather than
what a grep said was present, turned a vague complaint into the precise defect above. This is the
second time in two days that a substring match over prompt text produced a confident wrong
reading (the first was parsing rationales out of a truncated console log). **A grep over a prompt
finds the brief as readily as the board; locate the section, do not match the phrase.**

**Not fixed in this run** — reported, per the standing rule that a defect found mid-run is
recorded rather than patched while the run is live.

### 4.6ah Suppressing a one-shot section is itself a wake

The holder channel (§4.6ae) worked on its first live test. Run 17, window 2: WORKER-CODE
presented a claim at 11:52:28Z with 2,286s to expiry, waited, and was woken at 12:12:43Z — 72
seconds after the computed 12:11:31Z midpoint, which is one roster pass, the designed interval
of the per-round chain-clock refresh.

> *"A CLAIM YOU PRESENTED IS STILL UNSERVED … You presented it 1262s ago and it expires in
> 1024s."*

1262 > 1024: the waited-longer-than-remaining condition, correct, with no tuned constant. It had
slept through sixteen minutes and many roster passes without a single spurious wake, and it read
the warning and chose to keep waiting — *"nothing actionable until it's served or the window
closes, so I wait rather than spend a turn re-polling."* Informed, unsteered, and free to do
nothing, which is the whole design.

**Then it was woken again 22 seconds later, with an empty board.**

`markUnservedWarningShown()` blanks the section once it has genuinely been delivered — the
§4.6ac bound, so a standing fact cannot wake its holder every cursor. But `waitingOn` stores the
`wakeKey` **as it was when the agent waited**, and that key contained the warning. Blanking the
warning changes the key. A changed key is the definition of a wake. So:

**suppressing a one-shot section is itself a wake.** The agent is woken once by the arrival of
the fact (correct) and once more by its disappearance (§4.6ac, exactly the defect this was built
to fix).

The cost here is one turn, and the agent handled it by waiting again. The general form is worse
than the instance: every shown-once section has it. `gateDefeatedText` is bounded by
`unseenDefeatsFor`, the forward invitation by `shownForwardOffers`, and both will do the same
thing to any agent that waits on a turn where one of them was present.

**The fix is to store the post-suppression key.** `composeBoard` is pure, so the wait branch can
compose a second time with the one-shot sections blanked and store *that* — the key the next
evaluation will actually compute. The agent then stays asleep across the suppression. Stated as a
rule: **a wake key must be a function of state the agent will still see next turn, never of
state the act of showing it destroys.**

**Reproduced in the same run, both windows**, which is what makes it systematic rather than a
one-off timing accident:

| window | presented | midpoint | warning delivered | spurious wake |
| --- | --- | --- | --- | --- |
| 2 | 11:52:28Z | 12:11:31Z | 12:12:43Z (+72s) | 12:13:05Z (+22s) |
| 3 | 12:32:35Z | 12:51:34Z | 12:52:20Z (+46s) | 12:53:28Z (+68s) |

Both deliveries land within one roster pass of their midpoint, and both are followed by a wake
with an empty board on the very next pass. The lag is the design; the second wake is the defect.

Found live rather than in review, by watching the one agent the feature was built for, on the
one turn after it worked.

### 4.6ai A test built from the same assumption as the code cannot see the assumption

`classifyFinalWindow` had **six passing tests** when §4.6af shipped. They covered scarcity,
`failed_with_capacity`, `completed`, forward-dated cover, the same-window-payment misreading,
and a shut-out buyer. Every one of them passed, and the classifier could not see a dollar
purchase at all.

They passed because **every fixture was constructed the way the buggy code read the world.**
The code believed a purchase was a `mint_claim`/`pay_with_claim` capacity event attributed to
the buyer, so the fixtures supplied purchases as capacity events attributed to the buyer. The
assumption under test was the assumption used to build the test. Adding a seventh test written
the same way would have passed too, and so would an eighth.

**The thing that caught it was not a test. It was re-scoring nine real runs** and finding that
exactly one — the first whose final-window purchase settled in dollars — disagreed with its own
stored verdict. Real data had a property the fixtures did not: it was generated by something
other than the belief being checked.

**The rule.** A test whose fixture is built from the implementation's own model of the world
verifies that the implementation is self-consistent, which it always is. To test an assumption
you need an input the assumption did not construct:

- **a real artefact** — re-score stored runs, replay recorded turns, read a chain;
- **the opposite construction** — build the fixture from the OTHER side of the interface. For
  the dollar route that means a `reserve_for_work` event attributed to the *seller* and a `pay`
  in the buyer's turn log, which is what the live system produces and no existing test did;
- **a property rather than a case** — assert the guarantee ("an agent is woken only when it has
  something it can do") instead of the mechanism ("this input produces that output"). The
  mechanism is what the code already believes.

**Three of this project's defects are this shape**, which is why it is a rule rather than an
observation: §4.6af (six tests, none from the dollar side), §4.6ae (every wake test asserted
that a waiting agent stays asleep; none asserted that a woken one has something to do), and the
memo drop, where a schema accepted a field and an explicit arg builder discarded it — the
schema test and the builder test were both correct about their own halves.

**And the practical consequence for where effort goes.** After changing scoring logic, do not
write another unit test: **re-score the real runs, with the old logic and the new, and compare**
(§4.6af). That took one script and found two wrong verdicts, one of which no test would ever
have questioned because it had been stored, published and believed for five days.

### 4.6aj A cheap run tests the loop; only a full-cost run tests the roster

`--debug` substitutes the non-decider seats onto one cheap model, which **collapses the roster
from four providers to two** — Anthropic and OpenAI run, xAI and Google do not.

Both consequences are real and they point opposite ways. A debug run is materially harder to
kill: seven provider interruptions in two weeks, and a run cannot be stopped by a provider it
never calls. But the failures that have actually ended runs here are **model-specific**, and all
of them become unreachable: grok truncating mid-JSON at a 1,500-token ceiling and again at
4,500, gemini returning `contentBlockTypes: ["thinking"]` with no text after 21,782 reasoning
tokens. Neither can occur when neither model runs.

**A green debug run is evidence that the loop works. It is not evidence that the roster works,
and the two are routinely confused** — a clean run is a clean run, and nothing in the output
used to say which claim it supported. So the run says it: the banner prints the collapse, and
the manifest and report carry `providersExercised`, `providersNotExercised` and
`validatesTheBlocksRoster`.

**And a second, independent blindness: time-gated behaviour.** Every saving shortens the span
over which agents actually take turns — nobody authors a gate, and cheaper agents reach the end
of their ideas sooner and leave. The window's span is unchanged, but the stall guard ends it
much earlier. Anything that fires on **elapsed time rather than on an event** may therefore
never become eligible.

**Measured across both windows of the 14:46 debug run**, and it is not marginal:

| | presented | midpoint | last turn taken | span left unused |
| --- | --- | --- | --- | --- |
| w1 | 14:51:03 (2,298s left) | ~15:09Z | 14:51:58 | ~34 min |
| w2 | 15:31:07 (2,184s left) | ~15:49Z | 15:33:43 | ~33 min |

Window 2's entire agent activity lasted **under four minutes** against a forty-minute span. The
warning was sixteen minutes out of reach, in a window that had thirty-three minutes left on the
clock and nobody taking turns.

**And the mechanism is worse than "fewer turns".** Cheaper models are also *faster*: a turn
budget is spent in wall-clock seconds, and an elapsed-time threshold is measured in wall-clock
seconds, so substituting quicker agents shrinks the overlap from both ends at once. Ten haiku
turns are consumed in a couple of minutes where ten grok turns took the better part of twenty.
A debug run is therefore structurally worse at reaching an elapsed-time threshold than its turn
count alone would suggest.

The overdue warning was simply the one being watched; the unpresented-expiry warning, late-stage
forward invitations and any future elapsed-time mechanism are squeezed the same way. **A debug
run cannot evidence any of them**, and the §4.6ah one-shot wake fix in particular remains
unverified by live run after two attempts — only the full-cost run can reach it.

This is independent of the roster collapse — it would hold even if every provider still ran —
and it is recorded in the run's own banner and in `exercisesTimeGatedBehaviour` on the manifest
and report.

**The freeze rule this implies.** A full-cost run on the block's real roster is required before
the protocol freezes, however many clean debug runs precede it. There are now **two** reasons
rather than one: the roster is not exercised, and neither is anything time-gated. Debug runs are for iterating on
the loop; they cannot retire the risk that a model the block depends on behaves differently from
the one that stood in for it.

### 4.6ak The first debug run died of two defects in the debug mode itself

Launched 2026-10-03T14:28Z, dead on window 1 after $0.38. Both causes were in the cost-saving
machinery, not in anything it was built to test, and both are instructive.

**The pinned gate did not parse.** It was stored in a TypeScript **template literal**, and the
gate contains `].join('\n')` — a literal backslash-n inside a JS string. TypeScript read the
escape and wrote a real newline, producing an unterminated string literal. Every grading
returned `G1: SyntaxError: Invalid or unexpected token`.

Two things made it slip through. The fixture was checked for backticks, `${` and backslashes
before being embedded — and the backslash check was `grep -c '\\'` in bash, which after shell
quoting searches for **two** backslashes and reported none in a file full of single ones. Then
the stored file was syntax-checked and passed, because the corruption happens at TypeScript
compile time, not at write time: **the artefact that was verified was not the artefact that
ran.** It is now stored as a JSON string literal, which escapes by construction, and a test
writes the compiled value to disk and runs `node --check` on it.

**A substituted model had no price.** `--debug` moved three seats to `claude-haiku-4-5`, which
had no entry in `PRICES`, so `prices` was `undefined` and `projectedTurnCostUsd` threw 256
seconds into the first substituted agent's turn. TypeScript cannot see it: indexing a
`Record<string, ModelPrices>` is typed as present. The price is now taken from this repo's own
latest LiteLLM snapshot rather than estimated, because **the projection is what the run cap is
enforced against** — a silently absent price is not a crash waiting to happen so much as a run
with no ceiling at all. The real fix is the guard: every seat's model is checked against
`PRICES` before anything is spent, and the run refuses to start otherwise.

**And a consequence worth noting about fallbacks.** Because the pinned gate failed G1, the
window did not stop — it fell through to an agent authoring a gate normally, which is why
WORKER-CODE spent $0.377 on a run whose entire purpose was to avoid that. A degraded saving
that silently reverts to the expensive path is worse than one that fails loudly: it costs full
price and reports as debug. The gate is now verified to grade PASS before a run uses it.

**What this says about §4.6ai.** Both defects are that rule again. The template-literal
corruption was verified with a check built from the same assumption as the mistake (inspect the
source file, when the damage happens downstream of it). The missing price was invisible to the
type system for the same reason — the type asserted the belief rather than testing it. The
tests that now exist assert properties of the compiled artefact and of the actual roster, not of
the inputs that produced them.

### 4.6al A crashed run strands capacity into every run after it

§4.6z closed three routes by which capacity leaked *within* a run, and every run's close-out
sweeps what it consumed. **Nothing covered a run that never reaches its close-out.**

On 2026-10-03 a debug run died on window 1, having already minted a 10,000 mSIU claim. Its
sweeps never executed. The claim stayed outstanding, ISSUER-A stayed at 38,000 of 48,000, and
**the next run began 12.5% short without saying so** — discovered only because its starting
headroom line was read by hand afterwards. Left alone it would have propagated to every
subsequent run, each one quietly scarcer than the last.

That matters more here than it would elsewhere, because **scarcity is the thing this testbed
measures.** A run that starts short is not comparable with one that starts whole, and the
difference is invisible in every per-window figure the report prints.

**The fix is a pre-flight, not a post-mortem** (`cli/pool-reconciliation.ts`). At launch the run
reads live headroom per issuer, compares it against each lot's own `issuanceLimitPerClass`, and
if they differ names the issuer and the amount. It then **refuses to start** unless
`--allow-partial-pool` is passed, and either way the state travels into the report as
`poolAtLaunch`. A post-run check would have found this too; a pre-flight finds it before the
money is spent, which is the whole difference.

Headroom *above* a lot's limit is reported as a separate and louder failure rather than as a
negative shortfall: it means the deployment record and the chain disagree, and clamping it to
zero with a `Math.max` would hide the worse of the two problems behind the lesser one.

### 4.6am Payment symmetry, and a notice that told a claim-paid seller there was escrow

Single-issuer instrument, apparatus fix W1a. `pay_with_claim` took `{agentId, quantity}`: no
request, no quote, no seller. Paying in fSIU was one call and paying in dollars was three
(`request_quote`, wait for the seller, `pay`), and the buyer's own turns showed it — 1.56 per fSIU
window against 2.25 per USDC window (§4.6ab, amended). It now takes a `requestId` and settles a
quote the seller issued, exactly as `pay` and `settle_split` do. The recipient and the size come
from the seller's signed quote, so a model can neither redirect a payment nor resize it. Sizes
convert through exact integer maths, and a fraction of a milli-SIU is refused rather than
truncated — truncating would settle the quote for less than it states.

**Asserted as a property over the settlement routes, not as a case** (§4.6ai): every route must
name a quote, so a future route that skips it fails without anyone remembering to test it.
`mint_claim` plus an unkeyed `transfer_claim` remain, as the explicit two-step primitives, so
turns per payment must still be reported with unkeyed transfers flagged separately.

**A latent defect that symmetry would have multiplied.** `board.recordPaid` already fired for any
claim payment that carried a `requestId`, which showed the seller *"real USDC is in escrow in your
favour … settle_escrow"*. That is false — a claim moves no escrow — and it names tools a claim
holder cannot use. Worse, it could never clear: the notice ends on `settle_escrow`, which does not
apply to a claim, and the stall guard reads any board text as proof somebody can still act, so it
would hold a window open indefinitely. With payment symmetry every claim payment carries a
`requestId`, so every fSIU window would have shown it. The board now records the asset a quote was
settled in; a claim-paid quote is not shown to its seller as owed escrow, and the arrival is told
through the holder section instead — which names the quote ("It settles your quote qr-1") and
ends when the claim is presented. That is what the optional memo was reaching for, now structural.

**The asset text was rewritten in the same change (§8.5)**, because two of its sentences were
false of the run: *"Sellers state which they accept in their quotes"* (a quote permits exactly one
settlement entry and it must be USDC) and *"accepted by counterparties that list it"* (nothing is
listed). It is now 294 vs 424 characters across the two paragraphs (1.44x, against about 5x), states
the mechanics true in every window, and names no issuer.

### 4.6an Adversarial testing is a purchase, and `passed` now includes it — an instrument change

Single-issuer instrument, W1b. **`submit_attack` had no payment check** — its four `throw`s were
argument validation — and WORKER-EXTRACT woke the moment a gate existed. The 4,000 mSIU "attack
testing" quote was a tip for a service rendered anyway, which is why WORKER-CODE has never made a
purchase in any run. "Both buyers deciding" cannot be met by waiting; a purchase that changes
nothing is not a decision.

So testing is sold, and the rule is stated once, as a fact, to every agent: **a window passes when a
gate has passed its checks AND adversarial testing of it has been paid for AND carried out.**
`submit_attack` is refused until a quote the attacker issued has been settled, in either asset or
both — engagement is read from the board's record of a settled quote, never from which tool paid.
A window in which nobody buys testing is recorded as not passed with the reason attached
(`testing_never_purchased`), so a decline is a result rather than a silence; a window where it was
paid for and not carried out is a different finding (`never_attacked`), the seller's.

**This is recorded as an instrument change.** `passed` means something different from 2026-10-04,
so every run reports `gateDelivered` (the old meaning) beside it and carries `instrumentChanges` in
its manifest. It is off by default, so the single-agent loops and every existing test keep the old
meaning exactly.

Two consequences worth stating. The window must be held open after a gate passes until testing is
bought or the buyer is done: it used to break the instant a gate passed unless the free adversary
held it open, and with testing for sale that would end the window before the one agent able to buy
had a turn, making "declined" and "never asked" the same silence (§4.6y, on the buyer's side). And
a window where the buyer declines is a failed window — `passed` rates fall by design, and the
classifier files it under a new verdict `untested` rather than under the verdicts that send
someone looking for an apparatus fault.

### 4.7 Forward terms: a stated price, not an instrument

Issuers may state terms for a later window — a price per SIU and a quantity they say they will make
available (`quote_forward`), and a buyer may record that it is acting on one (`take_forward`).
Every offer is recorded whether or not anyone takes it: a book that kept only accepted terms would
show a market that always clears, and a rejected offer at a stated price is as much a datum as an
accepted one. Each offer is recorded alongside the issuer's **real headroom at the moment it
quoted**, so an offer of 20,000 mSIU from an issuer holding 200 is distinguishable from the same
number backed by real capacity.

**Nothing enforces a forward term, and every surface that shows one says so.** `WorkClaim.mint`
charges the attested print rate, the attestation is signed by the publisher rather than by the
issuer, and no contract in this build could bind an issuer to a price it named in advance. Building
one would be a new instrument, which build 1 does not have and this testbed's sanctioned exception
does not cover. What is measured is what an issuer offers and what a buyer does about it — which is
genuinely interesting, and genuinely not a forward market. `take_forward` pays, mints and reserves
nothing; it exists only so that *taking* an offer and *ignoring* one are distinguishable outcomes
rather than the same silence.
| **Default** | Disable an issuer's harness path for one window | Does that issuer's own bond pay the holder, at that claim's own grade's print? (No re-route to the other issuer — see §4.4's corrected DEFAULT row.) |

### 4.6ao A payment records the terms of the quote it settled

Single-issuer instrument, apparatus change valid on either topology. The block report is asked for
cost per delivered SIU, and the run artefact could not answer. A payment moment recorded who paid,
in which asset, on which turn and what they held — not what the payment bought, or at what stated
price. The quote that knew was on a board that no longer exists once the window ends. Found by
working out what the report needs *before* the freeze, which is the only moment the omission is
cheap: every run of a frozen block would have carried it.

A payment moment now carries the settled quote's own `siu`, `rate_usd_per_siu` and
`amount_usd_max`, as decimal strings, read from the signed quote the payer named. They are the
quote's **stated** terms, not a settlement: `amount_usd_max` is the ceiling the quote allows, a
seller may settle for less, and no settled amount is recorded. A report built from these says
*"quoted at"*, never *"paid"*. An unkeyed `transfer_claim` names no quote and carries none — which
is how a report finds it and counts it apart from keyed payments (§4.6am).

*Test (§4.6ai):* asserted on the real-bytecode loop's own recorded moment, not on a hand-built one;
verified failing first (`expected undefined to be '1'`).

### 4.6ap A settlement records which terminal state it reached

Single-issuer instrument, apparatus change valid on either topology. Windows 2 and 3 exist to
produce one number — how many claims **Defaulted**, the bond paying the holder — and a run's
artefact could not state it. `settle_window_close` returned a transaction hash and nothing else; a
Default and an Expiry are different events in the same function, and telling them apart meant
re-reading the chain afterwards. That is how every enforcement figure to date was produced (and how
the 11-versus-14 mix-up in the analysis happened: a settlement count compared against an
enforcement count, because the artefact held only the first).

The tool now decodes its **own receipt** and returns `outcome` — `Defaulted` or `Expired` — and, for
a Default, `bondPaidMinorUnits`, an integer in USDC minor units. The loop copies both onto the
recorded capacity event. If the receipt carries neither event the outcome is **absent**, never
guessed, and a report counts those separately: a figure built from a guess is not a figure.

*Tested on real bytecode in both directions* (§4.6ai): the presented-unserved claim reports
`Defaulted` with the bond payout equal to the print-valued amount the scenario independently
computes, and the never-presented claim reports `Expired`; both verified failing first
(`expected undefined to be 'Defaulted'` / `'Expired'`). **Not yet verified end to end:** the loop's
copy of those fields onto the capacity event is a pass-through checked by the typechecker and not
by a loop-level test, because none of the loop tests drives a real settlement through
`runFullRunWindow`. The first debug run is where it is confirmed, and the block report flags any
settlement whose outcome is missing, so a gap there cannot pass as zero enforcements.

### 4.6ar Price parity: settling a quote in fSIU costs what settling it in USDC costs

Single-issuer instrument, apparatus change valid on either topology, found before the freeze.
A quote states a size (`siu`) and a price (`settlement[0].amount_max`). Paying in USDC paid the
price. Paying in fSIU paid the **SIU count** — `quote.siu` converted to milli-SIU — which is the
same dollars only if the quote's rate happened to equal the print, and nothing made it so: the
buyer types `rateUsdPerSiu` into `request_quote` and the seller signs what was asked. If one asset
is cheaper for identical work, F1 measures which is cheaper, not which agents prefer.

**Observed, on real bytecode, with the old sizing** (`dry-loop/price-parity.test.ts`; an
illustrative $0.01 print, identical quotes paid once in each asset, USDC minor units read from the
payer's balance): 2 SIU quoted at $0.05 cost 100,000 in USDC and **20,000** in fSIU — 80% cheaper;
4 SIU at $0.009 cost 36,000 and **40,000** — 11% dearer; 1 SIU at $0.003 cost 3,000 and
**10,000** — 3.3× dearer. The gap runs both ways, so it could not have been a consistent bias in
favour of fSIU. The test's own earlier fixture quoted $0.50 for 10 SIU against a $0.0107 print and
asserted a claim of 10,000 mSIU — worth about $0.107: a fixture built from the code's assumption
(§4.6ai) encoding the defect it was meant to catch.

**What the stored runs can and cannot say.** The artefacts keep sparse snapshots of each agent's
turns, not a quote ledger: across every stored run, six distinct signed quotes survive. All six
are 10 SIU quoted at exactly the print (the brief hands the buyer the print rate to type), and the
two assets' costs differ by at most 0.21%, which is the four-decimal rounding of the USDC price.
That is an observation about what buyers typed, not a guarantee, and it says nothing about quotes
that were not kept. It cannot be determined from the artefacts whether the 25-of-29 was affected;
it is one more reason that figure is not quoted (methodology, 2026-10-04).

**The rule.** An fSIU settlement is sized so the claim is worth the quote's USDC price at the
print in force: `claim = ceil(price / print)`, in integers (invariant 4). Rounding up means the
seller is never short; the payer overpays by strictly less than the dollar value of one milli-SIU
at the print. The print in force is the one the quote names (`print_id`) and must equal the one
the window attests; a quote against another print is refused, not converted. Parity is to the
quote's **stated** price, itself rounded to four decimals by the quote format.

**Every fSIU route that names a quote is held to it.** `pay_with_claim` mints that quantity.
`transfer_claim` naming a `requestId` — which used to mark the quote paid for **any quantity to any
recipient**, so one milli-SIU to nobody counted as a settled testing purchase and passed a window
— now sets the quantity from the quote and requires the recipient to be the quote's seller; which
claim to spend stays the holder's choice. `settle_split` already had parity by construction: its
claim leg is valued at the print and its dollar leg is the remainder of the price. A transfer that
names no quote settles none, and is reported separately.

**Tested** three ways (§4.6ai): hand-worked examples; a property over 5,000 generated
(price, print) pairs and over every route that names a quote; and the on-chain observation above,
which takes its expectation from the chain's balances and not from the sizing formula. Each was
verified failing against the old behaviour. The briefs and tool descriptions state the new sizing,
and a pairing test fails any brief example that passes a quantity the loop ignores.

**A residual asymmetry, not fixed here.** A USDC payer's escrow can settle for *less* than the
quote — a seller may claim less and the rest returns to the payer — whereas a claim moves whole.
Parity holds at the quoted price; the *settled* cost in USDC can fall below it. The block report
therefore uses the amount actually settled (§4.6as).

### 4.6as What a payment cost is built from: the amount settled, and what a claim cost to mint

Single-issuer instrument, apparatus change valid on either topology. A cost per delivered SIU built
from a quote's `amount_usd_max` overstates the dollar route (the ceiling is not what is paid), and
one that gives fSIU no dollar figure describes only the minority asset. The run artefact had
neither number, so both are now recorded, each read from the chain's own record and not
recomputed from the formula under test (§4.6ai).

- **USDC: the amount actually settled.** Each `settle_escrow` is recorded as a `usdcSettlement`
  (`settledMinorUnits`, `quotedMinorUnits`, keyed by the quote's request id, which is also the key
  of the payment that opened the escrow). A seller may settle for less than the ceiling and the rest
  returns to the payer; the loop test settles $0.0060 of a $0.0100 quote and checks the **payer's
  real net USDC outflow** is 6,000 minor units, not 10,000.
- **fSIU: what the claim cost to mint.** Every `mint_claim`, `pay_with_claim` and `settle_split`
  claim leg records `mintCostMinorUnits`, decoded from the mint receipt's own USDC `Transfer`
  log. `WorkClaim.mint` charges `quantity × rate ÷ 1e6` and the `Minted` event does not say so; the
  receipt is what actually moved. Checked against the payer's real USDC balance (5,000 reported,
  5,000 observed) and, through the loop, 15,000 for 1,500 mSIU at the dry loop's illustrative
  $0.01 per SIU.
- **Which quote a movement settled.** The capacity event of a payment records `settlesRequestId`,
  so a transfer that named a quote is told from one that named none, and a `serve_redemption`
  records the **holder** whose claim it burned.

**A finding the settled-amount test surfaced.** The seller received 5,970 of the 6,000 settled: the
escrow's protocol fee (0.5% on the devnet escrow; the live escrow's rate is its own `feeBps`) comes
out of the *seller's* proceeds, and the fSIU route charges the seller nothing. That is a
seller-side asymmetry between the two assets and is **not** a buyer's cost — price parity (§4.6ar)
is a statement about what the payer pays. It is recorded because a reader comparing what sellers
receive would find the dollar route short by exactly that fee.

### 4.6at The decision rule's reading of "held" and "spent onward", fixed before any result

Revised 2026-10-05; the rule is in `cli/decision-rule.ts` and was fixed as code on 2026-10-04.
**"Held fSIU it had been given"** means fSIU received **as payment from another agent** — never an
opening balance, an operator grant, or a claim the agent minted for itself. The ledger credits
only agent-to-agent movements; an external buyer and the operator's drain are not agents and are
never tracked; and ORCHESTRATOR, which nothing in this roster pays in fSIU, cannot be eligible by
any route it has (tested across all four). If a report ever marks it eligible that is a **counting
error** and the block report refuses to compute a verdict.

**"Spent onward"** is stated at the **balance** level, because fSIU units are fungible and which
unit left is not knowable: the agent paid in fSIU **out of its balance** (a transfer naming a
quote), at a moment it held received fSIU, and **did not redeem all of what it received**. A
payment made by minting a fresh claim and forwarding it (`pay_with_claim`, `settle_split`) never
touches the balance, so it is not spending the received stock. This reading is a judgement call
worth reviewing: the looser asset-level reading — paid in fSIU by *any* route while holding
received fSIU — is computed and reported beside it (`paidInFsiuWhileHoldingReceived`), never
silently substituted, because the shortest fSIU route is `pay_with_claim`, and counting it would
let the rule pass because agents take the shortest route and not because fSIU circulates. Unkeyed
agent-to-agent transfers count as received (an agent has no other reason to move a claim to
another agent) and are reported apart (`receivedUnkeyedMilliSiu`) so a reading can say whether
eligibility depended on them.

### 4.6au Quantity is a property of the job; the buyer sets the price, the seller only signs

Single-issuer instrument, apparatus change valid on either topology. **Who decides a quote's
terms.** A buyer types every term into `request_quote`, and `issue_quote` takes only a `requestId`
and signs the buyer's own stored body: a seller decides *whether* to sign and can alter nothing,
including what the quote settles in (asserted by handing the builder every term a seller might try
to change). So price **and size** were buyer-set, and the D4 testing purchase counted any paid
quote from the attacker at any size — a request for a thousandth of a SIU at a fraction of a cent
satisfied it, the same class of hole as §4.6ar's transfer.

**The rule: quantity is the job's, price floats.** The runner states each seller's job size — 10 SIU
for the gate, 4 SIU for testing, from its own constants — and a `request_quote` naming another size
is refused when the buyer asks, so a quote of the wrong size never exists to be signed or paid.
Engagement is counted the same way: a paid quote of another quantity does not engage. The refusal
says what the size is and that the rate is the buyer's, and the briefs say both before the refusal
can happen; a pairing test asserts the size shown in each brief's example is the size enforced.
A near-zero *price* is still possible and is left free by design; the cost metric reports what was
actually settled, so it is visible.

### 4.6av Tool descriptions are held to the same neutrality as the asset text

The canonical asset text is byte-compared and the pre-turn validator's blocklist searches the pack
and the tool-call history. **Neither covers `TOOL_DESCRIPTIONS`**, which every agent sees every turn
and which now carries the price-parity statements. Found by reading them against each other:
`pay` was 207 characters and `pay_with_claim` 494; `pay_with_claim` was framed "in fSIU instead of
USDC" (making USDC the default), carried a one-sided scarcity note ("headroom, which is finite and
shared") that `pay` had no counterpart for, and `transfer_claim` was sold as "free" and "instead of
paying in dollars". None is a blocklisted phrase and each can lean an agent.

They are rewritten to the same shape — `settles a quote the seller issued, in <asset>: …` — at 310
and 382 characters. A test now runs the blocklist over **every** description, rejects comparative
and loaded wording in the four payment tools, and asserts `pay` and `pay_with_claim` open alike,
state how the amount is set from the quote, and stay within 1.6× of each other in length. The
scarcity sentence was dropped rather than mirrored: the briefs do not otherwise state it next to
the payment options, so this removes one cue and does not add one — reviewable. The asset text
already states, and a test already pins, that a claim is redeemable from "the issuer named on the
claim", settles "against its bond" if a presented claim is not delivered, and "expires when it
closes", all true in every window.

### 4.6aw No floating point in the settlement path

`settle_split` computed `claimShare` as `(Number(a) / Number(b)).toFixed(4)` and its budget spend
the same way. A share is a ratio and not money, but it is derived from money, it is what F1 reports
per split, and it printed 0.1812 for 29/160 = 0.18125 exactly (a float stores the tie a hair
low). Both are now integer arithmetic, half-up on the exact ratio, checked over 5,000 generated
pairs against the SDK's decimal library as an independent reference. Changed before the first
debug run because anything changed after it resets the freeze, and a rounding error in settlement
is what the conservation checks must never see. The remaining floats in this package are inference
**cost** accounting (`totalRealizedUsd`, per-provider spend) and a display sort — neither moves
money between parties.

## 5. Identity, wallets and chain

### 5.1 Chain

**Base Sepolia** as primary, since the escrow and attestation contracts already live there with a working deploy path. Arc testnet as the mirror if the byte-identical deployment discipline from v4 §6 is maintained — worth doing, because ACR is on Arc and a comparison later is easier if both exist there.

Testnet USDC throughout. No mainnet, no real value, in this run.

### 5.2 Identity

Each of the six agents gets an **ERC-8004 identity** and its own EOA. Identity is not decoration here: it is what binds a quote signature to a seller, what the receipt records, and what the bond contract checks on issuance. An agent without an identity cannot issue, cannot be paid and cannot appear in the receipt graph.

```
agent
 ├─ EOA (private key, held by the runner, never by the model)
 ├─ ERC-8004 identity record
 ├─ USDC balance (testnet)
 ├─ fSIU claim balances, per class × window
 └─ skill file + information pack
```

**The key is held by the runner process, not exposed to the model.** The agent requests a signature through a tool; it never sees the key material. Same principle as the API keys: the model gets capability, never credentials.

### 5.3 Contracts

Five, and three of them already exist in some form.

| Contract | New? | Purpose |
| --- | --- | --- |
| `TouchstoneAttestation` | exists | Publisher key, print anchoring |
| `TouchstoneEscrow` | exists | USDC escrow for the operator→ORCHESTRATOR leg |
| `CapacityBond` | **new** | Per-issuer: committed capacity, measured rate, issuance ratio, headroom, slashing |
| `WorkClaim` | **new** | Dated claims. Mint, transfer, present-for-redemption, retire, default. Per class × window. |
| `ClaimRouter` | **new** | Given a class and quantity, selects an issuer with headroom. Holder never picks. |

**Token standard:** ERC-1155, not ERC-20. Each `(class, window)` pair is a token id, which is exactly the fungible-within-tenor property (§4.3) expressed natively. An ERC-20 per tenor would mean a new contract every window; ERC-1155 gives batch transfers and per-id supply for free.

### 5.4 Invariants to test

Adapted from v4 §7.7, which was the right shape for the wrong instrument.

```
1. HEADROOM CONSERVATION
   outstanding(issuer, class) ≤ issuance_limit(issuer, class), always.
   Minting decrements, retiring increments, no path does both.

2. NO EARLY REDEMPTION
   present_for_redemption before window.from reverts.

3. FAILED WORK RETIRES NOTHING
   A gate failure must leave the claim balance unchanged and headroom
   unchanged. Fuzz this: no sequence of failed submissions may retire a claim.

4. NO ADMIN PATH TO BONDS
   No role can move bonded USDC except through the published default rule.
   Assert from the compiled ABI plus a bytecode scan, as already done for escrow.

5. DEFAULT PAYS AT THE RIGHT PRINT
   Cash settlement uses the print on the default date, not the issue date,
   not the current one.

6. ROUTER NEVER LEAKS ISSUER CHOICE
   A holder cannot specify an issuer. Assert there is no code path that reads
   a caller-supplied issuer address during redemption.

7. CROSS-CLASS ISOLATION
   Headroom in class X can never serve a redemption in class Y.
```

Invariant 3 is the one to fuzz hardest. It is the mechanical form of the project's founding claim, and if it can be broken the instrument pays for effort.

## 6. Quote, receipt, multi-hop

### 6.1 Quote

Extends `touchstone-quote` (v4 §5) with the fields a claim-settled trade needs. **The settlement list must offer both assets with neither marked preferred** — that is what makes F1 a real observation.

```json
{
  "quote_id": "…",
  "seller": "erc8004:0x…",
  "task_spec_hash": "…",
  "class": "extract",
  "quantity_siu": 40,
  "quantity_display_integer": 40,
  "quality_gate_id": "gate_extract_v2",
  "print_id": "…",
  "price_usdc": "0.0400",
  "spread_to_index_pct": 11.1,
  "accepted_settlement": ["usdc", "fsiu:extract/2026-W40"],
  "expiry": "…",
  "delivery_deadline": "…",
  "signature": "0x…"
}
```

`spread_to_index_pct` is first-class per v4 §5 — *"0.14 SIU, +102% above index" is actionable; "0.14 SIU" alone is not.* It is also the field that makes Work TCA computable directly from the quote stream.

**Note added 2026-09-27:** `"fsiu:extract/2026-W40"` reads as if class and window were the whole
identity — the real on-chain token id also carries issuer and grade (§4.3's correction above).
This string is a display convenience in these examples, not the wire format; it isn't rewritten
here to avoid touching the quote/receipt schema for a documentation-only fix.

### 6.2 Receipt

```json
{
  "receipt_id": "…",
  "parent_payment_id": "…",
  "quote_id": "…",
  "buyer": "…", "seller": "…", "executor": "…",
  "class": "extract",
  "siu_delivered": 40,
  "gate_results": { "G1": true, "G2": true, "G3": true, "G4": true, "G5": true },
  "settlement_asset": "fsiu:extract/2026-W40",
  "settlement_amount": 40,
  "usdc_equivalent_at_print": "0.0400",
  "print_id": "…",
  "methodology_version": "SIU-2026a",
  "claim_retired": true,
  "usage": { "input_tokens": …, "output_tokens": …, "retries": … },
  "artefact_hashes": { "gate_spec": "…", "adversarial_cases": ["…"] }
}
```

`claim_retired: false` alongside a failed gate result is the record that proves *failed work counts zero*. Those receipts are the most valuable ones in the run and must be kept, not filtered as errors.

### 6.3 The multi-hop chain

```
OPERATOR ──USDC──▶ ORCHESTRATOR          job: harden gate_extract_v1
                        │
                        ├──?──▶ WORKER-EXTRACT     write candidate + reference
                        │            │
                        │            └──?──▶ WORKER-CODE   (sub-subcontract,
                        │                      if it chooses to)   adversarial cases
                        │
                        └──?──▶ WORKER-EXTRACT     harden against the cases
                                     │
                                     └──redeem──▶ ROUTER ──▶ ISSUER-A or B
```

The `?` is the finding. Each agent chooses USDC or fSIU per hop, and nothing tells it which.

**Depth 3 is the target**, because depth 2 is a subcontract and depth 3 is a chain — the point at which unwrapping at every hop would actually cost something, which is the only functional argument for the instrument (v4 §9).

### 6.4 What the receipt graph answers

- **Do agents subcontract at all**, unprompted, when they could do the work themselves?
- **At which hop does conversion happen?** If every agent redeems to USDC on receipt, the instrument has no transitive use and F1 is answered negatively — cleanly, and early.
- **Does a claim ever travel more than one hop before redemption?** That single number is close to the whole case for fSIU existing.
- **Where did value leak?** Sum of child payments against parent payment, per job.

## 7. The three experiments

### 7.1 F1 — the choice test

**Question:** when USDC and fSIU are equally available and nothing recommends either, which do agents use?

**Protocol.** Every worker and the orchestrator open with balances in both, sized to roughly equal purchasing power. Quotes list both settlement assets with no preference marker. No skill file, prompt or information pack mentions a preferred asset. Agents are told only what each asset is and how to use it.

**THE CAPTION. No F1 number may be reported without these two sentences attached.** Both are
properties of the instruments or the scenario, not of agent preference, and a figure quoted
without them is the figure that gets retracted:

> **Agents chose fSIU N of M times, where fSIU settles unilaterally and USDC requires a
> seller-issued quote; and where every claim routed to the deliberately non-serving issuer, so
> the claim route defaulted in every window and never delivered.**

The first clause is a real difference between the instruments and part of the result — a bearer
claim can be sent, a dollar payment against a quote cannot, and a preference for unilateral
settlement *is* a reason to want a bearer instrument (§4.6ab). The second is a property of this
scenario, not a finding about fSIU: first-fit routing sends every claim to the issuer that
cannot serve, and that was analysed and deliberately left unfixed (§3.5a). A reader must be able
to see both without going looking.

There is also a separable artefact that is neither: the dollar route costs the buyer **one extra
turn** (`request_quote` then `pay`, against `pay_with_claim` alone), because a seller cannot
quote unprompted. That is the loop, not the dollar, and it is quantified rather than hidden.

**Measured:**

| Metric | What a positive result looks like |
| --- | --- |
| Share of payments settled in fSIU | > 50% and rising across the run |
| Median hops before redemption | > 1 |
| Time-to-redeem after receipt | Not immediate — held across at least one job |
| Quote denomination when the seller is free to choose | SIU rather than dollars |

**(d) Scarcity that binds only one route would produce a false result in either direction.** Found
live in the first real P5 window and fixed on 2026-09-28: capacity was consumed by minting a claim
and by nothing else, so an agent weighing the two routes was really weighing "accept a constraint"
against "don't". Both routes now draw on the same bonded pool (§4.4's RESERVE/RELEASE rows). The
remaining differences between them are real properties of the two instruments, not artefacts of
the plumbing, and are stated there and in every run output: a claim reserves capacity for a future
window and is transferable; a dollar payment consumes it for immediate work only.

**The protocol is fragile in one specific way.** A single sentence anywhere in an agent's context saying "pay in fSIU" invalidates the finding permanently. Review every prompt for this before the run and keep the diff under version control.

**Three further threats to validity, each with a structural fix rather than a caveat.**

**(a) Expiry pressure would produce a false negative.** Claims are dated, so as a window nears its end, holding becomes costly and redeeming becomes rational *regardless of preference*. A finding of "agents redeem immediately" could then be expiry pressure rather than rejection of the instrument — a false negative on the thing you most want to learn.

Fix, structural rather than analytical: **run two claim windows, and place the F1 arm entirely within the first half of the earlier one.** A hold decision is then never taken within sight of expiry. Log `time_to_expiry` on every hold and redeem decision anyway, so the analysis can demonstrate the separation rather than assert it. The second window then yields the term-structure observation (§7.4) as a side effect.

**(b) One model family is one disposition sampled repeatedly.** If ORCHESTRATOR and both workers run the same model, six agents choosing USDC is one prior observed six times, not six independent choices. **The deciding agents must span at least two model families** — see §12.2a, where this is a blocking validator rule.

**(c) One run is an anecdote.** Behaviour here is sensitive to seed, phrasing and model. **No F1 number may be quoted from fewer than five runs** differing only in seed, with the dispersion across runs reported beside the headline. The `bench diff` command (§14.4) makes this cheap, and stating the minimum now is free where adding it later is not.

**Negative result is a real result.** If agents redeem on receipt every time, the instrument has no transitive use, and that is worth knowing before building a contract for it.

### 7.1a The protocol freeze, and what breaks a block

Agreed 2026-09-30, before the five comparable runs. §7.1(c) sets the floor at five runs differing
only in seed; this is what "only in seed" is allowed to mean in practice, decided in advance
because these are exactly the judgements nobody makes well at run 3 with four good runs behind
them.

**The protocol freezes at the debugging run.** No fix lands during the five, however obviously
right. Every run in this project's history surfaced something worth fixing mid-flight, and the
discipline that makes five runs comparable is precisely not doing that.

Three categories, and the distinction that matters is whether the thing changes *what an agent
could express*:

**Finish and disclose.** An agent behaving oddly, a gate failing, an attack not landing, a window
producing nothing, a purchase not made. These are results, however disappointing, and a run that
produced one is a valid member of the block.

**An affordance defect ENDS the block.** Not restarts it — ends it. If one is found in run 3, the
remaining two would execute under a protocol already known to be wrong, and the block's findings
could not be quoted either way. So: finish the run in progress, report it, stop. The default is
stop rather than continue, and whether to fix and start five fresh is a decision taken with the
report in hand rather than mid-block.

This is the category that has bitten eight times (§4.6a, §4.6e–g, §4.6n, §4.6p, and the two
surfaced while building the freedom set), which is why it gets the strictest rule.

**A provider outage means re-running THAT run, not the block.** An outage is external and changes
no protocol, so the completed runs stay comparable with each other and with a replacement. Losing
four good runs to one bad hour would be a self-inflicted cost. Record which run was re-run and
why, so the block's composition is legible afterwards.

### 7.2 F2 — the shock test

**Question:** does a forward actually protect a fixed-price seller when the cost of work moves?

**Setup.** HEDGER commits on day 1 to deliver 10 gate-hardening jobs at a flat price. Two arms, identical in every other respect, run against the same job sequence and the same seeded gates.

```
ARM 1 (hedged)     day 1: buys forward from ISSUER-A covering expected consumption
ARM 2 (unhedged)   day 1: buys nothing, pays spot per job

day 8: print rises materially (see below)

both arms deliver the remaining jobs at the day-1 flat price
```

**Moving the print honestly.** Do not fake a number — that would corrupt the index, and a faked print in a testbed has a way of ending up in a chart later. Two clean options: **(a)** run the shock arm against a *reference print series* clearly labelled as a scenario series, separate from the published print and never anchored; or **(b)** time the run across a real print move if one is expected, and accept less control. (a) is recommended, with the scenario series published alongside the results so the shock is reproducible.

**Measured:** P&L per arm; whether arm 2 delivers all 10 jobs or stops; cost per delivered SIU in each arm.

**The output is one chart**, and it is the chart to put in front of a real fixed-price vendor. Nothing else in this run produces evidence that the instrument does economic work.

### 7.3 F3 — the integer control arm

**Question:** do agents make fewer decision errors when quantities are integers in a work unit than decimals in dollars?

**Protocol.** Every agent decision involving a numeric comparison — quote selection, budget check, spend-cap evaluation, reroute — is executed **twice against identical state**: once with quantities as decimal USDC (`0.00034`), once as integer work units (`340`). Only one arm's decision is acted on; the other is recorded and discarded. Alternate which arm is live to avoid path divergence.

**Measured:** decision error rate per arm, where an error is a comparison whose outcome contradicts the ground-truth ordering. Report per model, since this is a model-capability finding as much as a unit-design one.

**Why it belongs here.** It is nearly free — the decisions are happening anyway — and it produces the monetary design's strongest empirical claim (§3.3). It is also the only finding in this run that survives regardless of what happens to fSIU, because it is evidence about the *unit*, not the instrument.

### 7.3a F3 runs standalone, not inside the market — and why

**Status as of 2026-10-02: specified, partially built, never exercised, and structurally unable
to produce a figure.** `DualRenderer` exists and is instantiated per agent, but it is wired into
exactly one tool (`get_balances`), it shows the agent **both** representations at once —

```json
{"usdc":{"decimalUsd":"0.305618","integerMinorUnits":"305618","liveArm":"decimal"}}
```

— and `allRecords()` is never called, so the records die with the process. No run report has ever
contained an F3 result. It also does not do what §7.3 specifies: §7.3 says each decision is
*executed twice against identical state*, and the implementation alternates which form is
nominally live across turns.

**The Gate Market is the wrong venue, and defining the error metric is what shows it.** The
metric needs decisions with objectively correct answers — which of two amounts is smaller, does
a balance cover a cost, is a quote above or below a reference. The market has almost none: there
is **one seller per job**, so no two-quote comparison ever occurs, and five runs would yield
perhaps 15-30 genuine numeric decisions. That cannot detect a modest effect, and it would be
buried inside $10 of market runs whose failures are affordance defects.

**So F3 runs standalone. It does not block the protocol freeze.**

#### Three arms, because two would confound the claim

| arm | shown as | tests |
| --- | --- | --- |
| decimal USD | `$0.014170` | the baseline agents face today |
| integer minor units | `14170` | **integers beat decimals** — true of any currency |
| integer work units | `10000 mSIU` | **this unit beats dollars** — the claim that justifies SIU |

Without the minor-units arm those two are confounded, and only the second is a result nobody
else can produce. The first is a fact about number formatting that any team could establish.

#### Four comparison types, and the one that can falsify the story

| type | example | tests |
| --- | --- | --- |
| order-of-magnitude | `0.0034` vs `0.00034` | the 10x error — the expensive one in a payment |
| unequal decimal length | `0.0003` vs `0.00029` | place-alignment, where integers should help most |
| **transposition** | `0.001417` vs `0.001471` | **the control** |
| coverage | does a balance of X cover a cost of Y | a decision, not only a comparison |

**The transposition control is the point of the design, not a footnote.** Transposed digits are
equally hard in every arm — place-alignment is not the mechanism there. So if integers beat
decimals on transposition too, the proposed explanation is **wrong**, and the same data says so.
An experiment of this shape that omits the control cannot falsify its own story.

#### Method

- **Paired**: the same underlying comparison in every arm, arm order randomised per trial, one
  representation shown at a time, never labelled, never two at once.
- **Magnitudes from the run records** — rates `0.001400`-`0.001440`, costs `0.008`-`0.015`,
  quantities `3,000`-`16,000` mSIU — so the decimals are the ones agents actually face.
- **Inside a decision frame** ("you are settling a quote; which costs less?"), never as bare
  arithmetic. The claim is about representation under decision conditions, not about sums.
- **Error metric**: proportion answered incorrectly, per model per arm, with **Wilson** intervals
  (correct at low error rates where the normal approximation is not).
- **Comparison**: **McNemar** on the paired responses, which uses only discordant pairs and is
  the right test when the same item is answered under two conditions.
- **Power**: detecting 8% -> 4% at 80% power needs about **400 paired trials per model**; four
  model families across three arms is roughly 4,800 calls.
- **Constrained and unconstrained as a factor.** Constrained (answer-only, low effort) measures
  perception; unconstrained measures what happens in a loop, which is the claim that matters for
  agents. **Reported separately — a result that holds only under constraint is a weaker claim
  and must be labelled as one.**

#### The floor effect is planned for, not merely noted

Frontier reasoning models may answer everything correctly in every arm. If so the finding is
"the unit does not matter for models of this class", which is publishable — **but only if the
trials were hard enough to produce errors at all.** A null at the floor says the trials were
easy, not that representation is irrelevant, and the two are not distinguishable after the fact.

So the full run is **gated on a 50-trial pilot**, and the pilot's per-arm error rates are
reported before anything scales. If they sit at the floor, the magnitudes are calibrated toward
where error appears — more decimal places, closer values, a tighter token budget per answer —
and **what was changed is stated**, so the eventual null reads as *"no difference where errors
occur"* rather than *"no errors occurred"*.

### 7.4 Secondary observations worth capturing

Not experiments, but cheap to record and useful later:

- **Rate fingerprints** for both provider/model pairs, from the probe workload (§4.1). Builds the baseline library v4 §8.11 wants.
- **Quote accuracy**: quoted SIU against measured SIU, per agent, per class.
- **False-accept rate** of each gate generation, which is the gate-hardening artefact's headline number.
- **Term structure**, if three weekly windows produce three observable prices. Three points is not a curve, but it is the first evidence of whether one would form.

## 8. Skill files and information packs

Each agent gets exactly two things: a **skill file** (how to operate) and an **information pack** (facts it would otherwise waste budget discovering). Nothing else.

### 8.1 The common pack — every agent

- Current per-class prints (`code`, `extract`), refreshed each cycle
- `touchstone-quote` schema and receipt schema
- Its own wallet address, ERC-8004 id, and current balances
- The two asset descriptions, **written symmetrically** (see 8.5)
- Its class's gate definition and commercial-intent statement
- Tool list and call signatures

**Not in any pack:** the monetary design doc, this spec, the promise ladder rationale, the experiment descriptions, or any statement about which asset is preferred.

### 8.2 `issue-work-claims` (ISSUER-A, ISSUER-B)

```
You issue dated claims on AI work against capacity you have bonded.

WHAT YOU HOLD
  A capacity lot: {class}, {measured_rate} SIU per capacity-hour,
  {committed_hours} hours, valid {from}–{until}.
  A bond of {amount} USDC. Your issuance limit is
  committed_hours × measured_rate × 0.5.

WHAT YOU CAN DO
  mint_claim(class, quantity, window)   consumes headroom, pays you USDC
  serve_redemption(claim_id, task_spec) executes work, restores headroom
  check_headroom(class)
  get_print(class)

YOUR GOAL
  Sell claims for USDC, and serve every redemption routed to you inside
  its delivery window. A redemption you fail to serve defaults against
  your bond.

WHAT YOU MUST NOT DO
  Issue beyond headroom. Refuse a routed redemption you have headroom for.
  Choose which holders to serve — the router decides, not you.

EVERY TURN, APPEND TO YOUR FRICTION LOG (see schema).
```

### 8.3 `subcontract-and-settle` (ORCHESTRATOR)

```
You take gate-hardening jobs and deliver them, doing the work yourself
or subcontracting it.

THE JOB
  Given a candidate gate and a reference task, produce a hardened gate that
  (a) rejects every adversarial case found against the candidate,
  (b) still accepts the pinned known-good submission,
  (c) executes deterministically.
  You are paid only if the delivered job passes G1–G5. A failing job pays nothing.

WHAT YOU CAN DO
  request_quote(seller, task_spec)      receive a signed quote
  pay(seller, asset, amount, parent_payment_id)
  submit_job(job_id, artefacts)         runs the gate checks
  get_balances()  get_print(class)

YOUR GOAL
  Deliver as many passing jobs as possible within your budget.
  You are scored on jobs passed and cost per SIU delivered.

EVERY PAYMENT MUST CARRY parent_payment_id linking it to the job it serves.
```

### 8.4 `quote-and-deliver` (WORKER-CODE, WORKER-EXTRACT)

```
You sell work. You have two roles depending on what you are asked for.

AS BUILDER (your own class)
  Write candidate gates and reference instances; harden gates against
  adversarial cases supplied to you.

AS ADVERSARY (the other class)
  Produce submissions that PASS the candidate gate while violating the
  stated commercial intent. A submission that fails the gate is worthless;
  a submission that satisfies the intent is worthless. You are looking for
  the space between the gate and the intent.

WHAT YOU CAN DO
  issue_quote(task_spec, class, quantity_siu, accepted_settlement[])
  deliver(quote_id, artefacts)
  pay(seller, asset, amount, parent_payment_id)   you may subcontract
  redeem_claim(claim_id, task_spec)
  get_balances()  get_print(class)

YOUR GOAL
  Win work, deliver work that passes its gate, and quote accurately.
  You are scored on gate pass rate, quote accuracy, and — as adversary —
  how many of your submissions defeated a candidate gate.
```

### 8.5 The symmetric asset description

This paragraph is the most load-bearing text in the run. It appears identically in every pack.

```
You hold two assets.

USDC is a dollar. 1 USDC = $1. Every counterparty accepts it, and it has
no window and does not expire. Paid against a quote, it is held in escrow
until the seller settles. A seller may settle for less than it quoted, and
whatever it does not claim returns to you. Its dollar value never moves.

fSIU is a dated claim on completed work. One fSIU of class C, window W,
entitles the holder to one SIU of qualifying work in class C from the
issuer named on the claim, during window W. A presented claim that the
issuer does not deliver can be settled against its bond once the window
closes. It cannot be redeemed before the window opens, and expires when it
closes. Its dollar value moves with the published price of work.

Any quote can be settled in either, or partly in each.
```

Neutral in tone and structure, and within 1.44x in length (294 vs 424 characters). No adjective favours either. **Do not let this drift during implementation** — it is the entire validity of F1.

**Changed 2026-10-04 (single-issuer instrument, W1c), by decision of the operator.** The original text is below, kept so a reader can see exactly what moved.

```
You hold two assets.

USDC is a dollar. 1 USDC = $1. It is accepted by every counterparty.

fSIU is a claim on completed work. One fSIU of class C, window W,
entitles the holder to one SIU of qualifying work in class C, deliverable
during window W. It is accepted by counterparties that list it. It cannot
be redeemed before its window opens. Its dollar value moves with the
published price of work.

You may pay in either. Sellers state which they accept in their quotes.
```

Two of its sentences were false of the run — §4.6-RULE, the agent told a guarantee the system does not implement. *"Sellers state which they accept in their quotes"*: the quote format permits exactly one settlement entry and it must be USDC, so a quote states nothing about fSIU; since 2026-10-04 every quote can be settled in either asset, or partly in each. *"It is accepted by counterparties that list it"*: nothing is listed. It was also about 5x longer for fSIU than for USDC. The rewrite adds the three mechanics that hold in **every** window — redeemable from the issuer named on the claim, recoverable from that issuer's bond if a presented claim is not delivered, expiry when the window closes — and deliberately names no issuer, since which issuer serves or fails is what this instrument varies. Runs before this date carry the original text and are a different instrument.

### 8.6 The friction log

Appended by every agent every turn. This replaces the discarded "agents recommend improvements" goal: evidence from an agent that transacted, not opinion from one that read a spec.

```json
{
  "agent": "WORKER-EXTRACT",
  "turn": 47,
  "job_id": "…",
  "attempted": "pay WORKER-CODE 40 SIU in fsiu:extract/2026-W40",
  "outcome": "rejected — seller accepts only code-class claims",
  "could_not_express": "a quote conditional on the adversary finding at least one case",
  "forced_conversion": true,
  "conversion_reason": "seller would not accept my class of claim",
  "missing_information": "no way to see which classes a seller accepts before requesting a quote",
  "decision_confidence": "low"
}
```

The three fields that matter most: `could_not_express`, `forced_conversion` with its reason, and `missing_information`. Those are the design findings, and they are grounded in an actual failed attempt rather than a model's speculation about what might be inconvenient.

## 9. Run protocol

### 9.1 Phases

| Phase | Work | Exit condition |
| --- | --- | --- |
| **P0 — Harness** | Reference harness, seeded gates, known-good submissions, G1–G5 executor, probe workload | Every seeded gate passes G5 deterministically; known-good accepted; at least one hand-written adversarial case defeats each seeded gate |
| **P1 — Contracts** | `CapacityBond`, `WorkClaim`, `ClaimRouter` on Base Sepolia; invariant suite green | All seven invariants (§5.4) pass, invariant 3 fuzzed |
| **P2 — Rate measurement** | Probe workload against both provider/model pairs; capacity lots created and bonded | Two lots with measurably different rates; fingerprints recorded |
| **P3 — Dry loop** | One scripted job, no models: mint, transfer, redeem, retire, receipt | A complete receipt at depth 1 with `claim_retired: true`, and a failed-gate receipt with `claim_retired: false` |
| **P4 — Single-agent** | ORCHESTRATOR alone, does the work itself | One job passing G1–G5 with a real model in the loop |
| **P5 — Full run** | All six agents, three weekly windows | See 9.2 |
| **P6 — Shock arms** | HEDGER hedged and unhedged against the scenario print series | Both arms complete or arm 2 fails, either of which is the result |
| **P7 — Analysis** | F1/F2/F3 written up; gate artefacts extracted; friction logs synthesised | — |

P3 before P4 is not optional. Debugging settlement logic with a model in the loop wastes budget on nondeterminism.

### 9.2 Full run parameters

```
Duration            3 weekly delivery windows
Jobs per window     6–10 gate-hardening jobs, alternating class
Agent turn budget   capped per agent per window
Spend ceiling       hard USDC cap per agent; hard inference cap per window
Print cadence       daily, per class, from the live pipeline
Scenario series     separate, labelled, for P6 only
```

### 9.3 Abort conditions

The pipeline's existing discipline applies: it refuses to publish bad data rather than publishing stale data. Same here — **the run halts and publishes nothing rather than producing a result that will be cited wrongly later.**

| Condition | Action |
| --- | --- |
| Any agent obtains or proxies a provider API key | **Halt immediately.** Non-negotiable — this is the failure that could cost index constituents. |
| An asset preference leaks into any prompt or pack | Halt, fix, restart F1 from scratch. Partial data is worse than none. |
| Invariant 3 fails under fuzzing | Halt. Failed work retiring a claim breaks the founding claim. |
| Spend ceiling hit | Halt that agent, continue the run, disclose the truncation |
| A gate becomes non-deterministic | Quarantine that gate, continue, record it |
| Scenario print series confused with a published print anywhere | Halt and audit. This one contaminates the index. |

### 9.4 Cost estimate

At current print cost of roughly $0.09–0.11 per index print, the inference cost here is dominated by agent turns rather than by the graded work. Six agents, \~10 jobs per window, three windows, with adversarial generation being the expensive part. Order of magnitude: **tens of dollars of inference, not hundreds** — but set the hard ceiling anyway, because an agent loop that retries is the one thing that turns that estimate false.

### 9.5 What gets published

- **Internally:** everything, including failed receipts and friction logs.
- **Externally, if anything:** F3 (the integer finding) stands alone and is publishable on its own merits. F1 and F2 must carry the §1.1 caveat in the same visual frame as the result, not in a footnote. The hardened gates and their false-accept rates belong in the methodology appendix.
- **Never externally:** any number derived from the scenario print series without the scenario label attached.

## 10. Claude Code prompts

Eight work packages, in dependency order. Each is a standalone prompt — paste one, get it green, move on. Give each session this doc plus the named prior outputs and nothing more.

**Standing instruction, prepend to every prompt:**

```
This is WP-n of the Gate Market testbed. Read docs/gate-market-spec.md first.
Testnet only. No mainnet addresses, no real funds, no live API keys in any
agent-reachable code path. Write tests before implementation. Do not proceed
to the next work package.
```

### WP-1 — Reference harness and the gate executor

```
Build the gate-hardening harness.

1. A GateSpec format: declarative, executable, deterministic. A gate takes a
   submission and a reference task instance and returns accept/reject plus a
   reason. No model may be invoked during gate execution.

2. Two reference task instances:
   - code:    a repo with one seeded bug and a pinned pytest suite
   - extract: a source document and a pinned JSON schema
   Each with a pinned known-good submission that must be accepted.

3. Three seeded candidate gates per class, of deliberately varying weakness.
   Weakness means: passable by a submission that violates the commercial
   intent. Write the intent statement for each class as a separate file.

4. The G1-G5 executor from spec section 2.4. Pure function, no network,
   no model. Returns a per-check result object.

5. Prove each seeded gate is genuinely weak: hand-write at least one
   adversarial submission per seeded gate that passes it while violating
   the intent. These are fixtures, not test data — they prove the task is
   not trivially unsolvable or trivially solved.

Tests: every seeded gate deterministic across 3 runs; every known-good
accepted; every hand-written adversarial case passes its seeded gate and is
rejected by a hand-hardened version.
```

### WP-2 — Contracts

```
Implement CapacityBond, WorkClaim, ClaimRouter (spec section 5.3) in Solidity
with Foundry, for Base Sepolia.

WorkClaim is ERC-1155. Token id = keccak(class, window). Per spec 4.3.

Hard requirements:
- present_for_redemption reverts before window.from
- a failed gate result must leave claim balance AND headroom unchanged
- no admin path to bonded USDC except the published default rule
- redemption has no code path that reads a caller-supplied issuer address
- headroom in class X can never serve class Y
- default settles at the print on the default date

Write all seven invariants from spec 5.4 as Foundry invariant tests.
Fuzz invariant 3 (failed work retires nothing) across arbitrary operation
sequences, minimum 10000 runs. Add a bytecode scan asserting no DELEGATECALL
or SELFDESTRUCT, matching the existing TouchstoneEscrow check.
```

### WP-3 — Probe workload and capacity lots

```
Build the conversion-rate probe.

Run a fixed workload against a provider/model pair through the Touchstone
harness, measure SIU delivered per capacity-hour per class, and emit a
capacity_lot per spec 4.1. The rate must be measured, never configured.

Also emit a rate fingerprint per pair: tokens/sec, retry rate, gate pass
rate, cost per completed task. Store these as baselines — they are reusable
outside this testbed.

Run against two pairs chosen so the measured rates differ materially.
If they do not differ, pick different pairs and say why in the output.

Tests: probe is reproducible within a stated tolerance on repeat runs;
lot JSON validates; no API key is reachable from outside the harness module.
```

### WP-4 — Agent runtime

```
Build the agent runtime. No agent logic yet — just the substrate.

Per agent: an EOA whose key lives in the runner and is NEVER placed in model
context, an ERC-8004 identity record, balance tracking for USDC and per-
(class,window) claims, a tool-call interface, and a friction log writer
(schema in spec 8.6).

Tools: request_quote, issue_quote, pay, redeem_claim, mint_claim,
serve_redemption, submit_job, get_balances, get_print, check_headroom.
Every tool call and result logged with turn number and job id.

Critical: the model requests signatures through a tool. It never sees key
material and never receives a provider API key. Add a test that greps the
assembled model context for key patterns and fails if any appear.

Also implement the F3 dual-rendering hook: every numeric comparison a tool
surfaces is rendered twice, decimal-USDC and integer-work-unit, with one
arm live and the other recorded. Spec 7.3.
```

### WP-5 — Dry loop, no models

```
Script the full economic loop with no models involved.

mint -> transfer -> present_for_redemption -> harness executes ->
gate passes -> claim retired, headroom restored, receipt emitted

Then the same with a deliberately failing submission, asserting
claim_retired == false and headroom unchanged.

Then a 3-hop chain with parent_payment_id set at every hop, and assert the
receipt graph reconstructs: sum of child payments <= parent payment.

Then force each of the three interesting states from spec 4.5: headroom
exhaustion, cross-class unavailability, and default with re-routing.

This package must be green before any model is connected.
```

### WP-6 — Skill files and packs

```
Write the three skill files and the information packs from spec section 8,
verbatim where the spec gives text.

Then write a validator that runs before every agent turn and FAILS THE RUN if
the assembled context contains:
  - the monetary design doc or this spec
  - any string suggesting a preferred settlement asset
  - any deviation from the symmetric asset description in spec 8.5
  - any provider API key pattern

The asset-preference check is the important one. Implement it as an explicit
phrase blocklist plus a byte-comparison of the asset description against the
canonical text. This validator protects the only behavioural finding in the
experiment; treat a failure as a halt, not a warning.
```

### WP-7 — Agents and the full run

```
Wire the six agents from spec section 3 and run phases P4 then P5.

P4: ORCHESTRATOR alone, doing the work itself, one job to a passing gate.
P5: all six, three weekly windows, parameters in spec 9.2.

Enforce every abort condition in spec 9.3. Hard spend ceiling per agent and
per window. On ceiling, halt that agent, continue, record the truncation.

Emit per window: receipt graph, friction logs, settlement-asset shares,
hops-before-redemption, quote accuracy, gate false-accept rates, F3 arm
comparison.
```

### WP-8 — Shock arms and analysis

```
Run P6 and produce the analysis.

HEDGER, two arms, identical job sequence and seeded gates, against the
SCENARIO print series (spec 7.2 option a). The scenario series must be
stored separately from published prints, labelled in every record, and never
anchored on chain. Add a test asserting no scenario value can be read by the
published-print code path.

Outputs:
  - F1: settlement-asset share over time, hops before redemption, quote
        denomination when the seller was free to choose
  - F2: P&L per arm across the shock. One chart.
  - F3: decision error rate, decimal vs integer, per model
  - Artefacts: hardened gates per class with measured false-accept rates
  - Friction synthesis: could_not_express, forced_conversion, and
    missing_information grouped by theme, with the receipt each came from

Every F1 and F2 output carries the spec 1.1 caveat in the same frame as the
result, not as a footnote.
```

## 12. The operator console

The testbed above assumes a runner reading config files. That is fine for one run and wrong for a bench you will use repeatedly, so this section specifies the console. **It is the largest work package in the spec** — plausibly more code than the contracts and agents combined — which is worth knowing before starting, because it competes for time with the three shippable items in the monetary design (§13 there: the scale fix, the integer experiment, Work TCA).

Recommendation: **build it thin.** Four screens, read-mostly, no platform ambitions. Every hour spent on the console is an hour not spent on the findings.

### 12.1 The four screens

| Screen | Purpose | Write access |
| --- | --- | --- |
| **Bench** | Define a run: which agents, which task pack, parameters, ceilings | Full |
| **Agents** | Provision identity and wallet, attach skill and task, fund, inspect | Full |
| **Flow** | Live transaction graph, receipts, message stream | Read only |
| **Provider** | Capacity lots, headroom, mints, redemptions, defaults | Read + lot creation |

### 12.2 Agent builder

One form, one agent. Everything it does is also expressible as YAML, and the YAML is the source of truth — the form writes it. That is what makes a run reproducible and what lets you diff two runs.

```yaml
agent:
  name: WORKER-EXTRACT
  role: worker
  skill: quote-and-deliver          # picked from the registry
  class: extract
  adversary_for: code
  goal: >
    Win and deliver extract work; act as adversary on code jobs.

  # TWO model fields, never one. See 12.2a.
  reasoning_model:                  # what the agent thinks with
    provider: <from registry>
    model: <from registry>
  capacity_model:                   # what serves redemptions it issues
    null                            # issuer roles only; hidden otherwise

  wallet:
    chain: base-sepolia
    provision: new                  # or: reuse <address>
  identity:
    erc8004: auto
  opening_balance:
    usdc: "25.00"
    claims:
      - "extract/2026-W40: 500"
      - "code/2026-W40: 500"
  caps:
    turns_per_window: 40
    usdc_ceiling: "25.00"
    inference_ceiling_usd: "3.00"
  info_pack: [common, gate-extract, commercial-intent-extract]
```

**Provisioning, one button:** generate EOA → store key in the runner's keystore, never in model context → register ERC-8004 identity → fund from the faucet or operator wallet → mint opening claim balances → write the agent record. Show the address, the identity id and the balances when it completes.

### 12.2a Model assignment — two fields, never one

Two distinct things are being chosen, and conflating them corrupts the two-issuer comparison.

| Field | What it is | Required for |
| --- | --- | --- |
| `reasoning_model` | What the agent thinks with — decisions, negotiation, writing gates, writing attacks | **Every agent** |
| `capacity_model` | What serves redemptions of the claims this agent issues | **Issuer roles only**; hidden for other roles |

An issuer's measured conversion rate must depend **only** on `capacity_model`. With one combined field, §3.5's rate comparison would be contaminated by how the issuer reasons rather than by what it serves, and the whole efficiency arithmetic becomes unreadable.

**Both fields are dropdowns populated from `data/registry/models.json`.** No free-text model strings, so only admitted, priced models can be selected — and the assignment is made from what the registry actually contains rather than from a remembered list.

#### Validator rules, shown as badges like the context validator

| Rule | Severity | Reason |
| --- | --- | --- |
| **The builder and the adversary for a given class must not share a model family.** Scoped to that pair only. | **Block** | An attacker sharing the gate-writer's family shares its blind spots and will not find the holes the writer could not see. This is the most important assignment rule in the run. |
| Deciding agents (orchestrator + workers) span at least two families | **Block** | F1 threat (b) — one family is one prior sampled repeatedly |
| `capacity_model` differs between ISSUER-A and ISSUER-B | **Block** | Identical capacity models leave the two-issuer comparison with nothing to compare |
| Measured rates of the two issuers differ materially after the probe | Warn | If they come back equal, pick different pairs and record why |

**Scope the first rule carefully.** It applies to the builder/adversary pair per class and to nothing else. Two agents sharing a family is fine when neither attacks the other's gate — an issuer and the orchestrator sharing a family has no bearing on anything. A validator that fires on every same-family pair will be switched off within a day, which is worse than not having it.

#### Before the run starts

Show per agent: projected inference cost from the chosen `reasoning_model` against that agent's `inference_ceiling_usd`, and the family-coverage summary across deciding agents. Record **both** model fields in `manifest.yaml` so `bench diff` surfaces a model change explicitly rather than burying it in a config blob.

### 12.3 Skills and tasks are registry objects, not free text

This is the part that makes the bench reusable rather than a one-off with a form on top.

```
/skills/<name>/
    SKILL.md            the operating instructions (spec §8)
    tools.yaml          which tools this skill may call
    scoring.yaml        how an agent with this skill is scored

/task-packs/<name>/
    PACK.md             what the task is, in operator language
    goals/<role>.md     the goal text injected per role
    gates/              the machine-checkable gate executor
    fixtures/           reference instances, known-good submissions
    intent/             commercial-intent statements
    scoring.yaml        pack-level metrics
```

The console lets you attach any skill to any agent and any task pack to any bench. **Gate hardening is the first pack, not the only one** — the three obvious successors are already specified in the monetary design: reproducibility replication (§11.2), the agent-marketplace spread survey (§12.4), and rate-fingerprint baselines (§8.11 of v4).

### 12.4 The context validator is a console feature, not a script

WP-6's validator has to be visible, because a silent validator is one that gets disabled when it becomes inconvenient.

On the agent screen, show for each agent: the exact assembled context that will go to the model this turn, its byte count, and a **green/red badge per rule** — no design docs present, asset description byte-identical to the canonical text, no preference phrases, no key patterns. Red badge blocks the run rather than warning about it.

This is the one piece of console UI that earns its cost immediately, because it protects F1, which is the only behavioural finding available and cannot be recovered after contamination.

### 12.5 What stays out of the UI

- **Contract deployment.** Scripts and a runbook, not a button. A deploy button on a screen that also has a "fund agent" button is how mainnet accidents happen.
- **Editing a run in flight.** Runs are immutable once started. Change something, start a new run, diff the two.
- **Prompt editing per agent.** Prompts come from the skill registry. Per-agent overrides would make runs incomparable, and comparability across runs is the entire reason to build the bench.

## 13. Observability

### 13.1 Flow — the transaction graph

The primary screen during a run. One job = one graph.

```
  OPERATOR ──$2.00 USDC──▶ ORCHESTRATOR
                                │
                    ┌───────────┴───────────┐
            120 fSIU│                       │80 fSIU
            extract │                       │extract
                    ▼                       ▼
           WORKER-EXTRACT            WORKER-CODE
                    │                 (adversary)
            40 fSIU │
            extract ▼
              WORKER-CODE ──redeem──▶ ROUTER ──▶ ISSUER-B
                                                    │
                                              G1-G5: PASS
                                              claim retired
```

Edge labels carry asset, amount, and the integer work-unit rendering beside the dollar equivalent. **Colour by asset**, because the single most important thing to see at a glance is where the chain switched from fSIU to USDC — that switch point is F1's answer rendered visually.

Every edge clicks through to its receipt. Failed-gate edges stay on the graph, drawn distinctly, with `claim_retired: false` shown — those are the most informative edges in the run and must not be filtered out as errors.

### 13.2 The fSIU panel

Per `(class, window)` token id, live:

| Metric | Why |
| --- | --- |
| Minted / outstanding / retired / defaulted | The supply picture |
| Solvency check: outstanding ≤ Σ headroom | Invariant 1, visible |
| Transfer count and median hops before redemption | The F1 headline |
| Held-duration histogram | Distinguishes "used as money" from "redeemed on receipt" |
| Settlement-asset share over time | F1's trend line |
| Observed price per window, if any secondary trade occurs | The first three points of a possible term structure |

### 13.3 Agent messages — worth doing, with one condition

You asked to monitor chats between agents. Two things to separate.

**What already exists** is a full communication record without any chat channel: quotes, payments, receipts, tool calls and friction logs. Rendered as a threaded timeline per job, that reads like a conversation and is completely structured. Build this first — it is free, since the data is already being logged.

**A free-text channel is a design change, and it carries a specific risk.** If agents can send each other arbitrary text, then one agent's output enters another's context. That is a prompt-injection surface between agents, and more importantly for this run it is a **contamination surface for F1**: one agent saying "I prefer fSIU, it's better for chains" propagates a preference the operator carefully kept out of every prompt. §8.5's symmetric asset description would be undone by agents talking to each other.

So, if you want the channel — and it is genuinely useful for negotiation and for watching reasoning:

```
message:
  from: WORKER-CODE
  to: ORCHESTRATOR
  in_reply_to: <message_id>
  job_id: <job_id>
  body: <free text, length-capped>
```

With three rules: the **context validator runs on inbound messages too**, with the same asset-preference blocklist as prompts; messages are **scoped to a job**, never broadcast; and the F1 analysis reports **whether any preference language crossed the channel**, so a contaminated finding is detectable rather than silent. If the validator fires often, drop the channel and keep the structured timeline.

Also display each agent's reasoning trace per turn alongside its messages. That is where the useful surprises will be, and it is read-only by construction.

### 13.4 Provider console — Touchstone as issuer

Since you are both issuers in this run, this screen is your operational view.

**Per capacity lot:** class, provider, model, measured rate with its measurement timestamp, committed hours, issuance ratio, issuance limit, outstanding, headroom, validity window.

**Live:** headroom draw-down per class as a sparkline; mints and redemptions as they happen; queue of presented-but-unserved claims with time remaining in window; defaults with the bond draw and the print used.

**Two alerts that matter:**

- **Headroom below 10% in any class** — because the interesting states in §4.5 are reachable and you want to see them coming rather than discover them in the logs.
- **Measured rate drift** — re-run the probe mid-run and compare. If the rate moves materially, that is data on v4 §8.11's open question about rate stability, which is the question gating whether issuance limits can be set at all. Getting it as a side effect is worth more than the screen costs.

**Cost panel:** inference spend per agent per window against ceiling, and cost per delivered SIU. This is also the abort trigger from §9.3, so it should be the one number visible from every screen.

## 14. Reusability

You are right that one test will not be enough. The thing that makes a second run cheap is not the front end — it is the **separation between the bench and the task pack**.

### 14.1 The line

| Bench — built once | Task pack — written per experiment |
| --- | --- |
| Wallets, ERC-8004 identities, keystore | The task and what counts as delivered |
| Claim contracts, bond, router | The gate executor |
| Quote, payment, receipt, multi-hop | Reference fixtures and known-good submissions |
| Skill loader and context validator | Goal text per role |
| Flow graph, fSIU panel, provider console | Pack-level metrics |
| Run recorder, cost ceilings, abort logic | Which roles the pack needs |

If a new experiment requires touching anything in the left column, the line has been drawn in the wrong place. **That is the test to apply to every design decision in the console**: would this need to change for the spread survey? If yes, it belongs in the pack.

### 14.2 The minimum pack interface

A pack is valid if it provides these five things. Nothing else about the bench needs to know what the task is.

```
1. roles[]                which agent roles this pack needs
2. work_unit              what one job is, and its class
3. gate(submission, ref)  → accept | reject + reason.  Deterministic.
                            No model in the loop. This is non-negotiable:
                            a pack whose gate needs a judge cannot be run
                            on this bench, by design.
4. fixtures/              reference instances + pinned known-good
5. metrics.yaml           what to report at the end
```

Rule 3 is the real constraint and it is a feature. It means the bench can only run experiments where SIU is measurable, which is the same discipline the index itself operates under — and it is exactly why the "agents critique the currency" task was rejected in §1.5.

### 14.3 The next three packs, already specified

Each exists in the monetary design and each is mechanically gateable, so each drops onto this bench with no changes to the left column.

| Pack | Roles needed | Gate | Produces |
| --- | --- | --- | --- |
| **replication** | orchestrator + N replicators | Recomputed print matches published within tolerance | The reproducibility rate with named replicators (§11.2) |
| **spread-survey** | orchestrator + buyers | Purchase completed and comparable measurement produced | Spread-to-index per listed agent service (§12.4) — the opacity finding, with external data |
| **fingerprint** | profilers | Profile reproduces within tolerance on a second run | The baseline fingerprint library (v4 §8.11) |

**spread-survey is the one with a publishable external result**, and it is the only pack here that touches a real market rather than a closed one. Worth running second.

### 14.4 Runs are immutable and comparable

```
/runs/<run_id>/
    manifest.yaml       bench version, pack version, agent configs, seeds
    contexts/           every assembled model context, per agent per turn
    receipts/           the full receipt graph
    messages/           if the channel was enabled
    friction/           per-agent logs
    metrics.json        computed results
    validator.json      every validator verdict, including passes
```

The manifest is what makes two runs comparable, and `contexts/` is what makes an F1 result defensible six months later — you can prove no preference language was present rather than asserting it.

Add a `diff` command: two run ids in, a report of what differed in configuration and what differed in outcome. That single command is most of the value of having built a bench rather than a script.

### 14.5 The honest cost

This section describes roughly as much engineering as WP-1 through WP-8 combined. Three ways to keep it proportionate:

1. **Read-mostly.** Only the bench definition, agent provisioning and lot creation write anything. Everything else renders the run recorder's output.
2. **One page per screen, no framework ceremony.** The audience is you and one collaborator, not customers.
3. **Defer the message channel** until the structured timeline (§13.3) proves insufficient. It is the highest-risk and lowest-certainty feature here.

And the thing to protect against: **a console this general is a product, and products attract work.** The bench exists to produce findings. If it starts consuming more time than the experiments it runs, that is the signal to stop building it, not to finish it.

## 15. Console work packages

Four more, and the sequencing matters: **WP-9 comes before WP-7**, because the pack interface determines how agents are wired. WP-10 to WP-12 run after the first full run, built against a recording rather than against a guess.

### WP-9 — Pack interface and run recorder (do before WP-7)

```
Refactor the testbed into bench + task pack, per spec section 14.

1. Define the pack interface: roles, work_unit, gate, fixtures, metrics.
   The gate signature is (submission, reference) -> {accept, reason} and must
   be a pure function with no network and no model call. Enforce this with a
   test that fails if a pack's gate module imports any client library.

2. Move everything from WP-1 into task-packs/gate-hardening/. Nothing
   task-specific may remain in the bench. The test: a second, trivial pack
   (one that accepts any submission containing a given string) must load and
   run end to end with zero changes outside its own directory.

3. Build the skill registry: /skills/<name>/ with SKILL.md, tools.yaml,
   scoring.yaml. A skill declares which tools it may call; the runtime denies
   any call outside that list and records the denial.

4. Build the run recorder writing the /runs/<run_id>/ layout from spec 14.4.
   Every assembled model context is persisted verbatim before the call, not
   reconstructed after. Every validator verdict is recorded including passes.

5. Add: bench diff <run_a> <run_b> -> config differences and outcome
   differences, side by side.

Tests: the trivial pack runs unmodified; a skill calling an undeclared tool
is denied and logged; a run directory replays into identical metrics.
```

### WP-10 — Console: bench and agents

```
Build the two write screens. Next.js, single page each, no design system.

BENCH SCREEN
  Create a run: name, task pack (from registry), roles required by that pack,
  window count, per-agent ceilings, seed. Writes manifest.yaml. Start, halt,
  and a run list with status. Runs are immutable once started - no edit path.

  The run must span TWO claim windows, and the F1 arm must be confined to the
  first half of the earlier window (spec 7.1a). Enforce this: refuse to start
  a run whose F1 arm extends past the midpoint of window 1.

AGENTS SCREEN
  The YAML form from spec 12.2, one agent at a time, writing the same YAML
  the runner reads. Provision button: generate EOA -> store in runner keystore
  -> register ERC-8004 -> fund -> mint opening claims -> show address,
  identity id, balances.

  MODEL ASSIGNMENT - two fields, never one (spec 12.2a):
    reasoning_model  required for every agent
    capacity_model   required for issuer roles only, hidden for other roles
  Both are dropdowns populated from data/registry/models.json. No free-text
  model strings. An issuer's measured conversion rate must depend only on
  capacity_model; a single combined field would contaminate the section 3.5
  rate comparison.

  Blocking validator badges:
   - the builder and the adversary FOR A GIVEN CLASS must not share a model
     family. Scope this to that pair only. Do not fire on other same-family
     pairs - an issuer and the orchestrator sharing a family is irrelevant,
     and a validator that fires on everything gets switched off.
   - deciding agents (orchestrator + workers) must span >= 2 model families
   - capacity_model must differ between the two issuers

  Per agent, display the assembled context for the next turn with a
  green/red badge per context-validator rule (spec 12.4). Red blocks the run.
  This panel is the reason this screen exists; build it first.

  Before start, show per agent: projected inference cost from the chosen
  reasoning_model against its inference_ceiling_usd, plus a family-coverage
  summary across deciding agents.

Hard constraints:
  - no contract deployment from the UI, ever
  - no private key rendered in any response, log or DOM node
  - no per-agent prompt override field
  - the app may not write to any mainnet RPC; assert the chain id on boot

Record BOTH model fields in manifest.yaml so bench diff surfaces a model
change explicitly.

Tests: provisioning is idempotent on retry; a context containing a seeded
preference phrase shows red and blocks start; same-family builder/adversary
blocks start; same-family issuer/orchestrator does NOT block; no key material
appears in any HTTP response body.
```

### WP-11 — Console: flow and fSIU analytics

```
Build the read-only observability screens from spec section 13.

FLOW
  Per job, the payment graph. Nodes are agents, edges are payments, labelled
  with asset, amount, and the integer work-unit rendering beside the dollar
  equivalent. Colour edges by asset. Failed-gate edges rendered distinctly and
  never filtered - assert in a test that a run containing failures shows them.
  Every edge opens its receipt.

  Beside the graph, a threaded per-job timeline assembled from the existing
  record: quotes, payments, receipts, tool calls, friction entries, and each
  agent's reasoning trace per turn. No new logging needed - this is a view
  over what the recorder already writes.

fSIU PANEL
  Per (class, window): minted, outstanding, retired, defaulted; the solvency
  check outstanding <= sum(headroom) shown as pass/fail; transfer count;
  median hops before redemption; held-duration histogram; settlement-asset
  share over time; any observed secondary price.

All data comes from the run recorder. This app has no write path at all.
```

### WP-12 — Console: provider view, and the message channel (optional)

```
Two parts. Build the first. Build the second only if the structured timeline
from WP-11 proves insufficient.

PART A - PROVIDER CONSOLE (build)
  Per capacity lot: class, provider, model, measured rate and its measurement
  timestamp, committed hours, issuance ratio, issuance limit, outstanding,
  headroom, validity window.
  Live: headroom draw-down sparkline per class; mint and redemption feed;
  queue of presented-but-unserved claims with time remaining; defaults with
  bond draw and the print used.
  Alerts: headroom below 10% in any class; measured-rate drift when the probe
  is re-run mid-run (record the drift - it is data on rate stability).
  Cost panel: inference spend per agent per window against ceiling, and cost
  per delivered SIU. Show this from every screen; it is the abort trigger.
  Lot creation is the only write path.

PART B - MESSAGE CHANNEL (optional, defer by default)
  {from, to, in_reply_to, job_id, body} with a length cap.
  Three non-negotiable rules:
   1. the context validator runs on INBOUND messages with the same
      asset-preference blocklist as prompts
   2. messages are scoped to a job, never broadcast
   3. the run report states whether any preference language crossed the
      channel, so a contaminated F1 is detectable rather than silent
  If the validator fires more than a handful of times, remove the channel and
  keep the structured timeline. Write that decision into the run notes.
```

## 11. Kill criteria

Written before the run, because a criterion written afterwards is a rationalisation. Each of these is a result, not a failure, and each should be acceptable in advance.

### 11.1 What would close the instrument question

| Observation | Conclusion |
| --- | --- |
| Agents redeem to USDC on receipt, essentially always | The instrument has no transitive use. fSIU is not built. The unit and the receipt stand. |
| Median hops before redemption stays at 1 | No multi-hop benefit exists, which was the only functional justification (v4 §9) |
| Agents quote in dollars when free to choose | The work denomination is not how agents prefer to express price, even holding it |
| The hedged and unhedged arms perform the same | The forward transfers nothing worth paying for at this scale |

Any two of those and the honest conclusion is the one already stated in the monetary design: **Touchstone owns the best deflator in the agent economy, and the currency question is closed.** That is a smaller product surface and a real business, and v4 §11 already describes the licensing revenue that carries it.

### 11.2 What would close the task design

| Observation | Conclusion |
| --- | --- |
| No adversarial submission ever defeats a seeded gate | Either the gates are already strong, or the adversary role is too hard for these models. Check WP-1 fixtures first — if hand-written attacks worked and agent-written ones do not, it is capability, not gate strength. |
| Hardened gates fail G3 repeatedly | Agents over-tighten. Gate hardening is not a task LLM agents can do unsupervised, which is itself worth knowing about the methodology. |
| Gates become non-deterministic | The GateSpec format is wrong and must be fixed before any claim references a gate |

### 11.3 What would invalidate the run rather than answer anything

These produce no finding and waste the budget. Prevented by WP-6's validator and §9.3's halts.

- An asset preference leaked into a prompt. F1 is gone and cannot be recovered by analysis.
- The scenario print series contaminated a published print. Worse than losing the run.
- An agent touched a provider key. Halt regardless of what else was learned.
- Invariant 3 broken and not caught. Every receipt in the run becomes suspect.

### 11.4 What success actually looks like

Deliberately modest, because a testbed with both issuers backed by Touchstone's own accounts cannot prove demand:

1. **A working loop.** Mint, multi-hop transfer, dated redemption, gate verification, retirement, default with re-routing — all observed, all in receipts.
2. **A behavioural number.** Whatever share of payments settled in fSIU turns out to be, with hops-before-redemption beside it.
3. **One chart** on the hedged-versus-unhedged arms.
4. **Hardened gates with measured false-accept rates**, which go into the methodology whatever happens to the instrument.
5. **The integer finding**, which is the only result here that is publishable standalone and the only one that is evidence about the unit rather than the instrument.

If 1, 4 and 5 land and 2 and 3 come back negative, the run succeeded. It answered the question, and the answer was no.

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

**Fungible within class and delivery window.** `code/2026-W40` from ISSUER-A and from ISSUER-B are the same instrument. `code/2026-W41` is a different one. That is tenor standardisation (monetary design §6.1), and with weekly windows a three-week run produces three points — enough to see whether a term structure appears at all.

**Not on demand.** No redemption before the window opens. This is the change that removes the queue, the run and the demand liability.

### 4.4 The four operations

```
MINT      agent sends USDC → issuer's bond headroom is checked →
          claim minted at the current per-class print → USDC to issuer

TRANSFER  claim moves agent→agent, free, no print read, no issuer involvement

REDEEM    holder presents claim + task spec inside the window →
          router picks an issuer with headroom in that class →
          harness executes → G1–G6 run → pass: claim retired,
          headroom restored, receipt emitted; fail: claim NOT retired,
          holder may re-present within the window

DEFAULT   window closes with the claim unserved →
          re-route to the other issuer if it has headroom;
          otherwise bond pays cash at the print on the default date
```

The **fail path is the one to instrument carefully.** "Fail the gate and the claim is not retired" is the mechanical expression of *failed work counts zero*, and it is the single behaviour that distinguishes this from every token that pays for effort.

### 4.5 Forcing the interesting states

A run where nothing goes wrong tests almost nothing. Three states must be reachable and should be deliberately triggered:

| State | How to force it | What it tests |
| --- | --- | --- |
| **Headroom exhaustion in one class** | Size ISSUER-B's `code` lot small | Does routing find the other issuer? Does the holder notice? |
| **Cross-class unavailability** | Exhaust `extract` while `code` headroom remains | Confirms per-class claims are correct and unified ones overstate headroom |
| **Default** | Disable ISSUER-B's harness path for one window | Does re-routing work? Does the bond pay at the right print? |

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

**Measured:**

| Metric | What a positive result looks like |
| --- | --- |
| Share of payments settled in fSIU | > 50% and rising across the run |
| Median hops before redemption | > 1 |
| Time-to-redeem after receipt | Not immediate — held across at least one job |
| Quote denomination when the seller is free to choose | SIU rather than dollars |

**The protocol is fragile in one specific way.** A single sentence anywhere in an agent's context saying "pay in fSIU" invalidates the finding permanently. Review every prompt for this before the run and keep the diff under version control.

**Three further threats to validity, each with a structural fix rather than a caveat.**

**(a) Expiry pressure would produce a false negative.** Claims are dated, so as a window nears its end, holding becomes costly and redeeming becomes rational *regardless of preference*. A finding of "agents redeem immediately" could then be expiry pressure rather than rejection of the instrument — a false negative on the thing you most want to learn.

Fix, structural rather than analytical: **run two claim windows, and place the F1 arm entirely within the first half of the earlier one.** A hold decision is then never taken within sight of expiry. Log `time_to_expiry` on every hold and redeem decision anyway, so the analysis can demonstrate the separation rather than assert it. The second window then yields the term-structure observation (§7.4) as a side effect.

**(b) One model family is one disposition sampled repeatedly.** If ORCHESTRATOR and both workers run the same model, six agents choosing USDC is one prior observed six times, not six independent choices. **The deciding agents must span at least two model families** — see §12.2a, where this is a blocking validator rule.

**(c) One run is an anecdote.** Behaviour here is sensitive to seed, phrasing and model. **No F1 number may be quoted from fewer than five runs** differing only in seed, with the dispersion across runs reported beside the headline. The `bench diff` command (§14.4) makes this cheap, and stating the minimum now is free where adding it later is not.

**Negative result is a real result.** If agents redeem on receipt every time, the instrument has no transitive use, and that is worth knowing before building a contract for it.

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

USDC is a dollar. 1 USDC = $1. It is accepted by every counterparty.

fSIU is a claim on completed work. One fSIU of class C, window W,
entitles the holder to one SIU of qualifying work in class C, deliverable
during window W. It is accepted by counterparties that list it. It cannot
be redeemed before its window opens. Its dollar value moves with the
published price of work.

You may pay in either. Sellers state which they accept in their quotes.
```

Neutral in length, tone and ordering. No adjective favours either. **Do not let this drift during implementation** — it is the entire validity of F1.

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

# The Unit, the Claim and the Curve

**Touchstone monetary design · v1.0 · supersedes the currency sections of design doc v4**

2026-09-21 · @Someone

## 0. What this settles

This document replaces the currency sections of design doc v4 (§7, §8.5, §8.6) and supersedes both the cycle-wSIU addendum and the fSIU specification. Nothing in the index design changes. The unit, the print, the gates, the governance and the evidence hierarchy all stand.

**The conclusion in one line: three objects, not four.** A unit to reason in, a dollar to settle in, and a dated claim to transfer risk with. There is no fourth object, and every attempt to build one has failed for the same reason in a different costume.

| Object | What it is | Status |
| --- | --- | --- |
| **SIU** (rescaled, §3) | The unit of account. What agents quote, budget and compare in. | Live; needs a scale decision now |
| **USDC** | The settlement asset. Not ours, and should not be. | Live |
| **Dated Work Claim** | Dated, transferable, bonded claim on completed work. Fixed in work, floating in dollars. | The instrument to build |

### What changed, and why

**Rebasing wSIU is withdrawn.** v4 §7.4 concedes that holding it is economically identical to holding the escrowed asset. That concession is fatal rather than reassuring: an instrument transferring no risk performs no economic function. Protocol exposure was driven to zero by making the instrument null. The mechanism is sound engineering and stays on the shelf.

**Pooled on-demand fSIU is withdrawn.** Its central claim — that owing work rather than cash avoids banking — does not hold. A demand liability against non-storable production is more fragile than a bank's, not less, because nothing can be liquidated. The queue in its §3.3 is a contractual suspension of convertibility, and the public discount signal in its §4 doubles as a run signal. Removing *on demand* fixes it. That is the whole change.

**What survives from fSIU, and matters:** one collateral base supporting two products; the efficiency insight (a provider at 120 SIU/hour issues 50% more claims than one at 80 on the identical bond, which turns the conversion rate from analytics into the number governing a provider's balance sheet); redemption in work and never in cash; and the observation that an agent's principal input and principal output are the same commodity.

### Three things that are true and were not stated before

1. **The market is two-sided.** Capacity providers want to sell work forward for cash; fixed-price vendors want to buy it forward for certainty. Both motives are binding constraints, not conveniences. (§1)
2. **Completed work is electricity, not oil.** Non-storable, so no commodity currency is possible — and forwards work anyway, as PPAs do. (§2)
3. **A dated claim standardised by tenor produces a forward curve**, and the curve is worth more than any currency this project could issue. Brent's commercial value is overwhelmingly its curve. (§6)

### What to do next quarter

Three things, none requiring a token, a licence or a pool.

- Fix the SIU scale from measured data before history accumulates (§3). This has a deadline; the others do not.
- Run the integer-quoting experiment (§3). First hard evidence that an agent-native unit is necessary rather than aesthetic, and nobody else can produce it.
- Publish spread-to-index for listed agent services (§12). Needs no supply side, and makes every agent seller care about the print.

## 1. The two-sided market

A terminology collision confused this question across three documents, so it is worth clearing precisely.

**"Natural short" means two opposite things in commodity markets.** A producer is *long the price* of its own output and is simultaneously *the natural seller of forwards*, which desks call the natural short side. Both are true of an oil producer at once. Conflating them produced the false conclusion that no natural short exists here.

### Who sits where

| Party | Position in the price of completed work | Wants to |
| --- | --- | --- |
| **Model providers** (OpenAI, Anthropic, open-weight hosts) | Insulated — they bill tokens whether or not a gate passes | Sell effort, not work |
| **Capacity providers** (GPU clouds) | Long the price of capacity, holding a depreciating asset | **Sell work forward** for cash today |
| **Fixed-price vendors** (Cursor, Copilot, Devin, flat-fee agencies) | **Short the cost of completed work** — they sold output forward at a fixed price | **Buy work forward** for cost certainty |
| **Spot agent sellers** (per-task x402 quoters) | Roughly flat; costs pass through | Nothing — they are not hedgers |
| **Touchstone Assay** | None, structurally and permanently | Measure |

The critical row is the third, and the evidence is already in v3.2 without being recognised as such: Microsoft cancelled thousands of Copilot licences when costs spiralled; GitHub moved every plan to usage-based billing because agentic workflows broke flat rates; Uber burned an annual AI budget in four months. Those are not anecdotes about spend. **They are natural shorts being squeezed with no instrument to hedge**, so they broke their own pricing models instead. A market with real hedging demand and no hedging product.

### Why this matters more than it sounds

Both sides have an independent motive, and both motives are binding constraints rather than conveniences.

- The provider's binding constraint is **cost of capital**, not demand. Selling work forward converts idle capacity into cash against hardware depreciating faster than its amortisation schedule — exactly the constraint v4 §8.9 identifies as the strongest reason a provider would join anything.
- The fixed-price vendor's binding constraint is **cost certainty it cannot currently purchase at any price**. No product exists today that fixes the cost of completed work for two quarters.

That is the first structure in this corpus where two parties want opposite things at the same time, and it is what makes a forward market clear. Every prior design had one motivated party and one hypothetical one.

### The inverted carry

Worth recording because it is counterintuitive and usable. In crypto, structural consensus is upward, longs are crowded, and funding flows from longs to shorts — the engine of the Ethena trade. **The structural consensus in AI work is downward**: this project's own figures put cost decline at 60–70% annually.

So a forward market in completed work should be crowded *short*, and the risk premium should accrue to whoever is willing to be long. Concretely: **a provider selling work forward should expect to sell above expected spot**, because it is supplying protection to a crowded side. That is a better pitch to a provider than distribution or comparability, and it is testable the moment any forward trades.

It also disposes of the Ethena question. There is no spot leg — a completed task is not inventoriable, so there is nothing to be delta-neutral against — no SIU perp exists, and operating the venue that would list one is excluded by v3.2. Even granting all three, funding would run the wrong way. The structure is not missing; it is inverted.

## 2. Completed work is electricity, not oil

The oil analogy has carried this project since v1 and it has now failed twice in the same place. Oil is storable. Completed AI work is not. Every design that tried to make a holdable claim on work ran into non-storability and produced either a dollar in disguise (rebasing wSIU) or a demand liability against production that does not exist yet (pooled fSIU).

Electricity is the correct parent, and it fits on every axis that matters.

| Property | Oil | Electricity | Completed AI work |
| --- | --- | --- | --- |
| Storable | Yes | **No** | **No** |
| Quoted in | Barrels | **kWh** | **SIU** |
| Settled in | Dollars | **Dollars** | **Dollars** |
| Spot assessment | Dated Brent | **Day-ahead / index prices** | **Dated SIU** |
| Forward market | Futures on stored grades | **PPAs, bilateral, credit-backed** | **Dated Work Claims** |
| Became money | Petrocurrencies exist | **Never** | **Never** |
| Index publishers earn | Platts | **Nord Pool, EPEX, ICIS** | The available position |

### What the reframe settles

**No work-commodity currency can exist, for structural reasons rather than design failure.** You cannot hold a reserve of something that ceases to exist when unconsumed. A century of the most fungible commodity ever produced — the kWh — never produced a kWh-denominated money, and not for want of trying. This is not a gap in the design to be closed by a cleverer mechanism. It is a property of the underlying good.

**Forwards work anyway, and are the normal instrument.** A power purchase agreement is a dated, bilateral, credit-backed commitment to deliver non-storable output at a fixed price. It is the backbone of electricity finance, it requires no storability, and it works because the buyer needs certainty and the seller needs cash. That is precisely the structure in §1, and the ATC bond in v4 §8.5 is already the collateral half of it.

**The curve is driven by expectation, not carry.** In a storable commodity, the forward curve is anchored by the cost of storage — buy spot, store, sell forward. With no storage there is no arbitrage link, so the curve is a pure expectation of future price. That makes it more volatile and, importantly, **more valuable to publish**, because there is no mechanical way to derive it. In electricity, forward curve publication is a real product with real subscribers for exactly this reason.

**The business model is proven and is not a currency business.** Platts, Nord Pool, EPEX and ICIS make money from assessment, publication, licensing and reference-rate fees on markets in a non-storable commodity. None of them issues money. None of them holds a position. This is the shape of the available prize, and it is larger than the token.

### What it does not settle

Electricity has physical delivery that a grid operator can verify, and a regulatory framework that took decades. AI work has a quality gate instead, which is better in one respect — it is machine-checkable in milliseconds — and worse in another: the gate is defined by the same party publishing the price. That is the reason §9's entity separation is load-bearing rather than cosmetic.

## 3. The unit

SIU is the right unit and three things about it need fixing. One has a deadline.

### 3.1 The scale, and why it is urgent

The unit paper puts a typical MCP call at roughly 0.0003 SIU and proposes mSIU at 10⁻³, giving **0.3 mSIU**. The subdivision was introduced to stop agents quoting four-decimal numbers, and at that scale it does not. It renames the problem.

Two figures also fail to reconcile and one of them is wrong: a print near **$0.0014/SIU** against a typical task at **0.0003 SIU** implies a task costing about four ten-millionths of a dollar. Real API calls do not cost that. Either the basket magnitude is set somewhere unintended or the task-size figure is stale. **Resolve this before naming anything.**

**The deadline.** Chain-linking exists to preserve the magnitude of one SIU across basket versions. Once the series has history and anything references it, the magnitude is frozen permanently. There are currently a handful of prints. This is the only cheap moment to rescale, and rescaling SIU itself is better than papering over it with a prefix, because every subdivision is a permanent conversion an agent must carry.

**Rule to adopt:** choose the base scale so that ordinary single-task quotes land between **1 and 1000** in the unit agents see. Derive it from the measured distribution of real quotes, not from metric convention.

### 3.2 Per-class prints become primary

No agent buys a basket. Agents buy code repair, structured extraction, long-context retrieval. A blended headline cannot be quoted against, and v4 §4.1 already notes per-class prints fall out of existing runs at no extra measurement cost.

So: **SIU-code, SIU-extract, SIU-longcontext are the products**; blended Dated SIU becomes the citable headline for press and licensing. This also matters downstream — a Dated Work Claim must specify a class, because a provider bonded for code generation cannot serve retrieval.

### 3.3 The integer-reasoning argument, and the experiment that tests it

This is the strongest available case for an agent-native unit, and it is empirical rather than philosophical.

Language models are measurably weaker at comparing small decimals than small integers. `0.00034` against `0.00029` is a comparison models get wrong at a non-trivial rate — and that comparison is every budget check, every quote comparison, every spending-cap evaluation in an agent loop. Quote the same thing as `340` against `290` and it becomes integer arithmetic, which models handle reliably. The error compounds across every decision in a chain.

**The experiment.** Run identical routing and budget decisions through the registry models, quoted in dollars versus quoted in integer work units. Measure the error rate on both. Publish it.

This is the single highest-value experiment available: it is cheap, it uses infrastructure that already exists, and **nobody else can run it, because nobody else has the unit.** If the gap is real it is the first hard evidence that an agent-native unit is necessary rather than aesthetic, and it belongs at the front of every subsequent document. If the gap is not real, that is worth knowing before building anything denominated in it.

### 3.4 Two series: settlement and capability

The reproducibility-versus-relevance fork does not need resolving inside one number, and should not be.

Chain-linking handles composition changes because both baskets can be measured on the same runs. **It cannot handle new capability.** When a 2027 model completes a task no 2026 model could, the old-basket cost is undefined, and a link ratio with an undefined denominator does not exist. No amount of disclosure repairs a missing term.

| Series | Construction | Purpose |
| --- | --- | --- |
| **Settlement series** | Fixed basket, chain-linked, mechanical, never quality-adjusted | What contracts and claims reference |
| **Capability series** | Explicitly discontinuous; records when work becomes possible that previously was not | Research, commentary, the token-efficiency story |

The settlement series carries no discretion, because anything a counterparty can litigate, they will. LIBOR died of discretion; SOFR is mechanical. Hedonic adjustment, if it is ever done, belongs only in the capability series and must never feed the settlement one.

### 3.5 Define against the gate, not the constituent set

One definitional change with long consequences: **the unit is anchored to a fixed quality gate, not to a fixed set of models.** The gate is what survives a rebase. Constituents enter and leave under the published criteria in v4 §4; the gate is the invariant. This is what lets the reference class in v4 §3.4 remain meaningful across basket versions.

## 4. The rejected designs, and the single reason

Recorded so they are not rediscovered. Six designs, one underlying error each time: **an instrument that either transfers no risk, or transfers it to a party who cannot bear it.**

| Design | Fatal property | Status |
| --- | --- | --- |
| **Naive wSIU** (redeem at current print) | Protocol short its own index; insolvent if the print rises | Rejected in v4 |
| **Cycle wSIU (cwSIU)** | Duration-bounded, but needs cutoff, grace, rollover, lapse, keeper — machinery serving a claim that expires daily | Superseded by v4 |
| **Rebasing wSIU** | Economically identical to the escrowed asset (v4 §7.4). Transfers no risk; a display with a licence attached | **Withdrawn here** |
| **Pooled on-demand fSIU** | Demand liability against non-storable production. Queue = suspension of convertibility; discount = run signal | **Withdrawn here** |
| **ATC-collateralised SIUSD** | Collateral expires on a schedule, is unsellable precisely under stress, and is valued using our own print | Rejected |
| **Ethena-style basis on SIU** | No spot leg, no perp, and funding runs the wrong way in a deflating market | Rejected |

### The rebase, in detail, because the engineering is good

The mechanism is correct: shares fixed, denominator floating, solvency invariant `totalEscrow == totalSupply × P` preserved trivially, `setPrint` verifying a signed anchored print rather than accepting a number. The contract sketch in v4 §7.3 is sound and the invariant suite in §7.7 is the right suite.

The problem is not the mechanism. It is that **the mechanism succeeds**. Holding 100 wSIU at $0.01 and holding $1.00 leave the holder in exactly the same place after any print move — v4 §7.4 states this plainly and treats it as a safety property. It is, and it is also the thing that removes any reason to hold it. A hotel voucher is worth holding because it is *fixed in nights and floating in dollars*: the hotel carries the price risk. The rebase does the opposite — fixed in dollars, floating in nights. That is a dollar with a night counter.

Against that, the costs are real: an audited contract, a legal opinion, an oracle path, a privileged function able to move every balance in the system, a rebase-aware integration boundary that fences the token out of anywhere value pools, and Touchstone standing in the payment path — which costs the neutrality v4 made primary positioning.

**Disposition:** ship the denomination as a function in the replay SDK and a field in `touchstone-quote`. Client-side division by the published print delivers every stated benefit at zero cost. Keep the rebase design on the shelf; it is the right answer to a question nobody is asking yet.

### The pool, in detail, because the insight is good

fSIU's §0 claims a bank owes cash and holds loans, while the pool owes work and holds capacity, so no maturity transformation occurs. **This is backwards.** A bank's loans are assets that can at least be sold. Capacity is not an asset at all — it is a flow that ceases to exist when unconsumed. The pool owes on demand and holds nothing. That is more fragile, not less.

The queue in fSIU §3.3 is described as a rationing event rather than a solvency event. A contractual suspension of convertibility was the standard response of every nineteenth-century bank in a panic. And it is self-reinforcing through price: as the queue lengthens the market discount widens, which rewards whoever redeems first, which lengthens the queue. fSIU §4 correctly identifies the discount as a health signal; it is also the run signal, published live.

Two further problems the document does not resolve. **The cash-now proposition and the bond cancel**: if the bond is worth roughly what the claims are worth, the provider locks a dollar to receive a dollar; if it is partial, the remainder is uncollateralised credit carried by the pool, and the pool is a credit institution. And **fSIU is structurally subordinate**: providers finance GPUs with secured debt, so on failure the lender takes the hardware and the work claim ranks behind. It is unsecured trade credit junior to secured equipment debt, which makes the credit discount materially wider than "trades near the print."

**One change fixes all of it: remove on-demand redemption.** See §5.

## 5. The Dated Work Claim

**One sentence: a dated, transferable, bonded claim on a stated quantity of qualifying completed work in a stated class, deliverable in a stated window, defaulting into cash at the print on the default date.**

Fixed in work. Floating in dollars. That inversion is what makes it an instrument rather than a denomination skin — the holder sheds work-price risk and the issuer takes it, which is the definition of a transfer.

### 5.1 Why dating changes everything

Removing *on demand* removes, in one move, every failure the pooled design carried:

- **No queue**, because there is no earlier claim to beat. Delivery is scheduled, not raced.
- **No run**, because there is no first-mover advantage. A run requires that early redeemers do better than late ones; dating removes the ordering.
- **No demand liability**, so the issuer is not a bank by construction rather than by argument. This is the claim fSIU §0 wanted to make and could not.
- **No suspension of convertibility**, because convertibility was never promised before the date.

The thing smuggling banking back into every previous design was not work-denomination. It was the phrase *on demand*.

### 5.2 The historical object

This is a bill of exchange. A dated, transferable claim on a specific performance, trading at a discount reflecting time and credit, circulating as payment without its issuer being a bank. Four centuries of use, and the legal and commercial patterns are well understood.

It is also a PPA at small scale, which is the §2 framing applied: a credit-backed forward on non-storable output.

### 5.3 Fields

The claim is the object; `touchstone-quote` and the receipt already carry most of these.

| Field | Notes |
| --- | --- |
| `class` | `code`, `extract`, `longcontext` — must match a published per-class print (§3.2) |
| `quantity` | In the scaled unit (§3.1) |
| `quality_gate_id` | The gate defining qualifying work; versioned |
| `delivery_window` | Start and end. The tenor. |
| `issuer` | ERC-8004 identity |
| `atc_ref` | The bonded capacity the claim is issued against |
| `bond_ref` | Contract, chain, collateral asset, headroom consumed |
| `methodology_version` | Which SIU definition the quantity is measured under |
| `default_rule` | Cash at the print on the default date, per the promise ladder |
| `transferable` | Bearer or registered — see §6 |

### 5.4 Default

Unchanged from v4 §8.6 tier 2, which was already the right answer: **cash recovery at the print on the default date**, drawn from locked bond collateral. Failure to deliver within the window is observable and mechanical. No adjudication, because quality is decided by the gate, which exists, and delivery is decided by the clock.

The promise ladder should be published with the claim so a bond cannot be mis-sold. Tier 4 — guaranteed immediate substitute work — is not promised and should never be.

### 5.5 One instrument, two sizes

fSIU's open question 7 asked whether `FORWARD` and `fSIU` should share a name. They should, because they are not two instruments.

|  | Bilateral forward | Standardised claim |
| --- | --- | --- |
| Size | Large, bespoke | Small, uniform |
| Terms | Negotiated | Standardised by class and tenor |
| Transferable | Novation, awkward | Yes, freely |
| Counterparty | Known | The market |
| Exists when | **Now — has a customer today** | After standardisation, if anyone trades one |

The path from the first to the second is exactly how forwards became futures: standardise the terms, and a secondary market appears because someone wants out before delivery. **You do not design the second one. You standardise the first and observe whether it trades.**

That also makes the build order self-testing. If the standardised claim never trades secondhand, there was no demand for a transferable work instrument — learned before capitalising a default fund rather than after.

### 5.6 A class is redeemable only if its task spec can carry the means of verification

Found live in the Gate Market testbed, not derived on paper: REDEEM (§4.4 of the testbed spec) has the holder present a task spec, and a deterministic gate grades the result against it. That grading is only possible if the task spec itself carries something to check against — ground truth for an extraction task, a pinned test suite for a code-repair task. Where it does not, no gate, however well-written, can do better than weaker *property* checks (values appear verbatim in the source, formats are internally consistent) — which catch fabrication but not mis-assignment (a vendor and customer swapped, a value from the wrong field). Re-deriving the answer by re-running the same computation the holder was supposed to perform does not fix this: it only works when that computation is easy enough to reimplement cheaply and reliably, at which point the "gate" is really a second, competing implementation of the task, brittle to exactly the same real-world variation (a document laid out differently, an edge case the reimplementation didn't anticipate) that the original task exists to handle.

The consequence is structural, not a testbed detail: **a work class is only redeemable if its real task spec requires the holder to supply, or the operator to pin, the means of verification alongside the work itself.** `code` already satisfies this by construction — a pinned test suite is a normal part of software work. `extract`-shaped classes do not, automatically; they need real ground truth attached to each task instance. A class proposed for fSIU without an answer to "what does REDEEM actually check this against, and where does that live" is not yet specified well enough to gate — this is a precondition to state explicitly before adding new work classes, not something to discover mid-run.

## 6. Fungibility by tenor, and the curve

### 6.1 The fungibility objection, and its standard answer

The objection to any dated claim is that dating breaks fungibility: a claim maturing in October is not a claim maturing in December, so the thing cannot be a unit everyone quotes in.

Every futures market on earth answers this the same way. **Standardise the tenor.** WTI March and WTI June are not non-fungible; they are two fungible contracts with a term structure between them. Within a contract month, every unit is identical to every other.

So: a Dated Work Claim is fungible **within a class and a delivery month**. `SIU-code-2026-11` is one fungible instrument. `SIU-code-2026-12` is another. The relationship between them is a price, which is the next section.

This also disposes of fSIU's open question 4, which asked whether to launch class-specific or unified. Class-specific, always — not as a concession to thin membership, but because unified claims overstate available headroom in exactly the scenario that matters. A holder presenting long-context work when the issuer's spare capacity is code generation has an unservable claim against a dashboard showing headroom.

### 6.2 The curve is the prize

A term structure across delivery months in a work class **is a forward curve for AI work**, and no such thing exists today.

v3.2 states correctly that a forward curve is the expectation of a price and does not exist until someone trades it. Standardised Dated Work Claims are what make someone trade it. Once two months trade, there is a curve; once there is a curve, there is a published product that no competitor can construct, because it is derived from transactions rather than opinions.

Why this is worth more than a currency:

- **Brent's commercial value is overwhelmingly its curve**, not its spot assessment. The spot print is what makes the curve legible; the curve is what institutions pay for.
- A curve is the first object here a **derivatives venue would license**. v3.2 already excludes operating a venue and permits licensing to one; the curve is the licensable asset.
- It is the honest expression of the deflation thesis. Today "AI work gets 60–70% cheaper annually" is an assertion sourced from vendor claims. A forward curve is **the market's own priced expectation**, published as a series.
- It moves the project from CPI-shaped to Brent-shaped without needing a commodity. Electricity has forward curves and no storability (§2); this is the same structure.

### 6.3 What the curve requires

Less than it sounds, and nothing that is not already planned.

1. Standardised tenors — monthly delivery windows per class.
2. A published contract specification, which is the §5.3 field list plus the promise ladder.
3. At least two delivery months with observable prices. Two trades make a curve; twenty make a good one.
4. The spot assessment to anchor the front, which exists.

No venue, no clearing, no token, no balance sheet. Touchstone publishes the specification and the assessment and reports the prices it can observe. Whoever wants the position takes it.

### 6.4 The honest limit

A curve with two participants is not a curve, it is a quote. Until there are several issuers and several hedgers, anything published should be labelled as indicative and sparse, with the number of contributing transactions printed beside it — the same discipline already applied to the qualifying set on a print, and the same reason the 22 August print was superseded rather than quietly published.

## 7. Issuance and collateral

### 7.1 One collateral base, two products

This structure comes from fSIU §2 and is the part of that document worth keeping wholesale.

```
            BONDED CAPACITY (ATC)
     GPU-hours at a stated configuration;
     conversion rate measured by the Assay
                    │
     issuance limit = capacity × measured rate
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   BILATERAL              STANDARDISED
   FORWARD                DATED CLAIM
   large, negotiated      small, uniform tenor
   sold to one hedger     transferable
```

Both draw the same headroom. A provider with 120,000 units of issuance capacity can sell 40,000 bilaterally and standardise 60,000, leaving 20,000 free.

### 7.2 The efficiency insight — why a provider submits to measurement

The strongest argument in the entire project for why a provider would accept being measured, and it was buried in fSIU §2.

|  | Provider A | Provider B |
| --- | --- | --- |
| Bonded capacity | 1,000 hours | 1,000 hours |
| Measured conversion rate | 120 SIU/hour | 80 SIU/hour |
| **Issuance limit** | **120,000** | **80,000** |

Same collateral, **fifty per cent more sellable claims**. Efficiency is rewarded in issuance capacity, and it compounds, because the efficient provider monetises identical hardware harder.

This converts the conversion rate from an analytics curiosity into **the number that governs a provider's balance sheet**. Nobody has to be persuaded to care about a measurement that sets their issuance limit. It is also the answer to "why would a provider let Touchstone measure them" that v4 §8.9 was reaching for and did not quite find.

### 7.3 What the bond is denominated in — the unresolved question

fSIU open question 5, and it gates everything. The candidates and their problems:

| Collateral | Problem |
| --- | --- |
| **wSIU / the claim itself** | Circular. The ATC spec in v4 §8.2 lists `collateral_asset: "wSIU"`; this must change. |
| **USDC, fully** | Locks a dollar to receive a dollar. Destroys the provider's only motive, which is cash today. |
| **USDC, partial** | The uncollateralised remainder is credit. Someone carries it. If that someone is a pool, the pool is a credit institution. |
| **The GPU** | The only real asset in the chain. Storable, resaleable, and the terminal collateral of every structure here. Not natively on-chain, cannot be seized by a contract, needs perfected security interests across jurisdictions. |

**The honest chain is hardware → capacity commitment → issuance capacity → claim.** That means the capital-efficient answer routes through a party that already perfects liens on GPUs — a hardware lender. USD.ai and GAIB are named in v3.2 as lender-product customers; they are also the natural collateral agents here.

**Consequence to state plainly in any published spec:** a work claim is unsecured trade credit ranking behind secured equipment debt. The credit discount is therefore material, and "trades near the print" is not the default expectation for a thinly-collateralised issuer.

### 7.4 Correlation, not member count

fSIU open question 1 proposes seven members and a 20% concentration cap, from instinct. The number is not the binding parameter.

Mutualisation works against **idiosyncratic** risk and does nothing against **systemic** risk. Provider defaults in this market will be near-simultaneous — the same demand shock, the same GPU price collapse, the same funding withdrawal. Sizing a default fund for correlated multi-issuer failure means sizing it near the full outstanding, at which point capital efficiency is zero and the structure is fully reserved with extra steps.

**So: state a default-correlation assumption explicitly, and size from it.** That parameter, not the member count, is what any mutualisation stands on. If the honest assumption is high correlation, the conclusion is that claims should be individually collateralised rather than mutualised — which is simpler, and is what a bilateral forward already is.

### 7.5 Headroom

Unchanged from v4 §8.5 and correct: **capacity-denominated, tracked by the bond contract, never self-reported.** Issuing consumes headroom; delivery restores it. The staleness argument holds — a provider doubling efficiency after bonding in work units stays capped; bonded in capacity, the same bond supports twice the issuance.

## 8. Who issues

### 8.1 The retail capacity-holder does not work

The proposal was that a member of the public with a paid plan bonds unused capacity, posts collateral, and earns as the capacity is consumed. It is the right instinct about who should participate and the wrong thing for them to sell. Four problems, any one of which is disqualifying.

**The premise is factually thin.** A consumer subscription has no API — chat access, message limits, no key, nothing programmatically meterable. And pay-as-you-go API has *no unused capacity at all*: you pay per token, there is no allowance, nothing perishes. The marginal cost of serving someone else's request equals the provider's price, so the arbitrage is zero by construction. Latent capacity exists only on flat-rate plans with generous programmatic limits, where a light user has paid for headroom they will not consume.

**The margin and the prohibition are the same object.** That headroom exists because the provider is cross-subsidising: flat rates work by having light users fund heavy ones. The unused allowance is not a surplus the subscriber created — it is the provider's price discrimination sitting on their account. Selling it arbitrages the cross-subsidy, which is why systematic resale is prohibited everywhere and why enforcement is certain rather than probable. The margin exists only in the case that destroys the pricing model creating it.

**The arithmetic is negative.** Run the proposal's own numbers: 2,000 units of capacity, $20 gross, 50% haircut, $10 posted. That is $30 of capital committed to sell $20 of output. Selling at the reference price returns $20 on a $20 subscription, minus gateway fee, minus the cost of $10 locked for a month. To profit you must sell *above* reference while selling an undifferentiated commodity against the provider itself, who sets the ceiling. Undifferentiated capacity is a Bertrand market: margin goes to zero, collateral cost does not.

**Adverse selection finishes it.** Who locks cash and surrenders account control for a few dollars a month? Not the enterprise account with a volume discount and a compliance function. The pool fills with the smallest, least accountable supply, held by participants with no legal personality and no recourse — the worst credit in the market, sourced deliberately.

There is also a custody trap: preventing double-spend requires exclusive gateway control of the allowance, so the subscriber cannot sell unused capacity *and* keep their own access. Either they surrender what they are paying for, or the double-spend is real and the collateral is the only thing behind the claim — at which point the structure is cash-collateralised with a capacity story painted on the front.

**What survives:** the *capacity lot* abstraction is good engineering and better than ATC for small sellers — bounded, class-specific, time-limited, verified by a probe workload rather than asserted. Keep it regardless of who the seller turns out to be. And one genuine scarcity was identified: aggregate rate-limit headroom across many accounts is something no single account can buy at any price. It is also indistinguishable from rate-limit circumvention from the provider's side, which is why it cannot be built on.

### 8.2 The agent seller is the right issuer

The participant worth having is not the person holding unused capacity. It is **the person already selling agent output**.

|  | Capacity holder | Agent seller |
| --- | --- | --- |
| Sells | Raw allowance | **Completed work** |
| Gate can verify it | No — capacity is not an outcome | **Yes — it is the thing SIU is defined as** |
| Differentiated | No; commodity, Bertrand | **Yes; there is a real margin** |
| Provider permission | Prohibited resale | **Exactly what the provider wants** |
| Needs cash upfront | Marginally | **Acutely — no capital, dollar revenue, inference costs** |
| Already doing it | No | **Yes, at scale, opaquely** |

That reorders the chain. Not *provider → reseller → public holder → pool*, but:

```
agent seller  →  dated claim on its own output  →  buyer / secondary market
     ▲
  provider stays a supplier, never a counterparty
```

It is the bill of exchange again: a small operator issuing a dated claim on its own performance, discounted for time and credit, circulating without anyone becoming a bank. And the permission problem largely dissolves, because selling your agent's output is what the model provider wants you to do.

### 8.3 The opacity finding

Agent resale is happening now, at scale, and it is completely opaque. A user paying for an agent has no way to know whether they are paying twice or twenty times the underlying inference cost.

That is a real market failure sitting directly on top of the index, and addressing it requires no issuer, no collateral and no pool. See §12.

## 9. Entity separation

### 9.1 The contradiction this resolves

The project has carried an unresolved conflict since v3.2: neutrality is the primary positioning, and the payment rail requires being in the flow. Those are incompatible **inside one entity** and entirely compatible across two. The historical structure is not novel:

|  | Assessment | Market |
| --- | --- | --- |
| Oil | Platts assesses Dated Brent | ICE runs the futures, licenses the reference |
| Power | ICIS, Argus | EPEX, Nord Pool |
| Equities | S&P Dow Jones Indices | CME lists the futures |
| **Here** | **Touchstone Assay** | **Touchstone Markets, or a third party** |

The licence between them is the most profitable line in the index business, and it exists precisely because the two functions are separated.

### 9.2 The split

|  | Assay | Markets |
| --- | --- | --- |
| Publishes Dated SIU and per-class prints | ✓ |  |
| Publishes the claim and ATC specifications | ✓ |  |
| Measures conversion rates | ✓ |  |
| Defines and verifies quality gates | ✓ |  |
| Runs the settlement rail and escrow |  | ✓ |
| Clears, enforces par acceptance, expels |  | ✓ |
| Sets collateral ratios and default rules |  | ✓ |
| Holds any claim or position | **never** | operationally |

### 9.3 Where the clearing function goes

This is the part that has been missing, and naming it resolves the free-banking objection.

Historically, standardised private claims required a clearer to hold par: the Suffolk Bank and the New York Clearing House enforced acceptance at par by holding positions and cutting off members. Without one, notes traded at issuer- and distance-dependent discounts, and a claim trading at a discount is not fungible.

The Assay must never be that clearer. **Markets can be, or a third party can.** If a standardised claim ever needs par enforcement, the function goes to the entity that is allowed to hold a position — which is exactly why the separation is load-bearing rather than cosmetic.

### 9.4 The preconditions, restated

v4 §11 already sets them and they should be repeated wherever the split is described, because until they hold the separation is a plan and should be called one:

1. The Assay has **its own funding**.
2. The Assay has **governance beyond the founder**.
3. The Assay **survives Markets ceasing to exist**.

Until all three hold, no claim should be issued against the Assay's print by an entity the Assay is not separated from. The attribution firewall in v4 §11 applies equally: whoever administers the index must not see the revenue the rail generates.

### 9.5 What this means for the token question

A token, if one ever exists, governs Markets only, with a contract-encoded prohibition on touching baskets, weights, gates or prints. The Assay issues nothing, permanently.

**Ruled out flatly:** token-weighted governance over basket composition, weights or gates. That hands the definition of the price of AI work to whoever holds the most of a token, and the people who would hold it are the people being priced.

## 10. SIUSD

### 10.1 The metadata claim does not work, and v4 already says so

The case for SIUSD has been that the token contract carries provenance USDC lacks. It cannot, and v4 §7.9 states the reason correctly: **metadata cannot attach to a fungible balance.** An ERC-20 balance is one `mapping(address => uint256)`. There is no field, and if there were, balances merge on receipt — 50 from one seller plus 50 from another is 100 with no history.

What is actually meant is metadata carried in the *settlement call* and emitted as an event. **That is a property of the settlement contract, not of the asset it moves.** The `Settled` event in v4 §7.9 works byte-identically with USDC as the transferred asset.

The enforcement counter-argument — that an opt-in wrapper gets skipped, whereas a token could make provenance mandatory — fails on a technicality that is not small. Making it mandatory means requiring the fields in `transfer`, and a token with a non-standard `transfer` is not composable with wallets, escrow, DEXes or anything else. Keep `transfer` standard and provenance is optional again, which is the wrapper.

**The enforcement belongs in the verification layer instead**, where there is already a monopoly and it costs nothing: an unprovenanced payment simply does not verify through `verify_receipt`. That is stronger than an asset-level rule and it ships this quarter.

### 10.2 What SIUSD would need, hardest first

If it is ever built, the list is not a contract list:

1. **A licensed issuer.** Under MiCA a dollar-pegged token is an e-money token requiring EMI authorisation or a white-label arrangement with a licensed partner; under GENIUS it is a payment stablecoin requiring a permitted issuer. That is an entity with regulatory capital, a board, ongoing audits and a supervisor. Everything below is downstream of this.
2. Named reserve custodian and segregation structure.
3. A written redemption policy: who may redeem, minimum size, settlement time, behaviour under stress.
4. Attestation cadence and a named auditor.
5. A depeg playbook.
6. **The freeze question** — see below.

### 10.3 The freeze contradiction

Regulated buyers require sanctions compliance, which means someone can freeze a balance. That is discretionary power over user funds, held by the same institution that publishes the price of the market.

The escrow contract forbids an admin path to user funds; v4 §7.7 invariant 5 asserts it structurally from the compiled ABI. SIUSD reintroduces exactly that path, at the entity holding the index. Either the freeze exists and neutrality is gone, or it does not and the regulated buyers it was built for cannot touch it.

This is another instance of §9: if SIUSD is ever issued, it is issued by Markets or by a licensed partner, never by the Assay.

### 10.4 Disposition

**Ship the receipt over USDC. Do not issue.**

The settlement contract with the provenance event is a few hundred lines, needs no licence, no reserves, no custodian and no redemption desk, and delivers the audit trail that was the entire justification. v4 §7.9 already contains the correct instinct: *if the free version is not adopted, the paid version would not have been either.*

If provenance-carrying dollars are ever genuinely demanded, the answer is white-label issuance with a regulated partner — a fee business, not a float business, as v4 already concluded.

## 11. Decentralised measurement

Two things have been merged and must be separated: **who computes the print** and **who executes the measurement**. The first is safe, cheap and available now. The second is dangerous and premature.

> Replication removes publisher dependence. Delegation removes control while leaving responsibility.

### 11.1 Why paid node-style measurement fails

The blockchain-node analogy does not transfer, for a specific reason. Nodes work because execution is deterministic and verification is cheap — anyone re-runs the EVM and gets the same hash for a fraction of the cost of producing it. Inference measurement has neither property: sampling is nondeterministic, models update silently, latency is load-dependent, and prices are private per account. There is no re-execution that checks a reported number, and re-running costs real money and returns a different answer.

So paying strangers in a token for unverifiable numbers creates a market in **fabricated measurements**, where the cheapest way to earn is to report plausible figures and buy no inference. Sybil resistance does not help: one real, identity-verified account submitting invented numbers passes every check. **The verification problem is upstream of the incentive problem, and no incentive design solves it.**

Three further objections, each independently sufficient:

- **Composition.** The people willing to run inference at scale are providers and their resellers. An index of the price of AI work computed by the sellers of AI work, paid in a token whose value depends on that index mattering, is LIBOR's structure exactly — and it inverts v4's own evidence hierarchy, which puts user-submitted counts at rank six, never determinative.
- **Responsibility does not transfer.** The basket, gates, weights, constituent criteria and aggregation *are* the index; running jobs is labour. Under BMR someone must be the named administrator with an oversight function. "The public" is not an available answer.
- **It deletes the moat.** v4 §11 defines the moat as continuous spend that cannot be backfilled. Replace spend with an incentive scheme and the moat becomes token network effects, which is the weakest kind and trivially forkable.

All of this to distribute a cost currently running around eleven cents a print.

### 11.2 Replication — do this now

Publish the raw per-run records, keep the harness open, ship the replay SDK, and get independent parties recomputing the print from the same inputs and confirming the number. That is multi-party computation of the print, it answers *what stops Touchstone moving its own number*, and it needs no token, no Sybil resistance and no securities analysis.

**Incentives for replicators — and money is not one of them.** A paid replicator's confirmation is worth less than a free one's.

| Replicator | Why they do it |
| --- | --- |
| **A prospective licensee** (gateway, lender, venue) | Standing replication is cheaper than repeated diligence on a number they intend to reference |
| **An academic group** | A reproducibility study of the first inference-work index is a publishable artefact. Sky Lab and BenchJack are already identified in v3.2. |
| **A competitor or sceptic** | The most valuable participant. A hostile replication that confirms the number settles the question permanently. Make it as easy as possible. |

**The mechanism that makes all three happen:** publish a **reproducibility rate** as a headline statistic beside the print, with named replicators and their computed deltas. Being listed then becomes the incentive — independence for the academic, diligence for the licensee — and it costs nothing.

### 11.3 Contribution — the ladder, and it is not a token

For parties running actual inference and submitting measurements, the incentive ladder in order of when it becomes available:

1. **Reciprocity.** Contributors receive the complete per-run dataset and history; everyone else gets the headline. This is Pyth's structure, costs nothing, and cannot be gamed into value — the data is worthless to someone not already measuring.
2. **Coverage recognition.** A contributed regional or enterprise-tier price that materially moves a print gets named on the print page. For a regional cloud that is distribution.
3. **Financing legibility — the real one.** A provider signs usage attestations *as a term of bonded participation*, and receives auditable evidence of committed capacity, delivered work, fulfilment rate and realised revenue. For a provider whose binding constraint is cost of capital, that is worth more than any fee. It also converts contribution from a favour into a contractual obligation from a party with collateral at risk, which is why ATC attestations rank second in the hierarchy and open submissions rank fifth.

**Never pay per submission, in any asset.** If someone will only contribute for money, theirs is the data least worth having.

### 11.4 The manipulation-cost bound

Borrowed from ACR (§12) and stronger in this design than in theirs. Publish, beside every print: *what would it cost to move this number by one basis point?*

Under equal weighting across the qualifying set, with prices from executed runs, **the only way to move Dated SIU is to genuinely reduce the price of completed work.** A benchmark that can only be moved by making work actually cheaper is an extraordinary property, it is true of this design, and it is not true of a survey or a tape-derived index.

Alongside it, publish **dispersion** — the spread across constituents. With a small, open-weight-only reference set, the spread is currently more informative than the headline.

## 12. ACR, and transaction-cost analysis

### 12.1 What ACR is

A payment-tape reference rate for compute (inference, GPU, data) on Arc, recovered hourly from x402 settlement exhaust, with a hedonic adjustment stripping seller quality, a published confidence interval, a manipulation-cost bound, a futures contract and six MCP tools. Built by a third party; won the Arc prize at ETHOnline 2026.

It is precisely the *external ACR-style payment-tape index* the internal stack document instructs against building, and that instruction stands. It is supply-side, and it has **no quality gate** — an agent that paid three times for three bad completions appears in ACR as three fairly-priced trades. That gap is the entire Touchstone thesis, and it is untouched.

### 12.2 The uncomfortable part

Two real challenges to positioning, worth recording rather than dismissing.

**The moat argument weakens.** "A measurement index requires continuous spend and its history cannot be backfilled" is the stated moat. ACR reads the tape for free, and its history is on-chain, so it *can* be backfilled by re-indexing. It is also transaction-recovered rather than self-purchased, which is closer to SOFR than a self-executed basket is — on the LIBOR-to-SOFR argument this project cites itself.

**The coverage hole is real.** Executed runs measure one buyer's access to the market. A tape measures everyone's.

**The counterweight, which is decisive for now:** their tape is empty, and they disclose it — testnet, partly their own flow, flagged synthetic. A payment-tape index is only as good as its payments, and agent-to-agent x402 volume barely exists. Touchstone can buy real inference from real providers today and get real prices; they cannot. The threat is to the durability of the moat argument, not to the current position.

### 12.3 What to take

1. **The manipulation-cost bound** — see §11.4. The single most credible statement a benchmark publisher can make, and stronger here than there.
2. **Published dispersion and confidence intervals** beside every print.
3. **The TCA frame, taken outright.** *"Did I pay more than the benchmark at the moment I traded, and to whom?"* is a better demand story than comparability at 402-response speed. Comparability is a one-shot decision benefit; TCA is retrospective, aggregated and recurring, and best execution is why institutions need reference rates at all.

### 12.4 Work TCA — shippable now

Every receipt already carries a `print_id` and an SIU amount, so **spread-to-index at settlement time is a query, not a build**. That is the monitoring subscription the lender product implies, arriving early and for a different customer.

Extend it one layer up, which is where the real markups are and connects directly to §8.3: buy agent services from the agent marketplaces, run the same tasks through the basket, and publish **spread-to-index per listed agent service**.

> *"This agent charges 340 for work the index prices at 90."*

This requires no supply side, no collateral, no member and no issuer. It addresses a genuine market failure — buyers of agent services currently cannot tell whether they are paying 2× or 20× underlying cost — and it makes **every agent seller in those marketplaces care about the print**. Which is how they become issuers later (§8.2).

### 12.5 The joint product worth proposing

ACR-INF prices a paid inference call. Dated SIU prices a completed task. **The ratio between them is how many paid calls it takes to get one thing that works.**

That is the token-efficiency curve the August 2026 state-of-AI report explicitly declined to draw, because vendor claims each compare a model to its own predecessor on different tasks with no common benchmark. Neither project can compute it alone.

That is a joint publication, not a competitive overlap, and it is the most interesting number either could produce this year. Both are on Arc, both are x402- and MCP-native, and the author disclosed synthetic flow and sandbox identities unprompted — which is the behaviour of someone serious.

**Reach out before they conclude that adding a quality gate to ACR-INF is the obvious next step** — because it is, and it is a far shorter path for them than building a benchmark is for anyone else.

## 13. Build order

Each step has exit evidence, and each step can fail in a way that stops the next one. That is the point: **the order is designed so the expensive things are gated on cheap findings.**

### Now — three things, this quarter

| # | Build | Exit evidence | Why now |
| --- | --- | --- | --- |
| 1 | **Fix the SIU scale** (§3.1) | Base unit rescaled so ordinary quotes land 1–1000; the $0.0014 / 0.0003 reconciliation resolved | **Has a deadline.** Once history accumulates the magnitude is frozen. |
| 2 | **The integer-quoting experiment** (§3.3) | Published error rates, dollars versus integer units, same decisions, same models | Cheapest high-value experiment available; nobody else can run it |
| 3 | **Work TCA / spread-to-index** (§12.4) | Spread-to-index published per settled receipt, then per listed agent service | Needs no supply side; makes agent sellers care about the print |

Alongside, three low-cost additions to the print page: the **manipulation-cost bound**, **dispersion across constituents**, and a **reproducibility rate** with named replicators (§11).

And one phone call, which is worth more than any of the builds: **find one fixed-price AI vendor with a cost problem and ask whether they would pay to fix the price of completed work for two quarters.** If yes, there is a customer and a counterparty. If no, the honest finding is that this is the best deflator in the agent economy and the instrument question is closed.

### Next — the first claim

| # | Build | Exit evidence |
| --- | --- | --- |
| 4 | **Per-class prints promoted to primary** (§3.2) | SIU-code, SIU-extract, SIU-longcontext published as products; blended becomes the headline |
| 5 | **Two-series split** (§3.4) | Settlement series specified as mechanical and never adjusted; capability series separate and labelled discontinuous |
| 6 | **One bilateral forward** (§5) | A signed, bonded, dated commitment between one issuer and one hedger, delivered or defaulted. The whole mechanism proven at n=1. |
| 7 | **Bond denomination resolved** (§7.3) | A written answer, most likely routed through a hardware lender. Gates everything after. |

### Then — standardisation, on evidence

| # | Build | Exit evidence |
| --- | --- | --- |
| 8 | **Standardised tenors and contract spec** (§6) | Monthly delivery windows per class, published specification, promise ladder attached |
| 9 | **Observe secondary trading** | Does anyone sell a claim before delivery? **If not, there is no transferable work instrument and the project stops here — which is a finding, not a failure.** |
| 10 | **Publish the curve** (§6.2) | Two or more delivery months with observable prices, labelled indicative and sparse, with contributing transaction counts |

### Later — only if earned

| # | Build | Gate |
| --- | --- | --- |
| 11 | Reference-rate licensing to a venue | A curve with history |
| 12 | Clearing / par enforcement | Several issuers, and the §9.4 preconditions actually met |
| 13 | SIUSD | Demonstrated demand the USDC receipt could not serve (§10.4) |
| 14 | Any token | Markets only, never the Assay, never over the basket (§9.5) |

### Never

- The Assay issuing, clearing, routing, ranking or holding any position.
- Token-weighted governance over basket, weights, gates or prints.
- Paying per submission for unverifiable measurements (§11.1).
- A Touchstone-operated derivatives venue (unchanged from v3.2).

## 14. Open questions

Ordered by what they gate, not by difficulty.

**1. The SIU scale, and the $0.0014 / 0.0003 reconciliation.** *Gates: everything denominated in the unit, permanently.* The only question here with a deadline, because chain-linking freezes the magnitude once history exists. Decide from the measured distribution of real quotes.

**2. What the bond is denominated in.** *Gates: whether any claim can be issued at all.* Circular in wSIU, motive-destroying in full USDC, credit-creating in partial USDC, and legally heavy in hardware. Most likely answer routes through a lender who already perfects GPU liens. §7.3.

**3. Is there a real hedger?** *Gates: whether the instrument is built.* One fixed-price vendor willing to pay to fix the cost of completed work for two quarters. A phone call, not a build. If the answer is no, the honest conclusion is the deflator business, and that should be accepted rather than engineered around.

**4. Default correlation.** *Gates: individual versus mutualised collateral.* If correlation is high — and the plausible failure modes are all systemic — mutualisation does nothing and claims should be individually collateralised, which is what a bilateral forward already is. §7.4.

**5. Legal classification of a dated, transferable work claim.** *Gates: standardisation and transferability.* Three narrow questions for a real lawyer: does dated redemption-in-services with no cash par avoid collective-investment-scheme treatment in the EU; does transferability alone trigger it; does taking cash today against future services reach deposit-taking in the US. Redemption in services is a strong fact, and dating it makes it stronger. **Not advice — get an opinion.**

**6. Conversion-rate stability.** *Gates: whether issuance limits can be set at all.* Unchanged from v4 §8.11 and testable today against the existing registry. If the rate is unstable between measurements, bonding against it is unsound and the whole issuance structure needs a different denominator.

**7. Does a standardised claim trade secondhand?** *Gates: the curve, and everything after it.* Unanswerable in advance and cheap to observe once step 8 exists. A negative answer closes the instrument question honestly.

**8. Tenor granularity.** *Gates: curve resolution.* Monthly is the obvious default from commodity practice, but AI work may move too fast for monthly to be meaningful. Weekly tenors give more curve points and thinner liquidity per point.

**9. Naming.** The instrument needs one. "Dated Work Claim" is descriptive and clumsy; fSIU carries pooled-on-demand baggage; anything ending in -SIU will be read as a token. Settle before publication, because the name travels further than the specification.

**10. Whether the Assay can fund itself.** *Gates: the separation being real rather than planned, which gates everything in §9.* Currently unresolved and currently the reason the whole structure is described as a plan.

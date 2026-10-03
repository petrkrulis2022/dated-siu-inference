# fSIU — the dated work claim: routing, grades, basis and the pool

_Status: design record for the Gate Market testbed. Written 2026-09-29. Authority for the four
mechanics named in the title; `docs/gate-market-spec.md` remains the authority for the testbed
build as a whole and `docs/monetary-design.md` for the economics it is a miniature of._

---

## 0. What this document is, and the caveat that goes on every output

Four mechanics of the dated work claim — how a mint is routed to an issuer, what a grade is, what
a basis would be, and how the bonded pool behaves — existed only in conversation and in contract
doc comments. This document states them in one place, separates what is implemented from what is
intended, and records the open questions each one leaves.

**fSIU is a closed testnet experiment, not a product surface.** `CLAUDE.md` invariant 3 says no
token exists in build 1; the Gate Market testbed is a sanctioned exception to that invariant,
scoped to itself. `WorkClaim`, `CapacityBond` and `ClaimRouter` are deployed to testnet only,
they measure whether agents choose fSIU over USDC, and nothing here opens the door to wSIU, SIUSD
or any token in the print or escrow pipeline. Every figure produced by a run carries the testbed
caveat in `gate-market-spec.md` §1.1.

**The parent structure is a power purchase agreement, not a futures contract on a stored good.**
Completed AI work is not storable (`monetary-design.md` §2), so there is no spot leg to hold
against a forward and no carry to anchor a curve. What remains is the electricity structure: a
dated, bilateral, collateralised commitment to deliver non-storable output, where the buyer wants
cost certainty and the seller wants cash against depreciating hardware.

---

## 1. The instrument

A dated work claim is an ERC-1155 position in `WorkClaim.sol` whose token id is:

```
tokenId = uint256(keccak256(abi.encode(issuer, classId, series, windowFrom, windowTo)))
```

Five things, and the identity of the instrument is exactly those five:

| Component | Meaning | Source of truth |
| --- | --- | --- |
| `issuer` | the one address whose bond answers for this claim | fixed by the router at mint |
| `classId` | task class — `code`, `extract` | `keccak256(<plain class name>)` |
| `series` | **grade** — which published print it settles against | §2 below |
| `windowFrom`/`windowTo` | the delivery window, half-open `[from, to)` | chosen by the buyer at mint |

A claim is fungible **within** all five and never across any of them. Two issuers' claims for the
same class, grade and window are different tokens. That is the deliberate bilateral stage:
each issuer's bond answers for that issuer's claims alone, no risk is mutualised, and no clearing
function is needed. Pooled cross-issuer fungibility is a later stage and needs a real default
fund — see §3.2 for why it is not simply a nicer version of the same contract.

**Not on demand.** `presentForRedemption` reverts before `windowFrom` and after `windowTo`. This
is what removes the queue, the run and the demand liability that sank every earlier holdable-claim
design.

**Failed work counts zero.** `serveRedemption` retires the claim and restores headroom only when
the gate passes. A failed presentation leaves the claim alive and the holder may present again
inside the window. This is the single behaviour separating fSIU from a token that pays for effort.

---

## 2. Grades

### 2.1 A grade is a print series, and it is orthogonal to the task class

`classId` says *what work*. `series` says *which published assessment the claim settles against*.
They are independent axes: `code`/commodity and `code`/frontier are different instruments with the
same deliverable and different settlement references.

`WorkClaim` declares two:

```solidity
bytes32 public constant SERIES_FRONTIER  = keccak256("frontier");
bytes32 public constant SERIES_COMMODITY = keccak256("commodity");
```

These match `Print.series` in the real print pipeline (`packages/sdk/schemas/print.schema.json`),
so a claim's grade names a series Touchstone Assay actually publishes rather than a category
invented for the contract.

### 2.2 What is actually enforced on-chain

Stated precisely, because the constants suggest a stricter rule than the code contains:

- `mint` requires `att.series == series` — the rate attestation presented at mint must be for the
  same grade as the claim being minted. A caller cannot mint a frontier claim while attesting a
  commodity rate.
- `settleWindowClose` requires the same equality again on the default path, plus
  `att.printDate == dayStart(windowTo)` — a default pays at that claim's own grade's print, dated
  the day the window closed, not at whatever print is most convenient.
- **The contract does not enumerate the permitted grades.** Nothing rejects an arbitrary `series`
  value; `RateAttestationVerifier` checks an EIP-712 signature over
  `(printId, series, printDate, nanoUsdPerSiu, validUntil)` and does not constrain the series
  field either. The permitted grade set is therefore enforced by **what the publisher key will
  sign**, not by the token contract.

This is a real property to know before anything is built against it. If the grade set should be
closed on-chain, it is a contract change, not a configuration one.

### 2.3 Why grade is inside the token id

It was not, before 2026-09-27. A claim had no grade at all, so a frontier claim could
default-settle against a commodity or blended rate — underpayment of the holder, not a naming gap.
Putting grade in the id makes settlement reference part of the instrument's identity, which is
what it always was economically.

### 2.4 What grade does *not* do yet

- **The testbed only ever mints commodity.** Both issuers' capacity models are commodity-class,
  so the P5 runners load the most recent `<date>-commodity.json` print and attest against it. The
  frontier path is implemented and untested by a live run.
- **Blended is not a claim grade.** It exists as a published series but is confounded by registry
  growth (`monetary-design.md` §6.4); nothing should settle against it.
- **There is no credit grade.** An issuer that defaults on everything and an issuer that serves
  everything produce identically-priced claims in this build, because price comes from the
  attested print and not from the issuer. Issuer credit showing up *in the claim price* is a
  consequence of pooling that has not been built. See §3.4.

---

## 3. The routing rule

### 3.1 The rule as implemented

`ClaimRouter.route(classId, amount)` returns **the first issuer, in registration order, whose
headroom in that class is at least `amount` by itself**. If none qualifies it reverts
`NoIssuerWithHeadroom`. The candidate set is `CapacityBond.issuersForClass`, in the order lots
were created.

The buyer specifies class, quantity, grade and window. **The buyer never picks the issuer.** That
is the property the router exists to guarantee — not "the buyer got the best issuer", which a
buyer has no way to verify anyway. First-fit is deterministic given on-chain state and auditable
by anyone; an optimisation would be neither.

Headroom is the only input. Not price, not reliability, not how much capacity remains
proportionally.

### 3.2 Routing happens at mint, and cannot simply be moved to redemption

`monetary-design.md` §6.1 describes claims as fungible across issuers within one (class, window),
with routing at *redemption*: a holder presents, and whichever issuer has headroom serves it. That
is the pooled design, and it is not what is built.

The blocker is specific. A shared pool that only *partially* defaults has to attribute the
shortfall back to individual issuers, and nothing in the corpus states how. `monetary-design.md`
§7.4 flags default correlation as open; no section resolves the attribution rule. Writing an
improvised proportional rule directly into a contract holding bonded USDC is not an acceptable way
to discover the answer. Routing at mint sidesteps it entirely: every claim's default liability is
one issuer's, unambiguously.

The cost is the one recorded in §1 — no cross-issuer fungibility, so no single instrument per
(class, grade, window), so a thinner book than the pooled design would produce. Worth reopening
once attribution has a real answer, not before.

### 3.3 The same router serves the dollar route

`WorkClaim.reserveForWork` calls `ClaimRouter.route` with the same arguments a mint would. A
USDC-settled job therefore consumes an issuer's headroom on exactly the same rule and reverts on
exactly the same shortage, at the moment of acceptance rather than after the work is done. See
§4.5.

### 3.4 First-fit means nothing in the system reacts to a chronic defaulter

An issuer that has defaulted on every claim ever presented to it is exactly as eligible as one
that has served every claim, and keeps taking new mints until arithmetic — never reputation —
drops its headroom below the job size.

**The design's own answer is a redemption-pressure rule**: weight routing by how much an issuer
owes against how much it has actually delivered, so an issuer carrying claims it never serves
stops receiving new ones — automatically, with nobody adjudicating anything. It is recorded here
because it has been stated by the project owner and is implemented nowhere; `gate-market-spec.md`
§4.6g notes it is absent from `monetary-design.md` too, and it should be written into the monetary
design proper before anything is built against it.

**Its direction is not settled, and should not be inferred from either document.** §4.6g states it
as routing *to* "the issuer with the highest ratio of outstanding claims to work actually
delivered", which is the chronic defaulter — the opposite of the effect the same sentence claims
for it. One of the two halves is a slip, and which one is a design decision rather than an editing
one: routing to the *least*-pressured issuer starves a defaulter of new business, while the
inverse would be a rule about forcing a struggling issuer to clear its book. The effect everyone
has agreed on is "move work away from a chronic defaulter"; the ratio that produces it must be
written down explicitly when the rule lands in the monetary design.

**Recorded rather than fixed, deliberately.** Changing the routing rule mid-experiment alters
which issuer receives which claim and makes runs non-comparable — the same error as reweighting a
basket mid-series. The five comparable F1 runs must execute under one protocol. The next run
starts from a decision about this rather than rediscovering it.

One caveat on how this reads: `gate-market-spec.md` §3 states the rule as "routes to whichever
issuer has headroom in that class", which is what the contract implements. The gap is between the
testbed and the monetary design, not between the code and the spec it was written against.

---

## 4. Pool mechanics

### 4.1 One lot, one formula

An issuer opens a capacity lot per task class by bonding USDC against a **measured** rate — the
probe workload measures SIU/hour before the run; it is never self-asserted.

```
issuanceLimit = committedCapacityHours × measuredRateMilliSiuPerHour × ISSUANCE_RATIO_BPS / 10000
headroom      = issuanceLimit − outstanding          (floored at zero)
```

`ISSUANCE_RATIO_BPS` is 5000 — a 0.5 ratio — and is a constant, not a per-lot parameter. Not
because 0.5 is correct: the correct value depends on a default-correlation assumption nobody has
stated. It is fixed because the testbed needs a number, a conservative one makes headroom
exhaustion reachable inside a run, and making it per-lot would let an issuer choose its own
leverage, which is a real economic question this build deliberately does not open.

Quantities are in **mSIU** (1/1000 SIU) throughout, so issuance limits and headroom are whole
integers and no fixed-point arithmetic is needed on-chain. This is the same integer discipline as
invariant 4: no floats in money maths.

**One lot per (issuer, class) forever** — no top-up, no re-bonding. A mutation of committed
figures would retroactively change the basis every already-minted claim was issued under.

### 4.2 Headroom is contract state, never self-reported

`outstanding` is mutated only by `WorkClaim`, at an immutable address set at construction.
`CapacityBond` holds collateral and arithmetic; `WorkClaim` owns claim lifecycle. The
money-holding contract never reasons about ERC-1155 semantics and the token contract never moves
USDC except through the bond.

### 4.3 Every terminal state restores headroom

Three ways a claim ends, and all three free the capacity they consumed:

| Terminal state | Trigger | Holder receives | Headroom |
| --- | --- | --- | --- |
| **Redeemed** | issuer calls `serveRedemption`, gate passes | the work | restored |
| **Defaulted** | window closed, holder *had* presented | USDC from that issuer's bond | restored |
| **Expired** | window closed, holder *never* presented | nothing | restored |

If any one of them did not restore, headroom would lock up permanently against claims nobody
redeemed and nobody defaulted on either.

Default and expire are distinguished by `everPresented[tokenId][holder]` — a monotonic latch set
the first time a holder presents, never reset. A holder who never asked for the work has not been
failed by the issuer, and is not owed the bond.

`settleWindowClose` is **permissionless**: the destination is the same holder whose balance is
being settled, fixed by state, so any caller adds liveness without adding authority. It is
callable at most once per `(tokenId, holder)` via the `settled` latch, and effects are applied
before the USDC transfer so a reentrant call sees a zero balance and an already-settled position.

### 4.3a Presentation is what makes a claim enforceable, and nothing says so

The table above is correct and the rule behind it is deliberate: a holder who never asked for
the work has not been failed by its issuer and is not owed the bond. **This section is not a
proposal to change that.** It is about what the rule means for a holder, which no surface in the
system states.

**Presentation converts a claim from an option into an enforceable obligation.** Before
`redeem_claim`, a claim is a position: it consumes the issuer's headroom and entitles its holder
to ask for work, and it is worth exactly the work it can still be exchanged for. After
presentation, `everPresented` latches and the claim becomes a debt — if the issuer does not
deliver, the bond pays. At window close the two diverge completely:

- presented and unserved → `Defaulted`, the bond pays the holder the attested print value;
- never presented → `Expired`, the holder receives **nothing**, and the issuer's capacity is
  returned to it.

So the entire value of an fSIU position turns on one action taken before one deadline. **A
holder that does nothing loses everything, and the issuer that was holding the capacity gets it
back.**

**The rule is stated; the deadline is not.** The shared claim facts every holder carries say it
plainly — *"if you never presented it, it simply expires and pays nothing"*, and *"a claim
carries the delivery window it was minted for. Holding it past that window does not move the
window."* What no surface supplies is **when that window closes for the claim actually in
hand**. The arrival notice reads, in full:

```
A WORK CLAIM WAS TRANSFERRED TO YOU
  tokenId <id>, quantity <n>.
  Confirm with get_balances (pass this tokenId), then call redeem_claim once ready.
```

No expiry, no remaining time, no window. The loop has the figure — `pay_with_claim` records
`time_to_expiry` on its own capacity event — and does not pass it on. So a holder can know the
rule perfectly, hold a plan that depends on the deadline, and have no way to evaluate it.

**Run 17 is what this looks like in practice** (spec §4.6ag). WORKER-CODE was paid in fSIU and
kept the claim rather than redeeming it — the first deliberate hold in this project's history,
and the behaviour the instrument exists to make possible. Its reason was a real use: *"preserving
the claim for later use (e.g. funding adversarial testing once I have a gate to defend, or
settling a future quote)"* — and `transfer_claim` exists for exactly that, so the plan was sound
in every respect except timing. The claim died at that window's close, roughly forty minutes
later, and "later" was never available. At window close the claim was `Expired`. The holder received nothing, ISSUER-A — the issuer deliberately unable to deliver —
got its 10,000 mSIU back, and the holder was never told: the board section naming the claim was
present on one turn and simply absent on the next. In the same run, a claim the same agent *did*
present paid it 14,240 micro-USDC on exactly the same call.

**Two findings compounded, and the ordering is the point.** The seller could not tell it had been
paid (§4.6ag, the memo gap), so it held; holding without presenting forfeits (this section), so
it lost the lot. **The one agent that ever used fSIU as intended was the one it cost most.** A
design that punishes its own intended behaviour will not be used that way twice.

**Why this is an instrument property and not a testbed bug.** Nothing above depends on the
harness. It follows from `everPresented` gating the bond draw, which is the right rule, plus a
holder's reasonable belief that an asset it holds retains value while it holds it. A bearer
instrument in which holding without a further, undisclosed action silently forfeits the whole
position is a trap, and it is a trap that scales: build 2's `wSIU` is premised on claims moving
between hops *without* being unwrapped at each one, which is precisely holding without
presenting.

**What must change, in this build.**

1. **Put the deadline on the claim.** The arrival notice must carry the claim's own expiry, the
   figure the loop already holds. Stating the rule in a static brief while withholding the one
   number that makes it actionable is the §4.6-RULE shape: the agent is told what happens and
   cannot tell when.
2. **Warn before it is too late.** A holder still sitting on an unpresented claim as its window
   runs down must be told so, once, under the §4.6ae discipline: facts the holder could
   establish itself, no steer toward presenting, doing nothing left genuinely open. The point is
   an informed choice, not that everyone presents — a holder that lets a claim lapse knowingly
   is a result worth having.
3. **Stop telling an fSIU-paid seller it has not been paid.** The brief's *"an absence of `YOU
   HAVE BEEN PAID AND OWE THE WORK` means you have not been paid"* is true only of the dollar
   route. It is what caused the hold.

**What must change for build 2, recorded now rather than discovered later.** A transferable claim
whose value depends on an action the bearer may never take cannot be passed hop to hop safely.
Either the presentation latch has to travel with the claim, or `wSIU` must wrap only presented
claims, or redemption must be automatic at window close. That is a fork in the design and it is
better named here than met during the port.

### 4.4 What the bond pays, and the disclosed limitation

`drawForDefault` transfers from the issuer's bonded USDC to the holder, at the claim's own grade's
print for the day the window closed.

The settlement amount reaches the contract as a caller-supplied figure inside a
publisher-signed attestation. The honest fix — verifying a `dated_siu` value against
`TouchstoneAttestation`'s anchored `bodyHash` on the same chain — means reproducing the print
body's exact JCS canonicalisation on-chain, which is real work deliberately out of scope for this
pass. It is disclosed rather than half-solved, mirroring `TouchstoneEscrow`'s own limitation.

Two things bound the exposure in the meantime:

1. **A genuine publisher signature is required** (EIP-712, `RateAttestationVerifier`).
2. **A ±50% settlement band** (`SETTLEMENT_RATE_BAND_BPS = 5000`) clamps a verified rate to the
   nearest edge of a band around the rate attested at that token id's first mint. The band is
   grounded in the real print history: recomputed across every published commodity print from
   2026-09-01 to 2026-09-25 (24 prints), the largest single-day move is 1.38%, so ±50% leaves
   roughly 35× headroom over the largest real movement while still bounding an attacker, who
   needs a large multiple of the true rate to drain a bond.

It **clamps rather than reverts**, found live on 2026-09-25: the index has already shown a
single-day move over 30% from a basket composition change, and a genuine attestation for such a
rate would revert forever under a strict check — a defaulted claim that can never settle traps
the holder's funds permanently, which is worse than the attack the band defends against. A clamp
still bounds a forged rate's damage to the band edge and still pays a legitimate holder something
real. `SettlementRateClamped` is emitted only when a clamp actually happened, so its presence is
itself an operational signal.

### 4.5 One pool, two instruments

Since 2026-09-28 both ways of paying draw on the same finite headroom. Before that, minting
consumed capacity and paying in dollars consumed nothing — verified live in the first real P5
window, where an entire USDC purchase completed with the issuer's headroom untouched. Scarcity
that binds one route only is not a choice between two assets; it is a choice between accepting a
constraint and not, and an F1 preference measured against it would have measured the asymmetry.

The dollar route:

```
RESERVE   the seller named in a real Open escrow calls reserveForWork(quoteHash, classId, qty)
          → routed by ClaimRouter exactly as a mint is → headroom consumed
RELEASE   the escrow settles, or its own expiry passes unsettled → headroom restored
```

Design details worth keeping:

- **Only the escrow's named seller may reserve.** Consuming headroom costs the caller nothing
  directly, so without that tie it would be griefable.
- **The deadline is the escrow's own expiry**, deliberately. Capacity stays committed exactly as
  long as the payment commitment the two parties already agreed to, and no longer; any other
  number invents a second deadline nobody agreed to.
- **Release is permissionless in both cases.** An escrow opened, reserved against and abandoned
  must not lock an issuer's capacity because nobody with a stake bothers to call.
- The release check is `>=`, so at exactly `expiry` both settling and releasing are momentarily
  possible. Harmless — `released` is one-way — and stated rather than papered over.

What stays genuinely different between the two routes, and must appear in every run output rather
than be smoothed over:

| | Claim (MINT) | Dollar payment (RESERVE) |
| --- | --- | --- |
| Capacity is for | a **future** delivery window | **immediate** work only |
| Transferable | yes — held, passed on, redeemed by whoever holds it | no |
| Is it an instrument | yes, an ERC-1155 position | no, a mapping entry |
| Issuer compensated for the reservation | yes, paid USDC at mint | **no** |

The last row is an open gap, disclosed rather than closed with a fee this testbed has no basis to
set. A reservation is deliberately not a token: that distinction is the real difference between
the routes and belongs beside any F1 result.

---

## 5. Basis

### 5.1 What basis would mean here

Basis is the difference between the price of a dated claim and the prevailing print for the same
grade — what a buyer pays for a later window over or under today's assessment. A term structure of
basis across delivery windows is a forward curve, and a forward curve for AI work does not exist
anywhere today. It is the licensable object this whole structure is aimed at
(`monetary-design.md` §6.2).

### 5.2 In this build, basis is zero by construction

`WorkClaim.mint` charges `quantity × the attested print rate`, and the attestation is signed by
the **publisher**, not by the issuer. There is no field in which an issuer's own price could enter
a mint. Every claim in every run to date was therefore transacted at the print, and **the testbed
cannot produce a basis observation.**

This is a stopping point, not an oversight. Binding an issuer to a price it named in advance means
a contract that can hold it to that price, which is a new instrument — outside build 1 and outside
the sanctioned exception this testbed runs under.

### 5.3 What is collected instead: stated terms

An issuer may state terms for a later window (`quote_forward`: a price per SIU and a quantity), and
a buyer may record acting on one (`take_forward`). The book keeps:

- **Every offer, taken or not.** A book holding only accepted terms shows a market that always
  clears; a refused offer at a stated price is as much a datum as an accepted one.
- **The issuer's real headroom at the moment it quoted.** An offer of 20,000 mSIU from an issuer
  holding 200 is a different datum from the same number with capacity behind it.
- **Who took it and in which window**, or `null`.

`take_forward` pays nothing, mints nothing and reserves nothing. It exists only so that taking an
offer and ignoring one are distinguishable outcomes rather than the same silence. Every surface
showing a forward term says that nothing enforces it.

This is the raw material a curve would be built from. It is not a curve, and must never be
published as one.

### 5.4 The sign the theory expects, and why it is not evidence yet

The structural consensus in AI work is *downward*. So unlike crypto, where longs are crowded and
funding flows to shorts, a forward market in completed work should be crowded **short**, with the
risk premium accruing to whoever is willing to be long: **a provider selling work forward should
expect to sell above expected spot**, because it is supplying protection to the crowded side. That
is the inverted carry, and it is testable the moment any forward actually trades.

The honest limit, measured rather than asserted: **our own series does not evidence the decline
this is often assumed to express.** Across 26 Commodity SIU prints the log-linear drift is
+0.034%/day at R² 0.21 — noise, not a trend — and the steeper Frontier and blended series are
confounded by registry growth, since each admission changes basket composition. A forward price
cannot be derived from this series. It has to come from what issuers quote and buyers accept.

### 5.4a The first observable sign, from run 9

Four forward offers were stated in run 9 (2026-09-29) and **none was taken**, so there is still no
basis. What is new is that the offers themselves are now observable, and both issuers priced
*above* the prevailing print of $0.001427/SIU:

| Offer | Issuer | For | Rate | vs print | Quantity | Real headroom at quote |
| --- | --- | --- | --- | --- | --- | --- |
| fwd-1 | ISSUER-B | w2 | $0.002 | +40% | 32,000 | 32,000 |
| fwd-2 | ISSUER-A | w2 | $0.0015 | +5% | 8,000 | **4,000** |
| fwd-3 | ISSUER-A | w3 | $0.0015 | +5% | 1,000 | 5,000 |
| fwd-4 | ISSUER-B | w3 | $0.002 | +40% | 32,000 | 32,000 |

That is the direction §5.4's inverted carry predicts — a seller of forward work is supplying
protection to a structurally crowded short side and should ask above expected spot. It is the
first time the sign has been observable at all.

**It is a sign and not a basis, and the gap between those is not rhetorical.** Four offers, zero
takes, from two agents, none binding, in a testbed where a mint charges the attested print
regardless of anything an issuer says. Nothing here is a transacted price, and a curve cannot be
built from offers nobody accepted.

fwd-2 is worth keeping for a different reason: 8,000 mSIU offered against 4,000 mSIU of real
headroom. An issuer offered twice the capacity it held. That is exactly the case
`issuerHeadroomAtQuote` was added to expose, and it is why an offer recorded without the headroom
behind it would be a misleading datum rather than a thin one.

### 5.4a-i Both runs' forward quotes are artefacts of the wake gate, not appetite

Run 13 (2026-09-30) produced two more forward offers, and on their face they read as an
improvement on run 9: both were struck at exactly the prevailing print of $0.001417/SIU rather
than above it, and both sat within the quoting issuer's real headroom, so run 9's fwd-2 problem
(8,000 offered against 4,000 real) did not recur.

**Neither observation can be read as issuer behaviour.** Spec §4.6s establishes why: the forward
invitation sits inside the wake gate's own input, and it clears only when the issuer actually
quotes. Both issuers in run 13 woke on every turn until the exact turn they called
`quote_forward`, and neither took a turn after. An agent re-asked every turn, with no way to
decline, eventually accepts — so what the offers measure is the loop, not the issuer's view of
forward value.

This applies retroactively to run 9. The table in §5.4a stands as a record of what was quoted; it
does **not** support the inference drawn beneath it that issuers "should ask above expected spot"
and were observed doing so. The direction may still be right — but four offers produced under a
standing re-ask are not evidence for it, and run 13's move to spot is not evidence against it.
Both are the same artefact at different temperatures.

Nothing about forward pricing should be quoted from either run until the invitation is fixed and
a run produces offers from issuers that could have declined.

### 5.3c An issuer can never leave the routing set — a production design issue

Found on 2026-10-02 while costing a testbed change, and it is not a testbed problem.

`CapacityBond._issuersForClass` is a `push`-only array. **There is no removal function, no
deregistration, and no admin path.** Once an address has created a lot for a class it is in that
class's routing set permanently, and `ClaimRouter.route` is first-fit over that order with
headroom its only input.

**The consequence for a real market is direct: a provider that stops operating keeps absorbing
claims forever.** It does not need to misbehave — it needs only to have registered once and to
still show headroom. Every buyer routed to it mints against a bond nobody is serving, and every
such claim defaults. The bond pays, so holders are made whole in dollars, but the *work* never
happens and the capacity is consumed on the way. A departed provider is indistinguishable, to
the router, from a working one with the same headroom.

Three things follow for the production contract, none of which the testbed needs:

- **Registration must be revocable**, by the issuer at minimum. An issuer winding down should be
  able to stop receiving claims without draining its own headroom to do it.
- **Routing should not be first-fit over registration order.** The design's own answer is a
  redemption-pressure rule — route by the ratio of outstanding claims to work actually delivered
  — which moves work away from a non-delivering issuer automatically and without anyone
  adjudicating (§3.2). First-fit makes the *earliest* registrant structurally advantaged, which
  is an accident of deployment order rather than a market property.
- **Liveness is not headroom.** Headroom says an issuer *could* mint; it says nothing about
  whether anyone is behind it. A router that cannot tell these apart will send work to the dead.

The testbed demonstrates the failure rather than hypothesising it: across runs 13-15 every claim
routed to the deliberately non-serving issuer and the claim route delivered in no window, purely
because that issuer was registered first and large. Nothing in the system noticed or adapted
(spec §4.6g, §3.5a).

### 5.4b The deferral property has never been exercised

Recorded 2026-09-30, because it bears directly on every claim this document makes about what an
fSIU *is*.

§1 defines the instrument by its delivery window: a claim reserves capacity for a **future**
window, and that is what separates it from a payment for immediate work (§4.5). The mint path
implements this — `forWindow` on `mint_claim` and `pay_with_claim` resolves to a later window's
real bounds, and refuses a window outside the run rather than clamping.

**No claim in any run has ever used it.** Across all six windows of runs 9 and 10, every claim was
minted for the window it was bought in, because the payer omitted `forWindow` and the default is
current-window.

The consequence for this document's own claims: the testbed has so far exercised the *settlement*
half of the instrument (mint, present, serve, default, expire, one shared bonded pool) and none of
the *dating* half. A same-window claim that must be presented immediately or expire worthless is,
economically, a prepayment with a bond behind it — not a forward. Nothing here about term
structure, scarcity across windows, or what makes a later window worth paying for (§5.5) has yet
been tested against an agent that could actually choose to wait.

### 5.5 What makes a later window worth paying for, absent a decline

**Scarcity.** Capacity for a later window is finite, shared across all buyers first-come
first-served, and someone else may take it first. That is only observable across windows, which is
why the real run is three windows against one pool with a simulated external buyer taking capacity
between them on a fixed, disclosed schedule — and why the last window is allowed to fail outright
if the pool is gone.

### 5.6 The settlement band is not a basis

`SETTLEMENT_RATE_BAND_BPS` (§4.4) bounds the rate a *default* pays at, relative to the rate
attested at first mint. It is a defence against a forged or mis-issued attestation draining a
bond. It is not a price, not a spread, and nothing about it should be read as a market observation.

---

## 6. Implemented versus intended

| Mechanic | Status | Where |
| --- | --- | --- |
| Token id scoped to (issuer, class, grade, window) | implemented | `WorkClaim.tokenIdFor` |
| Grade bound to the attested series at mint and at default | implemented | `WorkClaim.mint`, `settleWindowClose` |
| Closed set of permitted grades on-chain | **not implemented** — publisher signing policy only | §2.2 |
| First-fit routing at mint, buyer never picks | implemented | `ClaimRouter.route` |
| Redemption-time routing, cross-issuer fungibility | **not implemented** — blocked on default attribution | §3.2 |
| Redemption-pressure routing | **not implemented**, and not yet in the monetary design | §3.4 |
| Issuance limit, headroom, three restoring terminal states | implemented | `CapacityBond`, `WorkClaim` |
| Dollar route consuming the same pool | implemented | `WorkClaim.reserveForWork` / `releaseReservation` |
| Issuer compensation for a dollar-route reservation | **not implemented**, gap disclosed | §4.5 |
| On-chain verification of the settlement amount | **not implemented**, bounded by signature + band | §4.4 |
| Binding forward terms | **out of scope** — a new instrument | §5.2 |
| Forward terms recorded as stated prices | implemented | `ForwardQuoteBook` |

---

## 7. Open questions

1. **Default attribution in a shared pool.** Until a partial default can be attributed back to
   individual issuers, pooled fungibility cannot be built and claims stay bilateral. This is the
   single largest structural gap.
2. **The routing rule.** First-fit is recorded as a known weakness, not defended. Redemption
   pressure needs writing into `monetary-design.md` before anything is built against it, and the
   change cannot land mid-experiment without breaking run comparability.
3. **What the bond is denominated in.** Unresolved in `monetary-design.md` §7.3 and unchanged here.
4. **The issuance ratio.** 0.5 is a placeholder standing in for a default-correlation assumption
   nobody has stated (§7.4).
5. **Compensating an issuer for a dollar-route reservation.** A reservation costs an issuer real
   capacity and pays it nothing.
6. **Closing the grade set on-chain**, or deciding deliberately that publisher signing policy is
   the right place for it.
7. **Whether a basis ever appears.** It cannot under the current mint rule. The question is
   whether stated forward terms diverge from the print enough to justify building an instrument
   that could bind them.

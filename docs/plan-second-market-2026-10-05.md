# Plan: a second market — claims that trade rather than settle

**Plan only. Nothing here is built.** Written 2026-10-05 from the 2026-10-02 design note and the
decisions of 2026-10-05. It is built **after the F1/schedule block, as its own pack on the same
bench**. It does not replace the block: F1 asks which asset an agent pays in; this asks whether a
claim circulates once held.

## 1. The gap

Across every run to date a claim is minted, transferred once and redeemed within minutes. Nothing
has changed hands twice. Until a claim can be passed on for a reason other than the work it names,
accepting one is accepting an obligation to consume specific work from a specific issuer in a
specific window — a payment method, not money.

## 2. The dealer prices by Becker–DeGroot–Marschak, on both sides

No posted price: a posted bid manufactures the number it reports.

- The agent states its **limit price**. A random price is drawn from a **published range with a
  public seed**. The trade happens **at the random price, and only if that price is at least as good
  as the stated limit** (a sale needs it at or above the limit; a purchase at or below). Stating
  the true reservation price is then the agent's best strategy, which is what makes the stated
  limit a measurement.
- The range is expressed against the index for that grade and window and is fixed and published
  **before the run**. Its endpoints are parameters to be set at that time and are not chosen here.
- The accept/decline rule is mechanical and published in advance. The dealer never exercises
  judgement. The seed is published before the run so a draw can be reproduced afterwards.

## 3. What counts as circulation

A claim circulates only if it is held, before redemption, by **at least two different non-dealer
agents**. Hops through the dealer are reported **separately** and never counted toward circulation:
a round trip through the house is not a second holder.

## 4. No dollar redemption at the print, in this pack

If a holder could cash a claim at the print, no one would ever sell below it and the discount — the
thing being measured — could never appear. The Gate Market's deployed contracts already have no such
path (spec §4.6bb); this pack must not add one.

## 5. Mismatch comes from delivery windows, disclosed as designed

A dealer has no function without mismatched needs. The cleanest source is `forWindow`: an agent
holding a window-3 claim but needing work now has a real reason to sell, and one holding a window-1
claim with work coming later has the matching reason to buy. This also finally exercises
forward-dating (zero uses in every stored run). The design states the mismatch as a **designed
condition**. Task classes and issuers are weaker sources and are not used.

## 6. Neutrality — disclosed on every output, bounded to the testbed

Every output states that **Touchstone was the counterparty to every dealer trade.** Mechanical
rules only. Touchstone runs both issuers, every agent and the external buyer in the testbed, so
nothing here is new in kind, but it is Touchstone taking a position in a market it prices.
**Production boundary, recorded now:** if claims ever trade for real, the dealer is Touchstone
Markets or a third party, **never the Assay.** This experiment is not a precedent for the Assay
holding inventory.

## 7. Open questions that must be settled before building

1. **Atomicity.** A sale needs two legs — claim one way, dollars the other. `transfer_claim`
   settles a quote today and does not move dollars. Two separate transfers are not atomic, and
   whether anyone will trade at all depends on it. An atomic swap needs a contract.
2. **Invariant check.** A swap contract must stay non-custodial (invariant 2: funds move only to the
   pre-agreed counterparty, back to the payer, or to the fee treasury) and issue no token
   (invariant 3). The testbed's sanctioned token exception covers `WorkClaim`, `CapacityBond` and
   `ClaimRouter` only, so a dealer contract is **not** covered by it and needs its own decision.
   A design where each leg moves straight between the two parties' balances in one transaction,
   with nothing held in between, is the form that fits.
3. **Does the dealer resell, or only buy?** Buying alone makes it a sink. Reselling creates the
   second hop and is the point; who holds inventory between a buy and a resale must be settled.
4. **Why would an agent hold a claim it cannot use?** Mismatch gives a reason to sell and wanting
   the work gives a reason to buy; a dealer that is the only holder produces a round trip, not
   circulation.
5. **Windows.** Term structure needs at least two live delivery windows at once, which the
   three-window shape supports and has never used.

## 8. What it would measure

Whether any claim reaches two non-dealer holders; the stated limit prices relative to the index for
their grade and window; whether window-3 and window-1 claims are priced differently (a forward
curve); headroom consumed per unit of work transacted with and without circulation; and whether an
agent declines every bid and holds to redemption, which is a legitimate answer.

## 9. What it is not

Not evidence that a market exists — Touchstone is the counterparty. Not a price signal anyone should
quote; limit prices from a handful of agents against a house dealer are the first evidence of what a
basis is made of, not a basis. Cost is expected to be well below a Gate Market run because no code is
written and turns are short, but that is an estimate: the first run is measured, not assumed.

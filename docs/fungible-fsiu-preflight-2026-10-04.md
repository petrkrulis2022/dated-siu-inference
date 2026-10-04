# Fungible fSIU for the Gate Market: report before building

Asked 2026-10-04, before any contract change. Three questions were posed; all three are
answered below against the contracts as they stand, plus **two findings that were not asked for
and that change the decision.**

**Recommendation: do not build this as specified.** Not because fungibility is wrong, but
because one of its premises does not survive contact with ERC-1155, and because the main thing
it was expected to cost you is probably not actually at risk.

---

## Finding A — "the vault records internally which issuer backed each mint" does not survive fungibility

This is the blocker, and it is upstream of the question about whose bond pays.

Today `tokenIdFor(issuer, classId, series, windowFrom, windowTo)` puts the issuer **in the token
identity**, so one tokenId has exactly one issuer and `claimTypes[tokenId].issuer` is well
defined. Drop the issuer from the id and two mints routed to different issuers in the same
class and window **collapse into the same tokenId**. `claimTypes[tokenId]` can then no longer
hold *an* issuer at all.

The proposal's answer is an internal per-mint ledger. That records who backed each *mint*. It
cannot tell you who backed a given *holder's balance*, because balances are fungible and
transferable: after `safeTransferFrom`, a holder's 10,000 mSIU is not traceable to any
particular mint. Settlement is per `(tokenId, holder)` — `settled[tokenId][holder]`,
`everPresented[tokenId][holder]`, `balanceOf(holder, tokenId)` — so at the moment you need to
know whose bond to draw, the only thing you have is a holder and a fungible quantity.

Resolving that needs an attribution rule — FIFO, pro-rata across backers, or a pool. **A rule
that allocates one party's loss across several backers is a clearing function**, which is the
thing this design explicitly says it does not have and is not trying to build.

So the honest statement: you can have fungible claims, or you can have per-issuer bond
attribution, and the internal ledger does not get you both.

## Finding B — the enforcement arm is probably NOT at risk, for a reason not yet stated

The expectation was that moving routing to redemption time would end defaults, because "the
router picks whoever can serve". **`ClaimRouter.route` has no notion of who can serve.** It is
first-fit over `bond.issuersForClass(classId)` in registration order, returning the first issuer
whose headroom covers the amount:

```solidity
for (uint256 i = 0; i < candidates.length; i++) {
    if (bond.headroom(candidates[i], classId) >= amount) return candidates[i];
}
```

`_issuersForClass` is append-only, and `LOT_CREATION_ORDER` registers **ISSUER-A first** —
which is `NON_SERVING_ISSUER`. So while ISSUER-A has headroom it is routed every time,
whether routing happens at mint or at redemption. Defaults continue for the same reason they
happen now (§4.6g).

The proposed alternative rule — "highest ratio of claims outstanding to work delivered, so a
free rider is served to first" — points at the same issuer even harder, since ISSUER-A delivers
nothing.

**So the scenario trick (size lots so the non-serving issuer is the only one with headroom) is
not needed.** It would be belt-and-braces for a risk that first-fit already forecloses. Worth
knowing before building a lot-sizing scheme to solve it.

## Finding C, answering question 1 — whose bond pays, and the part nobody has mentioned

Today backing issuer, routed issuer and **paid issuer** are the same address, enforced in five
places keyed off `claimTypes[tokenId].issuer`:

| where | what it does |
| --- | --- |
| `tokenIdFor` | issuer is part of the token identity |
| `mint` | `bond.consumeHeadroom(issuer, …)` — the backing |
| `mint` | **`usdc.safeTransferFrom(msg.sender, issuer, totalUsd)`** — the issuer is paid, at mint |
| `serveRedemption` | `if (msg.sender != ct.issuer) revert NotTheRoutedIssuer()` |
| `settleWindowClose` | `restoreHeadroom(ct.issuer, …)` and `drawForDefault(ct.issuer, …)` |

**The third row is the one missing from the discussion: the issuer is paid in USDC at mint.**
So the question is not only whose bond pays — it is that under redemption-time routing, issuer A
takes the money and issuer B is asked to do the work.

That makes each candidate answer defective:

- **Backing issuer's bond pays.** It was paid, so this is at least coherent — but it means A is
  penalised for B's failure to deliver. Mutualised loss with no clearer: precisely the accident
  that was flagged.
- **Routed issuer's bond pays.** This was the guess, and it is the *worse* option here: the
  routed issuer was never paid for this claim and never had headroom consumed for it. It would
  be liable for work it was not paid to do. And when a claim is never presented there is no
  routed issuer at all — `Expired` would have no counterparty.
- **Split or pro-rata.** That is a default fund.

**Conclusion: the clean answer is not available under this contract.** It only becomes available
if the USDC payment also moves to redemption time, which is a substantially larger change than
the token-id edit — it turns mint from a purchase into the issuance of an unfunded obligation.

## Question 2 — does `settleWindowClose` still work, and against whose bond?

Half of it survives cleanly and half does not.

- **Headroom restoration is unambiguous**: it must return to whoever's headroom was consumed,
  i.e. the backing issuer. That is knowable from a per-mint ledger *in aggregate*, and is
  independent of which holder settles.
- **The bond draw is not**, for the reason in Finding A: `drawForDefault` needs one issuer, and
  at settlement you have a holder and a fungible balance with no attributable backing.
- `settled[tokenId][holder]` and `everPresented[tokenId][holder]` continue to work per holder,
  so the double-settle and Defaulted/Expired logic is unaffected in structure.

Note also that `route` is called in **two** places — `mint` (line 360) and `reserveForWork`
(line 523, the dollar route). Any change to routing time has to account for the dollar route's
reservation as well, which the proposal does not mention.

## Question 3 — what of the recorded enforcements stays valid?

First, a correction to the figure in circulation. I count **14 `settle_window_close` capacity
events across 9 runs** in the machine-readable reports — not 11 — and more importantly
**a settlement is not a bond enforcement.** Only a claim with `everPresented` emits `Defaulted`
and draws the bond; the rest emit `Expired`, return capacity to the issuer and pay nobody. That
distinction was only discovered on 2026-10-03 (§4.6ag), so any previously-quoted count of
"bond enforcements" predates knowing the difference and should be re-derived from the
`Defaulted` events before it is cited again. Two of the recent settlements were also
operator-triggered and must be excluded from agent-behaviour counts.

Of what remains:

- **The conservation identity results stay valid.** Headroom restoration does not depend on when
  routing happens.
- **"Agents settle others' defaults unprompted" stays valid** as a finding about agent
  behaviour, and it reproduced again on 2026-10-03 with the holder settling its own.
- **The default results become results about a prior instrument.** Bilateral dated claims and
  pooled claims differ in who bears non-delivery, so the numbers are not comparable across the
  change — though per Finding B the *mechanism* would likely still fire.

## What I would do instead

1. **Record the comparability conditions and the three-prices distinction** in `fsiu-design.md`,
   as already agreed. That is pure gain and touches no contract.
2. **Do not change token identity yet.** The premise that makes it cheap — an internal ledger
   recovering per-issuer backing — is false under fungibility, so the real cost is a clearing
   rule, not a redeploy.
3. **If fungibility is still wanted for F1**, the smaller honest version is one issuer in the
   class for the Gate Market. Claims are then trivially fungible because there is only one
   obligor, the credit-risk argument is satisfied in full, the enforcement arm is untouched, and
   no clearing function is needed. It loses the two-issuer routing result, which is worth
   weighing — but it is a configuration change, not a contract change.
4. **The pooled design stays open**, and the thing it is actually waiting on is now named: an
   attribution rule from fungible holder balances to backing issuers.

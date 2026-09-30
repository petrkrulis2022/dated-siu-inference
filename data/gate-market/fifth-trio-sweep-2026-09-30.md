# Sweeping the fifth trio's residue — 2026-09-30

Operator cleanup, done to decide whether a sixth trio was needed. It was not.

## Why it was done

ISSUER-A had 2,000 mSIU of live headroom against a 48,000 limit and could not take a single job
in run 10 — so that run was a one-issuer market, and its asset-choice figures measure a buyer
with no alternative supplier. The question was whether 46,000 mSIU had been *spent* or merely
*locked*, because the answers point to opposite actions: a redeploy, or a sweep.

## What the enumeration found

Reconciled from `CapacityBond`'s own events against live headroom, scanned on the public endpoint
in 1,000-block chunks (the documented archive path does not work — see `docs/methodology.md`):

| | consumed | restored | net | live | limit |
| --- | --- | --- | --- | --- | --- |
| ISSUER-A | 70,000 | 36,000 | 34,000 | 14,000 | 48,000 |
| ISSUER-B | 70,000 | 60,000 | 10,000 | 22,000 | 32,000 |

**`WorkReserved: 0`. `ReservationReleased: 0`.** No reservation has ever been made on this trio,
so the dollar route has never consumed a unit of headroom and there is no second ratchet. That
follows from the same fact as everything else: every purchase in every run settled in fSIU, so
`reserveForWork` has never run outside a test.

Every missing unit was an unsettled claim. **A first scan reported "no open positions" because
its hand-written ABI omitted `TransferSingle`** — claims that had moved from buyer to seller were
invisible to it, and nothing errored. See the methodology's note on silent undercounting.

## What was settled

Three batches, all triggered by the operator.

**12,000 mSIU — external-buyer claims, expired** (earlier the same day):
`0x611f7ec2…`, `0xe14176aa…`, `0xc260ce78…`, `0x84e23f2c…`. ISSUER-A 2,000 → 14,000.

**8,000 mSIU — agent-held, never presented, expired:**
`0xf83337cf…` (4,000, ISSUER-A), `0xc10a87fa…` (4,000, ISSUER-B).
ISSUER-A 14,000 → 18,000; ISSUER-B 22,000 → 26,000. No payout, no bond touched.

**30,000 mSIU — agent-held, presented and never served, DEFAULTED:**
`0x8b6976a4…`, `0x3eedd3d4…`, `0x0d1aad79…`. Three 10,000 mSIU claims held by WORKER-CODE against
ISSUER-A, which cannot serve by construction. Settled at the 2026-09-29 commodity print
($0.001427/SIU), the day each window closed, as `settleWindowClose` requires.

## THESE THREE ARE OPERATOR-TRIGGERED, AND MUST NOT BE COUNTED WITH THE OTHERS

Every previous default in this project was **agent-triggered**, and that is the finding: a rival
issuer drawing a competitor's bond to pay that competitor's customer, a defaulting issuer settling
itself from its own collateral, the holder racing both and losing by a turn or two. The result is
that enforcement does not depend on any particular party being vigilant.

Defaults 9, 10 and 11 below are **operator cleanup of the fifth trio's residue**. Nobody noticed
them; an operator went looking. Merging them into the agent-triggered count would contaminate the
one finding this mechanism has actually produced.

## The conservation identity, ninth through eleventh

| | before | after | delta |
| --- | --- | --- | --- |
| `CapacityBond` USDC | 3,971,460 | 3,928,650 | **−42,810** |
| WORKER-CODE USDC | 219,910 | 262,720 | **+42,810** |

Exact. 30,000 mSIU = 30 SIU at $0.001427/SIU = $0.042810 = 42,810 base units at six decimals.
Every unit drawn from the bond reached the holder it was owed to, and this now holds across
eleven defaults.

## Final state, and the decision

| | headroom | limit |
| --- | --- | --- |
| ISSUER-A | **48,000** | 48,000 |
| ISSUER-B | 26,000 | 32,000 |

ISSUER-A is fully restored. ISSUER-B's remaining 6,000 sits in two external-buyer claims minted
by run 10 under the old far-future window; they become settleable about 1.5 hours after this was
written and will return it.

**No sixth trio is needed.** A redeploy would have stranded bonded USDC to buy capacity that was
already there, and — had the cause been reservations rather than claims — would have restarted
the same leak on fresh lots. With the ratchet fixed, the external buyer's 6,000 now returns at the
end of every run by construction.

## One measurement caveat, twice observed

Both sweep scripts reported the wrong figures immediately after their writes — `+9,000` against a
true `+12,000`, then `+10,000` and a `14,270` draw against a true `+30,000` and `42,810`. Waiting
for every transaction receipt was **not** sufficient; the load-balanced public endpoint still
served a pre-transaction view. Every figure in this document is from a separate verification read
taken afterwards, at block 47496032 and 47496063.

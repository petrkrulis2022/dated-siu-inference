# Run 10 — findings

`p5-three-window-2026-09-30T06-16-43-846Z`. Print `2026-09-30-commodity` @ $0.001417/SIU.
Completed. $1.868361 real inference against a $30 cap.

## The loop closed

Eight gate versions across the two working windows, against **one per window in run 9**. Every
revision followed an attack. The only thing that changed between the runs is the feedback edge
that tells an author its gate was defeated, and the shape of the input that did it.

| | W1 | W2 | W3 |
| --- | --- | --- | --- |
| Gate versions | 4 | 0 | 4 |
| Attacks | 6 | 0 | 5 |
| False accepts | 4 | — | 3 |
| Apparatus attacks | 0 | — | 0 |

Six of the eight revisions followed a false accept outright. One (W1 v4) followed both a false
accept and v3's own G6 failure, and is not claimed as purely loop-driven.

## Escalation, and the attack class that ignores it

The author answered defeat with volume: **8 → 74 → 11,859 test cases**, and was still beaten at
11,859 by an `import.meta` environment-detection probe. Bounds gaps close under more cases;
detection does not, because every additional case runs in the environment the submission
recognises. See spec §4.6l.

## Over-correction, from two independent instruments

W1 v3, at 11,859 cases, **failed G6** by rejecting a held-out known-good submission, and produced
a **`false_reject`** against a correct submission (`failed 13 of 74`). Adversarial pressure pushes
a gate toward refusing good work, and only held-out generalisation testing catches it. This is why
`countsAsAdversaryYield` and `countsAsGateOverRejection` must stay separate counters. See §4.6k.

## THE FALSE ACCEPTS ARE NOT A CAPABILITY RESULT

Stated plainly here, not only in a report, because it is the number most likely to be quoted
without its caveat.

Seven false accepts in this run and five in run 9 are **real findings against those gates**. They
are **not** evidence that an LLM adversary can find a gate's weakness unaided, because at least
two channels told it where to aim:

- **The gate's own `reason` string**, returned by `submit_attack` after every attempt. This run's
  reasons disclosed the exact test count — `all 74 tests passed` — and the next attack triggered
  on `calls > 74`. One turn. The precise number just reported.
- **`referenceFiles` echoed into context through tool-call records.** In run 9 the pinned suite,
  including its generator bounds, was absent from the adversary's first prompt and present in
  every prompt thereafter; it then quoted those bounds verbatim.

Neither channel is closed. Until both are accounted for, the defensible claim is that **an
adversary produces yield when told where to aim**. Whether it can search unaided is untested, and
§4.6h — where it found one probe and repeated it unvaried rather than converging — points away
from it.

## Zero apparatus attacks is a result, not a null

Yesterday's forged-verdict attack defeated both authored gates and this project's own reference
gate. Today the oracle runs submissions in a child process, G2 requires resisting the attack, and
an agent-authored gate cleared it on first attempt. `apparatus_attack` fired zero times.

## What this run cannot tell you

**It was a one-issuer market.** ISSUER-A began on 2,000 mSIU — below both job sizes — and could
not take a single job, so every claim routed to ISSUER-B for want of an alternative. Four
purchases, all fSIU, is **not** an asset-choice result: the buyer had no second supplier, and the
claim route delivering is arithmetic rather than reliability. Third consecutive run in which
routing was decided by depletion rather than design.

**No claim was ever forward-dated.** `forwardDated: true` appears zero times across all six
windows of runs 9 and 10. `pay_with_claim` supports `forWindow` and no buyer used it, so every
claim was for the window it was bought in — and a same-window claim held past its window is not
deferred but lost (unpresented claims Expire and pay the holder nothing). The instrument's
defining property, reserving capacity for a future window, remains implemented and unexercised.

**Window 2 was squeezed before it failed.** Window 1's turns overran its span, so window 2's first
purchase minted with 386 seconds left of a 1,200-second window. Turns are not bounded by window
spans. A single unparseable response from WORKER-CODE then cost the remainder: no presentation, no
job for the issuer, no gate, no attacks, and two paid-for claims that expired worthless.

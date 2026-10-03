# Test audit: what runs 16 and 17 paid to learn, and what a test could have told us free

Written 2026-10-03, after run 16 ($3.07) and run 17 ($1.77). Scope: every finding those two
runs produced, judged against one question — **could a test have caught this, and if so why
was there no test?** The goal it serves: *a live run should verify only what a live run can —
agent behaviour, chain state, provider interaction — and nothing else.*

---

## The verdict in one table

| # | Finding | Catchable by a test? | Status |
| --- | --- | --- | --- |
| 1 | §4.6af — final-window verdict blind to the dollar route | **Yes, trivially** | test added, verified failing first |
| 2 | §4.6af mirror — a failed `pay` counted as a settled one | **Yes, trivially** | test added, verified failing first |
| 3 | §4.6af — scarcity branch contradicting its own `hadCapacity` | **Yes** | branch corrected; covered by #1's test |
| 4 | 2026-09-28's stored verdict being stale | **Yes** — a re-score check | caught by the re-score; see "what is still missing" |
| 5 | §4.6ae — no renderer addresses a holder after presentation | **Yes, structurally** | lifecycle coverage test added |
| 6 | §4.6ah — suppressing a one-shot section is itself a wake | **Yes** | test added, verified failing first |
| 7 | §4.6ag — settling an unpresented claim pays nobody while the board promises payment | **Yes** | `renderSettleableText` extracted and tested |
| 8 | §4.6ag — brief tells an fSIU-paid seller it has not been paid | **Partly** | see "what a test cannot do" |
| 9 | memo silently dropped by `buildToolArgs` | **Yes** | caught before it ran, test added |
| 10 | arrival notice carrying no deadline | **Partly** | test added for the renderer; see below |
| 11 | cached `headroomAfter` printed after the sweeps | **Yes** | see "what is still missing" |
| 12 | the first deliberate hold; fSIU used as money | **No** | this is what a live run is for |
| 13 | the full enforcement cycle running end to end | **No** | real chain, real bond, real USDC |
| 14 | ISSUER-A authoring four passing gates it cannot serve | **No** | agent behaviour |

**Eleven of fourteen were catchable. Two runs and $4.84 bought three findings that genuinely
needed a run.**

## Why there were no tests, which is the part worth keeping

The eleven catchable findings share three causes, and none of them is "nobody thought to write
a test".

**1. The logic was not reachable from a test.** `classifyFinalWindow` was testable and tested —
there were six tests on it — and the dollar-route blindness still shipped, because every test
constructed its fixture the same way the buggy code read it. By contrast `settleableText` was
not reachable at all: it was an expression inside a 1,500-line function, so there was no
seam at which to ask it a question. **Extracting it was the fix; the test was an afterthought.**
The same is true of `composeBoard`, which did not exist until the wake key needed testing.

**2. The test asserted the mechanism, not the guarantee.** Every §4.6ac test checked that a
waiting agent stays asleep. None checked the property that matters — *an agent is woken only
when it has something it can do* — so a section that woke an agent with nothing passed every
test. The lifecycle-coverage and `WAKE_SECTION_TOOLS` tests added here assert the guarantee, and
the first of them caught a real case (WORKER-EXTRACT holding no purchase tool) on its first run.

**3. The fixture distribution hid it.** This is the one that cost the most. Nine runs of F1 data
exercised the claim route in every final window, so the dollar branch of the classifier was
never taken — by runs OR by tests, because the tests were written from the runs. A measurement
apparatus validated only under a biased input distribution is validated for nothing, and
correcting the bias is the event that breaks it (§4.6af).

## What a test cannot do, and should stop being asked to

**Finding 8 — a brief that states a false guarantee.** A test can assert that a string is
present or absent. It cannot tell that *"an absence of it means you have not been paid"* is
false on one of two payment routes, because that is a claim about the world the text describes,
not about the text. What a test CAN do, and now does not, is check the pairing: every "you will
be told X" in a brief should have a test that the loop can actually produce X in the
circumstances the brief implies. That is listed below as not yet built.

**Findings 12–14.** A deliberate hold, an end-to-end bond payment, four gates an issuer cannot
serve. No fixture produces these; they are why runs exist.

## What is still missing, named rather than quietly skipped

1. **A re-score check in CI.** Finding 4 was a published verdict contradicting the classifier
   that would produce it today, found only because this audit's own fix prompted a re-score. A
   test that re-scores every stored report and fails when a stored verdict differs from the
   current classifier's would have caught it the day the classifier changed. **Not built.**
2. **A brief-to-loop pairing check** for finding 8, as described above. **Not built.**
3. **A freshness assertion on reported figures** for finding 11. The summary prints a cached
   `headroomAfter` after the sweeps that invalidate it. A test could inject a reader that
   records when each figure was read and fail if a printed number predates an event in the same
   report. **Not built**, and it is the fiddliest of the three.
4. **Finding 10's other half.** The renderer is tested; what is not tested is that the loop
   actually supplies the clock, which is the part that was missing. A loop-level test needs the
   devnet and has not been written.

These four are the honest remainder. Each is a real gap, and listing them is worth more than a
claim that the audit closed everything.

## The standing rule this produces

**A live run is for agent behaviour, chain state and provider interaction. Everything else is a
test, and if it cannot be tested that is a seam problem, not a reason to run.** When a finding
turns out to have been catchable, the question to ask is not "why did nobody write that test"
but which of the three causes above applied — unreachable logic, an asserted mechanism in place
of a guarantee, or a fixture set inherited from biased data.

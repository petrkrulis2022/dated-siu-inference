# Task: a holder-facing information channel

Scoped 2026-10-02 from run 16, **built 2026-10-03**. Finding: `gate-market-spec.md` §4.6ae.
Companion fix landed separately: §4.6af.

**Build notes are at the bottom** — what changed from this design, one place the stated invariant
could not hold literally, and one limitation that remains.

---

## The architectural root, which is not "the wake condition is too narrow"

`boardSectionText` is two things at once: the text an agent is shown when it gets a turn, **and**
the wake key that decides whether it gets one. §4.6ac made them the same string deliberately, so
that the prompt and the wake gate could not disagree about whether there was anything to act on.

The consequence is a false choice: **anything worth telling the agent must also wake it.** So
either the holder is told nothing — which is what happens today — or every stage of a claim's
life wakes it, which is the idle burn §4.6ac exists to end.

**The fix is to stop conflating them:**

- `boardSectionText` — everything the agent is shown when it is given a turn, informational and
  actionable alike.
- `wakeKey` — the strict subset that affords a **new action**. `waitingOn` keys on this.

Informational text can then change freely without costing a turn, and §4.6ac's invariant gets a
sharper form that can actually be tested: **every string entering `wakeKey` must name a tool the
agent holds and a call it could not have made before.**

## The constraint that rules out the obvious implementation

The obvious trigger is `refusedTwiceFor(issuer, "serve_redemption")` — the loop knows at that
moment that delivery will never come. **It must not be used.** `NON_SERVING_ISSUER` is a
deliberate experimental condition whose own roster comment reads: *"Nothing tells the other
agents this: the holder noticing non-delivery and acting on it is precisely what the run is
testing."* Telling the holder the issuer cannot serve hands over the answer and converts the
measurement into a disclosure.

**Every stage below is therefore restricted to facts the holder could establish for itself** —
that it presented, when, and how long until expiry. All three were already in its own
`redeem_claim` result. Nothing about the issuer's state is disclosed.

## The stages

### Stage 1 — presented, awaiting the issuer
**Section:** none. **Wake:** no. Correct as it stands, and run 16's `{"wait": true}` at this
stage was the right call. The holder has acted; nothing is owed to it that it can act on.
`check_delivery` already answers if it chooses to ask.

### Stage 2 — served
**Section (new, this is the hole):** `YOUR CLAIM WAS SERVED — tokenId …, quantity …, result
PASS | FAIL.` No renderer addresses the holder here today; `renderForHolder` has already gone
empty at presentation and never returns.

**Wake on PASS: no.** The holder received what it paid for. There is no new call to make, and
waking it would be §4.6ac exactly.

**Wake on FAIL: yes.** The work did not pass and the rest of the window is the only chance to
buy replacement work — `request_quote`, `pay`, `mint_claim` are all newly worth making.

Run 16 could not test this stage at all: nothing was ever served.

### Stage 3 — presented, still unserved, window running down
**Section:** `A CLAIM YOU PRESENTED IS STILL UNSERVED — presented on turn N, window closes in T
seconds. Nothing is owed to you until it is served. If the window closes unserved it defaults
against the issuer's bond, and the bond pays you.`

**Wake: yes, exactly once per claim**, bounded the way `shownForwardOffers` already bounds the
forward invitation. Affordance: buy replacement work, pass the claim on, or deliberately do
nothing — each a real choice, and the last one is the choice the run is trying to observe.

**Recommended trigger, which needs no tuned constant:** fire when the time already waited since
presentation exceeds the time remaining before expiry. It is built only from the holder's own
facts, scales with window length, and reads as "you have waited longer than you have left"
rather than as a threshold someone picked. The alternatives — a fixed number of seconds, or a
fraction of the window — both need a magic number that decides how much window a holder has left
to act in, and neither is defensible from anything the run measures.

### Stage 4 — window closed unserved
Already exists as `settleableText`, and run 16 proved it works: WORKER-EXTRACT settled window
2's claim on its first turn of window 3. **Two gaps remain, and only one is fixable here.**

- It is offered to anyone holding `settle_window_close`, not preferentially to the holder the
  bond would pay. Worth ordering the holder first; not a correctness issue.
- **A claim minted in the last window has no later window** (§4.6z-ii), so its holder is never
  offered the settlement at all and `settleOutstandingAgentClaims` sweeps it at run end. No wake
  can fix this: there is no turn left to wake into. It should instead be **disclosed in the run
  report** — "N claims settled by the run-end sweep that no holder was ever given the
  opportunity to settle" — so that fulfilment statistics are not read as holder indifference,
  which is the §4.6y mistake in a new place.

## What must not be built

- A wake on Stage 1, or on a Stage 2 PASS. Both are information without affordance.
- Any trigger derived from the issuer's refusals or grant. It destroys the experiment.
- A Stage 3 wake that can fire more than once per claim.

## Testing

Tests are mandatory here by the standing rule, and each must be verified to fail against current
behaviour first:

1. A holder that presents a claim and declares `{"wait": true}` **is** woken when the claim is
   served with a FAIL. (Fails today: never woken.)
2. The same holder is **not** woken when it is served with a PASS, but the next prompt it
   receives for any other reason **does** carry the served section. (Needs the wakeKey split;
   impossible to express today, which is the point.)
3. The Stage 3 wake fires exactly once across an arbitrary number of rounds.
4. No `wakeKey` string is produced for an agent lacking the tool it names.

## Cost

No inference cost to build. One debugging run to verify, which is the run that would then be
eligible to freeze the protocol.


---

# Build notes, 2026-10-03

## The invariant is enforced, not merely asserted

The design said to test every wake against §4.6ac. It turned out better to make it structural.
`composeBoard(sections, availableTools)` consults `WAKE_SECTION_TOOLS` — a section→tools table
living beside the composition — and **drops from `wakeKey` any section whose tools the agent does
not hold**, while still showing it. §4.6ac cannot now be reintroduced by adding a section; it can
only be reintroduced by adding a wrong entry to one visible table, which the tests check.

## It caught a real case on its first run

`WORKER-EXTRACT` holds `redeem_claim` (granted 2026-09-30 after it was twice paid in fSIU it
could not redeem, §4.6p) and **no purchase tool at all**. So a served FAIL is real news it can do
nothing with: waking it would have been §4.6ac returning, on the very agent that gap already hurt
once. It is now shown the FAIL and not woken by it, while still being woken by an overdue claim,
which it *can* act on — it holds `settle_window_close`. Both directions are pinned by tests.

## Where the stated invariant could not hold literally

The brief was: *assert the agent holds a tool it could now use **and could not have used
before***. The second half cannot hold for either holder stage, and pretending otherwise would
have meant writing a test that passes by being vague.

Nothing is newly *granted* to a holder when its work fails or its claim goes overdue. Its tools
are the ones it always had. What changes is that an action which was pointless becomes worth
taking. So the implemented invariant is the first half plus a separate bound:

- **affordance** — the woken agent holds a tool the section is about (`WAKE_SECTION_TOOLS`), and
- **no repetition** — a given state wakes an agent at most once (`markUnservedWarningShown` for
  the overdue warning; `served` is terminal for the served one).

Together these give what the brief was protecting: you are not woken with nothing to do, and you
are not woken twice for the same fact. Stated here rather than quietly reinterpreted.

## A limitation that remains

The overdue warning fires on the holder's next turn after the midpoint, and turns only come
round while the window is live. **If every agent goes idle before the midpoint, the stall guard
ends the window and the warning never fires.** That is correct behaviour rather than a bug —
spinning the roster waiting for a clock is precisely the unbounded busy loop the guard was added
to stop, after one cost 39 minutes of CPU and three window spans — but it does mean the channel
is not guaranteed, only available. A quiet window still ends with the holder uninformed, and the
claim still reaches the default path.

## Not built, deliberately

Ordering the holder first in `settleableText`. It is a fairness nicety, not a correctness issue,
and run 16 showed the permissionless path works (WORKER-EXTRACT settled another agent's claim).
Left alone rather than changed on the way past.

# Task: a holder-facing information channel

Scoped 2026-10-02 from run 16. **Design only — not started.** Finding: `gate-market-spec.md`
§4.6ae. Companion fix already landed: §4.6af.

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

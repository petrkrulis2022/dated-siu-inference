# Marketplace redesign v2 — design note

**Status: PROPOSED, not built. Dev-testing runs on the stand-in data service only; no Blockworks access.** Written 2026-11-07 against the owner's instruction to fix the confounds found in D131–D133 without changing what the kill criteria measure. §16.9's four measures and four kill criteria (`docs/marketplace_plan.md`, `economy/scoring.ts`) are **unchanged** — same thresholds, same questions. This note changes the marketplace the agents play in, so that playing it actually exercises those questions, plus two implementation bugs that were never a rule change in the first place.

The counted run that prompted this (D131) stands as reported: a result under v1's rules, now understood to mostly reflect v1's own currency plumbing (D132, D133) rather than revealed agent preference. v2 is a different marketplace to run the same pre-registration against, not a correction to that result.

---

## The one root cause behind items 1–5

Every transaction *type* in v1 is hard-wired to one currency: data purchases USDC-only (`#buyData`, `world.ts`), commissioning work and paying for a brief AGU-lab-only (`#commission`, `#acceptQuote`, both hardcode `escrowOpen(..., "AGU", ...)`), buying ahead USDC-only (`#buyClaims`, the roll in `order_front_claim`). The only place an agent ever makes a real two-way choice is `buy_agu`/`sell_agu` with the participant. So "88.9% converted to USDC" and "0 instances of buying ahead" were never readings of preference — they were readings of which rail each transaction type happens to sit on. Items 1–5 put a real choice at every one of those transaction types, so the measures have something to measure.

## 1. A real currency choice at every transaction type

- `buy_data`: the data agent quotes its shadow price in both units (USDC at `dataShadowPriceUsdc`, and its AGU-lab equivalent at the live participant rate). The caller picks either; paying in AGU-lab costs the data agent a small, stated conversion spread (it still needs real USDC for its own costs, so it charges for taking the currency it didn't want — the same honesty the roll already applies to front-claim sales).
- `commission_task`: the issuer quotes both units the same way; paying in USDC costs the researcher/hedger the participant's own spread, same mechanism, opposite direction.
- `post_quote`/`accept_quote`: see item 2 — this is where "a free choice, with a consequence" has to be real, not just priced.
- `order_front_claim`/`buy_claims`: see item 4.

Every conversion between units, wherever it happens, goes through the SAME participant rate and spread already in `participant.ts` — no new pricing mechanism, just more callers of the one that exists.

The rate a price's second-currency figure is computed at is locked at the moment that price is posted — the live participant rate read once, at `post_quote`'s/`buy_data`'s/`order_front_claim`'s own call, never re-derived at acceptance or settlement. A quote that could redenominate itself between posting and acceptance would make item 2's binding-quote fix cosmetic: the agent accepting it would be accepting a formula, not a price. The number the board shows each round (item 3) is whatever rate a NEW price posted right now would lock at; an already-posted price never moves after it's posted, in either unit.

**Answers:** D132 (data purchases forced to USDC), half of D133's criterion-2 finding (commissioning forced to AGU-lab — once it isn't, "paid onward in AGU-lab" means something again).

## 2. Binding quotes in either unit

`post_quote`'s schema currently accepts `price_msiu` only (`parse.ts`); there is no way, anywhere in the live mechanics, for a binding quote to be denominated in dollars — which is exactly why the two messages that fired kill criterion 3 were chatter from a role (`HEDGER`) that doesn't even have `post_quote` in its tool list, and led to nothing (D133, confirmed 0 quote entries ever authored by HEDGER).

`post_quote` takes **either** `price_msiu` or `price_usdc_micro` (exactly one). `accept_quote` escrows in whichever unit the accepted quote named. The board shows both, so a demand agent comparing two quotes in different units sees the comparison, not just one side of it. This makes "an agent quoted in dollars" a real, trackable act with an outcome (accepted or not, paid or not) — criterion 3 now measures a decision instead of a stray sentence.

**Answers:** D133 (criterion 3 has no live choice point to measure).

## 3. Every price that matters, on the board, in both currencies

Today the board shows AGU-lab quote prices (with the whole-mSIU dual display from D130) but nothing else gets a live dollar or AGU-lab equivalent: not the front-claim discount, not the data agent's price, not an issuer's task price. The only place any of that is explained is one sentence in the system instructions, read once and never repeated (`model-agent.ts`'s `COMMON` block) — which is most of why nobody used the front-claim discount even though it was genuinely a real, unguarded ~10% saving (D131's diagnosis).

Every price line the board renders this window — a posted quote, an issuer's task price, the data agent's price, the front-claim/forward price and its discount — shows both units, computed live, every round. Nothing economic stays prose-only.

**Answers:** D131 (the discount was real and never surfaced), sets up items 1, 2 and 4's bi-currency prices to actually be visible.

## 4. Buying ahead, in both currencies, with its price shown

`order_front_claim` and `buy_claims` both become bi-currency the same way as item 1 (the roll/participant quotes both units; paying in the "wrong" one costs the stated spread). Its forward price and discount are a board line now (item 3), every round, not a sentence an agent has to remember from the start of the run.

**Answers:** D131 (no code or mandate ever blocked buying ahead — it just wasn't priced competitively in a visible place).

## 5. No agent's framing is denominated in one currency

`HEDGER`'s role text says, as its premise, "You sold briefs forward for USDC," and its genesis wallet is minted entirely in USDC (`hedger.usdc`, `world.ts`'s `genesis()`). Both of the run's two dollar-quoting messages came from this one role; `model-agent.ts`'s own doc comment already says the shared instructions "say nothing about which way to pay... no instruction may lean on it" — the hedger's role line is the one place that promise wasn't kept.

Restated neutrally: *"You hold a standing obligation: deliver N briefs over the coming windows, each from two passing outputs of different task types from the same day."* No currency named. Its genesis wallet is split across AGU-lab and USDC (matching how every other role starts: some capital, no stated preference) rather than seeded as a single-currency balance with a currency-specific backstory attached to it.

**Answers:** D131/D133 (the hedger's two firing messages trace directly to this one non-neutral line).

---

## 6. Bug fix: "converted" only counts a voluntary exit

`scoreConversionToUsdc`/`modelAgentReceipts` (`scoring.ts`) currently marks a receipt "converted" if the same agent is EVER seen exiting afterward, for *any* reason — which is why 8 of 9 receipts in the counted run were marked converted by three exits already classified "dollar cost" (forced) when the thesis was scored, a classification kill criterion 1 never consulted (D132).

**Fix:** a receipt is "converted" only if the *nearest subsequent* exit by that agent is classified something other than `"structural dollar route"` or `"dollar cost"` (the same `ExitClass` values the thesis already uses) — an unclassified or voluntary exit (`"price move"`, `"fear"`, `"other"`) still counts; a forced one does not. This needs the blind-tag map threaded into `scoreConversionToUsdc` the same way `scoreThesis` already takes it, so the same tagging pass serves both.

**Test:** a fixture with one receipt followed by a `"dollar cost"`-tagged exit (must NOT count as converted) and one receipt followed by a `"fear"`-tagged exit (must count) — plus the existing round-trip test, so this stays correct against a stored log, not just a live one.

This is the only code change needed to fix criterion 1's measurement; criterion 2's parallel problem (D133) is fixed structurally by item 1 instead, since once commissioning has a real currency choice, "paid onward in AGU-lab" stops being compelled and starts being informative again.

A seller who takes the "wrong" currency and then converts what it received to cover its own dollar costs (item 1's stated spread) is a forced conversion on the SELLER's side, never a reading of the BUYER's preference, and it must not be folded into the buyer's own circulation/conversion statistics. Concretely: when the data agent, an issuer, or the hedger receives AGU-lab and converts it to meet a real USDC cost, that conversion is logged and classified under that seller's own identity, using the same `ExitClass` machinery this item already fixes for the buyer side — never attributed to the paying agent's receipt. This is the same conflation D132 found, applied pre-emptively to the other side of the trade, so the new bi-currency mechanics don't reintroduce it from the seller's end.

## 7. Bug fix: the scorer reads the real seed, not a default

`scoreBuyingAhead` needs the run's seed to reconstruct each window's expected needs (`needsSchedule(params.seed, ...)`), but nothing in the log or the committed params records which seed a given run actually used — `economy-score`'s default `--params` carries the frozen file's `"dev-0"`, never a counted run's real seed (`counted-2026-11-06` here), a mismatch confirmed to diverge on 20 of 21 sampled (agent, window) pairs (D133). This also breaks the module's own claim of scoring "from the ordered log alone."

**Fix:** `world.genesis()` writes one `"genesis"` log entry carrying `{ seed, backend, t0 }`; `economy-score` (and `scoreBuyingAhead`) read the seed from that entry, never from `--params`. The committed params file keeps its own `seed` field for *running* a window (unchanged), but scoring never trusts it.

**Test:** score a fixture log whose genesis seed differs from the `EconomyParams` object passed alongside it, and confirm the result matches the genesis seed, not the params — the exact scenario that silently happened in the real run.

---

## 8. An economic objective for every agent, as a number on the board every round

Items 1–7 fix *how* an agent can pay; they don't fix the gap underneath all of them: v1 gives every role a way to earn or spend a currency but never a reason to care about the result. A research agent is "paid only if every part passes," with no running total it's trying to grow. A demand agent "chooses whether and how to get your needs met," with no cost attached to leaving one unmet. The hedger owes ten briefs with no consequence for missing one. Without an objective, "which currency an agent prefers" has nothing to be instrumental *to* — there's nothing to optimise.

- RESEARCH agents: a running **profit** — cumulative brief income minus cumulative issuer and data costs.
- DEMAND agents: a running budget minus spend minus a **stated cost for every unmet need**, charged whether or not that need is later covered. "Needs met within budget" becomes literally scoreable instead of a backstory phrase.
- HEDGER: a **stated bonus per brief delivered on time** (within the window it's owed) and a **stated penalty per brief delivered late or never delivered** by the run's end.
- PARTICIPANT stays unscored — a market-maker, not an optimising party. It holds no position, same principle as this project's standing "never a Datum-operated derivatives venue" invariant, applied here to the demo roll.

Mechanism: `World` keeps a running per-agent objective ledger — a score, never spendable, never the same map as `MemoryChain`'s real balances, so it can't be mistaken for money that actually moves — updated at the same points `#commission`/`#deliverBrief`/`#deliverForward`/need-closing already run. `boardFor` exposes it as a new `objective` field, shown in both currencies at the live participant rate (item 1's conversion path, reused, not a second one).

**Answers:** "the agents had nothing to optimise" — the precondition every other item in this note assumes.

## 9. Forward visibility

Demand agents and the hedger see their own needs for the next **N windows** ahead (N = 2; stated here and frozen into the config, item 14), not only on the day a need opens. `needsSchedule(seed, ...)` already generates every window's needs deterministically; the board's new `needsAhead` field just queries it N windows further than today — no new randomness, no new generator.

**Answers:** "with nothing to gain from planning, nobody had a reason to buy ahead" — visibility is the other precondition buying-ahead needs, alongside item 8's objective.

## 10. Moving prices: replay real Dated SIU history

Instead of one frozen print (`wp0`/`cr-print.json`) held constant for the whole run, the stand-in replays the REAL, already-published Dated SIU prints across the run's windows — one published day's print per simulated window, in calendar order from a fixed start date recorded in the frozen config. This is honest rather than a path the experimenter chose: real, already-printed history, not an authored scenario, and it gives timing decisions (buy now vs. wait, deliver now vs. later) real consequences instead of a constant backdrop.

**Answers:** "the print never moved during the run" — the price-side half of why nobody bought ahead.

## 11. A symmetric common introduction

`model-agent.ts`'s shared `COMMON` instructions currently name "paid in AGU-lab" as the default and USDC as the exception. Rewritten so both units are introduced in the same sentence, with whichever one is named first alternating window to window the same way the board's own SIU-first/dollars-first display order already does (`siuFirstForWindow`) — so the instructions and the board agree, and neither currency reads as *the* currency.

**Answers:** extends item 5's hedger-specific fix to the text every role reads.

## 12. Seller-side forced conversion — the data seller, explicitly

Already covered by item 6's addition above (2026-11-07): a seller converting received AGU-lab to cover its own dollar costs is classed as that seller's forced cost, never the buyer's choice. Restated here with the data seller named explicitly, since `buy_data` is the single most frequent source of exactly this conversion in every run so far (D132).

## 13. Models: all Anthropic, Haiku 5.5 for development, Sonnet 5 for the counted run

The counted run's seat rotation (`counted.seats`, currently alternating `claude-sonnet-5`/`gpt-5.1` by window, D75) becomes a single seat, `claude-sonnet-5`, for every window. This removes the Sonnet-vs-GPT confound entirely: any difference between agents in the counted run is now role, money, needs, and objective — never which model answered. Development windows run on `claude-haiku-5-5` (added to the model registry if not already present) to keep dev-testing cheap. The SIU-first/dollars-first display flip every two windows (unchanged, `board.ts`) stays, and so does keeping two demand agents' configurations byte-identical: identical agents behaving differently is the run's own built-in measure of how much of any result is chance rather than design.

**Answers:** removes a confound the owner flagged directly; the identical-pair control is pre-existing practice, reconfirmed here rather than dropped when the roster changes.

## 14. Freeze before any counted run

As already stated below (Build and test plan): the full redesigned configuration — `economy-params.json`, the roster, every role's instruction text, and the model/seat assignment from item 13 — is frozen and its hash recorded in this plan before any counted run, the same pre-registration discipline D87 applied to v1's file.

---

## What stays exactly as it is

The four kill criteria's thresholds and questions (§16.9, D130); the thesis/circulation/comparability measures' definitions; the blind-tagging methodology (reasoning text only, before the threshold is scored); the escrow/gate/settlement mechanics for a passing or failing task; the print's own publication, the issuers, the reserve/buffer/roll's own accounting rules. v2 changes who can pay whom in which unit, what the board shows, what each agent is trying to achieve, and what it can see ahead of time; it does not change what counts as a pass on a task or a brief, or how the reserve/roll itself accounts for a claim. Item 8's running objective is a new measurement surface for reading intent, layered on top of these unchanged mechanics — it is not a gate, and nothing about whether a task or a brief passes depends on it.

## Build and test plan

All code changes to `economy/world.ts`, `economy/parse.ts` (tool schemas), `economy/board.ts`, `economy/model-agent.ts` (role text, items 11/13), `economy/scoring.ts` (items 6–7), `economy/runner.ts`/`cli/economy-window.ts` (item 13's seat rotation, item 10's print-history replay), plus a new objective-ledger module for item 8. Every changed behaviour gets a test before it's considered done, same bar as the rest of `economy/`. Development and comprehension runs on the stand-in backend only (`StandInWorker`, calibrated to the print's own measured pass rates) — no Blockworks access needed or used, per your instruction. `claude-haiku-5-5` for the dev-test (item 13); `claude-sonnet-5` only for the counted run. Results shown before anything else happens — no counted run, no push, until you've seen the dev-test, together with an example of one agent's full step-by-step reasoning from the run.

Before any counted run under v2, the full redesigned configuration — `economy-params.json`, the roster, and every role's instruction text — is frozen and its hash recorded in this plan, the same pre-registration discipline D87 already applied to v1's file. Agent Studio's "freeze" (Part 2, item 5) is the mechanism that does this: no counted run starts from a configuration Studio hasn't frozen.

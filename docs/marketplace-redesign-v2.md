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

## 7. Bug fix: the scorer reads the real seed, not a default

`scoreBuyingAhead` needs the run's seed to reconstruct each window's expected needs (`needsSchedule(params.seed, ...)`), but nothing in the log or the committed params records which seed a given run actually used — `economy-score`'s default `--params` carries the frozen file's `"dev-0"`, never a counted run's real seed (`counted-2026-11-06` here), a mismatch confirmed to diverge on 20 of 21 sampled (agent, window) pairs (D133). This also breaks the module's own claim of scoring "from the ordered log alone."

**Fix:** `world.genesis()` writes one `"genesis"` log entry carrying `{ seed, backend, t0 }`; `economy-score` (and `scoreBuyingAhead`) read the seed from that entry, never from `--params`. The committed params file keeps its own `seed` field for *running* a window (unchanged), but scoring never trusts it.

**Test:** score a fixture log whose genesis seed differs from the `EconomyParams` object passed alongside it, and confirm the result matches the genesis seed, not the params — the exact scenario that silently happened in the real run.

---

## What stays exactly as it is

The four kill criteria's thresholds and questions (§16.9, D130); the thesis/circulation/comparability measures' definitions; the blind-tagging methodology (reasoning text only, before the threshold is scored); the escrow/gate/settlement mechanics for a passing or failing task; the print, the issuers, the reserve/buffer/roll's own accounting rules. v2 changes who can pay whom in which unit and what the board shows; it does not change what counts as success for a task, a brief, or the reserve.

## Build and test plan

All code changes to `economy/world.ts`, `economy/parse.ts` (tool schemas), `economy/board.ts`, `economy/model-agent.ts` (role text), `economy/scoring.ts` (items 6–7). Every changed behaviour gets a test before it's considered done, same bar as the rest of `economy/`. Development and comprehension runs on the stand-in backend only (`StandInWorker`, calibrated to the print's own measured pass rates) — no Blockworks access needed or used, per your instruction. Cheap models for the dev-test (Haiku-class), same as DW1–DW3. Results shown before anything else happens — no counted run, no push, until you've seen the dev-test.

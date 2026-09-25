# Methodology — v0

_`methodology_version` on every print refers to a section of this document; `methodology_url`
links here. This is the authority for how a Dated SIU print is computed — `docs/build1-spec.md`
is the engineering specification that implements it. Every rule below is either already
implemented in `packages/print`/`packages/basket`/`packages/prices` (cited by file) or stated as
an explicit open item, never left ambiguous. A sceptical outsider should be able to check every
claim here against the code that produces a print, not just against this prose._

**Status:** v0. No print has been marked `final` yet — see `docs/grant-base.md`'s readiness
checklist for the current, honest state of what has and hasn't been exercised against a real
print. This document describes the rules that will govern the first prints, not a retrospective
of ones already published.

---

## 1. What is measured

One **SIU** (Standard Inference Unit) is a fixed quantity of AI work: a versioned benchmark
basket of inference tasks, completed at a defined quality threshold. The current basket version
is **`SIU-2026a`** — three task classes, weighted `T1: 0.50, T2: 0.30, T3: 0.20`
(`@touchstone/basket`'s `TASK_CLASSES`). Dated SIU is the dollar price of one basket, published as a
signed, dated print. It is a measurement, not an instrument: nothing described in this document
is for sale, and the print is not a peg, an oracle computation, or a claim about real-time market
conditions — see `CLAUDE.md`'s vocabulary for the exact terms this project holds to.

The analogy that governs every design decision below: oil never got its own currency, it got a
benchmark grade — Dated Brent — priced in dollars. Inference is the commodity, SIU is the grade,
the dollar settles.

### What this measures, and what it doesn't

Dated SIU is an assessment of qualifying inference work under a versioned basket, a stated
model/provider configuration, and an objective quality gate (§5). **It is not a prediction of
production agent costs**, which vary with workflow design, tool reliability, retry policy, and
context handling — a fixed basket run under controlled settings cannot capture those, and reading
Dated SIU as "the cost of AI work" in general overextends the claim.

A documented production incident illustrates why configuration, not just the model, decides cost
and latency: [Local First AI, "The Model Wasn't Broken," 2026-08-30](https://localfirstai.eu/posts/2026-08-30-the-model-wasnt-broken/)
— external finding, not Touchstone's own — describes `gemma4:31b` running at roughly 1/400th of
its normal speed (94 seconds versus under one second) because of a single unexamined context/
KV-cache reservation default, on otherwise identical hardware. The diagnostic tell was a pegged,
not idle, CPU — the process was working, not stuck — and sweeping the setting produced a cliff,
not a slope: fine, fine, fine, then catastrophic past a threshold. The model wasn't broken; the
configuration was. The methodology point this supports: a throughput or cost claim without its
full execution configuration can be wrong by orders of magnitude, which is exactly why
`RunRecord.deviations` (§3, already implemented) exists — to record every forced configuration
change rather than silently discarding a real data-quality signal.

### Model SIU is an index. Workflow SIU and Outcome SIU are not, and never will be.

Model SIU — Dated SIU itself — is reproducible because the workload is fixed and published:
anyone can regenerate the exact instances from the published template, seed, and basket version,
and independently re-run the measurement (§4). A workflow has no equivalent canonical form to
standardize against — a research agent's cost depends on its own prompts, tools, and retry/
fallback rules, none of which are standard across agents. Publishing "our reference workflow
costs $X" would measure Touchstone's own implementation choices rather than the market, which is
how a benchmark stops being neutral.

Workflow and outcome measurement are therefore **analytics products**, computed for a specific
customer about their own agents, sold as a service — never published as a print, and never
described as an index. Full framing and business rationale: `docs/positioning.md`.

## 2. Inputs and the hierarchy of evidence

**The print is computed from executed runs only.** Three kinds of evidence exist, in strict
descending order, and only the first is ever an input to the print itself:

1. **Executed runs and reconciled invoices.** `@touchstone/harness` actually calls each registered
   model with the real basket, captures real token usage, and prices it against a pinned price
   snapshot. This is the only tier that ever produces a number in `exchange_rate_table` or
   `dated_siu`.
2. **Routed-market realised flows.** Where a defensible source of real usage share across models
   exists, it informs _weights_ — never costs. See §3's host-weighting note and the registry
   inclusion policy below for exactly where this tier can and cannot enter the computation.
3. **Published list prices.** Inform exchange-rate sanity checks and the subsidised-supply flag
   (§3) — never an input to the print. A price a provider merely advertises is not evidence that
   anyone paid it.

This ordering is a hard invariant, not a style preference: mixing evidence tiers inside a single
computed figure is exactly the kind of thing an outside auditor would be right to flag, and
`packages/harness`'s run records (`RunRecord.usage`, captured from the real provider response,
never from a list price) are the only thing `packages/print`'s cost computation reads.

**A fourth category exists and belongs to none of these tiers: telemetry from Touchstone's own
demo agents** (`data/agent-runs/`, `packages/agents`). It is never an input to the print, at any
tier — not because it's low-quality evidence, but because it isn't market evidence at all. Every
record there comes from an agent Touchstone Assay itself controls, running one fixed canned task
against a small, hand-picked set of models. That makes it genuinely useful for understanding
workflow behaviour (retries, latency, routing) and equally genuinely useless as evidence about
what independent buyers and sellers actually do — see `data/agent-runs/README.md`.

## 3. Policies

### Cache policy

Prompt caching changes the real cost of a call, so it must be either uniformly disabled or
explicitly modelled — never left to vary silently by provider. **T2 (the long-context class)
generates every instance with `cache_control: "disabled"`** (`@touchstone/basket/src/t2/generate.ts`);
T1 and T3 never set caching-related parameters at all, since their contexts aren't long enough for
caching to be a live policy question. Where a provider cannot honour an explicit disable request,
that is logged as a deviation on the run record (`RunRecord.deviations`) rather than silently
accepted.

**Worked note — cache policy alone can move a print by over 12%.** From the checked-in worked
example (`docs/siu-worked-example.md`, illustrative fixtures, not real prices): starting from a
baseline print of `$0.0383`, applying a hypothetical cache policy to a single model in the
reference set — 40% of that model's T2 input served from cache at 10% of the input price — moves
the print to `$0.0336`, a **`−12.3%`** delta, computed by the same `cachePolicyVariant`/sensitivity
code path (`packages/print/src/compute/sensitivity.ts`) that produces every print's disclosed
sensitivity block. This is exactly why cache policy must be stated and fixed, not left to reader
inference: a policy choice invisible in the headline number can move it by more than a typical
day's market movement in the underlying models' list prices.

### Batch-discount policy

Modelled the same way as caching — as an explicit price multiplier
(`packages/print/src/compute/sensitivity.ts`'s `batchDiscountVariant`) applied only in the
disclosed sensitivity block, never in the headline number. The headline basket cost always
reflects standard (non-batch) API pricing; a batch-discount variant is published alongside it so
a reader can see how much of any spread a batch-pricing tier could close.

### Reasoning-token pricing

Reasoning/thinking tokens (`RunRecord.usage.reasoning`) are priced at the same rate as regular
output tokens (`callCost(input, output + reasoning, ...)`, `packages/print/src/decimal.ts` via
`packages/print/src/compute/class-cost.ts` and `cost-of-production.ts`) — never excluded, never a
separate rate. This is not a policy choice among alternatives the way cache and batch-discount
modelling are (those are genuinely optional pricing scenarios, disclosed only in the sensitivity
block); it states plainly what the headline cost formula must include to measure what a buyer
actually pays, which is this project's own definition of the index.

**Found live, 2026-09-08, and fixed the same day.** `usage.reasoning` was captured in every run
record from the start (`RunRecord.usage.reasoning`, part of the schema) but never priced —
`computeClassCost`/`computeCostOfProduction` summed `usage.output` alone. Confirmed empirically
before fixing it, not assumed: Google's own published pricing states plainly, for Gemini's
thinking-capable models, "Output price (including thinking tokens)"; a live test call to a second
reasoning-capable provider (xAI's Grok, evaluated the same day for registry admission — see
Registry inclusion policy) matched its own real per-call billed cost exactly against
output-plus-reasoning at the output rate, and did not match output alone (a real, one-call, 8×
difference). Every daily print from `2026-09-08` back through `gemini-3.1-pro-preview`'s own
admission on `2026-08-30` understated that model's real cost and, through it, understated
`dated_siu` itself by roughly 10–14% each day. None of those prints are recomputed or replaced —
the revision policy's unconditional never-edit guarantee stands — each carries a
`correction_notes` entry stating both the originally published figure and the corrected one,
computed from that print's own real run records and price snapshot, so a reader sees the size of
the understatement rather than only being told one exists. The print immediately following this
fix will show a real, one-time jump in `gemini-3.1-pro-preview`'s cost, and therefore in
`dated_siu` itself, for this methodological reason — not a market move, the same disclosure
standard the constituent-change mechanism already applies to a registry admission.

### Host weighting for identical open weights

The same open-weight model is frequently served by more than one host at different prices — the
registry had three separate entries for `meta-llama/llama-3.3-70b-instruct` at one point
(`llama-3.3-70b-cloudflare`, `llama-3.3-70b-deepinfra`, `llama-3.3-70b-novita` —
`data/registry/models.json`; the cloudflare and novita entries were since removed for confirmed
structural incapacity, Registry inclusion policy below — `llama-3.3-70b-deepinfra` remains), each
a real, independently-priced registry entry while it was a member. Left unaddressed, multiple
entries for identical weights would let them inflate their influence on Dated SIU simply by being
listed under more hosts than a comparably-priced closed model — the same principle applies to a
frontier model reachable through more than one access path (e.g. a direct provider API and an
OpenRouter route to the same model), should that arise.

**Rule:** each host-variant of the same open weights is retained as its own row in the published
exchange-rate table — the price _does_ differ by host, and hiding that would itself be a loss of
information — but it counts as **one model family for weighting purposes**. A model family's
combined weight is never multiplied by the number of hosts it happens to be listed under; when
routed-market-share weighting is wired (§ Registry inclusion policy, below), a multi-host open
weight's family share is computed once, not once per host. Under the current equal-weighting
default, one weight is allocated per qualifying model family, not per registry row.

### Promotional and free tiers

A promotional or free-tier _price_ — a $0 or near-$0 per-token rate a provider advertises — is
not a real cost signal — it is definitionally below whatever it would cost to actually produce
that inference, which is exactly what the subsidised-supply policy below exists to catch.
Promotional pricing is not a separate carve-out; it is treated as subsidised supply.

This is a claim about _price_, not about _account tier_ — a free or rate-limited API key that
still charges the provider's normal, non-promotional per-token rate is a different thing
entirely, and is explicitly not covered by this section. See "Rate-limit tier is not the same
axis as subsidised pricing," directly below, for that distinction and the worked example that
motivated stating it explicitly.

### Subsidised supply

Inference sold below hardware cost — venture-subsidised, promotional, or supply-side-incentive
subsidised — must be flagged, not silently averaged into the reference set.
`packages/prices/src/snapshot/build-snapshot.ts`'s `flagSubsidised(snapshot, floorUsdPer1M)`
marks any price-snapshot entry priced below the published floor (§6) as `subsidised: true`. A
flagged entry still appears in the published exchange-rate table — the price is real and
informative — but is excluded from the headline reference set used to compute Dated SIU itself.

**Rate-limit tier is not the same axis as subsidised pricing.** The subsidy flag targets
below-cost _pricing_ — a per-token rate that doesn't cover what producing the inference actually
cost. A free or promotional _access tier_ that charges the identical per-token price as a paid
tier, and differs only in reliability and rate limits, is not that: nothing about the number
itself is subsidised, only the odds of a given call completing at all. **Worked example, found
live rather than assumed:** the 2026-08-22 incident (below) re-ran the same models on a free-tier
key and then a funded key. `llama-3.3-70b-deepinfra` priced at $0.000710 vs. $0.000707 across the
two runs; `mistral-small-3.2-24b-instruct` at $0.000652 vs. $0.000654 — both under 0.5%, both
sides of ordinary run-to-run output-length variance, and both rounding to the identical published
`usd_per_siu`. The tier changed which calls succeeded at all, not what a successful call cost.
Treating that reliability difference as a subsidy would conflate two genuinely different
questions this policy needs to keep separate.

### Rounding

Every intermediate value in the pipeline is kept at full decimal precision; rounding is applied
exactly once, at the point a value is written into the published print
(`packages/print/src/rounding.ts`'s `DEFAULT_ROUNDING`):

| Field             | Precision              | Mode                 |
| ----------------- | ---------------------- | --------------------- |
| `dated_siu`       | 4 significant figures | half-up              |
| `basket_cost`     | 6 decimal places       | half-up              |
| `usd_per_siu`     | 4 decimal places       | half-up              |
| `spread_to_index` | 4 decimal places       | half-up              |
| `siu_per_usd`     | 1 decimal place        | **down** (truncated) |

`basket_cost` is deliberately carried to more decimal places than `dated_siu` needs at any price
level it has reached or is likely to: at 4dp a reader cannot reproduce the published Dated SIU
from the published basket costs and weights alone — the rounding error compounds across models
enough to shift the last published digit. Reproducibility from a print's own published figures is
the entire claim the index rests on, so the working figures carry more precision than the
headline. `siu_per_usd` (how much work a dollar buys) truncates rather than rounds, so it can
never overstate what a buyer gets for their money — the one place in the print where the rounding
direction is a deliberate bias, stated here rather than left for a reader to notice.

**`dated_siu` rounds to significant figures, not a fixed decimal-place count, effective
2026-09-25** (found live and fixed the same day). The rule was originally 4 decimal places, applied uniformly
across the blended headline and both tier series (Frontier SIU, Commodity SIU). That undercounts
real precision once a series' price level falls low enough: at Commodity SIU's level (~$0.0014),
4 decimal places is only about 2 significant figures — coarser than the series' own real
day-to-day movement (roughly 1-3%). The result: every day from 2026-09-01 through 2026-09-24
published the identical `"0.0014"`, even though the true value moved every day (confirmed by
recomputing `Σ weight × basket_cost` from each affected print's own published `basket_costs` and
`weights` — both already carried at 6dp specifically so this recomputation is possible from a
print's own published figures alone, per the reproducibility point above). The same failure mode
already reaches the blended Dated SIU headline as its own price has fallen with the cost of
inference (by design, not a defect) — several days in August published an identical flattened
figure for the same reason, and by 2026-09 individual days were already down to 3 significant
figures at 4dp. A fixed decimal-place count would keep needing this fix again as the index falls
further; significant figures scale with the price and don't.

None of the affected historical prints are recomputed or replaced — the revision policy's
unconditional never-edit guarantee stands, the same as every prior correction. Each one carries a
`correction_notes` entry stating both the originally published figure and the figure recomputed
under the corrected rule, from that print's own published `basket_costs`/`weights` — reproducible
by any reader, not merely asserted. `correction_notes` is excluded from the signed payload
(`packages/print/src/sign/canonicalise.ts`), so none of this touches any print's signature or
on-chain anchor. The public site's series charts (`site/src/render/series-page.ts`) additionally
plot this recomputed figure as a second, clearly labelled line alongside the canonical published
one, so the real historical movement this rounding rule had hidden is visible without implying
any published, signed figure changed.

**The recomputed figure restores rounding precision only — it is not a claim of a print's true
economic value.** 24 of the corrected prints (the blended headline and Frontier SIU prints from
2026-08-30 through 2026-09-13) have `basket_costs` that were *also* built from under-priced usage
— the reasoning-token and cached-input pricing bugs, disclosed in each of those prints' own
earlier `correction_notes`. For those prints, the rounding-corrected figure is the unrounded
version of a value already known, via that print's own other correction notes, to need a further
correction this recomputation does not make. A second correction_notes entry on each of those 24
prints states this explicitly, rather than leaving the first note's "the real value is X" phrasing
to be read as more than it is.

Checked whether any on-chain or off-chain code depends on `dated_siu` having exactly 4 decimal
places (a fixed-width parse into an integer minor-unit amount would break under a variable decimal
count): none does, as of this writing, checked broadly across the settlement and quoting code
paths specifically, not just the contract — `packages/mcp-server/src/tools/get-quote.ts` builds a
quote from `exchange_rate_table.usd_per_siu` (unchanged, still fixed 4dp), never `dated_siu`
itself; `packages/mcp-server/src/settlement/reader.ts` binds a settlement to its quote by hash,
never parses a print value; `CapacityBond.sol`'s functions all take plain `uint256` amounts
supplied by an off-chain caller. Nothing in this repository parses the `dated_siu` string itself
into minor units anywhere, on-chain or off. Recorded here so this is checked again before any
future code does add that parsing.

## 4. Contamination control

Task instances are never taken from public benchmark datasets — HumanEval and comparable sets are
in every training set in wide use, so a model scoring well on them proves nothing about real
capability. Instead, every instance is generated deterministically from a public _template_ plus
a per-print seed, using a hand-rolled, dependency-free PRNG (`mulberry32`,
`packages/basket/src/seed.ts`) chosen specifically so the exact generation algorithm can't
silently change under a transitive dependency bump — reproducibility depends on the algorithm
itself staying fixed and auditable, not just documented.

**The seed is published only after the print that used it ships**, never before. Publishing it in
advance — even in a private working tree with CI or repo access — would let anyone with early
visibility pre-compute the exact instances a coming print will use, defeating the entire point of
seeded generation. Once a print has shipped, its seed becomes public alongside it, and a third
party can regenerate the identical instances from the published template, seed, and basket
version to independently reproduce the print's inputs.

## 5. Quality gates

Every task class has an objective, code-defined grader — `packages/basket/src/{t1,t2,t3}/grade.ts`
— checked automatically against each run's output. **No judge models are used anywhere in v1**:
an LLM-as-judge grader costs money, adds variance run to run, and imports someone else's opinion
into a number this project claims to measure, not survey. A class with zero passing instances for
a model is `undefined` for that model (`packages/print/src/compute/class-cost.ts`), and a model
with any undefined class is excluded from that print's headline reference set, appearing in the
exchange-rate table with an explicit `excluded_reason` rather than a silent gap.

**Subjective quality — whether an answer is not just gate-passing but genuinely good — is
explicitly out of scope for v1 and named here as a v2 question**, not solved by omission. Any
future subjective dimension would need its own stated methodology, its own disclosed cost and
variance characteristics, and would not retroactively change how v1 prints were computed.

**Reasoning-token budget accommodation (added 2026-08-30, ahead of frontier-model admission).**
Every task class defines a fixed token budget (T1/T3: 512, T2: 256 —
`packages/basket/src/{t1,t2,t3}/generate.ts`), the same ceiling for every model, deliberately: a
shared budget is how the basket keeps the comparison fair. But for a model whose provider reports
reasoning/thinking tokens separately and cannot be told to skip them — confirmed live for
`gemini-3.1-pro-preview`: requesting a zero thinking budget returns `"This model only works in
thinking mode"` — a shared budget stops being a fair constraint and becomes a different, tighter
one for that architecture alone. The mandatory reasoning consumes most or all of the budget before
the model can write an answer, and what gets measured is "how well does this model perform under a
budget that conflicts with how it works," not the model's real capability at the price it actually
charges. That's a benchmark artifact, not a market fact: a real buyer sets a budget that
accommodates the model's reasoning, pays for those tokens, and gets a correct answer — the index
should reflect that. The economics are already captured correctly regardless: reasoning tokens are
billed as output on every provider that reports them, so a model that reasons expensively shows
that cost in its exchange rate, which is the right place for it — not as an artificial failure
rate.

**Rule, architectural not per-model:** where a provider reports reasoning tokens separately for a
call **and** that call's completion was cut off by the task's token budget while reasoning tokens
were nonzero (the provider's own truncation signal — `finishReason: "MAX_TOKENS"` /
`finish_reason: "length"` / `stop_reason: "max_tokens"` — not inferred from output length), the
adapter retries once with the task's own budget preserved for the completion and a reasoning
allowance added above it, bounded at **`REASONING_BUDGET_MULTIPLE` = 3×** the task's token budget
(`packages/harness/src/adapters/types.ts` — one constant every adapter reads, so the bound is
uniform, not tunable per model). This applies identically to every adapter
(`anthropic.ts`/`google.ts`/`openai.ts`) and fires only on the observed symptom — a model that
doesn't exhibit it (every current registry model; `claude-sonnet-5` and `gpt-5.1` did not need this
in their admission evidence runs) is completely unaffected. Every retry is recorded in that run
record's `deviations` field, naming the truncation signal, the reasoning tokens observed, and the
accommodated total used — auditable per instance, not asserted in the aggregate.

**Result, measured (2026-08-30 admission evidence run):** `gemini-3.1-pro-preview` went from 3/15
to 14/15 once accommodated — confirming this was a benchmark artifact, not a finding about the
model. The one remaining failure (T3, instance `T3-04`) is not an infrastructure failure or a
retry that should have happened again: all three of T3's quality-gate attempts (§5) hit close to
the full 3x reasoning allowance and still failed to produce a passing answer within it. That's a
genuine, bounded result about this model's real reasoning cost on this specific task class, arrived
at under a stated rule — not expanded further to force a pass, which is exactly what
`REASONING_BUDGET_MULTIPLE` exists to prevent.

**Not a version bump.** `methodology_version` changes when a rule change would move an
_already-published_ number (Methodology versioning, below) — nothing published under the current
registry has ever exercised this path, since no admitted model has mandatory, separately-reported
reasoning. This rule applies from this revision onward, including to admission evidence runs
(Registry inclusion policy, criterion 3) for any future candidate — stated here, dated, before the
first run that uses it, per this document's own revision discipline elsewhere.

### Why quality gates define usefulness — the Pearl cuPOW case

This is the argument for why §5's gates exist at all, not a restatement of them.

Proof-of-useful-work schemes that define usefulness as _computation performed_ rather than
_outcome delivered_ are vulnerable to synthetic workloads that satisfy the computation without
producing the outcome. Pearl's cuPOW chain marketed itself as proof-of-useful-work for AI
inference. **External finding, not this project's own** — Basu, "The Usefulness Gap in
Proof-of-Useful-Work: An Empirical Study of Pearl's cuPOW Protocol"
([arXiv:2606.04819](https://arxiv.org/abs/2606.04819), June 2026): cuPOW's consensus verifies
that a submitted matrix multiplication (`NoisyGEMM`) was computed correctly, but never verifies
that the matrices came from an actual model forward pass. Miners running arbitrary, uniformly
random matrices through the identical verification pipeline passed every check while performing
zero AI inference. The audit's own figures: a network reporting 24 EH/s — on the order of 320,000
GPU-equivalents, an estimated 112 MW — producing no useful AI computation, while budget GPU rental
prices rose 38% and utilisation surged from 57% to 94% once the exploit became public, displacing
real research workloads with computation that satisfied the protocol's own proof while delivering
nothing it was meant to measure.

Touchstone's design is structurally immune to this specific failure, and it is worth stating
plainly why, not just asserting it:

- SIU is credited only for a defined task class (§3, T1/T2/T3) that passes a machine-checkable
  quality gate against a real, buyer-specified task. A synthetic computation tied to no task and
  no buyer yields zero SIU, regardless of how much compute it consumed — there is no "the
  arithmetic was correct" path to credit, because correctness of arithmetic was never what earned
  credit in the first place.
- Receipts (`verify_receipt`, `docs/settlement-metadata.md`) bind a settlement to a buyer, a task,
  and evidence hashes — a self-dealt synthetic job (the same party as both buyer and seller,
  manufacturing volume with no independent demand behind it) is structurally distinguishable from
  genuine traffic, not merely assumed absent.
- Because the index measures **cost per verified outcome**, not compute performed, a network
  emitting large rewards while producing little verified work is _measurable_, not merely
  suspected — the gap between reward volume and verified-outcome volume is exactly the number
  cuPOW's own design has no equivalent of publishing.

**The honest limit, stated as plainly as the claim above:** SIU does not fix anyone else's
incentives, and does not audit any other network's consensus. It only makes the distinction
between synthetic and delivered work legible to a buyer or observer who chooses to measure it —
the same way a benchmark grade never prevented anyone from selling adulterated oil, only made the
adulteration checkable against a stated standard.

## 6. The floor column

Published beside the print, never inside it: a hardware-cost floor,
`floor_usd_per_basket = (GPU-seconds per basket ÷ 3600) × rental rate ÷ assumed utilisation`,
measured on a rented reference GPU configuration (`NVIDIA H100 SXM 80GB`) actually serving a
model with vLLM and actually running the SIU basket against it — never estimated from FLOPs or
any other proxy. `market_spread = print ÷ floor`. Sources for the rental rate are freely usable:
auction-cleared listings from Akash and Vast.ai (`packages/prices/src/floor/`), never a licensed
index. See `docs/floor-measurement.md` for the full operator procedure and
`scripts/measure-floor.ts` for the tooling that turns a real measurement session into a
print-consumable record — it refuses to produce one at all unless the served model passed all
three quality gates (§5).

**Honest caveat: the floor is an open-weight substitution floor, not a same-model production
cost.** vLLM serves open weights — it cannot serve a closed frontier model whose weights aren't
available to run — so the floor necessarily measures the cost of self-hosting an _open-weight
substitute_, not the actual infrastructure cost behind whichever model dominates a given print's
weighted average. This means part of `market_spread` is genuine model-capability value (a
frontier model doing work an open-weight substitute cannot do as well, if at all) rather than
pure margin. Presenting `market_spread` as "how much margin is being captured" without this
caveat would overstate what the number actually shows; this document states it so nobody has to
infer it.

## 7. Provisional versus final status, and reconciliation

Every print is published `status: "provisional"` (`packages/print/src/publication.ts`) — and
**stays that way on its own signed body forever.** `status` is part of what a print's signature
commits to (unlike `anchor`/`correction_notes`/`superseded_by`, which record events that happen
*after* the print and are excluded from the signed body for exactly that reason): it's a claim
about the print at the moment of signing — "this number is unreconciled." Editing it later, even
to something true, would invalidate the original signature and desync the print from what's
already anchored on-chain. So nothing ever does. Reconciliation is a **separate, signed, anchored
record** — `data/reconciliations/<print_id>.json`, `@touchstone/sdk`'s `ReconciliationRecord`
schema — that references a print by `print_id` without ever touching it.

**A print is "final" exactly when a valid reconciliation record exists for it — presence, not a
field.** The site and console derive this by checking `data/reconciliations/` for the print's id
(`packages/print/src/publication.ts`'s `loadReconciledPrintIds`), never by reading `print.status`.
A reconciliation record carries `computed_usd` (copied directly from the print's own
`cost_of_production_usd` — already sums every recorded attempt across every measured model, so
there is exactly one computation of a print's real cost, never a second one recomputed from run
records that can silently drift from it), `invoice_usd` and a `provider_breakdown` (one entry per
real billing source, so the total is auditable), `relative_delta`/`tolerance` from
`packages/harness/src/reconcile.ts`'s `reconcile`, and its own `signature`/`public_key`/`anchor` —
anchored via the identical `TouchstoneAttestation.postPrint(bodyHash, version)` a print uses (the
contract never computes, validates or opines on a hash's contents, so no separate contract is
needed). `packages/print/src/cli/reconcile.ts` only signs, anchors and writes one when the
relative delta clears **2%** (`DEFAULT_RECONCILE_TOLERANCE = "0.02"`); outside that tolerance it
prints a full report and writes nothing — the print simply staying without a record already
discloses "not yet reconciled" honestly, the same way `correction_notes`' absence discloses "no
correction has been published." **A written reconciliation record is never overwritten** —
`writeReconciliation` uses the identical append-only guard as `writePrint`, for the identical
reason: a signed, anchored record is a real artifact from the moment it exists.

**Reconcile only against a figure the provider itself has finalised, never a pending or
provisional one.** Every provider dashboard used for this (OpenRouter, Anthropic, OpenAI, Google,
xAI) can show same-day usage before it's settled on their own side — reconciling against a number
that later moves on the provider's own books would produce a `"final"` print built on a non-final
input, exactly the quiet inaccuracy the evidence hierarchy (§2) exists to rule out. Wait for the
provider's own figure to stop being provisional before running `reconcile`. `ReconciliationRecord`
already carries `reconciled_at` for this reason — how long after the print's own `date`
reconciliation actually happened is part of the record, not implicit.

**A provider figure is only usable if it can be attributed to this project alone.** Any of these
five providers can bill something other than that day's print run onto the same total: the same
Anthropic key also powers the live chat widget's real-time responses and its weekly digest
clustering job (`packages/chat-server`), the same OpenAI key also powers the demo seller agents
(`packages/agents/src/workers/seller.ts`). Confirm which providers achieve this **structurally, by
construction** (OpenRouter's activity log is already per-model, so it's clean regardless) versus
**by filtering a shared total** (Anthropic and OpenAI's keys are shared with other real systems,
so their own per-key usage breakdown must be used instead of the account total) — don't assume
either without checking.

**A wrong diagnosis published is worse than an honest "unknown," and this project made that exact
mistake once before finding the real cause — corrected each time, not hidden.** A real Gemini
invoice figure showed a ~2.7x spike on 2026-09-08 against every neighbouring day, and a smaller
but real mismatch against this project's own computed cost on every other day checked. The first
diagnosis (shared Google Cloud billing, fixed by dedicating the API key to this project alone) was
wrong — the key had never been shared. The correction that followed said the cause was unknown.
It no longer is.

**The real cause, confirmed: two distinct bugs in this project's own code, neither about Google's
billing at all.** Both fixed forward (commit `48ba69c`), neither ever recomputes or edits an
already-published print.

1. **`RunRecord.usage.cached_input` was captured by every provider adapter but priced by
   neither cost formula.** `class-cost.ts` and `cost-of-production.ts` only ever priced `input`
   and `output + reasoning` — real, billed cache-hit tokens were silently free in every published
   number, for every model with cache usage, not only Gemini (deepseek-v3.2, mistral-small-3.2,
   gpt-5.1 and grok-4.6 all show real historical cached-token usage too). This is now priced via a
   new, optional `price_cached_in_usd_per_1m` on a price snapshot entry, sourced the same way as
   input/output pricing already is — LiteLLM's own published `cache_read_input_token_cost` — never
   defaulted to zero or to the input rate for a model with no published cache rate. This is
   unrelated to this section's own `cachePolicyVariant` sensitivity tool, which models a
   *hypothetical* alternative cache-adoption policy as a delta off the headline number; this fix
   prices cache use that actually happened, in the headline number itself.
2. **The larger effect, specific to Gemini: a real, separately-billed API call was silently
   discarded.** `packages/harness/src/adapters/google.ts` (structurally also `anthropic.ts` and
   `openai.ts`, though not yet triggered in practice for either) retries with a bigger completion
   budget whenever mandatory reasoning consumes the whole budget before an answer is produced —
   `gemini-3.1-pro-preview` cannot disable "thinking," so this fires on nearly every call. The
   retry's response used to *replace* the first call's result outright, discarding its real,
   billed input and reasoning tokens rather than adding them in. This is why Google's real per-day
   billed token counts were consistently higher than this project's own recorded usage on ordinary
   days, not only the spike day, and why 2026-09-08 (and 2026-08-30, this project's first day)
   showed a real spike: the retry simply fired unusually often on those two days specifically.
   Both calls' usage is now summed, and the raw response preserves both when this fires.

Every affected print's own `correction_notes` states its exact, per-model retroactive
cached-token dollar impact — bug (1) is precisely reconstructable from each print's own already-
recorded run records, since `cached_input` counts were always captured correctly, only unpriced.
Bug (2) is not: the discarded call's real input-token count and full raw response were never
saved, so its dollar effect cannot be reconstructed after the fact, only bounded qualitatively
from each affected record's own `deviations` entry (which does carry the discarded call's real
reasoning-token count). This is why these prints stay `status: "provisional"` permanently even
now that the cause is fully known — a known cause with a partially unrecoverable magnitude still
isn't a number this project will publish as final.

**Use the exchange rate the provider's own invoice states, never one picked to make a conversion
work.** Still true in general for any non-USD provider — but it was not, in the end, what this
gap was about. Back-converting with a guessed rate is inventing a number, the one thing this
project's working agreement forbids outright; use the invoice's own stated USD figure directly
when one is available.

**The implied-rate check correctly flagged a real problem — on the wrong side of the ratio.**
Found live, 2026-09-08: dividing each day's real Kč figure by that day's own computed USD cost,
across ten real days, gave a column ranging 22.9 to 33.1 — read at the time as a currency-side
signal. It wasn't: the ragged column was this project's own *denominator* moving around, because
the computed USD cost it was divided by was itself wrong in the two ways above (unpriced cache
tokens, discarded call usage), and how often the discarded-call bug fired varies day to day. The
general technique is still sound and still worth keeping for any provider billing in a foreign
currency — a flat implied-rate column is consistent with a clean read on both sides; a ragged one
means investigate *both* the real figure and this project's own computed figure before assuming
the problem is attribution or currency. Don't assume which side is wrong; this time it was the
side that looked authoritative because it was this project's own number.

**Rule out this project's own arithmetic before concluding a gap is attribution, not a
calculation error — and "arithmetic" means the whole formula, not just the rate.** Google's
published Gemini pricing ($2/1M input, $12/1M output including thinking tokens, confirmed via
`ai.google.dev/gemini-api/docs/pricing`) matched this project's own price snapshot exactly, which
correctly ruled out a *rate* error. It did not rule out a *scope* error — which tokens get counted
and priced at all — and that turned out to be exactly where both real bugs above lived. Checking
the counterparty's own published rate is cheap and immediate and worth doing first, but confirming
the rate is right is not the same as confirming the formula that rate feeds into is complete.

## 8. Signing and anchoring

A print's body is canonicalised (RFC 8785 JCS, every field except `signature`/`public_key`
excluded from the hash), hashed with keccak256, and signed with secp256k1 by
`TOUCHSTONE_PUBLISHER_KEY`. The signed print carries its own `signature` and `public_key`, so it is
internally self-consistent — but a print's own fields proving internal consistency is not the
same as proving the signer is really Touchstone Assay's key rather than an impersonator's who signed a
self-consistent but fabricated file. Closing that gap is exactly what §"Publisher identity and
verification" below does, and is why the publisher key is coupled to an on-chain contract rather
than distributed out of band.

## 9. Cost of producing the index

**Measured, not estimated.** The registry's own history so far: six models at launch, down to
four on 2026-08-30 (two removed for confirmed structural incapacity — Registry inclusion policy,
below), up to seven the same day with three direct frontier-provider adapters admitted
(`claude-sonnet-5`, `gpt-5.1`, `gemini-3.1-pro-preview` — Anthropic, OpenAI, Google). The last real
print under the six-model registry (`2026-08-29`) cost **$0.0977** — `cost_of_production_usd` on
the face of every print, per §7; the four-model registry's own real cost is close to that figure,
slightly lower, with no print yet published to state it more precisely than that.

**Frontier admission cost, measured from the real evidence run (2026-08-30), not projected:**

| Model                               | Real cost, one basket run |
| ----------------------------------- | ------------------------- |
| `gpt-5.1`                           | $0.1506                   |
| `claude-sonnet-5`                   | $0.3809                   |
| `gemini-3.1-pro-preview`            | $0.3871                   |
| **Three frontier models, combined** | **$0.9185**               |

Claude and Gemini cost roughly **2.5× GPT-5.1** for identical basket work — the first real
frontier-tier exchange-rate observation this index has made, exactly the kind of comparison Dated
SIU exists to publish. Combined with the existing four-model registry's own real cost, one print
under the seven-model registry costs **≈$1.00**, i.e. **≈$30/month at daily cadence typical, up to
≈$75/month at the full spend ceiling** — up from ≈$3/month at the six-model registry. This
supersedes the illustrative frontier estimate this section previously carried (that number is now
measured, not projected, and this is stated as a dated correction, not an edit that erases what
was said before it was known).

**`PUBLISH_SPEND_CEILING_USD` raised to $2.50/day, effective 2026-08-30** (from $1.10), set
deliberately with real headroom rather than to just clear the measured number — the $1.10 ceiling
was set the same way the registry itself was under-margined, cleared today's cost with nothing
held back for variance, and a week of missed prints was the result. $2.50 is ≈2.5× the measured
≈$1.00, sized to absorb T3 quality-gate retries, Gemini's reasoning-token variance (§5), and
day-to-day provider price movement without tripping, while still catching a genuine runaway.
Rented reference hardware for the floor-measurement session (§6) costs a few dollars per session,
run monthly, outside this daily figure.

---

## Registry inclusion policy

**Registry composition is the index.** Weights are currently equal across the qualifying set
(§ below), which means adding one cheap model or dropping one expensive one moves the headline
number materially, with no computation error involved at all. Composition decisions therefore
need to be as objective and auditable as the arithmetic itself — this section is what stands
between Touchstone Assay and a fair accusation that it can move its own number by curating who's in the
basket.

**Admission — objective criteria, no discretion:**

1. The model has a real, queryable price source already integrated (`packages/prices/src/sources/`
   — currently OpenRouter and LiteLLM) — never a manually-typed price. The publish pipeline reads
   the **merged** snapshot (`mergeSnapshots`, `packages/prices/src/snapshot/build-snapshot.ts`):
   OpenRouter's own routed-market price for an OpenRouter-routed entry, falling back to LiteLLM's
   list price only for a direct-provider entry with no OpenRouter presence at all — never
   overriding an available OpenRouter price. **Found live, not hypothesised (2026-08-30):** the
   day the first direct-provider frontier models were admitted, the publish pipeline was still
   reading the OpenRouter-only snapshot; all three silently dropped out of the print as
   "unpriced, excluded" — indistinguishable from a genuinely unpriced model — even though the
   harness had already spent real money calling them. Fixed the same day by wiring the merge in;
   noted here because it's exactly the kind of gap criterion 1 exists to prevent, caught only
   because the run failed loudly (below minimum qualifying) rather than silently.
2. It is servable through an existing or trivially-adaptable provider adapter
   (`packages/harness/src/adapters/`).
3. It has completed at least one full basket run recorded as real run records under
   `data/runs/` — a candidate is added to the registry once this evidence exists, not on the
   strength of a claim that it _would_ work.
4. Its registry entry states `provider`, `tier`, `open_weights`, and `host` truthfully
   (`packages/sdk/schemas/model-registry-entry.schema.json`) — tier and open-weight status are
   not judgment calls made per print, they're fixed at admission.
5. It is **structurally capable of every task class in the basket** — able to accept a class's
   required input size and complete the request at all, independent of whether it then passes
   that class's quality gate. This is distinct from criterion 3 (has completed one full run):
   a host can complete a _small_ class successfully and still be hard-incapable of a _larger_
   one, which is exactly the gap this criterion closes.

Passing a print's quality gates (§5) is **not** an admission criterion — that is evaluated fresh,
per print, and a model already in the registry that fails a class for one print is excluded from
_that print's_ reference set (with a disclosed reason) without being removed from the registry
itself. Registry admission and per-print qualification are deliberately separate questions.

**Structural incapacity is not the same as a failed gate.** A quality-gate failure (§5) means the
model attempted the task and produced output that didn't pass grading — evidence about the
model's _output quality_. Structural incapacity means the request could never be attempted at
all — the host rejects it outright (an explicit context-window/size limit, not a timeout or a
harness bug) regardless of what the model would have produced. `packages/print/src/compute/class-cost.ts`
already distinguishes these in the `undefinedReason` it records ("no run records for this class"
— never attempted — versus "all N instance(s) failed the quality gate" — attempted and graded),
and criterion 5 above is the registry-level consequence of the first case recurring: a per-print
exclusion for "no run records" is a signal to _check_, not by itself proof of incapacity — it only
becomes a removal case once confirmed structural (below), since a single print's infra hiccup
looks identical in that field.

**Confirmed structural incapacity (2026-08-18 print):** `llama-3.3-70b-cloudflare` and
`llama-3.3-70b-novita` were excluded from the first print with `undefined class: T2 (no run
records for this class)`. Diagnosed by replaying the exact real T2 prompt from that print
(same seed, same instance, `T2-01`) directly against each host: `llama-3.3-70b-cloudflare`'s
OpenRouter endpoint enforces a **24,000-token** context ceiling and `llama-3.3-70b-novita`'s
enforces **12,288 tokens**; the T2 request needs roughly **31,000 tokens**, and both hosts reject
it outright with an explicit context-length error — confirmed against the real deployed T2
generator, not estimated. `llama-3.3-70b-deepinfra`, the same weights on a different host, served
the identical prompt successfully (21,678 real prompt tokens). This is a per-host serving
configuration limit, not a harness defect: no timeout, truncation, or routing misconfiguration was
involved.

**Removed 2026-08-30**, per criterion 5 and the constituent-change rule (announced here, in
this revision, ahead of the print it takes effect in — every print already published, including
every one where these two were excluded per-print rather than absent from the registry, is
untouched). `llama-3.3-70b-cloudflare` and `llama-3.3-70b-novita` were removed from
`data/registry/models.json`, not merely excluded again: the 2026-08-30 scheduled run's own
infrastructure-failure breakdown independently confirmed the same finding with the real HTTP
status this time (`OpenAI-compatible request failed: 400` on every T2 instance, both hosts) —
the same conclusion as the manual replay above, now corroborated by production evidence rather
than resting on that replay alone. `llama-3.3-70b-deepinfra` — the same weights, unaffected —
stays in the registry.

**Admitted 2026-08-30:** `claude-sonnet-5` (Anthropic), `gpt-5.1` (OpenAI), and
`gemini-3.1-pro-preview` (Google) — the first `tier: "frontier"` entries this registry has ever
carried, each direct to its own provider (§ "Why not through OpenRouter" — no visible markup on
these three today, but real redundancy against the exact single-upstream failure mode that
produced the two removals above). Each satisfies every admission criterion: real price sources
(direct list pricing, already the source `packages/prices` uses for the illustrative comparisons
this document already published), real provider adapters
(`packages/harness/src/adapters/{anthropic,openai,google}.ts`), a completed real evidence run for
each (`data/runs/admission-2026-08-30/`, §9's cost table), truthful registry entries, and
structural capability across every task class — `gemini-3.1-pro-preview` only after the
reasoning-budget accommodation above; without it, the same evidence run would have wrongly read as
structural incapacity when the real cause was measurement, not capability. **The reference set now
spans both tiers this index was built to compare** — commodity, open-weight-hosted inference
(§1's positioning statement) and frontier closed models — rather than the commodity tier alone, as
it was from the first print through 2026-08-30.

**Admitted 2026-08-31:** `claude-haiku-4-5` (Anthropic) and `gpt-5.4-mini` (OpenAI) — the
registry's first `tier: "mid"` entries, both closed-weight (`open_weights: false`) and therefore
Frontier SIU constituents under design-doc §4a's segmentation rule, even though their real cost
lands in build1-spec.md §12's original "Mid" cost band rather than "Frontier." Admitted
specifically to widen the frontier tier's own internal price range: the reference set measured
only the expensive end of closed-weight inference through 2026-08-30, and frontier buying happens
across a wide internal range, not only at the top. Both model strings were resolved live against
each provider's own `/v1/models` endpoint, not assumed from memory — the catalogue moves,
`gemini-3.1-pro-preview` no longer existing under an earlier name is the standing precedent for
why. Each satisfies every admission criterion identically to the 2026-08-30 admissions: real price
sources (`claude-haiku-4-5-20251001`/`gpt-5.4-mini`, both cross-verified against LiteLLM,
OpenRouter's own listing, and each provider's official pricing page — four independent sources in
agreement), real provider adapters (the same `anthropic.ts`/`openai.ts` already serving
`claude-sonnet-5`/`gpt-5.1`), a completed real evidence run for each
(`data/runs/admission-2026-08-31/`), truthful registry entries, and structural capability across
every task class — **15/15 for both, zero infrastructure failures, zero forced deviations,
zero retries needed even on T3.** This is a genuine, reported finding, not an assumption tuned
toward: a cheaper frontier-family model was not expected to necessarily clear every gate as
reliably as the frontier flagships, and this evidence run shows it did. `claude-haiku-4-5`'s real
cost ($0.1236) is below `gpt-5.1`'s own admission cost ($0.1506) — "mini/haiku" does not mean
dramatically cheaper than the existing frontier constituents here, it means a different, real
price point the reference set was missing.

**Frontier SIU publishes for the first time as of this admission.** The frontier tier went from 3
constituents (below `MINIMUM_QUALIFYING_MODELS = 4`) to 5 — see Weighting's tier-segmentation
paragraph below and design-doc §4a. The reasoning-token budget accommodation above does not apply
to either new model: both recorded zero reasoning tokens across all 30 evidence-run records.

**`PUBLISH_SPEND_CEILING_USD` raised to $3.00/day, effective 2026-08-31** (from $2.50), for the
same reason the $1.10 → $2.50 raise was made on 2026-08-30: set with real headroom, not to just
clear the measured number. Real cost of production the day before this admission (7 constituents):
$0.8415. Adding both new models' real evidence-run cost ($0.1236 + $0.0866 = $0.2101) projects a
9-constituent baseline of **≈$1.05/print** under similar conditions — already close to the old
$2.50 ceiling's own ≈2.5× margin over the _previous_ ≈$1.00 baseline, meaning that margin would
have been eaten by this admission alone if left unchanged. $3.00 restores the same ≈2.5-2.85×
margin over the new ≈$1.05 baseline, sized the same way as before: to absorb T3 retries,
reasoning-token variance, and day-to-day provider price movement without tripping, while still
catching a genuine runaway.

**Removal:** a registry entry is removed when its price source stops publishing a price for it,
its provider adapter stops functioning and no replacement adapter is available within one review
cycle, the underlying model is discontinued by its provider, or it fails criterion 5 above
(confirmed structural incapacity in a task class, not merely a per-print gate failure). Removal
for any other reason is out of policy.

**Review cadence:** the candidate set is reviewed quarterly. A constituent change is announced in
the print immediately preceding the one in which it takes effect, and never applied
retroactively — see Index governance's constituent-change rule below, which this section shares.

**Minimum qualifying-set size: 4.** A print with fewer than 4 qualifying models is not published
at all — `packages/print/src/publish.ts`'s `MINIMUM_QUALIFYING_MODELS` refuses before signing or
anchoring, not merely before writing. Reasoning: under equal weighting (the current default),
each qualifying model carries `1 ÷ n` of the print's weight. At `n = 3`, one model already
carries a third; at `n = 2`, a coin flip between two models _is_ the index. Below 4, a single
constituent's idiosyncrasies — a bad day, a provider hiccup, one model's own pricing swing — move
the print more than the underlying market does, which defeats the entire point of a basket-wide
measurement. **Found live, not hypothesised:** on 2026-08-22, a harness run against an unfunded,
free-tier provider key qualified only 2 of 6 registered models and still published — see the
supersession entry in Index governance below. This constant exists so that can't happen silently
again; a run that thin is a measurement of a materially different, and materially thinner,
reference set, not a worse measurement of the usual one.

**Margin, restored 2026-08-30, widened further 2026-08-31.** The registry sat at exactly 4 — the
minimum, with zero margin — between the two structural removals and the three frontier admissions
the same day; the two scheduled runs in between both failed the qualifying-set guard on ordinary
infrastructure trouble that a thicker registry would have absorbed without incident. At 7
constituents against a minimum of 4, a single model having a bad day no longer breaks the print
outright — this is the direct, stated fix for a week of missed prints, not a side effect of
admitting frontier models for other reasons. At 9 constituents after the 2026-08-31 admissions
above, Dated SIU's own margin over the minimum widens again (2.25×); more directly, the frontier
tier itself goes from 3 constituents (no margin at all, below the minimum — Frontier SIU could not
publish) to 5 (1.25× the minimum) — the same zero-margin failure mode this note first documented,
now avoided for a tier series before it ever had the chance to occur.

**Weighting, stated on the face of every print:** weighting is currently **equal** across the
qualifying set (`weights.source: "equal"` — `packages/sdk/schemas/print.schema.json`), because no
defensible routed-market-share data source has been identified yet — guessing at a market-share
number would be exactly the kind of invented figure this project's own working rules forbid.
Every print states which weighting method it used. The moment a real, named, routed-market-share
data source is wired, `weights.source` switches to `"routed-market-share"` and this document is
updated to name that source before the first print that uses it ships.

**Limitation, disclosed prominently: equal weighting tracks frontier pricing more than a
demand-weighted index would.** The registry now spans commodity, open-weight-hosted inference and
frontier closed models (the 2026-08-30 admissions above) — basket costs across the qualifying set
span roughly 36x, cheapest to most expensive constituent. Equal weighting equalises constituent
_count_, not dollar magnitude, so a basket with a wide cost spread lets the expensive end dominate
the sum even though each constituent carries the same `1 ÷ n` share. **Illustrative, as of the
2026-08-31 print** (this is a snapshot, not a standing figure — it moves every print): the three
frontier constituents summed to $0.046977 of qualifying basket cost against $0.005737 for the four
commodity constituents — 43% of constituents (3 of 7) producing roughly 89% of the summed basket
cost that `dated_siu` is computed from. This is disclosed on the print page itself (computed live
from that print's own `basket_costs`, not hand-written per print), not only here.

**A registry composition change is quantified on the print that carries it, not just named.**
Alongside the admitted/removed model list (Registry inclusion policy's constituent-change rule,
above), the print page splits the move against the previous print into two mechanical components,
computed live from both prints' own `basket_costs` — a compositional share (attributable to the
admitted/removed constituents) and a continuous share (movement among constituents present in
both prints), using the same equal-weighting formula the print itself uses, restricted to the
qualifying set both prints share. The two always sum to the real observed move by construction.
This deliberately stops short of naming a cause: it states what moved and by how much, never why —
a mechanical split can't distinguish an actual market move from, say, a pricing-formula fix
reaching a constituent for the first time. When that distinction matters, it's made in prose, in a
`correction_notes` entry (Index governance, below) — see 2026-09-08's, which does exactly this for
the reasoning-token pricing fix's first appearance in the very next print.

**Routed-market-share weighting: investigated and rejected as unavailable, not merely deferred.**
OpenRouter publishes a real, public Data API (`/api/v1/datasets/rankings-daily`, CC BY 4.0,
live-updating per-model daily token totals) that looked, at first, like exactly the missing input.
It isn't: the API only sees OpenRouter's own routed traffic, which is a rounding error against
real frontier-model usage — ChatGPT, Claude.ai, and direct enterprise API access never pass
through it at all. Publishing a weighting scheme built on it would answer "what share of
OpenRouter's traffic" while presenting itself as "what share of real inference demand," which is a
materially different, and misleading, number — worse than disclosing no demand weighting at all.
**What would change this answer:** a credible cross-market volume source — aggregated usage
spanning major first-party surfaces, not one router's own logs. Recorded here so this is revisited
deliberately when one exists, rather than silently forgotten.

**A geometric mean was considered and rejected — not because it is hard, but because it has no
non-arbitrary justification.** Averaging the seven qualifying basket costs geometrically instead
of arithmetically would move `dated_siu` toward the commodity end without solving the underlying
problem, only obscuring it: the geometric mean of seven basket costs corresponds to no purchasable
basket of work, whereas the arithmetic mean at least means "one unit of work from each tracked
model." It would move the number in the direction intuition suggests is right only by
construction, not because it answers what a buyer actually purchases — and there is no
non-arbitrary answer to "why that estimator, and not some other one." A benchmark earns trust by
being mechanical and dull, not by reaching for a sophisticated estimator whenever an inconvenient
spread shows up.

**The resolution is segmentation, not a different weighting formula** — the project's design
document, §4a ("Segmentation: grades, not refineries"). Dated SIU stays the blended headline,
equally weighted, unchanged. Alongside it, **Frontier SIU** and **Commodity SIU** publish as
separate tier prints (`Print.series: "frontier" | "commodity"` —
`packages/sdk/schemas/print.schema.json`) computed from the exact same executed runs, at no
additional measurement cost. Tier assignment is objective and published, not an editorial call: a
model's own registry `open_weights` field (already required, already truthful at admission —
criterion 4 above) decides it — `open_weights: false` is Frontier SIU, `open_weights: true` is
Commodity SIU. Each tier print is gated by the identical `MINIMUM_QUALIFYING_MODELS` rule as Dated
SIU itself, applied to that tier's own constituent count: a tier with too few of its own qualifying
constituents on a given day simply doesn't publish that day, exactly like Dated SIU would, rather
than publishing a single-model proxy dressed up as a tier index. This lets a reader choose the
grade that matches their own exposure, instead of the index choosing an estimator that hides the
spread from every reader alike.

---

## Index governance

**Publication cadence and cut-off.** Prints are published **daily, at a fixed 00:17 UTC cut-off**
(`.github/workflows/publish-print.yml`), so the print's `date` and the run's actual date always
agree. **Cadence changed from weekly to daily, announced here, effective from the first scheduled
run** — infrastructure funding, previously the stated gate (see §9), is no longer the constraint;
the daily cost below reflects the registry as currently constituted. A print that cannot be
produced by its cut-off is **published as soon as it genuinely is available, with the delay
disclosed on the print itself** — never backdated to its scheduled date. A late print tells the
truth about when it was actually computed.

The automated run enforces the same invariants a manual publish does — the minimum
qualifying-set size (below), the append-only guard (Revision policy, below), idempotent
anchoring — plus guards that only matter with no human watching: it refuses to spend on
inference if the publisher's on-chain gas balance is too low to anchor the result, refuses to
sign or anchor if the run's actual cost exceeds a configured spend ceiling
(`PUBLISH_SPEND_CEILING_USD`, a GitHub Actions repository variable — currently $1.10, revisited
as the registry grows), and refuses to write a print whose anchor transaction failed rather than
recording it as anchored-in-name-only.

**Missed days.** When neither the scheduled attempt nor its retry (below) produces a print, the
day is disclosed, never left as a silent gap a reader has to notice on their own — the same
principle the supersession disclosure follows. The failing workflow run itself writes
`data/prints/incidents/<print_id>.json` (`.github/workflows/publish-print.yml`'s "Record a
failed run" step): the reason, a link to the actual failed run, real qualifying/registered
model counts, real spend incurred on that attempt, and — when the failure was widespread
instance-level infrastructure trouble rather than the qualifying-set gate alone — a
per-model/task-class breakdown of what actually failed (harness's `classifyFailure`:
rate_limit/timeout/network/server_error/auth_or_bad_request/malformed_response). Rendered
inline on the public Prints list, sorted by date alongside real prints, linking straight to the
failed run for full detail — never backdated, never presented as though nothing happened that
day.

**Retry policy.** A scheduled run that fails gets **one automated retry the same day, at 04:17
UTC** — before a day is declared missed (above), not instead of that disclosure.
`publish-unattended.ts` determines this from disk, not from which cron fired it: if a disclosed
incident for that print_id already exists (written by the first attempt's own failure, above),
this run is that day's retry, not a fresh first attempt. **One retry only** — a second failure
is a disclosed missed day, not a third attempt, and there is no third scheduled trigger to make
one.

The spend ceiling (above) applies **per day, not per attempt** — a deliberate choice, stated
here so it is never a surprise: the retry's own ceiling is `PUBLISH_SPEND_CEILING_USD` minus
whatever the first attempt already spent (its own disclosed, real `cost_usd`), so a day with a
retry can never spend more than the configured daily ceiling in total, never up to 2x it.

A print produced on the retry carries `prior_attempts` — every failed attempt that preceded it
that day, each with its timestamp, reason, the qualifying/registered model counts it reached,
and the real spend it incurred — **part of the signed body**, not added after the fact like
`superseded_by`/`anchor`, since it is known before signing. Disclosed on the print's own page
and flagged with a **late** badge everywhere the print is listed, on the same principle the
superseded-print disclosure already follows: anything that could have gone differently is
stated, not just correct in the underlying JSON. A print with no `prior_attempts` field
succeeded cleanly on its first, on-schedule attempt.

Retry eligibility is not yet conditioned on the failure's classification (harness's
`classifyFailure` — rate_limit/timeout/network/server_error/auth_or_bad_request/
malformed_response): every failure gets the one retry today. Once enough real incidents exist
to show which categories a retry actually helps with, this may become conditional — noted here
as a deliberate deferral, not an oversight.

**A model unreachable on print day.** The print proceeds. The unreachable model is marked
unavailable for that print (distinct from failing a quality gate, and distinct from registry
removal — it may well be reachable again next print) and its weight is redistributed across the
remaining qualifying set for that print only. This is disclosed on the face of the print, not
silently absorbed into the other models' weights.

**Revision policy.** Every print starts, and remains, `status: "provisional"` on its own signed
body forever — reconciliation never edits it (§7). A print IS final exactly when a separate,
signed, anchored reconciliation record exists for it, checked by presence, never by a field. A
correction to a print is never made by editing or
deleting the original — `writePrint` enforces this mechanically by refusing to overwrite _any_
existing print file, provisional or final, unconditionally — corrections are published as
**numbered revisions**, alongside the original, which remains in the public history exactly as it
was first published. Anyone auditing the record sees both the original and the correction, with
the correction's reasoning stated. (Earlier drafts of this policy read "refusing to overwrite a
_final_ print," on the theory that provisional meant "not yet reconciled, safe to redo." A live
incident — see the supersession rule immediately below — showed that reasoning was wrong:
provisional means "not yet reconciled," not "safe to destroy." The guard is unconditional now.)

**Supersession rule.** A print may be superseded by a same-day redo only for a defined, disclosed
cause — never because the redo produced a more welcome value. Both prints remain published and
anchored; neither is edited or deleted. The superseded print carries a `superseded_by` field
(excluded from its signed body, so adding it after the fact never invalidates the original
signature or its on-chain anchor) naming the print of record and the cause, stated in the same
terms as the cause itself — e.g. "insufficient qualifying set," not "we preferred the other
number." Defined causes, so far: **insufficient qualifying set** (below the minimum in this
section, above). **Found live, not hypothesised:** on 2026-08-22, a harness run against an
unfunded free-tier provider key qualified only 2 of 6 registered models and published anyway (the
minimum-qualifying-set guard above didn't exist yet). A same-day re-run under a funded key
qualified 4 of 6. The first print (`2026-08-22`) is superseded by the second (`2026-08-22b`) for
that reason alone — both remain visible on the public site, the superseded one marked distinctly
on every view that lists prints (the Series chart, the Prints list, and its own page), never
quietly dropped. A benchmark that hid this would be less credible than one that shows it: this is
the revision policy working in public, not a defect to conceal.

**Constituent changes.** Governed by the registry inclusion policy above: objective admission and
removal criteria, no per-print discretion, changes announced in the print preceding the one they
take effect in, never retroactive. A model retired mid-cycle by its provider is treated exactly
like a print-day-unavailable model (above) for the print in progress, and processed as a registry
removal (per the inclusion policy) from the next review cycle onward.

**Added 2026-08-31: the announcement lives on the print itself, not only in this document's
prose.** `prior_attempts` covered _when_ a print was actually computed; the same gap existed for
_what changed_ — a reader of the series months from now, seeing the level move materially between
two consecutive prints, had nothing on the record to say why beyond finding and reading this file.
`constituent_changes` (`packages/sdk/schemas/print.schema.json`) closes it: computed automatically
at publish time (`computeConstituentChanges`, `packages/print/src/publish.ts`) by diffing the
registry's current model ids against the _immediately preceding print's own_ `basket_costs` model
ids — every registered model as of that print, qualifying or not, so a model merely excluded from
one print's reference set is never mistaken for an actual removal. Known before signing, so part
of the signed body like `prior_attempts` — not added after the fact like `superseded_by`/`anchor`.
Rendered on the affected print's own page, annotated directly on the series chart's point, and
listed in a note beneath it — the same "surface it where people actually read, not only in a
separate document" principle every other disclosure in this section already follows. Not a
`methodology_version` bump: it doesn't change how any published number was computed, only what's
disclosed alongside it.

**Methodology versioning.** When this document's rules change in a way that would move a
published number, the new methodology version is published alongside the old one, and **both
series run in parallel for at least one full cadence cycle** before the old version is retired —
so a reader can see exactly what the change moved, not just take it on faith. `methodology_version`
on each print pins which rules produced that specific number.

**Error procedure, written before the first mistake.** On discovering an error: (1) disclose it
publicly, on the print(s) affected, before any correction is computed; (2) compute and publish the
correction as a numbered revision per the revision policy above; (3) record it in a public change
log entry naming what was wrong, why, and what changed. This procedure exists now, unexercised, so
that the first real error is handled by a process decided in advance rather than improvised under
pressure.

**First real exercise, and a distinction step (2) above didn't yet draw: not every disclosed fact
has a corrected number to redo it with.** `superseded_by` covers the case where a same-day re-run
produces a different, more complete value — a real redo. **Found live, 2026-09-08**: both
Anthropic constituents (`claude-sonnet-5`, `claude-haiku-4-5`) produced zero run records for that
day's print — every attempt failed with the same provider-side billing failure, not a quality-gate
failure — and were silently absent from `basket_costs`/`exchange_rate_table` (no `excluded_reason`
gap row), because `buildModelInputs` (`packages/print/src/cli/load-inputs.ts`) dropped a
zero-run-record model before the already-correct `excluded_reason` logic ever saw it — fixed for
every print from this one onward. Seven of nine registered models still qualified, above
`MINIMUM_QUALIFYING_MODELS`, so the print correctly published; **the resulting figure is the
correct equal-weighted average of the seven constituents that did produce real data — there is no
"more correct" number to redo it with**, only a missing disclosure of why the reference set
changed. `correction_notes` (`packages/sdk/schemas/print.schema.json`) is the mechanism for
exactly this: a fact discovered after publication that doesn't change `dated_siu`, excluded from
the signed body alongside `anchor`/`superseded_by` for the same reason (written after the fact,
never requiring a re-sign), rendered prominently on the print's own page. Applied to
`data/prints/2026-09-08.json` disclosing this incident. This is also why the apparent ~33% drop
from 2026-09-07's print is not a market move: it is the mechanical consequence of an
equal-weighted average losing its two most expensive constituents to a provider outage.

**This incident also exposed a real gap in gate design, not only disclosure — since fixed.**
`MINIMUM_QUALIFYING_MODELS` gated the blended print's *overall* qualifying count only. Frontier
SIU correctly declined to publish that day (3 of its own 5 constituents qualified, below its own
minimum of 4 — the tier-specific gate already applied to standalone tier prints) — but the blend
had no equivalent check on its own tier *composition*, so it published while its reference set
quietly shifted from a genuine frontier/commodity blend toward an overwhelmingly
commodity-weighted one, on the exact same underlying tier collapse Frontier SIU's own gate had
already caught. Verified directly against the real 2026-09-08 data: applied retroactively for
confirmation only, this rule would have refused that print outright (frontier: 3 of 5, below the
minimum) — the clearest possible demonstration that the gate was missing, not merely imperfect.

**The rule, stated plainly, because it changes behaviour materially:** a blend that has lost an
entire tier is not a thinner measurement of the same market, it is a measurement of a different
one. Publishing it as though the series continued is exactly what produced the misleading ~33%
drop this incident describes. Declining to publish is the honest failure; that drop was the
alternative. `publishPrint` (`packages/print/src/publish.ts`) now requires each tier — commodity
(`open_weights: true`) and frontier (`open_weights: false`) — to independently clear
`MINIMUM_QUALIFYING_MODELS` before the blend publishes at all, reusing the exact same threshold
and mechanism the standalone tier prints already use (`TierCollapseError`), not a new number. A
tier with zero *registered* constituents is never gated by this — a registry era where a tier
never existed (this project's own real history before 2026-08-30, commodity-only) is not a tier
that was "lost."

**The consequence, accepted deliberately, not a side effect to discover later:** the series will
have more gaps. Any provider outage affecting one tier now stops the headline print, not just
that tier's own standalone print. With five frontier constituents today, losing any two of them
for any reason — an outage, a removal, a quality-gate failure — blocks the blend entirely, even
though the overall registry would otherwise comfortably clear the minimum. That is the correct
trade, not a defect to work around: the alternative is publishing a number that misleads. The
answer to a thin tier is expanding the registry, never loosening the gate.

---

## Publisher identity and verification

`TouchstoneAttestation.publisher()` — an immutable address set at contract deployment — is the
canonical record of Touchstone Assay's publisher key. Verification is a closed loop requiring no out-of-band
key distribution or trusted third party beyond the chain itself:

1. Recompute a print's canonical body hash independently (JCS-canonicalise the body minus its
   signature fields, keccak256 it).
2. Recover the signer's address from the print's raw `{signature, hash}` pair — not from the
   print's own `public_key` field, which a tampered file could carry self-consistently over a
   different key entirely. (Recovery yields two address candidates, since the stored signature
   carries no recovery bit; exactly one matches a real signer.)
3. Compare the recovered address against `TouchstoneAttestation.publisher()`, read live from chain.
4. Confirm the same body hash is anchored on-chain (`postedAt(bodyHash) > 0`).

```bash
pnpm --filter @touchstone/print run verify-onchain <print-id> base-sepolia
```

reads nothing but the chain and the print file — no `TOUCHSTONE_PUBLISHER_KEY`, no trusted API. See
`packages/print/src/anchor/recover.ts` and `packages/print/src/cli/verify-onchain.ts` for the
implementation, and the README's own "Verify a print independently" section (generated from
`data/deployments/base-sepolia.json`) for a live worked example against a real anchored print.

**Deployed address (testnet — Base Sepolia, chain 84532):**
`TouchstoneAttestation` at
[`0xF60701793eD168ffd6e818e1DCcb600393297190`](https://base-sepolia.blockscout.com/address/0xF60701793eD168ffd6e818e1DCcb600393297190),
`publisher()` = `0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a`. **This is testnet, not the mainnet
production key** — see below.

**Limitations, stated plainly rather than discovered by an auditor:**

- `publisher` is immutable by design — there is no rotation function. Rotating the publisher key
  means deploying a new `TouchstoneAttestation` instance; the old contract's history remains as an
  honest record of what it anchored under the old key.
- If the publisher key is compromised or lost, recovery requires deploying a new
  `TouchstoneAttestation` and publishing a migration notice — itself signed by the old key, while it
  is still controlled — pointing every future verifier at the new contract address. A migration
  notice published _after_ the old key is already lost cannot be signed by it and would need a
  different, explicitly weaker trust path, stated at the time if that ever happens.
- The publisher key must be online to anchor each print — it is a **hot key** by necessity, not
  an oversight. Its blast radius on compromise is **forged prints**, not loss of funds: the key
  never touches `TouchstoneEscrow` or any USDC. This is a materially different risk profile from a
  wallet key, and is why anchoring frequency and monitoring matter more here than cold storage.
- The testnet key currently lives in a plaintext `.env` in this development environment — adequate
  for Base Sepolia, where nothing of value is at stake. **Mainnet deployment requires a distinct
  production publisher key**, generated on a clean machine, held in a secrets manager or hardware
  wallet, and never committed or stored in plaintext anywhere this key currently is. This is
  listed explicitly in `data/deployments/base-sepolia.json`'s `mainnetRequirements` and repeated
  here so it cannot be missed by only reading one of the two documents.

---

## Governance intention

Touchstone Assay currently controls its own methodology and harness. That is appropriate while the index
carries no real weight — a project of one has no constituency to capture. **Once the index has
real weight — cited, relied upon, priced against — the methodology and harness should move to
neutral governance**, structured so no single commercial party can move the number that party also
has a financial interest in. A benchmark whose publisher also trades on, or profits directly from,
the number it controls is a LIBOR panel waiting to happen. This document's registry-inclusion and
index-governance sections above are written to make that transition mechanical rather than
aspirational: objective admission/removal criteria, disclosed weighting, non-destructive revision
history, and a stated error procedure are exactly the properties a neutral governance body would
need to inherit and be able to audit from day one, not properties invented for the handover.

---

## 10. The unit: definition and magnitude

**Added 2026-09-22**, prompted by scoping `docs/gate-market-spec.md` and `docs/monetary-design.md` —
the first documents to need a precise, sub-basket SIU magnitude rather than only the blended
headline. Settles that companion document's build-order item 1 ("fix the SIU scale") as
**verified sound — no rescale.**

### 10.1 What one SIU actually is

One SIU is the **index-weighted cost of one representative task** — not the cost of running the
full basket. Precisely, from the real computation (`packages/print/src/compute/class-cost.ts`,
`basket-cost.ts`, `weights.ts`):

```
classCost[model, class]  = mean cost of one passing task instance in that class
basketCost[model]        = Σ_class classWeight[class] × classCost[model, class]   (classWeight sums to 1)
dated_siu                = Σ_model  modelWeight[model]  × basketCost[model]        (modelWeight sums to 1)
```

Both weighted sums have weights summing to 1 — the arithmetic is a weighted **average** at both
levels (across the three task classes, then across the qualifying constituent set), never a sum
over the basket's fifteen instances. `dated_siu` is already, by construction, the price of *one*
task, not fifteen.

### 10.2 The design documents said something else, and were wrong

Design doc v4 §3 and the unit-and-currency paper describe SIU as "the cost of completing the
Benchmark Basket" — language that reads as a full, fifteen-instance basket run. That wording is
inaccurate and is **superseded by this section**. The code was right; the prose describing it
wasn't, off by roughly the basket's own size (5 instances × 3 classes at weights 0.50/0.30/0.20).
The gap went unnoticed because nothing had previously needed the sub-basket magnitude stated
precisely — only a second instrument quoting fractions of a SIU (`WorkClaim`'s `quantity_siu`,
the Gate Market's `measured_rate_siu_per_hour`) surfaced it.

### 10.3 The real evidence

From the 2026-09-20 print (`dated_siu = $0.0108`), each qualifying constituent's own `usd_per_siu`
converted into "how many SIU is one of its own representative tasks" (`usd_per_siu ÷ dated_siu`):

| Model | usd_per_siu | one task, in SIU |
| --- | --- | --- |
| llama-3.3-70b-deepinfra / mistral-small-3.2-24b-instruct | $0.0007 | 0.065 |
| deepseek-v3.2 | $0.0018 | 0.167 |
| qwen-2.5-72b-instruct | $0.0025 | 0.231 |
| gpt-5.4-mini | $0.0054 | 0.500 |
| claude-haiku-4-5 | $0.0077 | 0.713 |
| gpt-5.1 | $0.0093 | 0.861 |
| grok-4.6 | $0.0172 | 1.593 |
| claude-sonnet-5 | $0.0236 | 2.185 |
| gemini-3.1-pro-preview | $0.0391 | 3.620 |

Single tasks range **0.065 to 3.62 SIU** across the real qualifying set, centred near 1 — exactly
the band ordinary single-task quoting wants. No rescale is needed: the existing definition already
delivers what a subdivision scheme would otherwise be introduced to achieve.

### 10.4 mSIU — named, not invented

The same table in milli-SIU (1 mSIU = 1/1000 SIU):

| Model | mSIU per task |
| --- | --- |
| llama-3.3-70b-deepinfra / mistral-small-3.2-24b-instruct | 65 |
| deepseek-v3.2 | 167 |
| qwen-2.5-72b-instruct | 231 |
| gpt-5.4-mini | 500 |
| claude-haiku-4-5 | 713 |
| gpt-5.1 | 861 |
| grok-4.6 | 1,593 |
| claude-sonnet-5 | 2,185 |
| gemini-3.1-pro-preview | 3,620 |

65 to 3,620 mSIU per task, integers throughout, with the cheapest real constituent clearing the
floor at 65. This is the real, measured unit the integer-reasoning experiment
(`docs/monetary-design.md` §3.3) should quote in — derived from an actual print, never asserted.

### 10.5 What this fixes for chain-linking

Chain-linking, as proposed in `docs/monetary-design.md`, exists to preserve "the magnitude of one
SIU" across future basket versions. A link ratio can only preserve a magnitude someone has written
down, and until this section nothing had. From this print onward: **a link ratio scales a new
basket version so that one SIU remains the index-weighted cost of one representative task at the
reference quality gate** — never the new basket's own instance count, whatever that turns out to
be. Any future transition away from `SIU-2026a` is computed and checked against §10.1's definition,
not the earlier "cost of the basket" prose.

### 10.6 Correcting "0.0003 SIU per MCP call"

That figure, and the "0.3 mSIU" subdivision it was meant to motivate, were never a measurement.
They originated as an illustrative example in an early prompt ("an agent should see 0.0003 SIU =
$0.001"), implying **$3.33 per SIU** — a rate no print has produced or approached; every published
`dated_siu` to date has run in the $0.009–$0.014 range. The figure then propagated, unchanged,
into the unit-and-currency paper `docs/monetary-design.md` §3.1 cites. It is corrected there
directly by its author. The one place it had reached this repo's own code — a doc-comment worked
example in `packages/mcp-server/src/tools/get-quote.ts`, with no bearing on that function's actual
(and correct) computation — is fixed in the same commit as this addendum.

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

| Field             | Decimal places | Mode                 |
| ----------------- | -------------- | -------------------- |
| `dated_siu`       | 4              | half-up              |
| `basket_cost`     | 6              | half-up              |
| `usd_per_siu`     | 4              | half-up              |
| `spread_to_index` | 4              | half-up              |
| `siu_per_usd`     | 1              | **down** (truncated) |

`basket_cost` is deliberately carried to more decimal places than the headline `dated_siu` figure:
at 4dp a reader cannot reproduce the published Dated SIU from the published basket costs and
weights alone — the rounding error compounds across models enough to shift the last published
digit. Reproducibility from a print's own published figures is the entire claim the index rests
on, so the working figures carry more precision than the headline. `siu_per_usd` (how much work a
dollar buys) truncates rather than rounds, so it can never overstate what a buyer gets for their
money — the one place in the print where the rounding direction is a deliberate bias, stated here
rather than left for a reader to notice.

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
*already-published* number (Methodology versioning, below) — nothing published under the current
registry has ever exercised this path, since no admitted model has mandatory, separately-reported
reasoning. This rule applies from this revision onward, including to admission evidence runs
(Registry inclusion policy, criterion 3) for any future candidate — stated here, dated, before the
first run that uses it, per this document's own revision discipline elsewhere.

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

Every print is published `status: "provisional"` first (`packages/print/src/publication.ts`).
Reconciliation compares the print's computed cost against a real provider invoice figure
(`packages/harness/src/reconcile.ts`'s `reconcile`); a print is marked `"final"` only when the
relative delta is within **2%** (`DEFAULT_RECONCILE_TOLERANCE = "0.02"`) of the invoiced amount.
Outside that tolerance, the print stays provisional and the reconciliation report says so
explicitly, pointing back at the run records or the invoice figure to re-check. **A final print is
never republished or overwritten** — `writePrint` refuses outright if a final print already
exists for that date, since a reconciled, publicly-referenced number is not something later work
gets to silently change.

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

| Model | Real cost, one basket run |
|---|---|
| `gpt-5.1` | $0.1506 |
| `claude-sonnet-5` | $0.3809 |
| `gemini-3.1-pro-preview` | $0.3871 |
| **Three frontier models, combined** | **$0.9185** |

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
   — currently OpenRouter and LiteLLM) — never a manually-typed price.
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

**Margin, restored 2026-08-30.** The registry sat at exactly 4 — the minimum, with zero margin —
between the two structural removals and the three frontier admissions the same day; the two
scheduled runs in between both failed the qualifying-set guard on ordinary infrastructure trouble
that a thicker registry would have absorbed without incident. At 7 constituents against a minimum
of 4, a single model having a bad day no longer breaks the print outright — this is the direct,
stated fix for a week of missed prints, not a side effect of admitting frontier models for other
reasons.

**Weighting, stated on the face of every print:** weighting is currently **equal** across the
qualifying set (`weights.source: "equal"` — `packages/sdk/schemas/print.schema.json`), because no
defensible routed-market-share data source has been identified yet — guessing at a market-share
number would be exactly the kind of invented figure this project's own working rules forbid.
Every print states which weighting method it used. The moment a real, named, routed-market-share
data source is wired, `weights.source` switches to `"routed-market-share"` and this document is
updated to name that source before the first print that uses it ships.

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

**Revision policy.** Every print starts `"provisional"` and becomes `"final"` only after
reconciliation clears the 2% tolerance (§7). A correction to a print is never made by editing or
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

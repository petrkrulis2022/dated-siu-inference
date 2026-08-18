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
registry today already has three separate entries for `meta-llama/llama-3.3-70b-instruct` alone
(`llama-3.3-70b-cloudflare`, `llama-3.3-70b-deepinfra`, `llama-3.3-70b-novita` —
`data/registry/models.json`), each a real, independently-priced registry entry. Left unaddressed,
this would let identical weights inflate their influence on Dated SIU simply by being listed
under more hosts than a comparably-priced closed model.

**Rule:** each host-variant of the same open weights is retained as its own row in the published
exchange-rate table — the price _does_ differ by host, and hiding that would itself be a loss of
information — but it counts as **one model family for weighting purposes**. A model family's
combined weight is never multiplied by the number of hosts it happens to be listed under; when
routed-market-share weighting is wired (§ Registry inclusion policy, below), a multi-host open
weight's family share is computed once, not once per host. Under the current equal-weighting
default, one weight is allocated per qualifying model family, not per registry row.

### Promotional and free tiers

A promotional or free-tier price is not a real cost signal — it is definitionally below whatever
it would cost to actually produce that inference, which is exactly what the subsidised-supply
policy below exists to catch. Promotional pricing is not a separate carve-out; it is treated as
subsidised supply.

### Subsidised supply

Inference sold below hardware cost — venture-subsidised, promotional, or supply-side-incentive
subsidised — must be flagged, not silently averaged into the reference set.
`packages/prices/src/snapshot/build-snapshot.ts`'s `flagSubsidised(snapshot, floorUsdPer1M)`
marks any price-snapshot entry priced below the published floor (§6) as `subsidised: true`. A
flagged entry still appears in the published exchange-rate table — the price is real and
informative — but is excluded from the headline reference set used to compute Dated SIU itself.

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

At roughly five instances per task class per model, per-print cost per model is dominated by T2's
long context: about 143,000 input and 26,500 output tokens per model per print. Illustrative,
tier-labelled per-print-per-model costs: frontier tier ≈ **$0.80**, mid tier ≈ **$0.15**,
open-weight-hosted tier ≈ **$0.04**. A basket of twelve models weighted toward the cheaper tiers
lands near **$3 per print**. Weekly prints therefore cost roughly **$13/month**; daily cadence
(gated behind infrastructure funding, not a technical blocker) would run roughly **$93/month**.
Rented reference hardware for the floor-measurement session (§6) costs a few dollars per session,
run monthly. These figures are illustrative estimates from `docs/build1-spec.md`'s cost model, not
figures reconciled against a real invoice — labelled as such, per this project's own rule against
presenting an estimate as a measured fact.

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

Passing a print's quality gates (§5) is **not** an admission criterion — that is evaluated fresh,
per print, and a model already in the registry that fails a class for one print is excluded from
_that print's_ reference set (with a disclosed reason) without being removed from the registry
itself. Registry admission and per-print qualification are deliberately separate questions.

**Removal:** a registry entry is removed when its price source stops publishing a price for it,
its provider adapter stops functioning and no replacement adapter is available within one review
cycle, or the underlying model is discontinued by its provider. Removal for any other reason is
out of policy.

**Review cadence:** the candidate set is reviewed quarterly. A constituent change is announced in
the print immediately preceding the one in which it takes effect, and never applied
retroactively — see Index governance's constituent-change rule below, which this section shares.

**Weighting, stated on the face of every print:** weighting is currently **equal** across the
qualifying set (`weights.source: "equal"` — `packages/sdk/schemas/print.schema.json`), because no
defensible routed-market-share data source has been identified yet — guessing at a market-share
number would be exactly the kind of invented figure this project's own working rules forbid.
Every print states which weighting method it used. The moment a real, named, routed-market-share
data source is wired, `weights.source` switches to `"routed-market-share"` and this document is
updated to name that source before the first print that uses it ships.

---

## Index governance

**Publication cadence and cut-off.** Prints are published weekly (daily cadence is the stated
build-2 goal, gated on infrastructure funding — see §9 — not on methodology readiness) against a
fixed weekly cut-off time, stated alongside the print schedule once cadence goes live. A print
that cannot be produced by its cut-off is **published as soon as it genuinely is available, with
the delay disclosed on the print itself** — never backdated to its scheduled date. A late print
tells the truth about when it was actually computed.

**A model unreachable on print day.** The print proceeds. The unreachable model is marked
unavailable for that print (distinct from failing a quality gate, and distinct from registry
removal — it may well be reachable again next print) and its weight is redistributed across the
remaining qualifying set for that print only. This is disclosed on the face of the print, not
silently absorbed into the other models' weights.

**Revision policy.** Every print starts `"provisional"` and becomes `"final"` only after
reconciliation clears the 2% tolerance (§7). A correction to a final print is never made by
editing or deleting the original — `writePrint` enforces this mechanically by refusing to
overwrite a final print — corrections are published as **numbered revisions**, alongside the
original, which remains in the public history exactly as it was first published. Anyone auditing
the record sees both the original and the correction, with the correction's reasoning stated.

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

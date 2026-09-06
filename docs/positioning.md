# Positioning — external validation and product boundaries

_This is not `docs/methodology.md`. Methodology is what a sceptic checks the number against, and
it stays scoped to how a print is computed. This document is competitive and investor-facing
context — dated, expected to go stale faster than methodology, and never a source for a
methodology claim. The lender product this document extends is specified in the external design
doc, `Touchstone_Assay_design_doc_v3_2.md` §9/§9a (not committed to this repo) — cited here, not
duplicated._

---

## 1. External validation — a16z Machine Age Fund

Three of the most sophisticated infrastructure investors describe the problem and then have no
vocabulary to solve it: the unit of work AI can do keeps rising in value, but the number of tokens
consumed to produce it goes up by orders of magnitude underneath — and they immediately revert to
tokens per second, tokens per watt, tokens per rack. Every metric they reach for measures machine
throughput, because no unit of delivered work exists for them to reach for instead. That gap is
**demonstrated, not asserted** — which is better evidence than agreement would be.

Commercially more useful is their ASIC calculation: a frontier model costs $3–5bn to train
(illustrative figures, theirs, not ours), inference must repay multiples of that, so a 20%
efficiency gain is worth on the order of $2bn — enough to justify a chip built for one model. That
entire calculation rests on an unverifiable claim: nobody can currently prove 20% more useful work
per dollar, at the same quality, on the same model. Today that claim is supported only by
benchmarks providers publish about themselves.

This extends the lender product (design doc §9/§9a): the customer is anyone underwriting a
hardware efficiency claim, including the investors funding these companies. `SIU per watt`,
`SIU per rack`, `SIU per dollar of capex` — adopting their vocabulary directly makes Touchstone
legible to that audience. Note this also lines up with the design doc's own unimplemented idea of
an energy/joules normalization column (day-ahead power prices, measured joules per task) — that
column does not exist in this repo yet; naming it here is a decision to build it later, not a
claim that it's live.

**Tension to keep honest — a central claim, not a footnote.** Their world has capacity prices
rising with demand effectively unbounded. That sits awkwardly beside a deflation thesis this
project's own print series cannot yet demonstrate. The answer holds: cost per completed task falls
through model efficiency even as capacity costs rise — but that divergence needs to be shown, not
just asserted, and showing it is exactly what `market_spread` (`print ÷ floor`) exists for.
`market_spread` and the floor column are already implemented and tested
(`packages/print/src/compute/index.ts`, `docs/methodology.md` §6, `docs/floor-measurement.md`) —
what's still needed is enough dated prints accumulated over time to make the divergence visible as
a trend, not a single-point comparison.

## 2. Positioning against adjacent layers

Three categories of system sit near Touchstone, and each answers a different question:

- **Routing systems** (e.g. Ramp Router) decide *where* a piece of work runs.
- **Billing systems** (e.g. Stripe, Metronome) decide *how* a seller charges for it.
- **Policy systems** (e.g. Ampersend, Catena) decide *whether* a given payment is permitted at all.

Touchstone Assay answers none of those questions. It defines the neutral unit those systems price,
bill, and gate *in* — a benchmark, not a router, biller, or policy engine. This is already true by
construction, not just by intent: `touchstone-quote` rides inside a standard x402/MPP
payment-required response (`docs/datum-quote.md`), so a routing or billing layer sitting in front
of or behind a seller sees an ordinary payment request with a pricing extension attached, not a
competing protocol. `Receipt` (`docs/settlement-metadata.md`) is a standalone signed attestation
that depends on no particular router, biller, or policy engine having been involved. Compose with
all three categories; compete with none of them — a benchmark's commercial value depends on its
publisher holding no position, and holding no position also means not competing with the systems
that consume its number.

## 3. Model SIU vs. Workflow SIU / Outcome SIU — why this is a product boundary, not just a
methodology footnote

`docs/methodology.md` §1 states the technical reason Model SIU (Dated SIU) can be an index and
Workflow/Outcome measurement cannot: the basket's workload is fixed and reproducible, while a
workflow has no canonical form to standardize against. The product consequence is worth stating
separately, because it's the kind of distinction a future session — or a future customer
conversation — could blur without noticing:

- **Model SIU is the published index.** Anyone can reproduce it from public templates, a
  published seed, and a price snapshot.
- **Workflow and outcome measurement are analytics products**, computed for one customer about
  their own agents — their prompts, their tool choices, their retry and fallback rules. This is a
  service, sold, never a print.

Publishing a "reference workflow" cost would measure Touchstone's own implementation choices
rather than the market, which is exactly how a benchmark stops being neutral. Keeping workflow
measurement out of the index isn't a limitation to apologize for — it's also the better business:
it opens a second revenue line (bespoke analytics, sold per customer) without ever compromising
the first (a neutral, reproducible index anyone can check).

## 4. Private holdout task set — a decision, not yet a spec

A second, permanently private task set, generated the same way `SIU-2026a`'s public basket is but
**never used to compute a published print**, so every published print's full reproducibility is
preserved exactly as documented today. Its only purpose is gaming detection: running it
periodically against the same providers tells Touchstone whether a provider is overfitting to the
public basket specifically, rather than performing well in general. This is recorded here as a
decision to build, not a specification — no schema, task content, or code exists for this yet, and
this document does not claim otherwise.

## 5. WebMCP's role — one of three surfaces, each a different job

Three distinct mechanisms exist for an agent to reach Touchstone Assay, each solving a different
problem, and this is the first place all three are written down together:

- **WebMCP** (`document.modelContext.registerTool`) is the browser-facing discovery surface for a
  human's own agent visiting the site directly — already implemented as a free, read-only
  experiment on both sites (`site/src/render/for-agents-page.ts`,
  `marketing/src/components/pages/for-agents/page.tsx`). It is a W3C Community Group proposal, not
  a shipped standard, and no browser implements it natively yet.
- **Remote MCP** (the paid four-tool server behind x402) is durable, programmatic integration —
  built for an agent operating outside any particular browser session.
- **x402** is payment — the mechanism either surface settles through when a tool isn't free.

These are three different jobs, not three competing implementations of the same idea, and nothing
here changes the hard constraint already enforced in both site implementations: WebMCP and the
in-browser demo only ever expose the three free, read-only tools (`get_current_print`,
`explain_siu`, `compare_model_cost`) — `get_quote`, `convert`, and `verify_receipt` stay paid, on
the remote server only, and nothing described anywhere in this document signs, mints, or moves
funds.

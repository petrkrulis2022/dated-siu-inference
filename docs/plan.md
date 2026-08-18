# Touchstone Assay — Build 1 orientation and plan

_Written per P1. No code in this step._

---

## 1. What Build 1 ships, restated

Build 1 ships a benchmark index — Dated SIU — for the price of AI inference, priced the way Dated Brent prices oil: not surveyed, but measured, by actually executing a versioned three-task basket (SIU-2026a) against ten to twelve real models, capturing real token usage and real prices, never list prices, as input. That measurement is published as a signed, hash-anchored "print" — a JSON file in a public git repo, rendered on a static site, carrying an exchange-rate table, a hardware-cost floor, and a sensitivity block disclosing how cache and batch policy choices move the number. Around that index sits the commercial surface: a four-tool MCP server (one free tool, three paywalled through Circle's x402 gateway, settled in USDC) that lets agents query and pay for SIU pricing; the touchstone-quote spec, extending x402/MPP so any payment-required response can carry an SIU-denominated quote; a non-custodial escrow contract on Base that settles those quotes; a Circle Agent Marketplace listing; and demo buyer/seller agents proving the full quote → compare → escrow → settle → verify loop. No token exists. Revenue comes from sitting in the payment path, not from issuing an instrument.

(187 words)

---

## 2. Dependency order

```
Layer 0   sdk (types + schemas only — this is M1, already scaffolded)
Layer 1   basket ─┐
          prices  ├─ parallel: both depend only on sdk's schema layer, not on each other
          contracts ─ parallel too, on a separate Foundry track — see note below
Layer 2   harness            — needs basket (what to run) + prices/registry (what to run it against)
Layer 3   print              — needs harness (run records) + prices (the snapshot it prices against)
Layer 4   mcp-server         — needs print (serves signed prints, quotes off the exchange-rate table) + sdk
Layer 5   agents             — needs mcp-server + contracts + sdk (nearly everything)
```

**Real parallelism opportunity the milestone numbering (M1→M8) hides:** `contracts` (M7 in the appendix) has no TypeScript package dependency at all — Foundry is a separate toolchain, and `TouchstoneEscrow`/`TouchstoneAttestation` only need to agree on the `quoteHash` shape that `sdk` defines in M1. There's no reason contracts work has to wait until week 5. If more than one person or session is working this, start contracts alongside basket/prices in week 1 rather than serially at the end — the only coordination point is that `quoteHash` computation must match between `sdk`'s quote builder and the Solidity contract, which is a five-minute conversation, not a dependency.

`basket` and `prices` are genuinely independent of each other — both only need the schema layer, not each other's output — so they're the other parallelizable pair.

---

## 3. Underspecified or risky assumptions — proposed resolutions

1. **"Prompt caching must be explicitly disabled" (§3, T2) assumes a uniform disable switch across providers that doesn't exist.** Anthropic's caching is opt-in (so "disabled" is just "don't opt in" — trivial). OpenAI and Google both have server-side automatic caching for long contexts that isn't always client-disable-able. _Resolution:_ add a `cache_disableable: bool` field to the model registry now. Any model where caching can't be turned off gets logged as a deviation, is excluded from the cache-disabled headline set, and only appears in the sensitivity block's cache-enabled variant. State this explicitly in methodology.md — don't discover it in M4.

2. **§6.3's "routed-market share" weighting names no data source.** OpenRouter publishes some app-level rankings but nothing that's cleanly "market share" per model. Guessing at a number here would be exactly the kind of invented figure CLAUDE.md's working agreement forbids. _Resolution:_ default to equal weights for every print until a defensible share source is identified and named in methodology.md — don't build a scraper for this speculatively.

3. **T3's "sandboxed child process" (M4 prompt) is not a real sandbox.** A bare Node `child_process` with a timeout gives no filesystem or network isolation from LLM-generated code. _Resolution:_ run T3 grading in an ephemeral, network-disabled container (or equivalent OS-level isolation) with CPU/memory/time caps — not a bare child process. This adds a Docker-or-equivalent runtime dependency the spec doesn't call out; worth flagging to you now rather than surprising you at M4.

4. **Reconciliation (§4) assumes provider invoices are queryable/diffable.** Most console billing (Anthropic, OpenAI, Google) is a manual CSV/PDF export, not a stable API, and coverage varies by provider. _Resolution:_ build reconciliation against a small manually-populated JSON (`actual_invoice_total` per account per month) rather than an automated invoice-fetch integration, unless a specific provider's billing API is confirmed usable.

5. **"Sign with a secp256k1 publisher key held offline" (§6) is in tension with an automated weekly/daily print pipeline.** Offline signing and unattended automation don't coexist without a decision. _Resolution — flagging as a stop-and-ask, not deciding it myself:_ either (a) the pipeline computes and stages the canonical body hash, and signing is a separate manual step run from an air-gapped machine (literal reading of "offline"), or (b) a hot key lives in a secrets manager and "offline" gets dropped from the methodology's language. This is a product/security decision, not an implementation detail.

6. **`verify_receipt(chain, tx_hash)`'s generic `chain` parameter implies multi-chain, but §10 only specifies a Base contract.** _Resolution:_ Build 1 supports `chain: "base"` only; the parameter exists in the schema for forward-compatibility but anything else errors with a documented v1 limitation, rather than building speculative multi-chain plumbing.

7. **Unit mismatch risk between `touchstone-quote`'s `amount_usd_max` (decimal string) and `TouchstoneEscrow.openAndFund`'s `maxAmount` (presumably USDC minor units, uint256).** This is the "expensive and silent" error category CLAUDE.md calls out by name. _Resolution:_ one shared conversion function in `sdk`, used by both `mcp-server` (building quotes) and `agents` (funding escrow) — never reimplemented ad hoc in either package.

8. **`@circle-fin/x402-batching` (§9) is asserted by name; I have not verified it's the actual current package.** Circle's MCP server is installed specifically so SDK docs stay current — M6 should query it to confirm the real current package/API before wiring the paywall, rather than trusting a possibly-stale string in the spec.

9. **The per-print seed (§3) is generated before the print ships but only published after — where does it live in the interim?** If it sits in a plaintext working-tree file pre-publication, anyone with repo/CI access sees it early, which undercuts the "nobody can pre-train against next week's tasks" claim. _Resolution:_ keep the pre-publication seed out of version control (generate at run time from a local secret, write it into `data/runs/` only once the print that used it has shipped).

---

## 4. Where the spec and CLAUDE.md's invariants are in tension

1. **CLAUDE.md's Build 2 design consequence — "the receipt and quote formats must be written so a token wrapper is additive later, never a rewrite" — isn't yet satisfied by §8's concrete `touchstone-quote`/receipt field lists.** Neither schema reserves an extension point (e.g. a `settlement_asset` field, defaulted to `"usdc"`) for a future wSIU-denominated payment. This is the clearest actual gap between an invariant and the spec's literal fields — worth closing in the M1 schema work rather than accepting a breaking change in Build 2.

2. **`TouchstoneEscrow.settle`'s buyer-authorised "settler" role (§10) needs precise scoping against the non-custodial invariant.** As written it's structurally fine — the settler triggers a transfer but funds still only reach seller, buyer, or treasury — but it's the one place in the contract where "no admin path to user money" could erode by accident if the settler role is ever widened. Recommend an explicit test: a malicious/compromised settler cannot redirect funds anywhere outside the pre-agreed seller.

3. **Minor, not a real conflict but worth stating in methodology.md:** §6.3 weights the print using routed-market share (CLAUDE.md's tier-2 evidence) while the underlying per-model costs must be tier-1 (executed runs). That's legitimate — weights aren't costs — but it should be said explicitly so it doesn't read as evidence-tier mixing to an outside auditor.

---

## 5. Three things to cut first if the timeline slips

1. **Marketplace listing polish and the demo video (§11).** The functional agent loop (quote → compare → escrow → settle → verify) stays — it's required by §14's definition of done and it's what generates real receipts for `verify_receipt`'s tests. What's cuttable is turning it into a polished, publicly-listed, video-ready artifact. The index's trustworthiness doesn't depend on distribution polish.

2. **Multi-host coverage for the open-weight model (§4's "one open-weight model served by three different hosts").** A valid, signed, reproducible Dated SIU doesn't require this — it's a nice provider-spread dimension, not load-bearing. Cutting it saves real integration work (three separate adapters for one model) and is easy to add back once weekly prints are stable.

3. **Daily cadence / the Base grant application (§13 Week 6).** Four consecutive weekly prints already satisfy §14's definition of done on their own, and the spec itself gates daily cadence behind the Base grant landing — an external dependency outside our control. Formalizing weekly as the committed baseline under time pressure just makes explicit what the spec already implies.

**Not cutting under any slippage:** the escrow contract, the print pipeline, the basket/harness, or the three paywalled MCP tools — that's the actual substance of "the index and the rail."

---

_Stopping here per P1. Waiting for your response before doing anything else._

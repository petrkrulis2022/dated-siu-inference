# Datum — Build 1 Engineering Specification
**Ship the index and the rail. No token.**
*v1.0 · 2026-08-13 · Implements Datum_design_doc_v3.md §6*

---

## 0. How to build this

**Use Claude Code in VS Code.** It works directly in your repo, runs the code, reads failures, iterates, and commits. Everything I write here runs in a sandbox that resets and cannot push to your GitHub, so anything built here would have to be copied over by hand. The division that works: **I write specs, schemas and prompts; Claude Code writes and runs the code.**

The one exception worth making: the **print computation module** (§6) is where an error is expensive and silent, and I have already worked the arithmetic. Ask and I'll write that module here with tests, and you drop it in as a reference implementation.

Workflow per milestone: open the milestone prompt from the appendix, paste into Claude Code, let it work, review the diff, commit. Prompts are ordered so each builds on the last.

---

## 1. Scope and non-goals

**In scope:** the SIU-2026a basket; the measurement harness; price scrapers; the print pipeline with signing and publication; a public index page; the four-tool MCP server behind x402 payment; the `datum-quote` specification; the agentic-settlement metadata specification; a non-custodial escrow contract on Base; a listing on the Circle for Agents marketplace; demo buyer/seller agents.

**Explicitly not in scope:** any token (wSIU, SIUSD); the SIU/hr lender surface; the Solana port; the simulation; provider credits; anything requiring a partner conversation. Those are builds 2–3 and phase 2.

**Two hard invariants.** The index is computed from executed runs only — list prices inform exchange rates, never the print. The escrow contract must be non-custodial: funds move only to the pre-agreed seller or back to the buyer, with no admin path to user money, ever.

---

## 2. Repo layout

Monorepo, pnpm workspaces, TypeScript throughout except contracts.

```
datum/
  packages/
    basket/          SIU-2026a task definitions + deterministic instance generators
    harness/         run orchestration, provider adapters, usage capture, quality gates
    prices/          scrapers, model registry, price snapshots
    print/           index computation, canonicalisation, signing
    sdk/             datum-quote types, quote builder/validator, receipt verifier
    mcp-server/      four tools + x402 paywall (Circle gateway)
    contracts/       Solidity: DatumEscrow, DatumAttestation (Foundry)
    agents/          demo buyer + seller agents
  data/
    registry/        models.json, sources.json
    runs/            raw run records, one file per print, git-tracked
    prints/          signed prints, one file per print, git-tracked — this is the product
  docs/
    methodology.md   the published methodology, versioned
    datum-quote.md   the x402/MPP extension spec
    settlement-metadata.md
  site/              static index page
```

`data/prints/` being a public git repo is the whole publication strategy: immutable history, free hosting, verifiable by anyone, no database.

---

## 3. SIU-2026a — the basket

One SIU = one execution of the weighted basket at reference quality.

| Class | Task | Weight | Instances/print |
|---|---|---|---|
| T1 | Short structured completion | 0.50 | 5 |
| T2 | Long-context retrieval | 0.30 | 5 |
| T3 | Code generation, test-verified | 0.20 | 5 |

**All three gates are objective.** No judge models in v1 — judges cost money, add variance, and import someone else's opinion into your number. Subjective quality is a v2 question and should be labelled as such in the methodology.

**T1 — short structured completion.** ~1,000 input tokens: a short synthetic document plus an instruction requiring a JSON answer against a supplied schema. Gate: output parses as JSON, validates against the schema, and every required field matches the expected value exactly.

**T2 — long-context retrieval.** ~25,000 input tokens (start here for cost; the basket version records the figure): a synthetic corpus with planted facts at varied depths. Gate: all planted values appear correctly in the output. **Prompt caching must be explicitly disabled**, and that policy stated in the methodology — cache policy alone can move a print by over 12%.

**T3 — code generation.** ~2,000 input tokens: a function specification and signature. Gate: generated code passes a hidden test suite executed in a sandbox. Up to 3 attempts; cost includes every attempt up to first pass; no pass in 3 attempts means the model fails the class for that print and receives no exchange rate for it.

**Contamination control, and this is a methodology feature not an implementation detail.** Do not use public benchmark datasets — HumanEval and friends are in every training set. Instances are generated programmatically from public templates using a per-print random seed. The templates are published; the seed is published *after* the print. Anyone can then reproduce the exact instances and re-run the measurement, which is the reproducibility claim the whole index rests on, while nobody can pre-train against next week's tasks.

**Execution settings:** temperature 0, fixed max_tokens per class, no system prompt beyond the task, no tools, no streaming. Every deviation a provider forces (e.g. reasoning models that cannot run at temperature 0) is recorded in the run record and disclosed.

---

## 4. The harness

Orchestrates runs across the model registry, captures usage, applies gates.

**Provider adapters** normalise to one interface: `run(prompt, params) → { text, usage: {input, output, cached_input, reasoning}, latency_ms, raw }`. Adapters for Anthropic, OpenAI, Google, and an OpenAI-compatible adapter covering OpenRouter, Together, Fireworks and Groq. Capture reasoning tokens separately where the provider reports them — they are billed as output and are a main source of cross-model cost variance.

**Model registry** (`data/registry/models.json`): `{ id, provider, endpoint, model_string, tier, open_weights: bool, host, notes }`. Ten to twelve entries for v1, including one open-weight model served by three different hosts so the print can publish provider spread.

**Reconciliation.** Monthly, compare summed run costs against the actual provider invoice per account. Any print whose runs are not yet reconciled is marked `provisional`; reconciled prints are marked `final`. This distinction is published. It is the difference between a measurement and a claim.

**Rate limiting and retries:** exponential backoff on 429/5xx; network-failure retries do not count as quality-gate attempts and their tokens are excluded from cost.

---

## 5. Price sources

`packages/prices` maintains a daily snapshot of price per 1M input and output tokens per registry entry.

Primary: OpenRouter's models endpoint (programmatic, covers most pairs). Secondary: LiteLLM's open `model_prices_and_context_window.json`. Verification: provider pricing pages, scraped weekly, with a diff alert when a price changes.

Snapshots are stored with a timestamp and never overwritten — a print references the exact snapshot it used.

**Cost-floor column** (published beside the print, never inside it): GPU-seconds per basket, measured on a rented reference configuration served with vLLM, multiplied by a rental rate and divided by an assumed utilisation. v1 rates come from freely usable sources — auction-cleared compute-exchange prints, Akash on-chain rates, Vast.ai public listings. Silicon Data's index is licensed later, not scraped.

**Subsidised-supply policy, needed before it bites.** Inference sold below hardware cost — whether venture-subsidised, promotional, or block-reward-subsidised as in Nockchain's Logos design — must be flagged rather than silently averaged in. Rule for v1: any observed price below the published floor is included in the exchange-rate table but flagged `subsidised`, and excluded from the headline reference set. State this in the methodology from day one.

---

## 6. The print pipeline

Deterministic, given runs and a price snapshot.

1. **Cost per class per model.** For each instance, `(input ÷ 1e6 × price_in) + (output ÷ 1e6 × price_out)`, summing all attempts to first pass. Average across passing instances. If the class failed, the value is undefined.
2. **Basket cost per model.** `Σ_classes weight × cost_class`. Undefined if any class is undefined — that model is excluded from the reference set and appears in the table with a gap.
3. **Weights.** Observed routed-market share across the qualifying set, normalised. If share data is unavailable, equal weights, and the print declares which was used.
4. **Dated SIU** = `Σ_models share × basket_cost`.
5. **Exchange-rate table.** Per model: USD per SIU, spread to index (`basket ÷ print − 1`), SIU per $1.
6. **Floor and spread columns.** Floor per §5; market spread = `print ÷ floor`.
7. **Sensitivity block.** Recompute the print under alternative cache and batch-discount policies and publish the delta. This pre-empts the single most effective attack on the number, which is "your policy choices made it."

All money maths in integer minor units or decimal strings — never floats. Rounding rules stated in the methodology, applied at publication only.

**Signing.** Canonicalise the print body (JCS), keccak256, sign with a secp256k1 publisher key held offline. The signature and public key go in the print file. **Anchoring:** call `DatumAttestation.postPrint(bodyHash, version)` on Base so the hash is timestamped by a third party.

---

## 7. Publication

`data/prints/YYYY-MM-DD.json` plus `latest.json`. The static site renders from those files: headline Dated SIU with the print date and status (provisional/final), the exchange-rate table, floor and spread columns, sensitivity block, methodology version and link, signature and anchor transaction, and a link to the raw runs.

Also published, per the round-2 decision: **cost of producing the index**, as a periodic aggregate.

The site is static and free to read. `get_index` is a free MCP tool for the same reason — citation is the business.

---

## 8. `datum-quote` specification

Rides inside an x402 (or MPP) payment-required response, alongside the dollar ask. Draft field set:

```json
{
  "siu": "1.000",
  "pattern": "estimate",
  "siu_max": "1.400",
  "model": "registry-id",
  "rate_usd_per_siu": "0.0483",
  "amount_usd_max": "0.0676",
  "index_version": "SIU-2026a",
  "print_id": "2026-08-14",
  "print_hash": "0x…",
  "seller_id": "erc8004:…",
  "sig": "0x…"
}
```

`pattern` is `estimate` (default), `cap`, or `fixed`. `siu_max` is required for `estimate` and `cap`, and escrow holds against `amount_usd_max`. Payment amounts are dollar-fixed; SIU is the comparison unit. A quote with `pattern: estimate` and no `siu_max` MUST be rejected by a payer operating under a spending mandate — that rule is normative in the spec, and it is what makes the extension safe to auto-accept.

Publish alongside it `docs/settlement-metadata.md`: the seller's ERC-8004 identity signature, SIU consumed, and index version, emitted as structured fields on settlement. Draft standard, works over USDC today.

---

## 9. MCP server

Four tools. Discovery via the MCP registries (official registry, Smithery, Glama, PulseMCP, mcp.so) and the Circle for Agents marketplace.

| Tool | Returns | Price |
|---|---|---|
| `get_index(version?, date?)` | signed print | free |
| `get_quote(task_class, model)` | SIU price, exchange rate, index refs | $0.001 |
| `convert(model, input_tokens, output_tokens)` | SIU + USD equivalent | $0.001 |
| `verify_receipt(chain, tx_hash)` | signed attestation: quoted vs paid vs matched | $0.01 |

Paywall via Circle's `@circle-fin/x402-batching` gateway middleware — settles in USDC, batches, credits the gateway balance. The product pays for itself through its own protocol, which is also the demo.

---

## 10. Contracts (Foundry, Base)

**`DatumAttestation`** — minimal. `postPrint(bytes32 bodyHash, string version)` restricted to the publisher key; emits an event; stores hash → timestamp. No upgradeability, no admin beyond the poster key.

**`DatumEscrow`** — non-custodial by construction.

- `openAndFund(bytes32 quoteHash, address seller, uint256 maxAmount, uint64 expiry)` — pulls USDC from the buyer.
- `settle(bytes32 quoteHash, uint256 actualAmount, bytes32 receiptRef)` — callable by seller (or a settler the buyer authorised in the quote); transfers `actualAmount` to seller, `feeBps` to treasury, remainder back to buyer; emits `Settled(quoteHash, actualAmount, receiptRef)`.
- `expire(bytes32 quoteHash)` — after expiry, buyer reclaims everything.
- Invariants: `actualAmount ≤ maxAmount`; funds can reach only the seller, the buyer, or the fee treasury; no admin withdrawal function exists; `feeBps` immutable or timelocked.

Tests must include: settle at max, settle below max with correct refund, expiry reclaim, double-settle rejection, reentrancy, and a fuzz test asserting conservation of funds.

---

## 11. Circle for Agents listing

Register as a **seller**: the four MCP tools as paid endpoints, USDC settlement, listed in the marketplace where Claude, Codex, Cursor and OpenClaw agents discover services. Use the seller quickstart and the batching middleware.

Then the **demo agents** (`packages/agents`): a seller agent exposing a trivial paid inference service that quotes in SIU via `datum-quote`, and a buyer agent that fetches two quotes, compares them in SIU, pays the cheaper one through escrow, and calls `verify_receipt`. Label it publicly as a testbed, never as traction. It generates the real receipts that `verify_receipt` is tested against, and it is the video that goes in the grant application.

---

## 12. Cost model

Per model per print, at 5 instances per class: roughly 143,000 input and 26,500 output tokens.

| Tier | ≈ cost per print per model |
|---|---|
| Frontier | $0.80 |
| Mid | $0.15 |
| Open-weight hosted | $0.04 |

Twelve models weighted toward cheaper tiers lands near **$3 per print**. Weekly prints ≈ **$13/month**; daily ≈ **$93/month**. Start weekly, move to daily when the Base grant lands. Rented reference hardware for the floor column is a few dollars per measurement session, run monthly.

---

## 13. Six-week sequence

**Week 1** — repo, schemas, model registry, basket generators with seeded instances, price scrapers, snapshot storage.
**Week 2** — harness end to end against all registry models; first unsigned print computed; reconciliation script.
**Week 3** — canonicalisation and signing; `data/prints` publication; methodology v0; static site live.
**Week 4** — MCP server with four tools; Circle gateway paywall; marketplace listing submitted; registry listings.
**Week 5** — contracts on Base testnet with full test suite; `datum-quote` and settlement-metadata specs published.
**Week 6** — demo agents end to end; ToS/benchmark-rights review across tracked providers; Base ecosystem grant application.

---

## 14. Definition of done

Four consecutive weekly prints published and signed, at least one marked `final` after reconciliation. Methodology v0 public, with cache, batch, host-weighting, subsidy and rounding policies all stated. A third party can reproduce a print from published templates, seeds and the price snapshot. MCP server live, listed, and has taken at least one real paid call from an agent that is not yours. Escrow contract deployed to testnet with green tests and no admin path to funds. `datum-quote` published as a draft spec. Demo agents complete a full quote → compare → escrow → settle → verify loop on testnet. Base grant application submitted.

---

## Appendix — Claude Code prompts

Paste one per milestone. Each assumes the repo and this spec are present at `docs/build1-spec.md`.

**M1 — scaffold.** *"Read docs/build1-spec.md. Create the pnpm monorepo described in §2 with TypeScript strict mode, vitest, eslint and prettier. Create JSON Schema files for: model registry entry, price snapshot, run record, print, datum-quote, and receipt, exactly matching the fields in §4, §6 and §8. Generate TypeScript types from the schemas. Add a README stating the two hard invariants from §1. No business logic yet."*

**M2 — basket.** *"Implement packages/basket per §3. Three task classes with deterministic seeded instance generators from public templates; each generator returns prompt, params and an objective grader. T1 JSON-schema match, T2 planted-fact retrieval at ~25k input tokens with caching disabled, T3 code generation graded by executing a hidden test suite in a sandboxed child process with a timeout. Export basket version SIU-2026a with weights 0.50/0.30/0.20 and 5 instances per class. Unit-test every grader against known-good and known-bad outputs."*

**M3 — prices.** *"Implement packages/prices per §5. Fetch and normalise per-model input/output pricing from OpenRouter's models endpoint and LiteLLM's price map; write immutable timestamped snapshots to data/registry. Add a diff report highlighting price changes since the last snapshot. Seed data/registry/models.json with 12 entries per §4, including one open-weight model across three hosts. No scraping of paid data sources."*

**M4 — harness.** *"Implement packages/harness per §4. Provider adapters for Anthropic, OpenAI, Google and an OpenAI-compatible adapter, all normalising to the run-record schema and capturing reasoning and cached-input tokens separately. Orchestrator runs the full basket across the registry with concurrency limits, exponential backoff, and up to 3 graded attempts on T3 where network failures do not consume attempts. Write raw run records to data/runs. Add a --dry-run mode that estimates cost before spending anything."*

**M5 — print.** *"Implement packages/print per §6. Compute class costs, basket costs, Dated SIU, exchange-rate table, floor and spread columns, and the sensitivity block. All monetary maths in decimal strings, never floats. Canonicalise with JCS, hash with keccak256, sign with secp256k1 from an env-provided key. Write to data/prints. Include a verify command that re-checks any published print's signature and recomputes it from stored runs and the referenced snapshot. Unit tests must cover the worked example in Datum_SIU_worked_example.md and reproduce $0.0383."*

**M6 — MCP server.** *"Implement packages/mcp-server per §9 with the four tools. get_index free; the others paywalled through Circle's @circle-fin/x402-batching gateway middleware. verify_receipt reads an on-chain settlement, matches it against the referenced quote hash, and returns a signed attestation. Include the manifest needed for MCP registry listing."*

**M7 — contracts.** *"Implement packages/contracts with Foundry per §10: DatumAttestation and DatumEscrow. Enforce every invariant listed. Write the full test suite including the fuzz test asserting conservation of funds, and a test proving no code path lets any admin role move user funds. Deploy scripts for Base Sepolia."*

**M8 — demo agents.** *"Implement packages/agents per §11: a seller agent exposing a paid endpoint that returns a datum-quote, and a buyer agent that fetches two quotes, compares them in SIU, funds escrow, settles, and calls verify_receipt. Record a scripted end-to-end run producing a transcript suitable for a demo video."*

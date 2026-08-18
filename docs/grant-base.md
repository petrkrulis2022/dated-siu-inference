# Base ecosystem grant application — draft

_Draft only. Not yet submitted — see the readiness checklist immediately below for exactly what
stands between this draft and a submission that would hold up. Every fact in this document is
either drawn directly from this repository's code, its checked-in test results, or its public git
history; nothing here is a projection, a metric, or a claim of usage. Where a figure is
illustrative rather than measured, it is labelled illustrative at the point it's used._

---

## Readiness checklist

Against `docs/build1-spec.md` §14's definition of done, checked honestly rather than smoothed
over. This is the actual current state as of this draft:

| #   | Condition (§14)                                                                                                     | Status                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Four consecutive weekly prints published and signed, at least one marked `final` after reconciliation               | **Not met.** Zero prints have been published. `data/prints/` is empty. The print-computation pipeline (`packages/print`) is implemented and unit-tested against a checked-in worked example, but has never been run against real provider API calls.                                                                                                |
| 2   | Methodology v0 public, with cache, batch, host-weighting, subsidy and rounding policies all stated                  | **Met.** `docs/methodology.md` (this draft's sibling document) states all five, each grounded in the code that implements it. Not yet exercised against a real print.                                                                                                                                                                               |
| 3   | A third party can reproduce a print from published templates, seeds and the price snapshot                          | **Not yet verified.** The mechanism exists (deterministic seeded generation, `packages/basket/src/seed.ts`) but cannot be demonstrated end-to-end until condition 1 is met — there is no published print or seed to reproduce yet.                                                                                                                  |
| 4   | MCP server live, listed, and has taken at least one real paid call from an agent that is not Touchstone Assay's own | **Not met.** `packages/mcp-server`'s four tools and Circle Gateway paywall integration are implemented and tested, but the server is not deployed to a public, always-on endpoint, and is not listed on any MCP registry or the Circle Agent Marketplace. Every call made against it so far has been from this project's own tests and demo agents. |
| 5   | Escrow contract deployed to testnet with green tests and no admin path to funds                                     | **Met.** `TouchstoneEscrow` and `TouchstoneAttestation` are deployed and verified on Base Sepolia (chain 84532) — see `data/deployments/base-sepolia.json`. 50+ Foundry unit tests, a reentrancy suite, and four fuzzed invariant tests (256 runs × 16,384 calls each) all pass. Zero privileged roles exist in the contract by construction.       |
| 6   | `touchstone-quote` published as a draft spec                                                                        | **Met.** `docs/datum-quote.md`.                                                                                                                                                                                                                                                                                                                     |
| 7   | Demo agents complete a full quote → compare → escrow → settle → verify loop on testnet                              | **Met.** `packages/agents`, run live against Base Sepolia — real HTTP 402 responses, real on-chain escrow funding and settlement, a real signed receipt. Explicitly labelled a testbed: these are Touchstone Assay's own agents on Touchstone Assay's own testnet wallets, demonstrating the protocol, not market demand.                           |
| 8   | Base grant application submitted                                                                                    | **Not met — this document is the unsubmitted draft.**                                                                                                                                                                                                                                                                                               |

**Three of eight conditions are met; one is partially exercised (methodology, not yet run
against a real print); four are not met, most materially condition 1: no print has ever been
published.** This checklist stays at the top of every future revision of this document until
every row reads "met."

---

## What Touchstone Assay is

Touchstone Assay publishes Dated SIU — the benchmark price of AI inference work. One SIU (Standard Inference
Unit) is a fixed quantity of AI work: a versioned benchmark basket of inference tasks completed at
a defined quality threshold. Its dollar price floats and is published as a signed, versioned
print. The positioning: oil never got its own currency, it got a benchmark grade — Dated Brent —
priced in dollars. Inference is the commodity, SIU is the grade, the dollar settles.

Touchstone Assay is a measurement standard and data publication. It is not a currency, not a stablecoin, and
nothing described here is for sale. Method: **verified, not surveyed** — the index is designed to
be measured by actually buying inference and capturing real usage, never by asking providers what
they charge or scraping list prices as the number itself (see `docs/methodology.md` §2's evidence
hierarchy).

## What's built (real, verifiable against this repository)

- **The print pipeline** (`packages/print`) — cost computation, canonicalisation, secp256k1
  signing, sensitivity analysis, all in decimal-string arithmetic (no floats in money maths).
  Reproduces a checked-in worked example to the cent. Never yet run against real inference calls.
- **The SIU-2026a basket** (`packages/basket`) — three task classes, deterministic seeded instance
  generation (a hand-rolled PRNG, not an npm dependency, so the exact algorithm can't silently
  drift), objective code-defined quality gates for each class, no LLM-as-judge anywhere.
- **Price and floor infrastructure** (`packages/prices`) — real price-snapshot scrapers
  (OpenRouter, LiteLLM), a subsidised-supply flag, and GPU-rate snapshot tooling
  (`packages/prices/src/floor/`, `scripts/measure-floor.ts`) for the hardware-cost floor column.
- **On-chain contracts, deployed and tested on Base Sepolia** — `TouchstoneAttestation` (immutable
  publisher-anchored hash timestamping) and `TouchstoneEscrow` (non-custodial: funds reach only the
  pre-agreed seller, the buyer, or the fee treasury; zero privileged roles; `settle`/`expire`
  paths are exact complements with no gap or overlap). Both verified on Blockscout.
- **`touchstone-quote`** (`docs/datum-quote.md`) — an x402/MPP payment-required response extension
  carrying an SIU-denominated price, with a stated minimum quotable amount, spending-mandate
  compatibility, and settlement-metadata bound to on-chain receipts.
- **The MCP server** (`packages/mcp-server`) — four tools (`get_index` free; `get_quote`,
  `convert`, `verify_receipt` paid via Circle's Gateway nanopayments middleware), independently
  testable, not yet publicly deployed.
- **Demo agents** (`packages/agents`) — a real, live-run buyer/seller loop on Base Sepolia. See
  `docs/demo.md` for a captured transcript. Explicitly a testbed, never presented as traction.
- **Independent, key-distribution-free verification** — recover a print's signer from its raw
  signature, compare against `TouchstoneAttestation.publisher()` on chain, confirm the body hash is
  anchored. No API, no trusted third party beyond the chain itself
  (`packages/print/src/cli/verify-onchain.ts`).

## Why Base

Every contract in this project is deployed to Base Sepolia today, with Base named as the intended
mainnet deployment target in `CLAUDE.md` from the start of this build. Settlement is USDC
throughout, paid via Circle's Gateway nanopayments middleware — no bridge, no wrapped asset, no
new token. `TouchstoneEscrow`'s constructor takes the settlement token and treasury as parameters and
makes no chain-specific assumptions (`evmVersion: shanghai`, no `block.chainid` branches), so a
future Arc deployment is a deployment decision, not a rewrite — but the near-term commitment is
Base, and every real transaction produced by this project so far (contract deployments, demo
agent settlements, print anchoring) has been on Base Sepolia.

## What mainnet deployment requires (stated now, not discovered later)

From `data/deployments/base-sepolia.json`'s own `mainnetRequirements`, carried forward here
verbatim rather than re-derived:

1. **`treasury` must be a Safe/multisig, not an EOA.** It is immutable with no setter in
   `TouchstoneEscrow`, so a lost treasury key would make fee revenue permanently unrecoverable — the
   only remedy would be redeploying the escrow and migrating every integrator.
2. **`TOUCHSTONE_PUBLISHER_KEY` must be generated on an air-gapped machine and held in a secrets
   manager or hardware wallet.** The testnet key used throughout this build has passed through
   repository-adjacent development files and must never be reused for a production deployment.
3. **A dedicated mainnet deploy script**, chain-guarded to Base mainnet (`8453`) the same way the
   current script is guarded to Base Sepolia (`84532`), reviewed separately.

## What a grant would fund

The known, code-derived operating cost of running the index (`docs/methodology.md` §9,
illustrative estimates from `docs/build1-spec.md`'s cost model, not yet reconciled against a real
invoice): roughly **$3 per weekly print** across a twelve-model basket weighted toward cheaper
tiers, i.e. **≈$13/month** at weekly cadence, rising to **≈$93/month** at daily cadence.
Floor-measurement sessions (rented reference GPU time) cost a few dollars per session, run
monthly. These are the only cost figures this project currently has grounds to state.

Costs this draft does **not** estimate, because no honest basis exists yet to put a number on
them: security audit of `TouchstoneEscrow` prior to mainnet deployment, ongoing infrastructure hosting
for a public MCP server deployment, and any personnel time. A funding ask with a specific total
belongs in a later revision of this document, once those are scoped — not invented here to make
the draft look complete.

## Risks, stated plainly

- **Single-operator governance risk.** Touchstone Assay currently controls its own methodology and harness.
  `docs/methodology.md` §10 states the intention explicitly: once the index carries real weight,
  governance should move to a neutral body, because a benchmark whose publisher also has a
  financial interest in the number it controls is a LIBOR panel waiting to happen. This is not
  yet built — it is a stated commitment for after the index has usage worth governing.
- **No real print has been published.** Every number this project can currently show is either a
  unit-tested worked example or a live testnet transaction — never a real, reconciled Dated SIU
  figure. This grant application is honest about that rather than implying otherwise.
- **Testnet-only today.** Every on-chain fact in this document is Base Sepolia. Mainnet
  deployment is gated on the three requirements listed above, none of which are technical
  unknowns — they're deliberate, stated prerequisites.

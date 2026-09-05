# CLAUDE.md — Touchstone Assay project context

_Save this file at the repo root. Claude Code reads it at the start of every session. Keep it current; it is the single source of shared context._

---

## What this is

**Touchstone Assay publishes Dated SIU — the benchmark price of AI inference work.**

One **SIU** (Standard Inference Unit) is a fixed quantity of AI work: a versioned benchmark basket of inference tasks completed at a defined quality threshold. Its dollar price floats and is published as a signed, versioned print. Every model carries an exchange rate into SIU. Quotes travel as an extension of the x402 and MPP payment protocols; settlement is in USDC.

Touchstone Assay is a **measurement standard and data publication**. It is not a currency, not a stablecoin, and nothing is for sale. Never write "backed by", "peg", "invest", "real-time" or "oracle" in code comments, docs or UI copy. Prints are _signed and hash-anchored_ — that is integrity of publication, not oracle computation.

The analogy that governs design decisions: oil never got its own currency, it got a benchmark grade (Dated Brent) priced in dollars. Inference is the commodity, SIU is the grade, the dollar settles. A touchstone is the fine-grained stone assayers have used since antiquity to test a metal's purity — rub the sample against the stone, compare the streak to a set of known-purity reference streaks. That is an assay, not a currency: the stone holds no position in the gold it tests. Touchstone Assay tests and publishes the price of inference the same way — it takes no position in what it measures.

**Positioning:** Silicon Data prices the machine-hour; Dated SIU prices the completed task.
**Method:** verified, not surveyed. The index is measured by actually buying inference, not by surveying prices.

---

## Vocabulary — use these exact terms

| Term                   | Meaning                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| **Touchstone Assay**   | The protocol and publisher. The project name.                                        |
| **Touchstone**         | Conversational short form of the project name.                                       |
| **SIU**                | The unit. Standard Inference Unit.                                                   |
| **Dated SIU**          | The published spot assessment — "the print".                                         |
| **the basket**         | The versioned set of benchmark tasks defining one SIU. Current version: `SIU-2026a`. |
| **the print**          | One published assessment, dated, signed.                                             |
| **exchange rate**      | A model's cost expressed in SIU terms.                                               |
| **the floor**          | Hardware cost of producing one basket, published as a comparison column.             |
| **market spread**      | print ÷ floor.                                                                       |
| **`touchstone-quote`** | The pricing extension inside an x402/MPP payment-required response.                  |
| **wSIU**               | Build 2. Transferable claim. Do not implement now.                                   |
| **SIUSD**              | Build 2. Dollar settlement token. Do not implement now.                              |
| **AIXD**               | Legacy internal codename. Do not use in new code or docs.                            |

---

## Build sequence

**Build 1 — current. The index and the rail.**
The SIU basket and measurement harness; price scrapers; the print pipeline with signing and publication; a public index page; a four-tool MCP server behind x402 payment; the `touchstone-quote` specification; the agentic-settlement metadata specification; a non-custodial escrow contract on Base; a listing on the Circle for Agents marketplace; demo buyer and seller agents. **No token exists in build 1.** Fee capture comes from being in the payment path, not from issuing an instrument.

**Build 2 — later. Do not implement, but do not foreclose.**
`wSIU`: an ERC-20 (later SPL) minted by depositing USDC at the prevailing print, one wSIU representing one SIU of work, redeemable at the prevailing print. Its purpose is chained agent-to-agent payment without unwrapping to dollars at every hop. `SIUSD`: a dollar settlement token with the agentic metadata native in the contract, minted only against major stablecoins.
_Design consequence for build 1:_ the receipt and quote formats must be written so a token wrapper is additive later, never a rewrite.

**Build 3 — later.**
Prepaid provider credits backed by provider commitments; reference-rate licensing to derivatives venues; the Solana/Rust port. **Never** a Touchstone-operated derivatives venue — a benchmark's commercial value is that its publisher holds no position.

---

## Hard invariants — never violate these

1. **The print is computed from executed runs only.** Published list prices inform exchange rates and are never inputs to the print. Evidence ranks: executed runs and reconciled invoices first, routed-market realised flows second, list prices last.
2. **The escrow contract is non-custodial.** Funds move only to the pre-agreed seller, back to the buyer, or to the fee treasury. No admin path to user money exists in any code path.
3. **No token in build 1.** If a task seems to require minting something, stop and ask.
4. **No floats in money maths.** Decimal strings or integer minor units throughout. Rounding applied at publication only, per stated rules.
5. **Never use public benchmark datasets.** HumanEval and similar are in every training set. Task instances are generated from public templates with a per-print seed; the seed is published after the print so anyone can reproduce.
6. **Quality gates are objective in v1.** No judge models — they cost money, add variance, and import someone else's opinion into the number.
7. **Verified-work proofs feed receipts and reputation, never supply.**

---

## Stack and conventions

TypeScript everywhere except contracts, strict mode, ESM, pnpm workspaces. Vitest for tests. Solidity with Foundry for contracts. Python only if the simulation is built later.

Storage is flat files under `data/`, git-tracked — no database. `data/prints/` being a public git repo _is_ the publication strategy: immutable history, free hosting, verifiable by anyone.

Deployment chain for contracts: **Base**. Write contracts with no chain-specific assumptions so Arc (Circle's L1) is a deployment target rather than a rewrite. The MCP paywall settles through Circle's Gateway and is chain-abstracted.

Arc is no longer an undated future target: Arc Testnet (chain id 5042002) has a real, deployed `TouchstoneAttestation`/`TouchstoneEscrow` (`data/deployments/arc-testnet.json`), a real buyer/seller demo loop running as Cloudflare Workers (`packages/agents/src/workers/`, `docs/demo-arc.md`), and a genuinely fixed mainnet date: **2026-09-16**. That date falls *after* ETHOnline 2026's submission deadline (2026-09-13, 12:00pm EDT) — so any ETHOnline submission is honestly testnet-complete with a mainnet-ready deploy script prepared (`packages/contracts/script/DeployArcMainnet.s.sol`, `TouchstoneAttestation` only), never a claim of a live Arc mainnet deployment. `TouchstoneEscrow` stays on Arc Testnet regardless of the date — the same mainnet preconditions (Safe treasury, settled `feeBps`, an air-gapped publisher key, external review) apply there as on Base.

Circle Agent Stack components in use: Nanopayments/Gateway for the paywall, Agent Wallets for the demo agents, Circle CLI for provisioning, Agent Marketplace for distribution. Circle's own MCP server should be installed so SDK documentation is current.

---

## Repo layout

```
touchstone-assay/
  packages/
    basket/          SIU-2026a task definitions + seeded instance generators + graders
    harness/         run orchestration, provider adapters, usage capture
    prices/          scrapers, model registry, immutable price snapshots
    print/           index computation, canonicalisation, signing
    sdk/             touchstone-quote types, quote builder/validator, receipt verifier
    mcp-server/      four tools + x402 paywall
    contracts/       Solidity: TouchstoneAttestation, TouchstoneEscrow
    agents/          demo buyer + seller agents
  data/
    registry/        models.json, price snapshots
    runs/            raw run records
    prints/          signed prints — the product
  docs/
    build1-spec.md   the engineering specification
    scope.md         scope and non-goals
    methodology.md   the published methodology, versioned
    datum-quote.md   the extension spec (filename kept from the pre-rename name; prose updated)
    settlement-metadata.md
  site/              static index page
```

---

## Working agreement

Plan before implementing anything that touches more than two files; show the plan and wait. Tests are mandatory for graders, print computation, and contracts — optional elsewhere. No new runtime dependencies without saying why. If a task appears to require scope beyond the current build, stop and ask rather than implementing it. Never invent numbers in documentation or UI copy; if an example value is needed, label it illustrative.

Reference documents: `docs/build1-spec.md` is the authority for build 1. This file is the authority for vocabulary, invariants and build boundaries.

# Listing on the Circle Agent Marketplace

_build1-spec.md §11's first paragraph: "Register as a seller: the four MCP tools as paid
endpoints, USDC settlement, listed in the marketplace where Claude, Codex, Cursor and OpenClaw
agents discover services." This is separate from `docs/demo.md`'s demo agents — this document is
about listing the real, already-implemented `@datum/mcp-server` itself._

---

## What's already built, and what's still needed

**Already implemented in this repo** — nothing here is aspirational:

- Four MCP tools (`get_index`, `get_quote`, `convert`, `verify_receipt`) — `packages/mcp-server`,
  build1-spec.md §9.
- Circle's Gateway nanopayments middleware wired in front of the three paid tools —
  `packages/mcp-server/src/paywall.ts`'s `createToolPaywall`, using
  `@circle-fin/x402-batching`'s `createGatewayMiddleware`. Pricing is
  `TOOL_PRICES = { get_quote: "$0.001", convert: "$0.001", verify_receipt: "$0.01" }`;
  `get_index` is free by omission.
- The dispatcher (`createDispatcher`) correctly routes payment checks per-tool despite every MCP
  tool call sharing one `POST /mcp` route — verified in `paywall.test.ts`.
- `loadSellerAddressFromEnv` (`packages/mcp-server/src/env.ts`) — the wallet address Gateway pays
  out to, read from `DATUM_SELLER_ADDRESS`.

**Not yet available in this environment, and required before a real listing can go live:**

- A real `DATUM_SELLER_ADDRESS` funded/configured with Circle Gateway (a Circle Agent Wallet, or
  any EOA registered with Gateway as a payout destination).
- Circle API credentials for whichever facilitator/network configuration the listing targets
  (`.env` in this environment has none — same gap `docs/demo.md` documents for the demo agents).
- A public, always-on deployment of `packages/mcp-server` — the four tools currently only run
  locally (`pnpm --filter @datum/mcp-server run start`) or in this demo's own short-lived local
  instance; a marketplace listing needs a stable public URL.

## Steps to list as a seller

1. **Deploy `@datum/mcp-server` publicly.** `pnpm --filter @datum/mcp-server run start` (reads
   `DATUM_PUBLISHER_KEY`, `DATUM_SELLER_ADDRESS`, and — once P14 step 2's wiring is in place —
   resolves `DatumEscrow`'s address from `data/deployments/<chain>.json` via
   `loadSettlementReaderFromEnv`) behind a public host with TLS. `server.json` under
   `packages/mcp-server/src/manifest/` already describes the four tools for discovery — confirm
   its contents match the deployed endpoint before publishing anywhere.
2. **Provision Gateway for the seller address**, following Circle's own seller quickstart —
   [Quickstart: Accept Payments with Nanopayments](https://developers.circle.com/gateway/nanopayments/quickstarts/seller)
   — which walks through adding Gateway's Express middleware to accept gasless USDC payments via
   x402. This repo's `createToolPaywall` is already that integration; the quickstart is what to
   follow for provisioning the Circle-side account/credentials it needs.
3. **Confirm the 402 flow works against the real facilitator**, not `skipPaywall: true` — request
   each paid tool unpaid (expect `402`), then with a valid signed payment (expect `200` and a
   `PAYMENT-RESPONSE` header). `packages/mcp-server/src/integration/testnet.live.test.ts` already
   contains this exact check, gated on real `CIRCLE_TESTNET_PRIVATE_KEY` /
   `DATUM_SELLER_ADDRESS` / `DATUM_PUBLISHER_KEY` credentials — run it for real once they exist,
   rather than trusting the local `skipPaywall` path as a stand-in for this step.
4. **List on the MCP registries build1-spec.md §9 names** — the official MCP registry, Smithery,
   Glama, PulseMCP, mcp.so — each with its own submission flow (typically: a public manifest URL
   or GitHub repo, a short description, and the server's live endpoint). Circle's Agent
   Marketplace listing is the same shape: a public endpoint plus a manifest describing priced,
   x402-payable tools, submitted through whichever intake Circle's for-Agents program is running
   at listing time. **Verify the current submission mechanics directly against Circle's developer
   docs when this step is actually executed** — no specific self-serve submission flow for the
   Agent Marketplace was found in Circle's documentation as searched during this session, so this
   document does not invent one.

## Draft listing copy

_Illustrative — for use once a real public endpoint and Gateway-provisioned seller address exist._

> **Datum — Dated SIU price index**
> The benchmark price of AI inference work, published as a signed, versioned print. Four tools:
> `get_index` (free) returns the signed print; `get_quote` and `convert` ($0.001 each) price a
> task or a token count in SIU and USD against the current print; `verify_receipt` ($0.01) reads
> an on-chain `DatumEscrow` settlement and returns a signed attestation of what was quoted versus
> what was actually paid. Settles in USDC via Circle Gateway nanopayments. Method: verified, not
> surveyed — the index is measured by actually buying inference, not by surveying list prices.

Positioning line, reused verbatim from `CLAUDE.md`: _"Silicon Data prices the machine-hour; Dated
SIU prices the completed task."_

## What not to claim in the listing

Per `CLAUDE.md`'s hard invariants: never "backed by," "peg," "invest," "real-time," or "oracle."
The print is signed and hash-anchored — that's integrity of publication, not oracle computation.
Nothing here is for sale; Datum publishes a measurement, not an instrument.

# Listing on the Circle Agent Marketplace

_build1-spec.md §11's first paragraph: "Register as a seller: the four MCP tools as paid
endpoints, USDC settlement, listed in the marketplace where Claude, Codex, Cursor and OpenClaw
agents discover services." This is separate from `docs/demo.md`'s demo agents — this document is
about listing the real, already-implemented `@touchstone/mcp-server` itself._

---

## What's already built, live, and verified

**Deployed and verified live, 2026-08-31** — nothing here is aspirational:

- Four MCP tools (`get_index`, `get_quote`, `convert`, `verify_receipt`) — `packages/mcp-server`,
  build1-spec.md §9 — live at `https://mcp.touchstoneassay.com/mcp` (Cloudflare Workers,
  `src/workers/`, Hono + `McpAgent` + Circle's Gateway nanopayments middleware).
- Circle's Gateway nanopayments middleware wired in front of the three paid tools —
  `packages/mcp-server/src/paywall.ts`'s `createToolPaywall`, using
  `@circle-fin/x402-batching`'s `createGatewayMiddleware`. Pricing is
  `TOOL_PRICES = { get_quote: "$0.001", convert: "$0.001", verify_receipt: "$0.01" }`;
  `get_index` is free by omission.
- **A real x402 settlement, verified from outside this environment, on live Base Sepolia** — not
  a mock, not `skipPaywall: true`: `get_quote` ($0.001) and `verify_receipt` ($0.01), each paid
  for real through Circle's testnet Gateway by a funded buyer wallet
  (`0x22e2...d743`), against the live deployment. Circle transfer ids
  `81c4cb52-dfb0-4de2-a545-ac63404ea170` (`get_quote`) and
  `fd31f299-424e-4818-b79d-59a591b6b314` (`verify_receipt`) — the buyer's Gateway balance
  actually decreased by exactly $0.011 across both, confirmed via Circle's balances API before
  and after. `verify_receipt` correctly read a real, independent `TouchstoneEscrow` settlement
  (tx `0xdc9c4b6a1ea25d5661cb7a2f7d8b628bc92f6f1b0602ca5d1e7f1bd56a38779b`, from the demo agents'
  own 2026-08-18 run) and returned `matched: true`, signed with `TOUCHSTONE_ATTESTATION_KEY` —
  never the publisher key.
- `get_index` (free, unauthenticated): ~200-650ms. Paid calls, including the real Gateway
  round-trip: `get_quote` ~640ms, `verify_receipt` ~860ms.
- Usage logging (`src/workers/analytics.ts`, Cloudflare Analytics Engine) confirmed receiving
  real data from the calls above: call counts per tool, payer address for the paid three, no
  request bodies, no PII.
- The dispatcher (`createDispatcher`) correctly routes payment checks per-tool despite every MCP
  tool call sharing one `POST /mcp` route — verified in `paywall.test.ts`, and live above.
- `loadSellerAddressFromEnv` (`packages/mcp-server/src/env.ts`) — the wallet address Gateway pays
  out to, read from `TOUCHSTONE_SELLER_ADDRESS`, already configured (`wrangler.jsonc`).
- **Security boundary, confirmed from the live deployment's own secret list**: the only secret
  set on this Worker is `TOUCHSTONE_ATTESTATION_KEY` — no publisher key, anywhere. Every data read
  is unauthenticated GET against `raw.githubusercontent.com` (the run-record manifest,
  `data/runs/<print_id>/index.json`, replaced an earlier version that called GitHub's rate-limited
  Contents API — see `src/workers/env.ts`'s doc comment); nothing on this service can write to
  `data/`, trigger a print, or move funds.

**Still needed before a listing submission (§ Steps below):**

- Git-connected auto-deploy (Cloudflare Workers Builds) — every deploy so far has been a manual
  `wrangler deploy`; connecting the GitHub repo through the Cloudflare dashboard so pushes to
  `main` redeploy automatically needs a one-time authorization click-through only a human can do.
- The actual registry/directory submissions themselves (§ below) — each is a manual step under an
  account this environment doesn't have access to.

## Steps to list as a seller

1. ~~Deploy `@touchstone/mcp-server` publicly.~~ **Done** — `mcp.touchstoneassay.com`, live.
2. ~~Provision Gateway for the seller address.~~ **Done** — `TOUCHSTONE_SELLER_ADDRESS` is
   configured and has received two real settlements (above).
3. ~~Confirm the 402 flow works against the real facilitator.~~ **Done, verified live** —
   `get_quote` and `verify_receipt` both real-paid, above; `packages/mcp-server/src/integration/testnet.live.test.ts`
   still exists as a repeatable local check gated on the same credentials.
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

Real and ready to paste — the endpoint, seller address, and settlements above are live, not
illustrative. **Every version leads with `get_index` being free** — a server where every tool is
paywalled gets skipped.

> **Touchstone Assay — Dated SIU price index**
> The benchmark price of AI inference work, published as a signed, versioned print.
> **`get_index` is free** and returns the signed print. Three tools are paid via x402/Circle
> Gateway nanopayments in USDC: `get_quote` and `convert` ($0.001 each) price a task or a token
> count in SIU and USD against the current print; `verify_receipt` ($0.01) reads an on-chain
> `TouchstoneEscrow` settlement and returns a signed attestation of what was quoted versus what
> was actually paid. Method: verified, not surveyed — the index is measured by actually buying
> inference, not by surveying list prices.

One-line variant (character-limited fields):

> Dated SIU: the benchmark price of AI inference. `get_index` free; `get_quote`/`convert`/`verify_receipt` paid via x402 (Circle Gateway, USDC).

Positioning line, reused verbatim from `CLAUDE.md`: _"Silicon Data prices the machine-hour; Dated
SIU prices the completed task."_

Fields every listing needs, gathered in one place:

| Field | Value |
| --- | --- |
| Endpoint | `https://mcp.touchstoneassay.com/mcp` (Streamable HTTP) |
| Manifest | `packages/mcp-server/src/manifest/server.json` in the repo below |
| Repo | `https://github.com/petrkrulis2022/dated-siu-inference` |
| Registry name | `io.github.petrkrulis2022/touchstone-mcp` |
| Pricing | `get_index` free · `get_quote` $0.001 · `convert` $0.001 · `verify_receipt` $0.01 (USDC via x402/Circle Gateway) |
| Network | Base Sepolia (`eip155:84532`) — testnet, disclose as such |

## What not to claim in the listing

Per `CLAUDE.md`'s hard invariants: never "backed by," "peg," "invest," "real-time," or "oracle."
The print is signed and hash-anchored — that's integrity of publication, not oracle computation.
Nothing here is for sale; Touchstone Assay publishes a measurement, not an instrument. Settlement
is on Base **Sepolia** (testnet) — never imply mainnet or real-value settlement in any listing
until it actually is.

## Listing checklist — what needs manual submission, and where

Every submission below needs a human on an account this environment can't access. None have a
confirmed public API for headless submission (checked live, not assumed) — each is a dashboard
form or a PR against the registry's own repo.

- [ ] **Official MCP registry** (`registry.modelcontextprotocol.io`) — self-serve CLI, see below.
      No manual dashboard step, but `mcp-publisher login github` needs your browser to approve as
      `petrkrulis2022` (the manifest's namespace owner).
- [ ] **Smithery** (smithery.ai) — connects a GitHub repo through their dashboard. Point it at
      this repo; the manifest under `packages/mcp-server/src/manifest/` should be discoverable
      automatically once connected, but confirm against their current onboarding flow.
- [ ] **Glama** (glama.ai/mcp/servers) — submission is a GitHub-repo connect, similar shape to
      Smithery. Use the same repo URL and description above.
- [ ] **PulseMCP** (pulsemcp.com) — has historically taken submissions via a form linking the repo
      and a short description; confirm the current form at submission time.
- [ ] **mcp.so** — directory submission, typically repo URL + description + category. Category:
      pricing/finance/data.
- [ ] **Circle Agent Marketplace** (seller) — no confirmed self-serve API found in Circle's docs as
      of this session (same finding as before deployment); check
      [developers.circle.com](https://developers.circle.com) directly for the current Agent
      Marketplace seller intake before submitting, since this is exactly the kind of thing that
      moves between when this is written and when it's read.
- [ ] **x402 ecosystem directories, incl. x402scan** (x402scan.com and similar) — some x402
      directories index on-chain settlement activity automatically rather than taking manual
      submissions; x402scan's own submission mechanics weren't confirmed live this session (its
      page content didn't resolve a clear submit flow) — check directly before assuming either way.

### Official MCP registry — exact steps

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
mcp-publisher login github   # opens a browser — approve as petrkrulis2022
cd packages/mcp-server && mcp-publisher publish
```

`server.json` is already schema-valid and points at the real live URL (`https://mcp.touchstoneassay.com/mcp`)
— nothing to edit first.

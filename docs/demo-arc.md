# Demo agents on Arc Testnet

_The same protocol `docs/demo.md` documents on Base Sepolia, ported to Arc Testnet (chain id
5042002) and deployed as real Cloudflare Workers rather than local processes —
`packages/agents/src/workers/seller.ts` (deployed twice, `wrangler.seller-a.jsonc`/
`wrangler.seller-b.jsonc`) and `workers/buyer.ts` (`wrangler.buyer.jsonc`). Everything in
`docs/demo.md`'s "This is a testbed, not traction" section applies here identically — these are
our own agents, on our own testnet wallets._

---

## Why Arc, and why now

ETHOnline 2026's submission deadline is **Sunday, September 13, 2026, 12:00pm EDT** — three days
*before* Arc's public mainnet launch on **September 16, 2026**. No live Arc mainnet deployment can
ever be part of the judged submission, no matter how fast this work goes. What follows is
honestly **testnet-complete, with a mainnet-ready deploy script prepared**
(`packages/contracts/script/DeployArcMainnet.s.sol`, for `TouchstoneAttestation` only — see
`data/deployments/arc-testnet.json`'s `mainnetRequirements` for why `TouchstoneEscrow` stays on
testnet regardless of the date) — never presented as more than that.

## What's different from the Base Sepolia demo, architecturally

- **Deployed Workers, not local processes.** `cli/demo.ts` spins up two Express seller processes
  and a local `mcp-server` instance, all torn down at the end of one script run. The Arc version
  is three persistent, independently-deployed Cloudflare Workers, invoked over real HTTPS —
  `POST https://touchstone-arc-buyer.perklur.workers.dev/run` triggers one full loop, the same
  way `cli/arc-worker-loop.ts` does.
- **A real, isolated, unpaid MCP Worker for `verify_receipt`**, not a local `skipPaywall: true`
  instance — `packages/mcp-server/src/workers/arc-testbed-index.ts`, deployed at
  `arc-testbed-mcp.touchstoneassay.com`. It reuses the exact same `TouchstoneMcpAgent` Durable
  Object the real, paid `mcp.touchstoneassay.com` runs, just without the Circle Gateway paywall
  dispatch — no code or state is shared with the real service.
- **Verify_receipt's chain allow-list was genuinely widened.**
  `packages/mcp-server/src/tools/verify-receipt.ts`'s `SUPPORTED_VERIFY_RECEIPT_CHAINS` now
  includes `"arc-testnet"` — this only widens which chain *names* are syntactically accepted; the
  actual on-chain read is still governed entirely by whichever single `chainName` the calling
  deployment's own `SettlementReader` was built with, so this doesn't let the real, single-chain
  production service verify anything on Arc.

## Real platform issues this surfaced (worth knowing before repeating this)

1. **Cloudflare blocks a Worker's own `fetch()` to another Worker's bare `*.workers.dev` URL** —
   anti-loop/abuse protection on that shared zone. Confirmed live: the buyer Worker's call to a
   seller's `workers.dev` URL came back with a synthetic 404 in ~3ms, far too fast to have reached
   real code. Fixed by giving each callee Worker a real custom domain instead
   (`arc-seller-a.touchstoneassay.com`, `arc-seller-b.touchstoneassay.com`,
   `arc-testbed-mcp.touchstoneassay.com`) — a Worker calling another Worker's *custom domain* has
   no such restriction. (Service Bindings are Cloudflare's other documented fix, but would have
   required threading a service-binding-vs-fetch-URL branch through `buyer.ts`'s shared logic;
   custom domains needed no code change at all.)
2. **Arc's real gas price is far above Base Sepolia's.** `wallets.ts`'s
   `SELLER_GAS_FUNDING_WEI` default (tuned for Base Sepolia's ~0.01 gwei) genuinely reverted a
   real `settle()` call here with `gas required exceeds allowance` — Arc's observed
   `maxFeePerGas` was 29 gwei, and its native gas token is USDC itself (18-decimal protocol
   representation, distinct from the 6-decimal ERC-20 contract), not ETH. `generateAndFundSeller`
   now takes an optional funding-amount override for exactly this; both deployed sellers were
   funded with 0.02 native units, and `arc.live.test.ts` does the same for its own ephemeral test
   seller.
3. **The primary `rpc.testnet.arc.io` endpoint rate-limited** under this session's own repeated
   deploy/read/write traffic (`Request exceeds defined limit ... rate limit exceeded`). Every
   deployed Worker and the live test suite now point at `https://rpc.drpc.testnet.arc.io`, one of
   Arc's own documented alternate mirrors (`docs.arc.io/arc/references/connect-to-arc`) — same
   chain, no API key needed.

None of these are protocol-level findings — they're real Cloudflare/Arc platform mechanics that
would trip up anyone deploying agents as Workers against a new chain for the first time.

## A real transcript

Captured from a real, unattended run (`pnpm --filter @touchstone/agents run arc-worker-loop`,
`ARC_BUYER_WORKER_URL=https://touchstone-arc-buyer.perklur.workers.dev`) against the deployed
Workers, live Arc Testnet, real Circle-Gateway-free `verify_receipt`:

```
==============================================================================
Touchstone Assay Arc Testnet worker loop — TESTBED. Real calls, no mocks.
==============================================================================
invoking deployed buyer Worker: POST https://touchstone-arc-buyer.perklur.workers.dev/run
  [buyer] requesting a quote from seller-a (https://arc-seller-a.touchstoneassay.com)...
  [buyer] seller-a quoted siu=0.024311 (cap 0.048311)
  [buyer] requesting a quote from seller-b (https://arc-seller-b.touchstoneassay.com)...
  [buyer] seller-b quoted siu=0.033246 (cap 0.065246)
  [buyer] cheaper in SIU: seller-a (siu=0.024311)
  [buyer] funding escrow for quoteHash 0x6170c54e7e76cd3080c79c4efe21da03479ec11f8f732a5faa31c95fe725495f (maxAmount 2400)...
  [buyer] escrow funded — tx 0xb7aab42a639e840927d466c1586eec3952af55e932445e9defc73e3f546cda09
  [buyer] requesting fulfillment from seller-a with the funded quote...
  [buyer] received result (settled $0.00054342, tx 0x0a6a8d07002642875e42a87761f997ce8eafffdd2005e7d3681c4e5dcba7e3da): "# **Commodity Benchmark Price Indices: A Deep Dive Using Dated Brent as an Example** ## **Introduction** Commodity benchmark price indices are foundational to "
  [buyer] calling verify_receipt via the real MCP server...
  [buyer] receipt: matched=true amount_paid_usd=$0.000544 amount_quoted_usd=$0.002400 print_ref=demo-no-real-print-published-yet

==============================================================================
SUMMARY — real, unattended, live Arc Testnet: OK in 44825ms (wall clock 45061ms).
```

Every hash above is a real Arc Testnet transaction, independently checkable on
[Arcscan](https://testnet.arcscan.app) against `data/deployments/arc-testnet.json`'s
`TouchstoneEscrow` address. `data/deployments/arc-testnet.json`'s own `smokeTests` records this
run alongside a separate, independent live escrow-lifecycle test suite
(`packages/agents/src/arc.live.test.ts`) and a real print-hash anchor on `TouchstoneAttestation`.

## Running it yourself

```bash
pnpm --filter @touchstone/agents run arc-worker-loop
```

Needs `ARC_BUYER_WORKER_URL` (the deployed buyer Worker's own URL) in the environment. The three
Workers themselves are deployed with `pnpm --filter @touchstone/agents run deploy:seller-a`
(`:seller-b`, and `wrangler deploy -c wrangler.arc-testbed.jsonc` from `packages/mcp-server` for
the MCP Worker) — see each `wrangler.*.jsonc`'s own comments for the secrets each one needs.

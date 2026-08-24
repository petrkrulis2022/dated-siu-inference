# Demo agents

_`packages/agents` — build1-spec.md §11's "demo agents": a seller agent quoting a trivial paid
inference service in SIU via `touchstone-quote`, and a buyer agent that compares two sellers, funds
`TouchstoneEscrow`, and calls `verify_receipt`. Run it with `pnpm --filter @touchstone/agents run demo`._

---

## This is a testbed, not traction

**These are our own agents, on our own testnet wallets.** The run below demonstrates that the
protocol — quote, compare, escrow, settle, verify — works end to end. It does not demonstrate
market demand, and it must never be presented as such. No external party requested this work; no
money outside this repo's own testnet wallets moved. This framing is repeated in `cli/demo.ts`,
`seller.ts`, and here, deliberately, so it can't be quoted out of context.

## What's real, and what's illustrative

Everything below is a genuine on-chain and off-chain action on Base Sepolia — nothing is mocked,
canned, or replayed. Two things are honestly labeled as illustrative rather than faked, because
the alternative was fabricating numbers CLAUDE.md's first hard invariant forbids:

1. **No real print exists in this environment yet.** `data/prints/` is empty — the harness has
   never been run for real against paid provider APIs (see `docs/keys_needed_datum.md`). A real
   `usd_per_siu` exchange rate therefore doesn't exist to quote against. Both sellers use the
   same clearly-labeled illustrative `rate_usd_per_siu` (`pricing.ts`'s
   `DEMO_ILLUSTRATIVE_USD_PER_SIU`, `"0.0500"`), and the quote's
   `index_version`/`print_id`/`print_hash` are placeholder values
   (`SIU-2026a-illustrative-demo` / `demo-no-real-print-published-yet` / a zero hash) — never
   presented as, or confused with, a real published print. Everything priced _with_ that rate is
   real: a genuine OpenRouter call to one of two `llama-3.3-70b-instruct` registry entries —
   `llama-3.3-70b-novita` and `llama-3.3-70b-cloudflare` — the identical model weights served by
   two different hosts at very different real prices ($0.40 vs $2.253 per 1M output tokens, a
   real ~5.6x spread), which is exactly the provider-spread column `docs/methodology.md`
   publishes. The SIU gap the buyer compares comes only from that real per-host price
   difference, since the rate is shared. Real token usage and real dollar cost both come from
   `@touchstone/print`'s own `callCost` against the real, already-fetched price snapshot in
   `data/registry/`.
2. **No Circle Agent Wallet or Gateway credentials exist in this environment.** Two consequences,
   both already anticipated in this project's planning:
   - The buyer runs on a plain testnet wallet (`DEPLOYER_PRIVATE_KEY`) rather than a Circle Agent
     Wallet, with the spending policy enforced in agent code instead of at the wallet level —
     `buyer.ts` calls `@touchstone/sdk`'s `checkSpendingMandate` against every quote before accepting
     it. **The wallet-level policy is the intended production path**; this is a stopgap.
   - `verify_receipt` is normally a paid x402 call through Circle's Gateway (like `get_quote` and
     `convert` already are in the real, deployed MCP server). This demo runs its own instance of
     the real, unmodified `buildApp(...)` from `@touchstone/mcp-server` with its existing
     `skipPaywall: true` test escape hatch, so the tool call itself — signature, on-chain
     verification, receipt — is real; only the payment gate in front of it is bypassed, for the
     same reason the buyer's wallet is a stopgap: no Circle credentials in this environment.

## The loop, step by step

1. **Setup.** The buyer (an already-funded testnet wallet, reused from this session's earlier
   on-chain work) generates and funds two fresh seller wallets with a little ETH for gas. Two
   seller HTTP servers start, each running `createSellerApp` against a different real registry
   model — same underlying weights, different real host price — and the same `rate_usd_per_siu`,
   so "compare two sellers" reflects a genuine real cost difference, not a hand-picked markup. A
   local instance of the real `@touchstone/mcp-server` also starts.
2. **Two real quotes.** The buyer `POST`s an empty request to each seller's `/infer`. Each seller
   issues a fresh signed `touchstone-quote` (pattern `"cap"`: a point estimate `siu` plus a `siu_max`
   ceiling sized from a real per-token price times a bounded `max_tokens` budget the seller commits
   to enforcing) and responds `402 Payment Required`, the quote riding in `extensions.touchstone_quote`
   alongside a minimal x402-v2-shaped `accepts` array.
3. **Spending-mandate check, then compare.** Each quote passes through `checkSpendingMandate`
   (the in-code stand-in for a Circle Agent Wallet policy). The buyer then picks the cheaper quote
   **in SIU** — "payment amounts are dollar-fixed; SIU is the comparison unit"
   (`docs/datum-quote.md`) — which is exactly what differs between the two sellers here.
4. **Fund escrow.** The buyer calls `TouchstoneEscrow.openAndFund` for the chosen quote's `quoteHash`,
   naming the chosen seller and `settler = address(0)` (the seller-only path this demo exercises,
   per P13's design — the delegated-settler path is unit-tested but not run here).
5. **Fulfillment.** The buyer re-`POST`s to the chosen seller with the funded quote attached.
   The seller independently reads `escrows(quoteHash)` on-chain to confirm it's genuinely `Open`
   and funded on the exact terms it quoted — never trusting the buyer's say-so — then performs the
   real OpenRouter call, computes the real `actualAmount` from real usage (capped at the quoted
   ceiling), and calls `TouchstoneEscrow.settle` with its own key.
6. **Verify.** The buyer calls the real `verify_receipt` tool, as a genuine MCP tool call over
   `StreamableHTTPClientTransport` against the local server — not an in-process function call,
   since that would require the buyer to hold `TOUCHSTONE_ATTESTATION_KEY`, which would break the entire
   point of the tool (Touchstone Assay attests; the buyer doesn't self-attest). The reader recomputes the
   quote's hash and checks it against the on-chain `Settled` event before trusting anything else,
   exactly as it does for a real caller.

## A real transcript

Captured from a real run (`pnpm --filter @touchstone/agents run demo`) against Base Sepolia,
after the settlement floor and repricing below:

```
==============================================================================
Touchstone Assay demo agents — TESTBED, not traction. These are our own agents on our
own testnet wallets; this run demonstrates the protocol, not market demand.
==============================================================================
2026-08-18T11:36:17.977Z [setup] buyer wallet: 0xD7CA8219C8AfA07b455Ab7e004FC5381B3727B1e
2026-08-18T11:36:19.661Z [setup] seller-a wallet funded: 0x5a26f55FA55D17C8E7B9277Bd41AD1Ba1C04ceA3
2026-08-18T11:36:20.642Z [setup] seller-b wallet funded: 0xd31d342fcD1297738553B876e926Bd2c869a38f9
2026-08-18T11:36:20.652Z [setup] seller-a listening on :44343, seller-b on :38819
2026-08-18T11:36:20.658Z [setup] local mcp-server (paywall bypassed) listening on :40317
2026-08-18T11:36:20.658Z [buyer] requesting a quote from seller-a (http://127.0.0.1:44343)...
2026-08-18T11:36:20.728Z [seller-a] issuing quote: siu=0.032467 (cap 0.064467), amount_usd_max=$0.0032
2026-08-18T11:36:20.736Z [buyer] seller-a quoted siu=0.032467 (cap 0.064467)
2026-08-18T11:36:20.736Z [buyer] requesting a quote from seller-b (http://127.0.0.1:38819)...
2026-08-18T11:36:20.743Z [seller-b] issuing quote: siu=0.181254 (cap 0.361494), amount_usd_max=$0.0181
2026-08-18T11:36:20.746Z [buyer] seller-b quoted siu=0.181254 (cap 0.361494)
2026-08-18T11:36:20.746Z [buyer] cheaper in SIU: seller-a (siu=0.032467)
2026-08-18T11:36:20.746Z [buyer] funding escrow for quoteHash 0xd7b4cf92014ee8a5900b198a43ccecf57792d9eca96740664c89191bb51cce7e (maxAmount 3200)...
2026-08-18T11:36:23.347Z [buyer] escrow funded — tx 0x6483b03207ef8267509a06de14bc154de33407470c008e00b57d41d52f56e40d
2026-08-18T11:36:23.347Z [buyer] requesting fulfillment from seller-a with the funded quote...
2026-08-18T11:36:25.114Z [seller-a] escrow confirmed funded — performing the real inference call...
2026-08-18T11:39:46.313Z [seller-a] settled: actual=$0.003217955 (of $0.0032 max) — tx 0xdc9c4b6a1ea25d5661cb7a2f7d8b628bc92f6f1b0602ca5d1e7f1bd56a38779b
2026-08-18T11:39:46.318Z [buyer] received result (settled $0.003217955, tx 0xdc9c4b6a1ea25d5661cb7a2f7d8b628bc92f6f1b0602ca5d1e7f1bd56a38779b): "**Introduction to Commodity Benchmark Price Indices** Commodity benchmark price indices, such as Dated Brent, play a crucial role in the global commodity marke"
2026-08-18T11:39:46.319Z [buyer] calling verify_receipt via the real MCP server...
2026-08-18T11:39:46.704Z [buyer] receipt: matched=true amount_paid_usd=$0.003200 amount_quoted_usd=$0.003200 print_ref=demo-no-real-print-published-yet
2026-08-18T11:39:46.704Z [demo] complete.
```

The real per-token usage pushed `actualUsd` (the uncapped log value, `$0.003217955`) very
slightly past the quote's rounded `amount_usd_max` ceiling — `settle()`'s on-chain `actualAmount`
is capped at `maxAmount` before it's ever sent, which is exactly why `amount_paid_usd` and
`amount_quoted_usd` both read `$0.003200` in the receipt: the safety cap engaged and the buyer
was never charged past what they approved.

Every hash above is a real Base Sepolia transaction, independently checkable on
[Blockscout](https://base-sepolia.blockscout.com) against
`data/deployments/base-sepolia.json`'s `TouchstoneEscrow` address.

## Lessons this demo surfaced

**RPC lag, escrow status.** An early run's fulfillment step failed with a false `escrow for ...
is not open and funded as quoted` rejection — the escrow _had_ genuinely been funded (re-querying
moments later showed the correct state), but the seller's immediate, unretried read landed on a
load-balanced RPC node that hadn't caught up yet. `escrow-client.ts`'s `readEscrowUntilMatch`
fixes this, the same way `readPostedAtWithRetry` already did for print anchoring — both now go
through the shared `retryUntilConclusive` (`@touchstone/sdk`). Confirmed live, not assumed — see
`live.test.ts`, which runs a real fund + settle + read cycle against Base Sepolia rather than a
mock.

**RPC lag, nonces.** The same failure mode shows up in transaction _sending_, not just reading:
two sequential seller-funding transfers from the same buyer account hit `replacement transaction
underpriced`, because the second `sendTransaction`'s automatic nonce lookup reached a node that
hadn't yet indexed the first transfer, even though this function's own `waitForTransactionReceipt`
had already confirmed it mined against a different node. `wallets.ts`'s `generateAndFundSeller`
now retries the send itself on that specific error, not just the read that follows it.

**Shared-tier upstream congestion.** OpenRouter's free-tier requests are served from a shared
provider pool per host, and that pool intermittently 429s under load — confirmed by hitting it on
more than one registry model's pinned host in the same session, with the identical request
succeeding seconds later against the same host with no other change. This is a different failure
mode than RPC lag (it's real congestion, not staleness — waiting doesn't reliably help, and
neither does switching to a "safer" model, since congestion moves around). `seller.ts`'s real
inference call now retries through `withBackoff` (`@touchstone/harness`), the same exponential
backoff the harness's batch orchestrator already used for real print runs. `createAdapterFor`
also gained an `allowUnpinnedRouting` escape hatch for a demo that would rather auto-route around
a congested host than fail — off by default, and it must never reach the real measurement path
(see its doc comment): this demo keeps it off, since host pinning is what makes its
provider-spread comparison true in the first place.

## Running it yourself

```bash
pnpm --filter @touchstone/agents run demo
```

Needs `BASE_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (a funded Base Sepolia wallet — this account
also funds the two fresh seller wallets each run), `TOUCHSTONE_ATTESTATION_KEY` (dedicated to
`verify_receipt` — never `TOUCHSTONE_PUBLISHER_KEY`, which signs prints and anchors on-chain), and
`OPENROUTER_API_KEY` in `.env`. Nothing is written back to `.env`; the two seller keys are
generated fresh per run.

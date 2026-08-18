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
   `usd_per_siu` exchange rate therefore doesn't exist to quote against. Each seller uses a
   clearly-labeled illustrative `rate_usd_per_siu` instead (`pricing.ts`'s
   `DEMO_ILLUSTRATIVE_USD_PER_SIU`, `"0.0500"` for seller-a and a markup, `"0.0650"`, for
   seller-b), and the quote's `index_version`/`print_id`/`print_hash` are placeholder values
   (`SIU-2026a-illustrative-demo` / `demo-no-real-print-published-yet` / a zero hash) — never
   presented as, or confused with, a real published print. Everything priced _with_ that rate is
   real: a genuine OpenRouter call to `deepseek-v3.2` (already in `data/registry/models.json`),
   its real token usage, and its real dollar cost from `@touchstone/print`'s own `callCost` against the
   real, already-fetched price snapshot in `data/registry/`.
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
   seller HTTP servers start, each running `createSellerApp` with the same real registry model and
   real price data but a different `rate_usd_per_siu` — so "compare two sellers" is a genuine
   comparison, not a coincidence. A local instance of the real `@touchstone/mcp-server` also starts.
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
   since that would require the buyer to hold `TOUCHSTONE_PUBLISHER_KEY`, which would break the entire
   point of the tool (Touchstone Assay attests; the buyer doesn't self-attest). The reader recomputes the
   quote's hash and checks it against the on-chain `Settled` event before trusting anything else,
   exactly as it does for a real caller.

## A real transcript

Captured from a real run (`pnpm --filter @touchstone/agents run demo`) against Base Sepolia:

```
==============================================================================
Touchstone Assay demo agents — TESTBED, not traction. These are our own agents on our
own testnet wallets; this run demonstrates the protocol, not market demand.
==============================================================================
2026-08-16T14:42:21.837Z [setup] buyer wallet: 0xD7CA8219C8AfA07b455Ab7e004FC5381B3727B1e
2026-08-16T14:42:23.169Z [setup] seller-a wallet funded: 0x6ce6623f2A78F6Ee7b445E1bD8172EC86bD4832A
2026-08-16T14:42:24.315Z [setup] seller-b wallet funded: 0x773cA03Ab5feE44e8b9753fEB4B15ce3C64fcCa9
2026-08-16T14:42:24.330Z [setup] seller-a listening on :37235, seller-b on :44923
2026-08-16T14:42:24.343Z [setup] local mcp-server (paywall bypassed) listening on :45315
2026-08-16T14:42:24.343Z [buyer] requesting a quote from seller-a (http://127.0.0.1:37235)...
2026-08-16T14:42:24.447Z [seller-a] issuing quote: siu=0.007673 (cap 0.015273), amount_usd_max=$0.0008
2026-08-16T14:42:24.460Z [buyer] seller-a quoted siu=0.007673 (cap 0.015273)
2026-08-16T14:42:24.460Z [buyer] requesting a quote from seller-b (http://127.0.0.1:44923)...
2026-08-16T14:42:24.469Z [seller-b] issuing quote: siu=0.005902 (cap 0.011748), amount_usd_max=$0.0008
2026-08-16T14:42:24.471Z [buyer] seller-b quoted siu=0.005902 (cap 0.011748)
2026-08-16T14:42:24.471Z [buyer] cheaper in SIU: seller-b (siu=0.005902)
2026-08-16T14:42:24.473Z [buyer] funding escrow for quoteHash 0x05f4b1bac9908db6ed020d0d0991b1767abffa7589224616f424bef0d16d6f8a (maxAmount 800)...
2026-08-16T14:42:26.223Z [buyer] escrow funded — tx 0xe2a9774214361445f81c55c6a6a36ceeeb523bcfc187ee66120d495e80b099f9
2026-08-16T14:42:26.223Z [buyer] requesting fulfillment from seller-b with the funded quote...
2026-08-16T14:42:28.017Z [seller-b] escrow confirmed funded — performing the real inference call...
2026-08-16T14:42:32.142Z [seller-b] settled: actual=$0.0000148 (of $0.0008 max) — tx 0xdb392dea02207820ff89db63ba673800cf02018c3308ab7ac28f0a51984fdd56
2026-08-16T14:42:32.143Z [buyer] received result (settled $0.0000148, tx 0xdb392dea02207820ff89db63ba673800cf02018c3308ab7ac28f0a51984fdd56): "A benchmark price index is a standard measure used to track and compare the overall price changes of a specific market or asset class over time."
2026-08-16T14:42:32.143Z [buyer] calling verify_receipt via the real MCP server...
2026-08-16T14:42:32.451Z [buyer] receipt: matched=true amount_paid_usd=$0.000015 amount_quoted_usd=$0.000800 print_ref=demo-no-real-print-published-yet
2026-08-16T14:42:32.451Z [demo] complete.
```

Every hash above is a real Base Sepolia transaction, independently checkable on
[Blockscout](https://base-sepolia.blockscout.com) against
`data/deployments/base-sepolia.json`'s `TouchstoneEscrow` address.

## A lesson this demo surfaced

The first real run of the fulfillment step failed with a false `escrow for ... is not open and
funded as quoted` rejection — the escrow _had_ genuinely been funded (re-querying moments later
showed the correct state), but the seller's immediate, unretried read landed on a load-balanced
RPC node that hadn't caught up yet. This is the exact class of bug this project's earlier
`readPostedAtWithRetry` (`packages/print/src/anchor/attestation.ts`) already existed to prevent
for print anchoring; `escrow-client.ts`'s `readEscrowUntilMatch` applies the identical fix here.
Confirmed live, not assumed — see its header comment and `live.test.ts`, which runs a real fund +
settle + read cycle against Base Sepolia rather than a mock.

## Running it yourself

```bash
pnpm --filter @touchstone/agents run demo
```

Needs `BASE_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (a funded Base Sepolia wallet — this account
also funds the two fresh seller wallets each run), `TOUCHSTONE_PUBLISHER_KEY`, and `OPENROUTER_API_KEY`
in `.env`. Nothing is written back to `.env`; the two seller keys are generated fresh per run.

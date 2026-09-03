# Operator console

_`packages/console` — a localhost analytics board for operating Touchstone Assay: reading every print,
watching agent buy/sell activity in SIU, and following the USDC that moved. Not the public index
page in `site/`, which stays a separate, plainer artefact for outside readers._

---

## Hard constraints — read this before anything else

- **Read-only.** This package never imports a write-capable function from any `@touchstone/*`
  package — no `signPrintBody`, `signQuote`, `writePrint`, `publishPrint`, no
  `openAndFund`/`settle`/`expire`, no private-key loader. It only ever constructs a viem _public_
  client, never a wallet client. There is no code path that could sign anything or send a
  transaction, because nothing capable of doing so is ever imported — this is enforced by absence,
  not a runtime check that could be bypassed.
- **`127.0.0.1` only — for the API this package ships.** Both the API (`server/index.ts`) and the
  Vite dev server (`web/vite.config.ts`) bind `127.0.0.1` explicitly, never `0.0.0.0`. Not
  reachable from another machine. No auth on the local process, because nothing is exposed to
  authenticate against. No telemetry. A static build of the web bundle is separately deployed at
  `console.touchstoneassay.com`, gated by Cloudflare Access — but that deployed frontend's own
  `/api` calls have no backend to answer them there, since this package's API is a Node/Express
  process with no remote deployment; every panel except Chat analytics is consequently only fully
  functional against a local `pnpm console`. Chat analytics is the one exception to the `/api`
  pattern (see `web/src/lib/chat-digest.ts`): it fetches cross-origin, directly from
  `chat-server`'s own read-only `GET /digest` — a real Worker with its own deployment and its own
  CORS allowlist — so that one panel works on the deployed console as well as locally.
- **`.env` is read, never written, and no key material is ever read.** The console reads
  `BASE_SEPOLIA_RPC_URL`/`TOUCHSTONE_CHAIN_NAME`/`TOUCHSTONE_PUBLISHER_ADDRESS` and displays addresses as-is.
  `TOUCHSTONE_PUBLISHER_KEY` and `DEPLOYER_PRIVATE_KEY` are never touched by any file in this package.
- **No invented data.** A print's absent `floor`/`market_spread` renders as `—`, never `0` or a
  placeholder — the same rule `computePrint` already enforces when it writes a print; the console
  just doesn't override that absence.
- **Reuse, not reimplementation.** Every panel's data comes from an existing exported function in
  `@touchstone/sdk`/`@touchstone/print` — `loadPrint`, `verifyPrint`, `recoverSignerCandidates`,
  `readAttestationPublisher`, `readAttestationPostedAt`, `loadRunRecords`, `loadPriceSnapshot`,
  `loadDeployment`. New code here is limited to the HTTP layer, the on-chain event indexer (the
  first historical `getLogs` scan anywhere in this repo — every existing on-chain reader only did
  point reads), and pure aggregation over what those functions already produced.

## Running it

```bash
# once, or after a long gap — full backfill of the event cache
pnpm console:index

# starts the read-only API and the Vite dev server together, proxying /api -> the API
pnpm console
```

Needs `.env` sourced first (`BASE_SEPOLIA_RPC_URL`, `TOUCHSTONE_CHAIN_NAME`, `TOUCHSTONE_PUBLISHER_ADDRESS` —
same convention every other script in this repo uses; no `dotenv` dependency). The server also
does a quick incremental catch-up on every startup, so `pnpm console:index` is only needed for a
guaranteed-fresh rebuild (after a cache-format change, or suspected corruption), not routine use.

The event cache lives at `data/.cache/console/events.json` — derived, gitignored, regenerable
from nothing by `pnpm console:index`. `packages/agents`' sellers additionally log every quote
they issue to `data/.cache/quotes/<quoteHash>.json` (same gitignored convention) purely so this
console can join a settlement back to what was actually quoted — see Panel 5 below for why that
matters.

## Panels

**1. Series.** Dated SIU over time, provisional and final shown distinctly. A falling line is
normal and expected — one SIU always buys the same work, so a falling line means inference got
cheaper, not that the measurement drifted.

**2. Prints.** Every print: date, status, Dated SIU, weighting method, methodology version, anchor
transaction, and a _live_ signature-verification result — computed on every request by calling
`verifyPrint` plus the same on-chain closed loop `verify-onchain.ts` already runs
(`recoverSignerCandidates` → compare against `TouchstoneAttestation.publisher()` → confirm the body
hash is anchored), never a stored flag. Click through for the full exchange-rate table, floor and
market spread where present (with the open-weight-substitution caveat surfaced), the sensitivity
block, cost of production, and a pointer to the raw runs.

**3. Models.** Per-model exchange rate and spread-to-index over time, plus gate pass/fail history
— where you'd spot a model that quietly started failing a class or drifted in cost.

**4. Agent activity.** Every escrow lifecycle reconstructed from `TouchstoneEscrow`'s own
`Opened`/`Settled`/`Expired` events: quoteHash, buyer, seller, settler, maxAmount, actualAmount,
fee, refund, status, block timestamps. Fee is computed off-chain from the settled `actualAmount`
and the contract's own immutable `feeBps` — there's no fee event. Where a local quote is known
(see below), it's joined in to show the SIU amount, model, and print referenced. Aggregates: total
USDC settled, total SIU transacted, counts and volumes by seller and by buyer.

**5. Quoted vs paid.** For every settlement with a known quote, the quote's committed/ceiling
amount against what was actually settled, flagged as matched or mismatched using the exact
formula `docs/settlement-metadata.md`/`verify_receipt` already define
(`amount_paid_usd ≤ amount_quoted_usd`) — computed with plain arithmetic
(`@touchstone/sdk`'s `minorUnitsToUsd`/`D`), **not** by calling `verifyReceiptTool` itself, which needs
`TOUCHSTONE_PUBLISHER_KEY` to sign a receipt and this read-only package must never hold or use a
signing key. This is the honest-seller check, and the thing `verify_receipt` exists to prove, made
visible across all activity at a glance — build a dishonest seller into the testbed later, and
this is the panel where it should light up. If it doesn't, the console is wrong.

**6. Health.** Models that failed a gate in the latest print; prices flagged subsidised; whether
the price snapshot referenced is older than the latest print; prints written but not anchored;
prints still provisional past the reconciliation window (no window is stated anywhere in
`docs/methodology.md` — one weekly cadence cycle is the default, overridable); and the publisher
address's ETH balance, so anchoring never silently fails for want of gas.

## Why local quotes need a separate log

`TouchstoneEscrow`'s `Settled` event carries only `quoteHash` — the full quote (SIU amount, model,
which print it referenced) never appears on chain, only its hash. Confirmed by direct search: no
file anywhere in this repo persisted a `touchstone-quote` after building it until this console's build
added `packages/agents/src/quote-log.ts`, which `seller.ts` now calls on every issued quote. This
is a console-convenience side effect a write-capable package (`agents`) performs for the console's
benefit — it changes nothing about `verify_receipt`'s own deliberately stateless design.
A settlement with no matching file in `data/.cache/quotes/` — every settlement predating this
change, or any settled through a path that doesn't log quotes — correctly shows "quote unknown"
rather than a fabricated join.

## Every transaction/address links out to Blockscout

The explorer base URL is served from `/api/config` (ultimately
`data/deployments/<chain>.json`'s `network.explorer`) and read by `ExplorerLink` — never
hardcoded in a component. Authoritative data always comes from the RPC via viem; the explorer is
link-out only, so the console never depends on a third-party explorer API being up.

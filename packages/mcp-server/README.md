# @touchstone/mcp-server

The four-tool MCP server — build1-spec.md §9. `get_index` is free; `get_quote`, `convert`, and
`verify_receipt` are paywalled through Circle's Gateway nanopayments (`@circle-fin/x402-batching`),
settled in USDC.

| Tool                                          | Returns                                       | Price  |
| --------------------------------------------- | --------------------------------------------- | ------ |
| `get_index(version?, date?)`                  | signed print                                  | free   |
| `get_quote(task_class, model)`                | SIU price, exchange rate, index refs          | $0.001 |
| `convert(model, input_tokens, output_tokens)` | SIU + USD equivalent                          | $0.001 |
| `verify_receipt(chain, tx_hash)`              | signed attestation: quoted vs paid vs matched | $0.01  |

Transport is Streamable HTTP (`POST /mcp`), not stdio — x402 is an HTTP-status-code protocol, so
a paywalled tool needs an HTTP layer to hang a `402` off. `verify_receipt`'s on-chain read is live
(`src/settlement/on-chain.ts`), reading the real deployed `TouchstoneEscrow`
(`data/deployments/base-sepolia.json`) — `StubSettlementReader` (`src/settlement/reader.ts`)
remains for tests and for running the server with no chain configured, the same pattern
`@touchstone/print`'s `StubAttestationClient` uses.

## Running it locally (Node/Express)

```bash
export TOUCHSTONE_ATTESTATION_KEY=0x...  # signs receipts — a dedicated key, never
                                          # TOUCHSTONE_PUBLISHER_KEY, which signs prints and
                                          # anchors on-chain and has no business on this
                                          # public-facing service
export TOUCHSTONE_SELLER_ADDRESS=0x...   # receives USDC payments through Gateway
pnpm run start                       # builds, then listens on $PORT (default 3000)
```

Both env vars are required and there is no default — the server refuses to start rather than
run unconfigured. `data/prints/` needs at least one published print (`pnpm --filter @touchstone/print
run publish-print`) before `get_index`/`get_quote`/`convert` have anything real to serve.

## Deployed: Cloudflare Workers (`mcp.touchstoneassay.com`)

The live, public deployment is `src/workers/` — a different transport (Hono + Cloudflare's
`McpAgent`, Durable-Object-backed) and a different data-loading layer (KV-cached fetches against
this repo's own public GitHub content, since Workers has no filesystem), but the exact same four
tools and the exact same paywall logic (`../paywall.ts`, run through a minimal req/res shim —
`src/workers/node-shim.ts` — rather than reimplemented). See that directory's files for the
per-piece reasoning; `wrangler.jsonc` is the binding/route source of truth.

**Security boundary:** `TOUCHSTONE_PUBLISHER_KEY` is never present on this Worker — not as a
secret, not as a var, not transitively. The only key is `TOUCHSTONE_ATTESTATION_KEY`, which signs
receipts and nothing else (no anchoring, no transactions, no funds). Every other binding is
non-sensitive: a chain name, a public contract address, a public RPC URL, and
`TOUCHSTONE_SELLER_ADDRESS` (the Touchstone revenue wallet — a payment-receiving address; no
private key for it exists on this Worker at all). The two optional secrets below are the only other
keys it can hold: `KITE_SETTLER_PRIVATE_KEY` pays gas to settle Kite payments and can never receive
or redirect revenue (a payment moves funds buyer → payTo in one transaction), and
`CIRCLE_LIVE_API_KEY` is Circle's Console key, sent only to Circle's own Gateway.

**Setup, once:**

```bash
npx wrangler login
npx wrangler kv namespace create PRINTS_CACHE   # then paste the id into wrangler.jsonc
npx wrangler secret put TOUCHSTONE_ATTESTATION_KEY
```

Enable Analytics Engine once for the account (dashboard-only, no API/CLI path):
`https://dash.cloudflare.com/<account-id>/workers/analytics-engine` — usage logging
(`src/workers/analytics.ts`) degrades to a caught, logged no-op if this isn't done, so it never
blocks the rest of the service, but the point of it (adoption evidence — call counts, distinct
payer addresses) needs it enabled.

**Deploy:**

```bash
pnpm run deploy   # wrangler deploy
```

Re-run `npx wrangler types` after changing any binding in `wrangler.jsonc` — `worker-configuration.d.ts`
(committed) is generated from it and is what makes `Env` resolve for `agents`' `McpAgent<Env, ...>`
generic constraint; a stale copy silently breaks `this.env` inside `TouchstoneMcpAgent`. (It also
lists `TOUCHSTONE_ATTESTATION_KEY` because wrangler reads secret names from a local `.dev.vars`; to
regenerate it faithfully, put a placeholder `TOUCHSTONE_ATTESTATION_KEY=x` in `.dev.vars` first and
delete the file afterwards — it is gitignored.)

### Networks the paid tools accept — the flag, and going live

Which networks a payment can be made on is a **profile**, chosen on every request from a flag, so
switching never needs a deploy (`src/networks.ts`):

| Profile        | Accepts                                                             | Settled by                                 |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `mainnet`      | Base `eip155:8453`, Arc `eip155:5042`                               | Circle Gateway (live)                      |
|                | Kite `eip155:2366`, paid in USDC.e                                  | this Worker itself (`src/self-settled.ts`) |
| `testnet`      | Base Sepolia `84532`, Arc Testnet `5042002`                         | Circle Gateway (testnet)                   |
|                | Kite Testnet `2368`, paid in test PYUSD                             | this Worker itself                         |
| `base-sepolia` | Base Sepolia only — exactly the behaviour before the mainnet switch | Circle Gateway (testnet)                   |

Every profile pays `TOUCHSTONE_SELLER_ADDRESS`. The profile is the KV key `config:network-profile`
in the `PRINTS_CACHE` namespace, falling back to the `TOUCHSTONE_NETWORK_PROFILE` var in
`wrangler.jsonc` (committed as `testnet`), falling back to `testnet` for anything unreadable or
misspelled — the only way to reach `mainnet` is for the flag to say exactly `mainnet`. Each 402
carries an `x-touchstone-network-profile` header naming the profile that produced it.

```bash
# go live on mainnet — and the rollback to the old behaviour is the same command with another value
npx wrangler kv key put config:network-profile mainnet      --binding PRINTS_CACHE   # or testnet | base-sepolia
npx wrangler kv key delete config:network-profile           --binding PRINTS_CACHE   # back to the wrangler.jsonc default
```

**Secrets for the Kite networks** (a profile that has none simply does not offer Kite — a 402 never
advertises a network this Worker cannot settle; the Worker logs which one it left out):

```bash
npx wrangler secret put KITE_SETTLER_PRIVATE_KEY   # a key YOU generate, funded with a little KITE for gas
npx wrangler secret put CIRCLE_LIVE_API_KEY        # optional: Circle's mainnet Gateway answered without it on 2026-10-25
```

Kite settlement is a transaction per payment, so each payment costs its gas in KITE (about 71,000 gas
observed on Kite Testnet; about 0.0125 KITE at mainnet's 175 gwei, of which 150 gwei is a default wallet
tip over a flat 25 gwei base fee). Kite therefore asks at least **$0.005** a call (`minimumPriceUsd` in
`src/self-settled.ts`, with the working): `get_quote` and `convert` cost $0.005 there against $0.001 on
Base and Arc, `verify_receipt` keeps its $0.01. Budget about 1 KITE of settler gas per 80 payments, and
revisit the floor from the settlement log once real payments exist.

**The settlement log** (optional; payments work without it): create the database once, add the
binding to `wrangler.jsonc`, and create the table with the schema exported from
`src/workers/settlement-log.ts`:

```bash
npx wrangler d1 create touchstone-settlements
# add to wrangler.jsonc:  "d1_databases": [{ "binding": "SETTLEMENTS", "database_name": "touchstone-settlements", "database_id": "<id>" }]
npx wrangler d1 execute touchstone-settlements --remote --command "$(node -e 'import("./dist/workers/settlement-log.js").then(m=>process.stdout.write(m.SETTLEMENTS_SCHEMA))')"
```

**What is never charged for** (the paywall settles before the tool runs, so everything a call can be
refused for beforehand is checked beforehand and passed through unpaid): arguments that fail the
tool's schema or its own first checks (`src/tools/schemas.ts`), a model the print excludes
(`get_quote`, `convert`), a paid call with no MCP session (the agent can only refuse it), and
`verify_receipt` on `mainnet`, which answers that it is not available there yet. Still charged: a
`verify_receipt` whose quote does not match the settlement it names — that needs a chain read.

**A reply as JSON:** a client that sends `Accept: application/json, text/event-stream` gets a single
tool reply as plain JSON rather than a one-event stream (`src/workers/json-response.ts`), because
paying clients such as Circle's `GatewayClient.pay()` read the paid response with `response.json()`.

### REST routes (`/v1/*`)

The same four tools as plain HTTP routes, for the x402 marketplaces that list a paid route by its
URL and read its OpenAPI schema (Circle's Agent Marketplace, PayAPI Market, Agentic.market). Served
by the same Worker (`src/workers/rest.ts`); `/mcp` is unchanged.

| Route                                                                  | Tool                        | Price  |
| ---------------------------------------------------------------------- | --------------------------- | ------ |
| `GET /v1/index?date=&version=`                                         | `get_index`                 | free   |
| `GET` or `POST /v1/quote` (`task_class`, `model`)                      | `get_quote`                 | $0.001 |
| `GET` or `POST /v1/convert` (`model`, `input_tokens`, `output_tokens`) | `convert`                   | $0.001 |
| `POST /v1/verify-receipt` (`chain`, `tx_hash`, `quote`)                | `verify_receipt`            | $0.01  |
| `GET /openapi.json`                                                    | the OpenAPI 3.1 description | free   |

Same paywall as MCP (same prices, networks, Kite floor, settlement log), and no MCP session is
needed. Differences worth knowing:

- **An unpaid paid route always answers 402**, even with no arguments, because a marketplace's
  checker calls it exactly that way. Arguments are checked once a `PAYMENT-SIGNATURE` is attached,
  and before the paywall settles it: invalid arguments are a `400` and a model the print excludes a
  `422`, both with `"charged": false`. `verify-receipt` reads the chain after payment, as on MCP, so
  a settlement it cannot find is a `422` with `"charged": true`.
- **A tool the profile holds back** (`verify-receipt` on `mainnet`) answers `501`, uncharged, offers
  no payment, and is left out of the OpenAPI document.
- **`/openapi.json` is built per profile**: it names only the networks and routes that profile can
  deliver, so a spec fetched while the service is on testnet never mentions mainnet. It is hand-written
  from the tools' own input shapes (`src/workers/openapi.ts`) and `openapi.test.ts` fails if they drift.
  Cached for 60 seconds so a profile switch shows quickly.
- The usage and settlement logs do not record which door a call used.

## Listing this server

### Official MCP registry (registry.modelcontextprotocol.io)

`src/manifest/server.json` is a schema-valid manifest (verified against
`static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json`) with `remotes: [{ type:
"streamable-http", url }]` — **the URL in it is a placeholder** (`https://mcp.touchstone-assay.example/mcp`,
the RFC 2606-reserved `.example` domain) and must be replaced with the real deployment URL before
publishing.

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

The manifest's `name` (`io.github.petrkrulis2022/touchstone-mcp`) is namespaced under GitHub-OAuth
ownership — `mcp-publisher login github` must authenticate as an account matching that namespace,
or publishing is rejected.

### Smithery, Glama, PulseMCP, mcp.so

Each has its own submission flow (typically: connect the GitHub repo through their dashboard, or
a registry-specific manifest file), and none were verified against live documentation while
building this package — consult each registry's current docs directly before submitting rather
than trusting a summary here that could be stale by the time you read it.

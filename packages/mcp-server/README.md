# @datum/mcp-server

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
a paywalled tool needs an HTTP layer to hang a `402` off. `verify_receipt`'s on-chain read is
currently stubbed (`src/settlement/reader.ts`) — `DatumEscrow` doesn't exist until the contracts
milestone, and this stub says so rather than fabricating a settlement.

## Running it

```bash
export DATUM_PUBLISHER_KEY=0x...   # signs receipts — same key print publication uses
export DATUM_SELLER_ADDRESS=0x...  # receives USDC payments through Gateway
pnpm run start                      # builds, then listens on $PORT (default 3000)
```

Both env vars are required and there is no default — the server refuses to start rather than
run unconfigured. `data/prints/` needs at least one published print (`pnpm --filter @datum/print
run publish-print`) before `get_index`/`get_quote`/`convert` have anything real to serve.

## Listing this server

### Official MCP registry (registry.modelcontextprotocol.io)

`src/manifest/server.json` is a schema-valid manifest (verified against
`static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json`) with `remotes: [{ type:
"streamable-http", url }]` — **the URL in it is a placeholder** (`https://mcp.datum.example/mcp`,
the RFC 2606-reserved `.example` domain) and must be replaced with the real deployment URL before
publishing.

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

The manifest's `name` (`io.github.petrkrulis2022/datum-mcp`) is namespaced under GitHub-OAuth
ownership — `mcp-publisher login github` must authenticate as an account matching that namespace,
or publishing is rejected.

### Smithery, Glama, PulseMCP, mcp.so

Each has its own submission flow (typically: connect the GitHub repo through their dashboard, or
a registry-specific manifest file), and none were verified against live documentation while
building this package — consult each registry's current docs directly before submitting rather
than trusting a summary here that could be stale by the time you read it.

# Architecture

_One diagram of the whole system: how a print gets made and anchored, how an agent pays for
inference through the MCP server, and how the same buyer/seller loop now runs on Arc Testnet as
deployed Cloudflare Workers. Written for the ETHOnline 2026 submission's required architecture
diagram, and kept here as living repo documentation, not a one-off submission asset._

```mermaid
flowchart TB
    subgraph pub["Publication (data/, git-tracked, no database)"]
        harness["packages/harness<br/>runs real inference against<br/>provider APIs, captures usage"]
        prices["packages/prices<br/>scrapers, model registry,<br/>immutable price snapshots"]
        print["packages/print<br/>computes + signs the print<br/>(SIU-2026a basket)"]
        prints[("data/prints/*.json<br/>signed, dated prints")]
        harness --> print
        prices --> print
        print --> prints
    end

    subgraph chain["On-chain (Base Sepolia + Arc Testnet, byte-identical contracts)"]
        attest["TouchstoneAttestation<br/>anchors a print's body hash<br/>holds no funds"]
        escrow["TouchstoneEscrow<br/>non-custodial: buyer funds,<br/>seller settles, fee to treasury"]
    end
    print -- "postPrint(bodyHash)" --> attest

    subgraph site["site/ (static, public)"]
        indexpage["prints.touchstoneassay.com<br/>the published index"]
    end
    prints --> indexpage

    subgraph mcp["packages/mcp-server (Cloudflare Worker)"]
        gateway["Circle Gateway paywall<br/>x402 402-challenge + settle"]
        tools["get_index (free)<br/>get_quote / convert (paid)<br/>verify_receipt (paid)"]
        gateway --> tools
    end
    prints --> tools
    tools -- "reads settlements" --> escrow
    tools -- "reads anchors" --> attest

    subgraph chat["packages/chat-server (Cloudflare Worker)"]
        widget["Chat widget<br/>Claude Haiku 4.5"]
        digest["Weekly digest<br/>D1 analysis layer"]
        widget --> digest
    end
    widget -- "calls get_index" --> tools
    indexpage -.embeds.-> widget

    subgraph agents["packages/agents — the buyer/seller loop"]
        direction LR
        seller["Seller<br/>quotes in SIU, returns 402,<br/>runs inference, settles"]
        buyer["Buyer<br/>compares quotes by SIU,<br/>funds escrow, verifies receipt"]
        buyer -- "1. POST /infer (empty)" --> seller
        seller -- "2. 402 + touchstone-quote" --> buyer
        buyer -- "3. openAndFund(quoteHash)" --> escrow
        buyer -- "4. POST /infer (funded quote)" --> seller
        seller -- "5. reads escrow, infers, settle()" --> escrow
        buyer -- "6. verify_receipt(chain, tx_hash)" --> tools
    end

    subgraph arcworkers["Arc Testnet deployment — same loop, as real Workers"]
        direction LR
        sellerA["touchstone-arc-seller-a<br/>(Worker)"]
        sellerB["touchstone-arc-seller-b<br/>(Worker)"]
        buyerW["touchstone-arc-buyer<br/>(Worker, POST /run)"]
        mcpTestbed["arc-testbed-mcp<br/>(Worker, unpaid,<br/>isolated from mcp-server)"]
        buyerW --> sellerA
        buyerW --> sellerB
        buyerW --> mcpTestbed
    end
    sellerA -- "settle()" --> escrow
    sellerB -- "settle()" --> escrow
    mcpTestbed -- "reads settlements" --> escrow

    subgraph console["packages/console (Access-gated, internal)"]
        ops["Ops dashboard:<br/>prints, activity, health,<br/>chat analytics"]
    end
    escrow -.indexed by.-> ops
    digest -.fetched by.-> ops
```

## Reading the diagram

- **Publication** (top-left) is entirely off-chain and file-based: a print is computed from real,
  executed inference runs and real price data, then signed and written to `data/prints/`. Nothing
  here ever touches a wallet.
- **Anchoring** is the only place publication meets the chain: a print's body hash is posted to
  `TouchstoneAttestation`, which holds no funds and exists purely so a print's signer can be
  proven against an on-chain, immutable `publisher()` address.
- **The paid rail** (`mcp-server`) is the one component that takes money: Circle's Gateway issues
  a real x402 402-challenge, a real agent pays, and only then does the request reach the actual
  tool. `get_index` is free by design — citation is the business model.
- **The buyer/seller loop** is the same protocol running in two shapes: locally as Node processes
  (`packages/agents`'s CLI demo, Base Sepolia) and as real, persistent Cloudflare Workers (Arc
  Testnet) — same `seller.ts`/`buyer.ts` logic underneath both.
- **Two chains, one set of contracts.** `TouchstoneEscrow`/`TouchstoneAttestation` are deployed
  byte-identical on Base Sepolia and Arc Testnet (`data/deployments/*.json`) — no chain-specific
  code exists in either contract, only in each chain's own deploy script.

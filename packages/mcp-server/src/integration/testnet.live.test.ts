import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { buildApp } from "../server.js";

/**
 * A real test against Circle's Base Sepolia testnet facilitator — not a simulation. Requires a
 * funded testnet wallet: `CIRCLE_TESTNET_PRIVATE_KEY` (a Base Sepolia private key holding
 * Gateway-deposited testnet USDC — see docs/build1-spec.md §9 and
 * https://developers.circle.com/gateway/nanopayments/quickstarts/buyer) and
 * `TOUCHSTONE_SELLER_ADDRESS`/`TOUCHSTONE_PUBLISHER_KEY` for the server side.
 *
 * This sandbox's `.env` holds neither — the same already-flagged gap as the harness never
 * having run against a real paid provider API (P7/P9). This suite is real, runnable code that
 * stays skipped until real testnet credentials exist, not a simulation dressed up as one.
 */
const canRun = Boolean(
  process.env.CIRCLE_TESTNET_PRIVATE_KEY &&
  process.env.TOUCHSTONE_SELLER_ADDRESS &&
  process.env.TOUCHSTONE_PUBLISHER_KEY,
);

describe.skipIf(!canRun)("mcp-server paywall against Circle's Base Sepolia testnet", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = buildApp({
      publisherPrivateKeyHex: process.env.TOUCHSTONE_PUBLISHER_KEY!,
      paywall: {
        sellerAddress: process.env.TOUCHSTONE_SELLER_ADDRESS!,
        networks: ["eip155:84532"], // Base Sepolia
        facilitatorUrl: "https://gateway-api-testnet.circle.com",
      },
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("server did not report a listening address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("get_quote requires payment: a real buyer pays $0.001 in testnet USDC and gets a real result", async () => {
    const buyer = new GatewayClient({
      chain: "baseSepolia",
      privateKey: process.env.CIRCLE_TESTNET_PRIVATE_KEY as `0x${string}`,
    });

    const { status } = await buyer.pay(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_quote", arguments: { task_class: "T1", model: "registry-id" } },
      },
    });

    expect(status).toBe(200);
  });
});

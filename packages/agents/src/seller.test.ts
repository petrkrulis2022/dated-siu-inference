import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createSellerApp, type SellerDeps } from "./seller.js";
import type { ChainClients } from "./wallets.js";
import type { EscrowRead } from "./escrow-client.js";

const TEST_KEY = `0x${"44".repeat(32)}`;
const account = privateKeyToAccount(TEST_KEY);

function clients(): ChainClients {
  // Only `.account` is ever read by seller.ts's HTTP layer in these tests — publicClient/
  // walletClient are exercised for real in live.test.ts, not here.
  return { account, publicClient: {} as never, walletClient: {} as never };
}

const OPEN_ESCROW: EscrowRead = {
  buyer: "0x0000000000000000000000000000000000000009",
  expiry: 9_999_999_999n,
  status: 1,
  seller: account.address,
  settler: "0x0000000000000000000000000000000000000000",
  maxAmount: 999_999_999n,
};

function fakeDeps(overrides: Partial<SellerDeps> = {}): SellerDeps {
  return {
    readEscrowUntilMatch: async () => OPEN_ESCROW,
    settle: async () => "0xsettletxhash" as `0x${string}`,
    adapter: async () => ({
      text: "a trivial reply",
      usage: { input: 20, output: 10, cached_input: 0, reasoning: 0 },
      latency_ms: 5,
      raw: {},
      deviations: [],
    }),
    ...overrides,
  };
}

function options() {
  return {
    label: "test-seller",
    clients: clients(),
    privateKeyHex: TEST_KEY,
    registryEntry: {
      id: "demo-model",
      provider: "openrouter" as const,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model_string: "demo/model",
      tier: "open-weight-hosted" as const,
      open_weights: true,
      host: "demo-host",
    },
    prices: { price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" },
    rateUsdPerSiu: "0.05",
    openrouterApiKey: "unused-in-tests",
    escrowAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    chainName: "base-sepolia",
    prompt: "a trivial fixed demo prompt",
    maxOutputTokens: 2000,
    quoteTtlSeconds: 3600,
    log: () => {},
  };
}

describe("createSellerApp", () => {
  let server: Server;
  let baseUrl: string;

  async function startServer(deps: SellerDeps): Promise<void> {
    const app = createSellerApp(options(), deps);
    server = createServer(app);
    await new Promise<void>((resolvePromise) => server.listen(0, resolvePromise));
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("server did not report a listening address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  afterAll(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  describe("unpaid request", () => {
    beforeAll(() => startServer(fakeDeps()));

    it("responds 402 with a signed datum-quote in extensions.datum_quote", async () => {
      const res = await fetch(`${baseUrl}/infer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { extensions: { datum_quote: Record<string, unknown> } };
      const quote = body.extensions.datum_quote;
      expect(quote.pattern).toBe("cap");
      expect(quote.sig).toBeTypeOf("string");
      expect(quote.seller_id).toBe(`erc8004:${account.address}`);
    });
  });

  describe("funded request, escrow genuinely open and matching", () => {
    beforeAll(() => startServer(fakeDeps()));

    it("performs the (fake) inference call and returns a settle_tx_hash", async () => {
      const quoteRes = await fetch(`${baseUrl}/infer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const { extensions } = (await quoteRes.json()) as { extensions: { datum_quote: unknown } };

      const fulfillRes = await fetch(`${baseUrl}/infer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote: extensions.datum_quote }),
      });
      expect(fulfillRes.status).toBe(200);
      const body = (await fulfillRes.json()) as { text: string; settle_tx_hash: string };
      expect(body.settle_tx_hash).toBe("0xsettletxhash");
      expect(body.text).toBe("a trivial reply");
    });
  });

  describe("funded request, escrow not actually open", () => {
    beforeAll(() =>
      startServer(fakeDeps({ readEscrowUntilMatch: async () => ({ ...OPEN_ESCROW, status: 0 }) })),
    );

    it("responds 402 rather than performing the real work unpaid", async () => {
      const quoteRes = await fetch(`${baseUrl}/infer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const { extensions } = (await quoteRes.json()) as { extensions: { datum_quote: unknown } };

      const fulfillRes = await fetch(`${baseUrl}/infer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote: extensions.datum_quote }),
      });
      expect(fulfillRes.status).toBe(402);
    });
  });
});

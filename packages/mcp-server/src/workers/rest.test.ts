import { afterEach, describe, expect, it, vi } from "vitest";
import type { PriceSnapshot, Print, RunRecord } from "@touchstone/sdk";
import { buildQuoteBody, signQuote } from "@touchstone/sdk";
import type { createToolPaywall } from "../paywall.js";
import type { NetworkProfile } from "../networks.js";
import type { PrintDataSource } from "../print-data-source.js";
import {
  StubSettlementReader,
  type OnChainSettlement,
  type SettlementReader,
} from "../settlement/reader.js";
import { createRestApp, type RestDeps } from "./rest.js";
import type { PaymentInfo } from "./record-call.js";

// ---- fixtures: the same shapes ../tools/get-quote.test.ts builds ----------------------------------

const print = {
  version: "SIU-2026a",
  print_id: "2026-08-14",
  date: "2026-08-14",
  status: "provisional",
  basket_costs: [{ model_id: "A", cost_usd: "0.001" }],
  weights: { source: "equal", values: [{ model_id: "A", weight: "1" }] },
  dated_siu: "0.0019",
  exchange_rate_table: [
    { model_id: "A", usd_per_siu: "0.10", spread_to_index: "0", siu_per_usd: "10" },
  ],
  sensitivity_block: [{ policy_variant: "none", dated_siu: "0.0019", delta: "0" }],
  rounding: {
    dated_siu_dp: 4,
    basket_cost_dp: 6,
    usd_per_siu_dp: 4,
    spread_dp: 4,
    siu_per_usd_dp: 1,
    mode: "ROUND_HALF_UP",
    siu_per_usd_mode: "ROUND_DOWN",
  },
  cost_of_production_usd: "0.06",
  price_snapshot_ref: "snap-1.json",
  methodology_version: "v0-draft",
  signature: `0x${"ab".repeat(64)}`,
  public_key: `0x${"cd".repeat(33)}`,
} as unknown as Print;

const snapshot: PriceSnapshot = {
  snapshot_id: "snap-1",
  timestamp: "2026-08-14T00:00:00Z",
  source: "openrouter",
  entries: [{ model_id: "A", price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" }],
};

const runRecord: RunRecord = {
  run_id: "r1",
  model_id: "A",
  task_class: "T1",
  instance_id: "i1",
  seed: 1,
  attempt: 1,
  usage: { input: 1000, output: 500, cached_input: 0, reasoning: 0 },
  latency_ms: 100,
  gate_passed: true,
  raw_response_ref: "raw/r1",
  deviations: [],
};

const dataSource: PrintDataSource = {
  loadLatestPrint: async () => ({ print, cached: false, fetchedAt: "2026-08-14T00:00:00Z" }),
  loadPrintByDate: async (date) => {
    if (date !== print.date) throw new Error("not found");
    return print;
  },
  listPrintIds: async () => [print.print_id],
  loadPriceSnapshot: async () => snapshot,
  loadRunRecords: async () => [runRecord],
};

const VALID_QUOTE = signQuote(
  buildQuoteBody({
    siu: "0.0676",
    pattern: "fixed",
    model: "A",
    rateUsdPerSiu: "1.0000",
    indexVersion: "SIU-2026a",
    printId: "2026-08-14",
    printHash: `0x${"cc".repeat(32)}`,
    sellerId: "erc8004:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    chain: "base-sepolia",
    expiresInSeconds: 3600,
  }),
  `0x${"33".repeat(32)}`,
);

// ---- a paywall that behaves like the real one: a 402 until a payment header is attached ------------

const PAYMENT: PaymentInfo = {
  payer: "0xPayer",
  amount: "1000",
  network: "eip155:84532",
  transaction: "0xTx",
};

function harness(
  profile: NetworkProfile = "testnet",
  reader: SettlementReader = new StubSettlementReader(),
) {
  const paywallCalls: { name: unknown; arguments: unknown; url: unknown }[] = [];
  const recorded: {
    tool: string;
    payment: PaymentInfo | undefined;
    selfSettled: readonly string[];
  }[] = [];

  interface FakeReq {
    url?: string;
    headers: Record<string, string>;
    body?: { params?: { name?: unknown; arguments?: unknown } };
    payment?: PaymentInfo;
  }
  interface FakeRes {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  }
  const paywall = ((req: FakeReq, res: FakeRes, next: () => void) => {
    paywallCalls.push({
      name: req.body?.params?.name,
      arguments: req.body?.params?.arguments,
      url: req.url,
    });
    if (req.headers["payment-signature"] === "good") {
      req.payment = PAYMENT;
      res.setHeader("PAYMENT-RESPONSE", "receipt-b64");
      next();
      return;
    }
    res.statusCode = 402;
    res.setHeader("PAYMENT-REQUIRED", "challenge-b64");
    // What ../siu-price-402.ts's wrapper leaves on the request after pricing a 402.
    (req as unknown as Record<string, boolean>).touchstoneSiuPriced = true;
    res.end("{}");
  }) as unknown as ReturnType<typeof createToolPaywall>;
  const challenges: { tool: string; profile: NetworkProfile; siuPriced: boolean }[] = [];
  // The ?via= listing each recorded call and each 402 carried (./channel.ts).
  const recordChannels: (string | undefined)[] = [];
  const challengeChannels: (string | undefined)[] = [];

  const deps: RestDeps<Record<string, never>> = {
    profileFor: async () => profile,
    paywallFor: () => paywall,
    toolDepsFor: () => ({
      dataSource,
      settlementReader: reader,
      attestationPrivateKeyHex: `0x${"11".repeat(32)}`,
    }),
    record: (_env, _ctx, tool, payment, selfSettled, channel) => {
      recorded.push({ tool, payment, selfSettled });
      recordChannels.push(channel);
    },
    recordChallenge: (_env, _ctx, tool, profileSeen, siuPriced, channel) => {
      challenges.push({ tool, profile: profileSeen, siuPriced });
      challengeChannels.push(channel);
    },
  };
  const app = createRestApp(deps);
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
  const call = (path: string, init: RequestInit = {}, origin = "https://mcp.example") =>
    app.request(`${origin}${path}`, init, {}, ctx as never);
  const paid = (extra: RequestInit = {}): RequestInit => ({
    ...extra,
    headers: { ...(extra.headers as Record<string, string>), "payment-signature": "good" },
  });
  const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { call, paid, post, paywallCalls, recorded, challenges, recordChannels, challengeChannels };
}

afterEach(() => vi.useRealTimers());

describe("GET /v1/index (free)", () => {
  it("returns the latest print without touching the paywall, and records the call unpaid", async () => {
    const h = harness();
    const res = await h.call("/v1/index");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Print & { _meta?: unknown };
    expect(body.print_id).toBe("2026-08-14");
    expect(body._meta).toBeDefined();
    expect(h.paywallCalls).toHaveLength(0);
    expect(h.recorded).toEqual([
      { tool: "get_index", payment: undefined, selfSettled: ["eip155:2368"] },
    ]);
  });

  it("answers a date that has no print with a 404 that says so", async () => {
    const res = await harness().call("/v1/index?date=1999-01-01");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: 'No print for date "1999-01-01".',
      charged: false,
    });
  });
});

describe("a paid route with no payment attached", () => {
  it("answers 402 with the challenge even when called with no arguments at all (a marketplace probe)", async () => {
    const h = harness();
    const res = await h.call("/v1/quote");
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBe("challenge-b64");
    expect(res.headers.get("x-touchstone-network-profile")).toBe("testnet");
    expect(h.recorded).toHaveLength(0);
  });

  it("logs each 402 it sends, with whether it carried an SIU price; a paid call logs none", async () => {
    const h = harness();
    await h.call("/v1/quote");
    expect(h.challenges).toEqual([{ tool: "get_quote", profile: "testnet", siuPriced: true }]);
    await h.call("/v1/quote?task_class=extract&model=claude-haiku-4-5", h.paid());
    expect(h.challenges).toHaveLength(1);
  });

  it("builds the tool call the paywall sees from the route, with the route's own URL", async () => {
    const h = harness();
    await h.call("/v1/quote?task_class=T1&model=A");
    expect(h.paywallCalls).toEqual([
      {
        name: "get_quote",
        arguments: { task_class: "T1", model: "A" },
        url: "/v1/quote?task_class=T1&model=A",
      },
    ]);
  });

  it.each([
    ["GET", "/v1/quote"],
    ["POST", "/v1/quote"],
    ["GET", "/v1/convert"],
    ["POST", "/v1/convert"],
    ["POST", "/v1/verify-receipt"],
  ])("%s %s is challenged, never refused, when unpaid and empty", async (method, path) => {
    const res = await harness().call(path, { method });
    expect(res.status).toBe(402);
  });

  it("does not accept a payment header the paywall rejects: still a 402, nothing served", async () => {
    const h = harness();
    const res = await h.call("/v1/quote?task_class=T1&model=A", {
      headers: { "payment-signature": "forged" },
    });
    expect(res.status).toBe(402);
    expect(h.recorded).toHaveLength(0);
  });
});

describe("get_quote and convert with a payment attached", () => {
  it("tags each 402 and each paid call with the listing named in ?via=, and calls an untagged one direct", async () => {
    const h = harness();
    await h.call("/v1/quote?via=circle");
    await h.call("/v1/quote?task_class=T1&model=A&via=circle", h.paid());
    await h.call("/v1/quote?task_class=T1&model=A", h.paid());
    expect(h.challengeChannels).toEqual(["circle"]);
    expect(h.recordChannels).toEqual(["circle", "direct"]);
  });

  it("serves the quote, with the receipt header, uncached, and records the settlement", async () => {
    const h = harness();
    const res = await h.call("/v1/quote?task_class=T1&model=A", h.paid());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      siu_per_call: "0.02",
      usd_per_call: "0.002",
      usd_per_siu: "0.10",
      index_version: "SIU-2026a",
      print_id: "2026-08-14",
    });
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe("receipt-b64");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(h.recorded).toEqual([
      { tool: "get_quote", payment: PAYMENT, selfSettled: ["eip155:2368"] },
    ]);
  });

  it("serves the identical quote over POST with a JSON body", async () => {
    const h = harness();
    const viaGet = await (await h.call("/v1/quote?task_class=T1&model=A", h.paid())).json();
    const viaPost = await (
      await h.call(
        "/v1/quote",
        h.post({ task_class: "T1", model: "A" }, { "payment-signature": "good" }),
      )
    ).json();
    expect(viaPost).toEqual(viaGet);
  });

  it("converts token counts parsed from the query string", async () => {
    const res = await harness().call("/v1/convert?model=A&input_tokens=1000&output_tokens=500", {
      headers: { "payment-signature": "good" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siu: "0.02", usd: "0.002" });
  });

  it.each([
    ["a missing task_class", "/v1/quote?model=A"],
    ["an unknown task class", "/v1/quote?task_class=T9&model=A"],
    ["a missing model", "/v1/quote?task_class=T1"],
    ["a fractional token count", "/v1/convert?model=A&input_tokens=1.5&output_tokens=1"],
    ["a negative token count", "/v1/convert?model=A&input_tokens=-1&output_tokens=1"],
    ["an exponent token count", "/v1/convert?model=A&input_tokens=1e3&output_tokens=1"],
    ["an empty token count", "/v1/convert?model=A&input_tokens=&output_tokens=1"],
    [
      "a token count beyond safe integers",
      "/v1/convert?model=A&input_tokens=99999999999999999999&output_tokens=1",
    ],
  ])("refuses %s with a 400, uncharged, before the paywall runs", async (_label, path) => {
    const h = harness();
    const res = await h.call(path, h.paid());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ charged: false });
    expect(h.paywallCalls).toHaveLength(0);
    expect(h.recorded).toHaveLength(0);
  });

  it("refuses a model the print does not carry with a 422, uncharged, before the paywall runs", async () => {
    const h = harness();
    for (const path of [
      "/v1/quote?task_class=T1&model=ghost",
      "/v1/convert?model=ghost&input_tokens=1&output_tokens=1",
    ]) {
      const res = await h.call(path, h.paid());
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ charged: false });
    }
    expect(h.paywallCalls).toHaveLength(0);
    expect(h.recorded).toHaveLength(0);
  });

  it("treats a body that is not a JSON object as missing arguments", async () => {
    const h = harness();
    for (const body of ["[]", "null", "not json", ""]) {
      const res = await h.call("/v1/quote", {
        method: "POST",
        headers: { "payment-signature": "good", "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    }
    expect(h.paywallCalls).toHaveLength(0);
  });
});

describe("verify-receipt", () => {
  it("refuses invalid arguments with a 400, uncharged, before the paywall runs", async () => {
    const h = harness();
    for (const body of [
      {},
      { chain: "base-sepolia", tx_hash: "0x1", quote: {} },
      { chain: "solana", tx_hash: "0x1", quote: VALID_QUOTE },
    ]) {
      const res = await h.call("/v1/verify-receipt", h.post(body, { "payment-signature": "good" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ charged: false });
    }
    expect(h.paywallCalls).toHaveLength(0);
  });

  it("returns the signed receipt with the settlement receipt header once payment clears", async () => {
    const settled: OnChainSettlement = {
      quoteHash: `0x${"a".repeat(64)}`,
      actualAmountMinorUnits: "67600",
      maxAmountMinorUnits: "67600",
      receiptRef: `0x${"b".repeat(64)}`,
      printRef: "2026-08-14",
    };
    const reader: SettlementReader = { read: async () => settled };
    const h = harness("testnet", reader);
    const res = await h.call(
      "/v1/verify-receipt",
      h.post(
        { chain: "base-sepolia", tx_hash: `0x${"ab".repeat(32)}`, quote: VALID_QUOTE },
        { "payment-signature": "good" },
      ),
    );
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      matched: true,
      quote_hash: settled.quoteHash,
      chain: "base-sepolia",
    });
    expect(typeof receipt.signature).toBe("string");
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe("receipt-b64");
    expect(h.recorded).toEqual([
      { tool: "verify_receipt", payment: PAYMENT, selfSettled: ["eip155:2368"] },
    ]);
  });

  it("runs after payment, so a settlement it cannot read is a 422 that says it WAS charged", async () => {
    const h = harness();
    const res = await h.call(
      "/v1/verify-receipt",
      h.post(
        { chain: "base-sepolia", tx_hash: `0x${"ab".repeat(32)}`, quote: VALID_QUOTE },
        { "payment-signature": "good" },
      ),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ charged: true });
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe("receipt-b64");
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]?.tool).toBe("verify_receipt");
  });
});

describe("a tool the profile holds back", () => {
  it("answers 501 uncharged, paid or not, and never offers a payment for it", async () => {
    const h = harness("mainnet");
    const attempts: Record<string, string>[] = [{}, { "payment-signature": "good" }];
    for (const headers of attempts) {
      const res = await h.call(
        "/v1/verify-receipt",
        h.post({ chain: "base", tx_hash: "0x1", quote: VALID_QUOTE }, headers),
      );
      expect(res.status).toBe(501);
      expect(await res.json()).toMatchObject({ charged: false });
    }
    expect(h.paywallCalls).toHaveLength(0);
    expect(h.recorded).toHaveLength(0);
  });

  it("still challenges the tools that profile does serve", async () => {
    const res = await harness("mainnet").call("/v1/quote?task_class=T1&model=A");
    expect(res.status).toBe(402);
    expect(res.headers.get("x-touchstone-network-profile")).toBe("mainnet");
  });
});

describe("a payment service that does not answer", () => {
  it("gives up after 25 seconds with a 504 that says nothing was delivered", async () => {
    vi.useFakeTimers();
    const recorded: string[] = [];
    const hung = (() => undefined) as unknown as ReturnType<typeof createToolPaywall>;
    const app = createRestApp<Record<string, never>>({
      profileFor: async () => "testnet",
      paywallFor: () => hung,
      toolDepsFor: () => ({
        dataSource,
        settlementReader: new StubSettlementReader(),
        attestationPrivateKeyHex: `0x${"11".repeat(32)}`,
      }),
      record: (_env, _ctx, tool) => {
        recorded.push(tool);
      },
    });
    const pending = app.request("https://mcp.example/v1/quote?task_class=T1&model=A", {}, {}, {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as never);
    await vi.advanceTimersByTimeAsync(25_000);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("Nothing was delivered"),
    });
    expect(recorded).toEqual([]);
  });
});

describe("GET /openapi.json", () => {
  it("describes the profile the service is on", async () => {
    const testnet = (await (await harness("testnet").call("/openapi.json")).json()) as {
      info: Record<string, unknown>;
    };
    const mainnet = (await (await harness("mainnet").call("/openapi.json")).json()) as {
      info: Record<string, unknown>;
    };
    expect(testnet.info["x-touchstone-network-profile"]).toBe("testnet");
    expect(mainnet.info["x-touchstone-network-profile"]).toBe("mainnet");
  });

  it("names the origin the request came in on as its server, whatever that is", async () => {
    const h = harness();
    for (const origin of ["https://mcp.example", "https://staging.example:8443"]) {
      const res = await h.call("/openapi.json", {}, origin);
      const doc = (await res.json()) as { servers: { url: string }[] };
      expect(doc.servers).toEqual([{ url: origin }]);
    }
  });

  it("is cached for no more than a minute, so a switch of profile shows quickly", async () => {
    const res = await harness().call("/openapi.json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });
});

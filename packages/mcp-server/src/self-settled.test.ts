import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  KITE_MAINNET,
  KITE_TESTNET,
  exactRequirementsFor,
  withSelfSettledNetworks,
  type SelfSettler,
} from "./self-settled.js";
import type { ToolMiddleware } from "./paywall.js";

const TREASURY = "0xB514882859f43DbF3df664C899D707f649E0CF4A";
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const decode = (h: string) => JSON.parse(Buffer.from(h, "base64").toString("utf-8"));

/** What Circle's middleware sets on an unpaid request — two Gateway networks. */
const CIRCLE_402 = {
  x402Version: 2,
  resource: { url: "/mcp", description: "paid", mimeType: "application/json" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      payTo: TREASURY,
      amount: "1000",
      extra: { name: "GatewayWalletBatched" },
    },
    {
      scheme: "exact",
      network: "eip155:5042002",
      payTo: TREASURY,
      amount: "1000",
      extra: { name: "GatewayWalletBatched" },
    },
  ],
};

function fakeCircle() {
  return vi.fn<ToolMiddleware>((_req: Request, res: Response) => {
    res.statusCode = 402;
    res.setHeader("PAYMENT-REQUIRED", encode(CIRCLE_402));
    res.end("{}");
  });
}

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: "",
    setHeader(name: string, value: string) {
      headers[name] = String(value);
      return res;
    },
    end(chunk?: string) {
      res.body = chunk ?? "";
    },
  };
  return { res: res as unknown as Response & { body: string }, headers };
}

function paidReq(accepted: Record<string, unknown>): Request {
  const payload = { x402Version: 2, accepted, payload: { signature: "0xsig", authorization: {} } };
  return { headers: { "payment-signature": encode(payload) } } as unknown as Request;
}

function settlerReturning(outcome: Awaited<ReturnType<SelfSettler["verifyAndSettle"]>>) {
  const verifyAndSettle = vi.fn<SelfSettler["verifyAndSettle"]>(async () => outcome);
  return { settler: { verifyAndSettle } as SelfSettler, verifyAndSettle };
}

describe("exactRequirementsFor", () => {
  // a network with no floor above any price, so the conversion itself is what's under test here
  const NO_FLOOR_6DP = { ...KITE_MAINNET, minimumPriceUsd: "0" };
  const NO_FLOOR_18DP = { ...KITE_TESTNET, minimumPriceUsd: "0" };

  it("converts dollar prices to atomic units with no floating point, per token decimals", () => {
    expect(exactRequirementsFor(NO_FLOOR_18DP, "$0.001", TREASURY).amount).toBe("1000000000000000"); // 18 dp
    expect(exactRequirementsFor(NO_FLOOR_18DP, "$0.01", TREASURY).amount).toBe("10000000000000000");
    expect(exactRequirementsFor(NO_FLOOR_6DP, "$0.001", TREASURY).amount).toBe("1000"); // 6 dp
    expect(exactRequirementsFor(NO_FLOOR_6DP, "$0.01", TREASURY).amount).toBe("10000");
    // a value that is not exactly representable as a binary float still converts exactly
    expect(exactRequirementsFor(NO_FLOOR_6DP, "$0.000003", TREASURY).amount).toBe("3");
  });

  it("asks at least the network's floor, because each payment here is a paid-for transaction", () => {
    // Kite floor $0.005: the two $0.001 tools are lifted to it, the $0.01 tool keeps its own price
    expect(exactRequirementsFor(KITE_MAINNET, "$0.001", TREASURY).amount).toBe("5000"); // 6 dp
    expect(exactRequirementsFor(KITE_MAINNET, "$0.01", TREASURY).amount).toBe("10000");
    expect(exactRequirementsFor(KITE_TESTNET, "$0.001", TREASURY).amount).toBe("5000000000000000"); // 18 dp
    expect(exactRequirementsFor(KITE_TESTNET, "$0.01", TREASURY).amount).toBe("10000000000000000");
    // a price exactly at the floor is neither lifted nor lowered
    expect(exactRequirementsFor(KITE_MAINNET, "$0.005", TREASURY).amount).toBe("5000");
  });

  it("the floor is on both Kite networks, so the testnet rehearses the mainnet price", () => {
    expect(KITE_MAINNET.minimumPriceUsd).toBe("0.005");
    expect(KITE_TESTNET.minimumPriceUsd).toBe("0.005");
  });

  it("carries the token's own EIP-712 domain and the treasury as payTo", () => {
    const r = exactRequirementsFor(KITE_MAINNET, "$0.001", TREASURY);
    expect(r).toMatchObject({
      scheme: "exact",
      network: "eip155:2366",
      asset: "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
      payTo: TREASURY,
      extra: { name: "Bridged USDC (Kite AI)", version: "2" },
    });
    expect(exactRequirementsFor(KITE_TESTNET, "$0.001", TREASURY).extra).toEqual({
      name: "PYUSD",
      version: "1",
    });
  });

  it("refuses a price it cannot parse rather than guessing", () => {
    expect(() => exactRequirementsFor(KITE_TESTNET, "$abc", TREASURY)).toThrow(/Unparseable/);
  });
});

describe("withSelfSettledNetworks", () => {
  const opts = (settlers: Record<string, SelfSettler> = {}) => ({
    networks: [KITE_TESTNET],
    payTo: TREASURY,
    settlers,
  });

  it("an unpaid call gets ONE 402 listing Circle's networks AND Kite, every payTo the treasury", async () => {
    const circle = fakeCircle();
    const { res, headers } = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    await withSelfSettledNetworks("$0.001", circle, opts())({ headers: {} } as Request, res, next);

    const offered = decode(headers["PAYMENT-REQUIRED"] as string);
    expect(offered.accepts.map((a: { network: string }) => a.network)).toEqual([
      "eip155:84532",
      "eip155:5042002",
      "eip155:2368",
    ]);
    expect(offered.accepts.slice(0, 2)).toEqual(CIRCLE_402.accepts); // Circle's entries untouched
    expect(offered.resource).toEqual(CIRCLE_402.resource);
    expect(
      offered.accepts.every(
        (a: { payTo: string }) => a.payTo.toLowerCase() === TREASURY.toLowerCase(),
      ),
    ).toBe(true);
    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it("a payment on Kite is settled here, with the SERVER's terms, and never reaches Circle", async () => {
    const circle = fakeCircle();
    const { settler, verifyAndSettle } = settlerReturning({
      ok: true,
      payer: "0xbuyer",
      transaction: "0xtx",
      network: "eip155:2368",
    });
    const ours = exactRequirementsFor(KITE_TESTNET, "$0.001", TREASURY);
    // Same price/payee/token, but a client-chosen signing domain and timeout: the settler must
    // still receive the server's own terms, never anything the client wrote.
    const req = paidReq({
      ...ours,
      extra: { name: "Not The Token", version: "9" },
      maxTimeoutSeconds: 1,
    });
    const { res, headers } = fakeRes();
    const next = vi.fn() as unknown as NextFunction;

    await withSelfSettledNetworks("$0.001", circle, opts({ [KITE_TESTNET.network]: settler }))(
      req,
      res,
      next,
    );

    expect(circle).not.toHaveBeenCalled();
    expect(verifyAndSettle).toHaveBeenCalledTimes(1);
    expect(verifyAndSettle.mock.calls[0]?.[1]).toEqual(ours);
    expect(next).toHaveBeenCalledTimes(1);
    expect(decode(headers["PAYMENT-RESPONSE"] as string)).toMatchObject({
      success: true,
      transaction: "0xtx",
      payer: "0xbuyer",
    });
    expect((req as unknown as { payment: unknown }).payment).toMatchObject({
      payer: "0xbuyer",
      amount: ours.amount,
      transaction: "0xtx",
    });
  });

  it.each([
    ["a lower amount", { amount: "1" }],
    ["a different payee", { payTo: "0x000000000000000000000000000000000000dEaD" }],
    ["a different token", { asset: "0x0309764915AFC7a2a7CDd1E64c58a57c1F1705E3" }],
  ])(
    "refuses a Kite payment whose client-chosen terms carry %s — nothing settles",
    async (_label, change) => {
      const circle = fakeCircle();
      const { settler, verifyAndSettle } = settlerReturning({
        ok: true,
        payer: "x",
        transaction: "x",
        network: "x",
      });
      const req = paidReq({ ...exactRequirementsFor(KITE_TESTNET, "$0.001", TREASURY), ...change });
      const { res } = fakeRes();
      const next = vi.fn() as unknown as NextFunction;

      await withSelfSettledNetworks("$0.001", circle, opts({ [KITE_TESTNET.network]: settler }))(
        req,
        res,
        next,
      );

      expect(verifyAndSettle).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(402);
    },
  );

  it("a payment the settler rejects (bad signature, spent nonce, failed transfer) is a 402, never next()", async () => {
    const { settler } = settlerReturning({
      ok: false,
      reason: "invalid_exact_evm_payload_signature",
    });
    const req = paidReq({ ...exactRequirementsFor(KITE_TESTNET, "$0.001", TREASURY) });
    const { res } = fakeRes();
    const next = vi.fn() as unknown as NextFunction;

    await withSelfSettledNetworks(
      "$0.001",
      fakeCircle(),
      opts({ [KITE_TESTNET.network]: settler }),
    )(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.body).toContain("invalid_exact_evm_payload_signature");
  });

  it("a payment on a Circle network goes to Circle, untouched", async () => {
    const circle = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const { settler, verifyAndSettle } = settlerReturning({
      ok: true,
      payer: "x",
      transaction: "x",
      network: "x",
    });
    const req = paidReq({
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      payTo: TREASURY,
    });
    const { res } = fakeRes();
    const next = vi.fn() as unknown as NextFunction;

    await withSelfSettledNetworks("$0.001", circle, opts({ [KITE_TESTNET.network]: settler }))(
      req,
      res,
      next,
    );

    expect(circle).toHaveBeenCalledTimes(1);
    expect(verifyAndSettle).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

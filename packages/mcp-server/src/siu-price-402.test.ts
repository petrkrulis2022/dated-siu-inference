import { describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { Print } from "@touchstone/sdk";
import { printBodyHashHex } from "@touchstone/print";
import {
  commodityPrintOfRecord,
  priceChallengeHeader,
  siuPricedFrom,
  withSiuPrice,
  type SiuPricing,
} from "./siu-price-402.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (header: string) => JSON.parse(Buffer.from(header, "base64").toString("utf8"));

const COMMODITY = {
  version: "SIU-2026a",
  print_id: "2026-11-26-commodity",
  date: "2026-11-26",
  status: "provisional",
  series: "commodity",
  dated_siu: "0.001409",
  methodology_version: "v0-draft",
  methodology_revision: "rules-2026-11-21",
} as unknown as Print;

const NOW = new Date("2026-11-26T12:00:00Z");
const DECIMALS: Record<string, number> = {
  "eip155:8453": 6,
  "eip155:5042": 6,
  "eip155:2366": 6,
  "eip155:2368": 18,
};
const decimalsFor = (network: string) => DECIMALS[network];

// A 402 shaped like the composed one: Circle's two Gateway offers, then Kite's own at its floor.
const CHALLENGE = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: "/v1/quote" },
  accepts: [
    { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0xusdc", payTo: "0xT", maxTimeoutSeconds: 60, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0xgw" } },
    { scheme: "exact", network: "eip155:5042", amount: "1000", asset: "0xusdc", payTo: "0xT", maxTimeoutSeconds: 60, extra: { name: "GatewayWalletBatched", version: "1" } },
    { scheme: "exact", network: "eip155:2366", amount: "5000", asset: "0xusdce", payTo: "0xT", maxTimeoutSeconds: 60, extra: { name: "Bridged USDC (Kite AI)", version: "2" } },
  ],
};

describe("priceChallengeHeader", () => {
  it("adds the SIU price, per offer, beside each USDC amount, keeping every existing field", () => {
    const { header, carried } = priceChallengeHeader(encode(CHALLENGE), COMMODITY, decimalsFor, NOW);
    const out = decode(header);
    expect(carried).toBe(true);
    expect(out.resource).toEqual(CHALLENGE.resource);
    expect(out.error).toBe(CHALLENGE.error);
    const siu = (msiu: string) => ({
      price_msiu: msiu,
      rate_usd_per_siu: "0.001409",
      grade: "commodity",
      print_id: "2026-11-26-commodity",
      print_date: "2026-11-26",
      print_hash: printBodyHashHex(COMMODITY),
      methodology_version: "v0-draft",
      methodology_revision: "rules-2026-11-21",
    });
    expect(out.accepts[0]).toEqual({ ...CHALLENGE.accepts[0], extra: { ...CHALLENGE.accepts[0]!.extra, touchstone: siu("710") } });
    expect(out.accepts[1].extra.touchstone.price_msiu).toBe("710");
    expect(out.accepts[2].extra).toEqual({ name: "Bridged USDC (Kite AI)", version: "2", touchstone: siu("3549") });
  });

  it("converts by each offer's own token decimals (Kite Testnet's PYUSD has 18)", () => {
    const challenge = { ...CHALLENGE, accepts: [{ ...CHALLENGE.accepts[2], network: "eip155:2368", amount: "5000000000000000" }] };
    const { header } = priceChallengeHeader(encode(challenge), COMMODITY, decimalsFor, NOW);
    expect(decode(header).accepts[0].extra.touchstone.price_msiu).toBe("3549");
  });

  it("leaves an offer unpriced when its token's decimals are unknown, and says the 402 was not fully priced", () => {
    const challenge = { ...CHALLENGE, accepts: [CHALLENGE.accepts[0], { ...CHALLENGE.accepts[1], network: "eip155:1" }] };
    const { header, carried } = priceChallengeHeader(encode(challenge), COMMODITY, decimalsFor, NOW);
    const out = decode(header);
    expect(carried).toBe(false);
    expect(out.accepts[0].extra.touchstone.price_msiu).toBe("710");
    expect(out.accepts[1].extra).toEqual(CHALLENGE.accepts[1]!.extra);
  });

  it("omits the SIU price entirely, never a wrong number, without a usable print", () => {
    for (const print of [undefined, { ...COMMODITY, date: "2026-11-01" } as Print]) {
      const { header, carried } = priceChallengeHeader(encode(CHALLENGE), print, decimalsFor, NOW);
      expect(carried).toBe(false);
      expect(decode(header)).toEqual(CHALLENGE);
    }
  });

  it("returns an unreadable header untouched rather than breaking the 402", () => {
    expect(priceChallengeHeader("not base64 json", COMMODITY, decimalsFor, NOW)).toEqual({
      header: "not base64 json",
      carried: false,
    });
  });
});

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name] = String(value);
      return res;
    },
    end() {
      return res;
    },
  };
  return { res: res as unknown as Response, headers };
}

const challengingInner = (req: Request, res: Response) => {
  res.statusCode = 402;
  res.setHeader("PAYMENT-REQUIRED", encode(CHALLENGE));
  res.end();
  void req;
};

function pricing(load: SiuPricing["loadPrint"]): SiuPricing {
  return { loadPrint: load, decimalsFor, now: () => NOW };
}

describe("withSiuPrice", () => {
  it("prices the 402 the wrapped paywall sends, and records that it did", async () => {
    const req = { headers: {} } as Request;
    const { res, headers } = fakeRes();
    await withSiuPrice(challengingInner, pricing(async () => COMMODITY))(req, res, (() => undefined) as NextFunction);
    expect(decode(headers["PAYMENT-REQUIRED"]!).accepts[0].extra.touchstone.price_msiu).toBe("710");
    expect(siuPricedFrom(req)).toBe(true);
  });

  it("still serves the plain 402 when the print cannot be loaded", async () => {
    const req = { headers: {} } as Request;
    const { res, headers } = fakeRes();
    await withSiuPrice(challengingInner, pricing(async () => Promise.reject(new Error("KV down"))))(
      req,
      res,
      (() => undefined) as NextFunction,
    );
    expect(decode(headers["PAYMENT-REQUIRED"]!)).toEqual(CHALLENGE);
    expect(siuPricedFrom(req)).toBe(false);
  });

  it("records nothing when no 402 was sent", async () => {
    const req = { headers: {} } as Request;
    const { res } = fakeRes();
    let passed = false;
    await withSiuPrice((_req, _res, next) => next(), pricing(async () => COMMODITY))(req, res, (() => {
      passed = true;
    }) as NextFunction);
    expect(passed).toBe(true);
    expect(siuPricedFrom(req)).toBeUndefined();
  });
});

describe("commodityPrintOfRecord", () => {
  const corrected = { ...COMMODITY, print_id: "2026-11-26b-commodity" } as Print;

  it("takes the newest date's latest revision that nothing supersedes", async () => {
    const prints: Record<string, Print> = {
      "2026-11-26-commodity": {
        ...COMMODITY,
        superseded_by: { print_id: "2026-11-26b-commodity", reason: "test correction" },
      } as Print,
      "2026-11-26b-commodity": corrected,
      "2026-11-25-commodity": { ...COMMODITY, print_id: "2026-11-25-commodity", date: "2026-11-25" } as Print,
    };
    const source = {
      listPrintIds: async () => [...Object.keys(prints), "2026-11-26", "2026-11-26-frontier"],
      loadPrintByDate: async (id: string) => prints[id] as Print,
    };
    expect(await commodityPrintOfRecord(source)).toBe(corrected);
  });

  it("is undefined when there is no Commodity print, or none that loads unsuperseded", async () => {
    expect(
      await commodityPrintOfRecord({ listPrintIds: async () => ["2026-11-26"], loadPrintByDate: async () => COMMODITY }),
    ).toBeUndefined();
    expect(
      await commodityPrintOfRecord({
        listPrintIds: async () => ["2026-11-26-commodity"],
        loadPrintByDate: async () => Promise.reject(new Error("404")),
      }),
    ).toBeUndefined();
  });
});

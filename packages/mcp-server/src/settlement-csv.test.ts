import { describe, expect, it } from "vitest";
import { MAINNET_PAYMENT_NETWORKS } from "@touchstone/print";
import { PROFILES } from "./networks.js";
import { KITE_MAINNET } from "./self-settled.js";
import {
  CSV_HEADER,
  PAYMENT_NETWORK_FACTS,
  atomicToDecimal,
  csvField,
  daysToExport,
  exportPayments,
  toCsv,
  utcDay,
  type ClassifiedSettlementRow,
} from "./settlement-csv.js";

const row = (over: Partial<ClassifiedSettlementRow> = {}): ClassifiedSettlementRow => ({
  id: 1,
  at: "2026-11-26T17:04:53.812Z",
  tool: "get_quote",
  network: "eip155:8453",
  route: "gateway-batched",
  amount: "1000",
  payer: "0x22e2f3427ffbf5d453649824c7bfcb6c8f12d743",
  reference: "transfer-1",
  batch_tx: null,
  traffic: "internal",
  ...over,
});

describe("atomicToDecimal", () => {
  it("shifts the decimal point exactly, keeping every decimal place", () => {
    expect(atomicToDecimal("1000", 6)).toBe("0.001000");
    expect(atomicToDecimal("10000", 6)).toBe("0.010000");
    expect(atomicToDecimal("1234567", 6)).toBe("1.234567");
    expect(atomicToDecimal("0", 6)).toBe("0.000000");
    expect(atomicToDecimal("10000000000000000", 18)).toBe("0.010000000000000000");
    expect(atomicToDecimal("987654321987654321987", 6)).toBe("987654321987654.321987");
  });

  it("refuses anything that is not a whole number of atomic units", () => {
    for (const bad of ["", "-1", "1.5", "1e6", " 1", "0x10", "01"])
      expect(() => atomicToDecimal(bad, 6)).toThrow(/atomic/);
  });
});

describe("csvField", () => {
  it("quotes commas, quotes and line breaks, doubling inner quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "x"')).toBe('"say ""x"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(null)).toBe("");
    expect(csvField(42)).toBe("42");
  });

  it("keeps a spreadsheet from reading a text field as a formula", () => {
    for (const lead of ["=", "+", "-", "@"]) expect(csvField(`${lead}SUM(A1)`)).toBe(`'${lead}SUM(A1)`);
  });
});

describe("utcDay", () => {
  it("is the UTC calendar day of an ISO timestamp", () => {
    expect(utcDay("2026-11-26T23:59:59.999Z")).toBe("2026-11-26");
    expect(utcDay("2026-11-27T00:00:00.000Z")).toBe("2026-11-27");
  });

  it("refuses a timestamp that is not ISO-8601 UTC", () => {
    for (const bad of ["2026-11-26", "2026-11-26T10:00:00+01:00", "yesterday"])
      expect(() => utcDay(bad)).toThrow(/timestamp/);
  });
});

describe("the network table", () => {
  it("knows every network any profile takes payment on, so no row can be guessed", () => {
    const offered = Object.values(PROFILES).flatMap((p) => [
      ...p.circle.networks,
      ...p.selfSettled.map((n) => n.network),
    ]);
    for (const n of [...offered, KITE_MAINNET.network]) expect(PAYMENT_NETWORK_FACTS.has(n)).toBe(true);
  });

  it("marks only Base, Arc and Kite mainnet as mainnet, with the decimals the payments carried", () => {
    const mainnet = [...PAYMENT_NETWORK_FACTS].filter(([, f]) => f.mainnet).map(([n]) => n);
    expect(mainnet.sort()).toEqual(
      [...MAINNET_PAYMENT_NETWORKS.map((n) => n.caip2), KITE_MAINNET.network].sort(),
    );
    expect(PAYMENT_NETWORK_FACTS.get("eip155:8453")).toMatchObject({ chain: "Base", asset: "USDC", decimals: 6 });
    expect(PAYMENT_NETWORK_FACTS.get("eip155:5042")).toMatchObject({ chain: "Arc", asset: "USDC", decimals: 6 });
    expect(PAYMENT_NETWORK_FACTS.get("eip155:2368")).toMatchObject({ mainnet: false, decimals: 18 });
  });
});

describe("toCsv", () => {
  it("writes the header and one CRLF-terminated line per payment, amounts exact", () => {
    const csv = toCsv([row(), row({ id: 2, network: "eip155:2368", amount: "5000000000000000", route: "self-settled" })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_HEADER.join(","));
    expect(lines[1]).toBe(
      "1,2026-11-26T17:04:53.812Z,get_quote,Base,eip155:8453,yes,gateway-batched,USDC,0.001000,1000," +
        "0x22e2f3427ffbf5d453649824c7bfcb6c8f12d743,internal,transfer-1,",
    );
    expect(lines[2]).toContain(",KiteAI Testnet,eip155:2368,no,self-settled,PYUSD,0.005000000000000000,");
    expect(lines.at(-1)).toBe("");
  });

  it("writes a header-only file for a day with no payments", () => {
    expect(toCsv([])).toBe(CSV_HEADER.join(",") + "\r\n");
  });

  it("refuses a payment on a network it does not know, rather than guess its decimals", () => {
    expect(() => toCsv([row({ network: "eip155:1" })])).toThrow(/eip155:1/);
  });
});

describe("daysToExport", () => {
  it("is every complete UTC day from the first payment to yesterday that has no file yet", () => {
    expect(
      daysToExport({ firstDay: "2026-11-24", today: "2026-11-27", existingDays: new Set(["2026-11-25"]) }),
    ).toEqual(["2026-11-24", "2026-11-26"]);
  });

  it("never exports today, which is not over", () => {
    expect(daysToExport({ firstDay: "2026-11-27", today: "2026-11-27", existingDays: new Set() })).toEqual([]);
  });

  it("crosses month and year ends", () => {
    expect(daysToExport({ firstDay: "2026-12-31", today: "2027-01-02", existingDays: new Set() })).toEqual([
      "2026-12-31",
      "2027-01-01",
    ]);
  });

  it("rewrites a day it is asked for, but never one that is not over", () => {
    const base = { firstDay: "2026-11-24", today: "2026-11-27", existingDays: new Set(["2026-11-24", "2026-11-25", "2026-11-26"]) };
    expect(daysToExport({ ...base, forceDays: ["2026-11-25"] })).toEqual(["2026-11-25"]);
    expect(() => daysToExport({ ...base, forceDays: ["2026-11-27"] })).toThrow(/not over/);
    expect(() => daysToExport({ ...base, forceDays: ["26-11-2026"] })).toThrow(/YYYY-MM-DD/);
  });

  it("has nothing to do before the first payment", () => {
    expect(daysToExport({ firstDay: undefined, today: "2026-11-27", existingDays: new Set() })).toEqual([]);
  });
});

describe("exportPayments", () => {
  it("queries once over the missing days and writes one file per day, empty days included", async () => {
    const queries: [string, string][] = [];
    const written = new Map<string, string>();
    const result = await exportPayments({
      today: "2026-11-27",
      existingDays: new Set(["2026-11-24"]),
      firstDay: async () => "2026-11-24",
      query: async (from, to) => {
        queries.push([from, to]);
        return [row({ at: "2026-11-24T10:00:00.000Z" }), row({ id: 7, at: "2026-11-26T23:59:59.999Z", traffic: "organic" })];
      },
      write: async (day, csv) => void written.set(day, csv),
    });
    expect(queries).toEqual([["2026-11-25", "2026-11-27"]]);
    expect([...written.keys()]).toEqual(["2026-11-25", "2026-11-26"]);
    expect(written.get("2026-11-25")).toBe(CSV_HEADER.join(",") + "\r\n");
    expect(written.get("2026-11-26")).toContain("\r\n7,2026-11-26T23:59:59.999Z,");
    expect(result).toEqual({ days: ["2026-11-25", "2026-11-26"], rows: 1, byTraffic: { organic: 1 } });
  });

  it("writes nothing and queries nothing when every day is already on disk", async () => {
    let queried = false;
    const result = await exportPayments({
      today: "2026-11-27",
      existingDays: new Set(["2026-11-26"]),
      firstDay: async () => "2026-11-26",
      query: async () => ((queried = true), []),
      write: async () => {
        throw new Error("should not write");
      },
    });
    expect(queried).toBe(false);
    expect(result.days).toEqual([]);
  });

  it("writes no file at all if any row cannot be written, so a day is never half-exported", async () => {
    const written: string[] = [];
    await expect(
      exportPayments({
        today: "2026-11-27",
        existingDays: new Set(),
        firstDay: async () => "2026-11-25",
        query: async () => [row({ at: "2026-11-25T01:00:00.000Z" }), row({ at: "2026-11-26T01:00:00.000Z", network: "eip155:1" })],
        write: async (day) => void written.push(day),
      }),
    ).rejects.toThrow(/eip155:1/);
    expect(written).toEqual([]);
  });
});

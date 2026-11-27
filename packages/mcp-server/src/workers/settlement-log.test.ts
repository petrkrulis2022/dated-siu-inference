import { describe, expect, it, vi } from "vitest";
import {
  SETTLEMENTS_SCHEMA,
  logSettlement,
  routeFor,
  type SettlementEntry,
} from "./settlement-log.js";

const ENTRY: SettlementEntry = {
  tool: "get_quote",
  network: "eip155:2366",
  route: "self-settled",
  amount: "1000",
  payer: "0xBuyer",
  reference: "0xTx",
  at: "2026-10-25T10:00:00.000Z",
};

function fakeDb(fail = false) {
  const bound: unknown[][] = [];
  const sql: string[] = [];
  return {
    bound,
    sql,
    db: {
      prepare(q: string) {
        sql.push(q);
        return {
          bind(...args: unknown[]) {
            bound.push(args);
            return {
              run: async () => {
                if (fail) throw new Error("D1 down");
                return { success: true };
              },
            };
          },
        };
      },
    } as never,
  };
}

describe("routeFor", () => {
  it("is self-settled for the networks this server settles itself, gateway-batched for everything else", () => {
    expect(routeFor("eip155:2366", ["eip155:2366"])).toBe("self-settled");
    expect(routeFor("eip155:8453", ["eip155:2366"])).toBe("gateway-batched");
    expect(routeFor("eip155:8453", [])).toBe("gateway-batched");
  });
});

describe("logSettlement", () => {
  it("writes one parameterised row with every field, amount kept as a string", async () => {
    const { db, bound, sql } = fakeDb();
    await logSettlement(db, ENTRY);
    expect(sql[0]).toMatch(/INSERT INTO settlements/);
    expect(sql[0]).not.toContain(ENTRY.payer); // values go through bind(), never into the SQL text
    expect(bound[0]).toEqual([
      ENTRY.at,
      "get_quote",
      "eip155:2366",
      "self-settled",
      "1000",
      "0xBuyer",
      "0xTx",
    ]);
  });

  it("does nothing, quietly, when there is no database bound", async () => {
    await expect(logSettlement(undefined, ENTRY)).resolves.toBeUndefined();
  });

  it("never throws when the write fails — it reports instead, so a settled payment is never failed by its log", async () => {
    const { db } = fakeDb(true);
    const onError = vi.fn();
    await expect(logSettlement(db, ENTRY, onError)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ships a schema that creates the table and its indexes idempotently", () => {
    expect(SETTLEMENTS_SCHEMA).toMatch(/CREATE TABLE IF NOT EXISTS settlements/);
    expect(SETTLEMENTS_SCHEMA).toMatch(/batch_tx TEXT/);
    expect((SETTLEMENTS_SCHEMA.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length).toBe(2);
  });
});

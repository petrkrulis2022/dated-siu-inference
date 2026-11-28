import { describe, expect, it, vi } from "vitest";
import {
  SETTLEMENTS_SCHEMA,
  SETTLEMENTS_VIA_MIGRATION,
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
  via: "registry",
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
      "registry",
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

describe("the via column", () => {
  it("is in the schema for a fresh database, and in the migration for the live one", () => {
    expect(SETTLEMENTS_SCHEMA).toMatch(/\bvia TEXT\b/);
    expect(SETTLEMENTS_VIA_MIGRATION).toMatch(/^ALTER TABLE settlements ADD COLUMN via TEXT;/);
    // settlements_classified selects s.*, so it is recreated to include the new column.
    expect(SETTLEMENTS_VIA_MIGRATION).toMatch(/DROP VIEW IF EXISTS settlements_classified;/);
    expect(SETTLEMENTS_VIA_MIGRATION).toMatch(/CREATE VIEW settlements_classified AS/);
  });

  it("records direct for an entry that names no listing", async () => {
    const { db, bound } = fakeDb();
    const { via: _drop, ...noVia } = ENTRY;
    void _drop;
    await logSettlement(db, noVia);
    expect(bound[0]?.at(-1)).toBe("direct");
  });
});

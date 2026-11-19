import { describe, expect, it, vi } from "vitest";
import { paymentFrom, recordCall, type PaymentInfo } from "./record-call.js";

const PAYMENT: PaymentInfo = {
  payer: "0xBuyer",
  amount: "1000",
  network: "eip155:2366",
  transaction: "0xTx",
};

function env(options: { usageThrows?: boolean; withDb?: boolean } = {}) {
  const points: unknown[] = [];
  const rows: unknown[][] = [];
  const usage = {
    writeDataPoint: (point: unknown) => {
      if (options.usageThrows) throw new Error("Analytics Engine unavailable");
      points.push(point);
    },
  };
  const SETTLEMENTS = {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          rows.push(args);
          return { success: true };
        },
      }),
    }),
  };
  return {
    points,
    rows,
    env: { USAGE: usage, SETTLEMENTS: options.withDb === false ? undefined : SETTLEMENTS } as never,
  };
}

function ctx() {
  const pending: Promise<unknown>[] = [];
  return { pending, ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) } };
}

describe("recordCall", () => {
  it("writes a usage point for a free call and no settlement row", async () => {
    const e = env();
    const c = ctx();
    recordCall(e.env, c.ctx, "get_index", undefined, []);
    await Promise.all(c.pending);
    expect(e.points).toHaveLength(1);
    expect(c.pending).toHaveLength(0);
    expect(e.rows).toHaveLength(0);
  });

  it("writes the usage point and one settlement row for a paid call, routed by network", async () => {
    const e = env();
    const c = ctx();
    recordCall(e.env, c.ctx, "get_quote", PAYMENT, ["eip155:2366"]);
    await Promise.all(c.pending);
    expect(e.points).toEqual([
      { blobs: ["get_quote", "0xBuyer"], doubles: [1], indexes: ["0xBuyer"] },
    ]);
    expect(e.rows).toHaveLength(1);
    const row = e.rows[0] ?? [];
    expect(row.slice(1)).toEqual([
      "get_quote",
      "eip155:2366",
      "self-settled",
      "1000",
      "0xBuyer",
      "0xTx",
    ]);
  });

  it("routes a network Circle settles as gateway-batched", async () => {
    const e = env();
    const c = ctx();
    recordCall(e.env, c.ctx, "convert", { ...PAYMENT, network: "eip155:8453" }, ["eip155:2366"]);
    await Promise.all(c.pending);
    expect(e.rows[0]?.[3]).toBe("gateway-batched");
  });

  it("never throws when the usage dataset fails, and still logs the settlement", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = env({ usageThrows: true });
    const c = ctx();
    expect(() => recordCall(e.env, c.ctx, "get_quote", PAYMENT, [])).not.toThrow();
    await Promise.all(c.pending);
    expect(e.rows).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith("usage logging failed:", expect.any(Error));
    spy.mockRestore();
  });

  it("is harmless with no settlement database bound", async () => {
    const e = env({ withDb: false });
    const c = ctx();
    recordCall(e.env, c.ctx, "get_quote", PAYMENT, []);
    await expect(Promise.all(c.pending)).resolves.toBeDefined();
  });
});

describe("paymentFrom", () => {
  it("reads the payment a paywall attached to the request, or nothing", () => {
    expect(paymentFrom({ payment: PAYMENT })).toBe(PAYMENT);
    expect(paymentFrom({})).toBeUndefined();
  });
});

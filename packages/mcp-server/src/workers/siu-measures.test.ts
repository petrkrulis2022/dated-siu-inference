import { describe, expect, it } from "vitest";
import { recordChallenge, recordPaidInSession, sessionTag } from "./siu-measures.js";

function usage(throws = false) {
  const points: { blobs: string[]; doubles: number[]; indexes: string[] }[] = [];
  return {
    points,
    USAGE: {
      writeDataPoint: (p: { blobs: string[]; doubles: number[]; indexes: string[] }) => {
        if (throws) throw new Error("Analytics Engine unavailable");
        points.push(p);
      },
    },
  };
}

function ctx() {
  const pending: Promise<unknown>[] = [];
  return { pending, ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) } };
}

describe("sessionTag", () => {
  it("is a short one-way tag of the MCP session id, empty without one", async () => {
    const tag = await sessionTag("3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90");
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(await sessionTag("3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90")).toBe(tag);
    expect(tag).not.toContain("3f2a9c1e");
    expect(await sessionTag(undefined)).toBe("");
    expect(await sessionTag("")).toBe("");
  });
});

describe("recordChallenge", () => {
  it("logs one data point per 402: tool, profile, whether it carried an SIU price, the session tag", async () => {
    const u = usage();
    const c = ctx();
    recordChallenge({ USAGE: u.USAGE as never }, c.ctx, "get_quote", "mainnet", true, "session-1");
    recordChallenge({ USAGE: u.USAGE as never }, c.ctx, "convert", "mainnet", false, undefined);
    await Promise.all(c.pending);
    // Written asynchronously (after the response), so in no particular order.
    expect(u.points).toHaveLength(2);
    expect(u.points).toContainEqual({
      blobs: ["challenge", "get_quote", "mainnet", "siu", await sessionTag("session-1")],
      doubles: [1],
      indexes: ["challenge"],
    });
    expect(u.points).toContainEqual({
      blobs: ["challenge", "convert", "mainnet", "usdc-only", ""],
      doubles: [1],
      indexes: ["challenge"],
    });
  });

  it("never throws or rejects when logging fails", async () => {
    const c = ctx();
    expect(() =>
      recordChallenge(
        { USAGE: usage(true).USAGE as never },
        c.ctx,
        "get_quote",
        "mainnet",
        true,
        "s",
      ),
    ).not.toThrow();
    await expect(Promise.all(c.pending)).resolves.toBeDefined();
  });
});

describe("recordPaidInSession", () => {
  it("logs a paid call against its session tag, so a 402 can be matched to a later payment", async () => {
    const u = usage();
    const c = ctx();
    recordPaidInSession({ USAGE: u.USAGE as never }, c.ctx, "get_quote", "mainnet", "session-1");
    recordPaidInSession({ USAGE: u.USAGE as never }, c.ctx, "get_quote", "mainnet", undefined);
    await Promise.all(c.pending);
    expect(u.points).toEqual([
      {
        blobs: ["paid", "get_quote", "mainnet", "", await sessionTag("session-1")],
        doubles: [1],
        indexes: ["paid"],
      },
    ]);
  });
});

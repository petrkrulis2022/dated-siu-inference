import { describe, expect, it } from "vitest";
import { listObligationsTool, type IssuerObligation } from "./list-obligations.js";
import type { ToolContext } from "../deps.js";

const CTX = {} as ToolContext;
const call = (obligations: IssuerObligation[], windowLabel?: string) =>
  listObligationsTool.handler(
    CTX,
    listObligationsTool.argsSchema.parse({ obligations, ...(windowLabel ? { windowLabel } : {}) }),
    "0x00",
  );

describe("list_obligations", () => {
  it("says plainly that nothing is outstanding, rather than returning a bare empty list", async () => {
    // An issuer that asks and gets `[]` has to infer what that means. The whole reason this tool
    // exists is that inference was the failure mode (§4.6b).
    const r = await call([]);
    expect(r.obligations).toEqual([]);
    expect(r.totalOutstandingMilliSiu).toBe("0");
    expect(r.summary).toMatch(/nothing is outstanding/i);
  });

  it("distinguishes work owed now from headroom consumed by a claim nobody has presented", async () => {
    const r = await call([
      { tokenId: "1", state: "presented_awaiting_delivery", quantityMilliSiu: "10000", holder: "WORKER-CODE" },
      { tokenId: "2", state: "minted_not_presented", quantityMilliSiu: "4000" },
    ]);
    expect(r.counts.presented_awaiting_delivery).toBe(1);
    expect(r.counts.minted_not_presented).toBe(1);
    expect(r.totalOutstandingMilliSiu).toBe("14000");
    // Both facts must reach the issuer in words, because the second one is the one it has never
    // been able to see: its bond is committed and it cannot act on that claim yet.
    expect(r.summary).toMatch(/1 claim\(s\) presented and awaiting you/);
    expect(r.summary).toMatch(/have NOT been presented/);
    expect(r.summary).toMatch(/cannot serve what has not been presented/i);
  });

  it("warns about claims carried from an earlier window, which default against the bond", async () => {
    const r = await call([
      { tokenId: "9", state: "carried_unsettled", quantityMilliSiu: "10000", mintedInWindow: 1 },
    ]);
    expect(r.summary).toMatch(/carried from an earlier window/);
    expect(r.summary).toMatch(/default against your bond/);
  });

  it("sums only what it was given, in integer mSIU — no floats anywhere near money", async () => {
    const r = await call([
      { tokenId: "1", state: "minted_not_presented", quantityMilliSiu: "10000" },
      { tokenId: "2", state: "minted_not_presented", quantityMilliSiu: "4000" },
      { tokenId: "3", state: "presented_graded_awaiting_service" }, // no quantity recorded
    ]);
    expect(r.totalOutstandingMilliSiu).toBe("14000");
    expect(typeof r.totalOutstandingMilliSiu).toBe("string");
  });

  it("carries the window label through, so an answer can be read against a window", async () => {
    expect((await call([], "window 2")).windowLabel).toBe("window 2");
  });

  it("reports every state it is given, counting each exactly once", async () => {
    const r = await call([
      { tokenId: "1", state: "minted_not_presented" },
      { tokenId: "2", state: "presented_awaiting_delivery" },
      { tokenId: "3", state: "presented_graded_awaiting_service" },
      { tokenId: "4", state: "carried_unsettled" },
    ]);
    expect(r.counts).toEqual({
      minted_not_presented: 1,
      presented_awaiting_delivery: 1,
      presented_graded_awaiting_service: 1,
      carried_unsettled: 1,
    });
    expect(r.obligations).toHaveLength(4);
  });
});

import { describe, expect, it } from "vitest";
import { checkDeliveryTool, type DeliveryStatus } from "./check-delivery.js";
import type { ToolContext } from "../deps.js";

const CTX = {} as ToolContext;
const call = (claims: DeliveryStatus[]) =>
  checkDeliveryTool.handler(CTX, checkDeliveryTool.argsSchema.parse({ claims }), "0x00");

describe("check_delivery", () => {
  it("answers the question WORKER-CODE actually asked, in words", async () => {
    // Run 13: "No tool exists to check whether the issuer has actually served the redeemed
    // claim." It had presented and was waiting. That state must be unambiguous.
    const r = await call([
      { tokenId: "1", state: "presented_awaiting_issuer", issuer: "ISSUER-B", quantityMilliSiu: "10000" },
    ]);
    expect(r.counts.presented_awaiting_issuer).toBe(1);
    expect(r.summary).toMatch(/presented and NOT yet served/);
    expect(r.summary).toMatch(/issuer owes you this/i);
  });

  it("distinguishes served-with-a-pass from served-with-a-fail", async () => {
    // Both are delivery. Conflating them would tell a holder it got work it did not get.
    const passed = await call([{ tokenId: "1", state: "served_passed" }]);
    expect(passed.summary).toMatch(/served with a PASS/);
    const failed = await call([{ tokenId: "1", state: "served_failed" }]);
    expect(failed.summary).toMatch(/served with a FAIL/);
    expect(failed.summary).not.toMatch(/PASS/);
  });

  it("tells a holder that an unpresented claim owes it nothing yet, and how to change that", async () => {
    const r = await call([{ tokenId: "1", state: "not_presented" }]);
    expect(r.summary).toMatch(/not been presented/);
    expect(r.summary).toMatch(/redeem_claim/);
  });

  it("says a closed-window claim defaults against the bond and pays the holder", async () => {
    const r = await call([{ tokenId: "1", state: "window_closed_unserved" }]);
    expect(r.summary).toMatch(/default/);
    expect(r.summary).toMatch(/bond pays you/);
  });

  it("says plainly there is nothing to check rather than returning a bare empty list", async () => {
    const r = await call([]);
    expect(r.claims).toEqual([]);
    expect(r.summary).toMatch(/nothing to check/i);
  });
});

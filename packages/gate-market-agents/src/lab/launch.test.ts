import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { checkEndowmentFits, endowmentAllowance, endowmentBound } from "./launch.js";
import { printNano } from "./money.js";

const print = printNano("0.001437"); // illustrative, the one the plan's examples use

describe("the lab's endowment bound (nothing is minted after the opening, D31)", () => {
  it("is four openings, each sized so either asset alone meets every need", () => {
    const b = endowmentBound(print, DEFAULT_PARAMS);
    expect(b.perTraderMilliSiu).toBe(4_318n);
    expect(b.perTraderUsdcMinor).toBe(6_205n);
    expect(b.perTraderUsdcNeededMinor).toBe(6_200n);
    expect(b.totalMilliSiu).toBe(17_272n);
  });

  it("admits the default economy against ISSUER-B's 32,000 mSIU headroom, inside 80% — with room to spare", () => {
    const check = checkEndowmentFits(endowmentBound(print, DEFAULT_PARAMS), 32_000n);
    expect(check).toEqual({ ok: true, allowanceMilliSiu: 25_600n });
    // The reason minting was removed: with it, the worst case adds eight job claims and eight raw-work claims, 17,272 more.
    expect(17_272n + 8n * (1_184n + 975n)).toBe(34_544n);
    expect(34_544n).toBeGreaterThan(32_000n);
  });

  it("refuses a pool too short for the endowment (an earlier run left claims outstanding), naming both figures", () => {
    const check = checkEndowmentFits(endowmentBound(print, DEFAULT_PARAMS), 20_000n);
    expect(endowmentAllowance(20_000n)).toBe(16_000n);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("17272 mSIU");
      expect(check.reason).toContain("ISSUER-B can back 16000");
    }
  });

  it("scales with the schedule: more needs per trader, a bigger opening", () => {
    const more = endowmentBound(print, { ...DEFAULT_PARAMS, needsPerTrader: 3 });
    expect(more.perTraderMilliSiu).toBe(3n * (1_184n + 975n));
  });

  it("refuses to start if USDC alone would not cover every quote", () => {
    const b = endowmentBound(print, DEFAULT_PARAMS);
    const check = checkEndowmentFits({ ...b, perTraderUsdcMinor: b.perTraderUsdcNeededMinor - 1n }, 32_000n);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("USDC alone would not be enough");
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, buildEconomy } from "./economy.js";
import { checkMintsFit, mintAllowance, mintBound } from "./launch.js";
import { printNano } from "./money.js";

const economy = buildEconomy(9);
const print = printNano("0.001437"); // illustrative, the one the plan's examples use

describe("the lab's mint bound", () => {
  it("is the endowment plus, for every need, a job claim and a raw-work claim, each sized as the loop sizes one", () => {
    const b = mintBound(print, economy);
    // 1,700 and 1,400 minor units are what the SDK's quote quantisation gives at this print; the claim is the
    // price's worth at the print, rounded up (loop/parity.ts): 1,700,000,000 / 1,437,000 and 1,400,000,000 / 1,437,000.
    expect(b.jobClaimMilliSiu).toBe(1184n);
    expect(b.rawClaimMilliSiu).toBe(975n);
    expect(b.needs).toBe(8);
    expect(b.openingMilliSiu).toBe(4n * BigInt(DEFAULT_PARAMS.openingMilliSiu));
    expect(b.worstCaseMilliSiu).toBe(b.openingMilliSiu + 8n * (1184n + 975n));
  });

  it("admits the default economy against ISSUER-B's 32,000 mSIU headroom, inside 80%", () => {
    const b = mintBound(print, economy);
    const check = checkMintsFit(b, 32_000n);
    expect(check).toEqual({ ok: true, allowanceMilliSiu: 25_600n });
    expect(b.worstCaseMilliSiu).toBeLessThanOrEqual(25_600n);
  });

  it("refuses an endowment that would not fit — the figure the first draft of the plan used, 4,000 each", () => {
    const heavy = buildEconomy(9, { ...DEFAULT_PARAMS, openingMilliSiu: 4000 });
    const b = mintBound(print, heavy);
    expect(b.worstCaseMilliSiu).toBe(16_000n + 8n * (1184n + 975n)); // 33,272: more than the whole headroom
    const check = checkMintsFit(b, 32_000n);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("33272 mSIU");
      expect(check.reason).toContain("ISSUER-B can back 25600");
    }
  });

  it("refuses a pool that is not whole, however small the economy", () => {
    const b = mintBound(print, economy);
    const check = checkMintsFit(b, 20_000n);
    expect(check.ok).toBe(false);
    expect(mintAllowance(20_000n)).toBe(16_000n);
  });

  it("scales with the number of needs", () => {
    const more = buildEconomy(9, { ...DEFAULT_PARAMS, needsPerTrader: 3 });
    const b = mintBound(print, more);
    expect(b.needs).toBe(12);
    expect(b.worstCaseMilliSiu).toBe(b.openingMilliSiu + 12n * (1184n + 975n));
  });
});

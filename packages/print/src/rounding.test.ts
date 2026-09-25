import { describe, expect, it } from "vitest";
import { D } from "./decimal.js";
import { DEFAULT_ROUNDING, roundDatedSiu, roundSignificantFigures } from "./rounding.js";

describe("roundSignificantFigures", () => {
  it("pads trailing zeros to show exactly N significant figures, not a shorter equal value", () => {
    // The real bug this exists to fix: "0.0014" alone looks like 2 significant figures even
    // when it was actually checked to 4 — the 3rd and 4th digit are genuine zeros, not omitted.
    expect(roundSignificantFigures(new D("0.0014"), 4)).toBe("0.001400");
  });

  it("rounds half-up at the 4th significant figure, real Commodity SIU values", () => {
    // The real value that produced 23 identical published days at 4dp — see docs/methodology.md.
    expect(roundSignificantFigures(new D("0.001414"), 4)).toBe("0.001414");
    expect(roundSignificantFigures(new D("0.0014145"), 4)).toBe("0.001415");
  });

  it("shows a real, non-zero trailing digit rather than truncating it", () => {
    expect(roundSignificantFigures(new D("0.010795"), 4)).toBe("0.01080");
  });

  it("carries a rounding-driven order-of-magnitude shift correctly", () => {
    expect(roundSignificantFigures(new D("0.099995"), 4)).toBe("0.1000");
    expect(roundSignificantFigures(new D("9.9996"), 4)).toBe("10.00");
  });

  it("handles zero without dividing by an undefined exponent", () => {
    expect(roundSignificantFigures(new D("0"), 4)).toBe("0");
  });
});

describe("roundDatedSiu", () => {
  it("uses significant figures when the rounding rule carries dated_siu_sig_figs (DEFAULT_ROUNDING)", () => {
    expect(roundDatedSiu(new D("0.03832605"), DEFAULT_ROUNDING)).toBe("0.03833");
  });

  it("falls back to fixed decimal places for a rounding rule that still carries the legacy dated_siu_dp", () => {
    const legacy = { ...DEFAULT_ROUNDING, dated_siu_dp: 4, dated_siu_sig_figs: undefined };
    expect(roundDatedSiu(new D("0.03832605"), legacy)).toBe("0.0383");
  });
});

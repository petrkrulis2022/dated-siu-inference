import { describe, expect, it } from "vitest";
import { DualRenderer } from "./dual-render.js";

describe("DualRenderer — F3, the integer control arm (spec §7.3)", () => {
  it("renders the SAME value as decimal USD and integer USDC minor units", () => {
    const renderer = new DualRenderer();
    const record = renderer.render("0.00034");
    // The exact pair spec §3.3's own example uses: 0.00034 <-> 340 (a factor of exactly 1e6).
    expect(record.decimalUsd).toBe("0.00034");
    expect(record.integerMinorUnits).toBe("340");
  });

  it("alternates which arm is live on every call, per §7.3's own instruction", () => {
    const renderer = new DualRenderer();
    const first = renderer.render("0.01");
    const second = renderer.render("0.02");
    const third = renderer.render("0.03");
    expect([first.liveArm, second.liveArm, third.liveArm]).toEqual([
      "decimal",
      "integer",
      "decimal",
    ]);
  });

  it("records every render, not just the live arm, for later F3 analysis", () => {
    const renderer = new DualRenderer();
    renderer.render("0.01");
    renderer.render("0.02");
    expect(renderer.allRecords()).toHaveLength(2);
  });

  it("liveValue() returns whichever arm's string was marked live for that record", () => {
    const renderer = new DualRenderer();
    const decimalTurn = renderer.render("0.005"); // liveArm: "decimal"
    const integerTurn = renderer.render("0.005"); // liveArm: "integer"
    expect(renderer.liveValue(decimalTurn)).toBe("0.005");
    expect(renderer.liveValue(integerTurn)).toBe("5000");
  });
});

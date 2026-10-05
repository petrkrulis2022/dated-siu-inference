import { describe, expect, it } from "vitest";
import { untilVisible } from "./until-visible.js";

describe("untilVisible", () => {
  it("returns as soon as the effect shows, however many stale reads came first", async () => {
    const reads = [0n, 0n, 0n, 7n];
    let calls = 0;
    const seen = await untilVisible(async () => reads[Math.min(calls++, reads.length - 1)], (v) => v >= 7n, "the allowance", 1);
    expect(seen).toBe(7n);
    expect(calls).toBe(4);
  });

  it("waits for the EFFECT, not for the value to stop changing: two stale reads agreeing is not enough", async () => {
    // A lagging node serves the pre-write value every time, so two consecutive reads agree and are
    // wrong. Only the expected effect ends the wait.
    let calls = 0;
    await expect(untilVisible(async () => (calls++, 0n), (v) => v > 0n, "the allowance", 1, 5)).rejects.toThrow(
      /the allowance was not visible after 5 reads \(last read: 0\)/,
    );
    expect(calls).toBe(5);
  });

  it("does not fall through to acting on the last value seen when the effect never shows", async () => {
    await expect(untilVisible(async () => "old", (v) => v === "new", "the write", 1, 3)).rejects.toThrow(/not visible/);
  });
});

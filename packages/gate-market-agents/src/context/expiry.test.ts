import { describe, expect, it } from "vitest";
import { computeTimeToExpirySeconds } from "./expiry.js";

describe("computeTimeToExpirySeconds — spec §7.1a", () => {
  it("returns the real remaining seconds when the window is still open", () => {
    expect(computeTimeToExpirySeconds(1000n, 1800n)).toBe(800);
  });

  it("clamps at 0 rather than going negative once the window has closed", () => {
    expect(computeTimeToExpirySeconds(2000n, 1800n)).toBe(0);
  });

  it("returns 0 exactly at the boundary", () => {
    expect(computeTimeToExpirySeconds(1800n, 1800n)).toBe(0);
  });
});

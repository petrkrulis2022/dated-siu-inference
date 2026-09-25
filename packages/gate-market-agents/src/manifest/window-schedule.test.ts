import { describe, expect, it } from "vitest";
import { jobClassesForWindow, shuffledTurnOrder, windowBounds } from "./window-schedule.js";

describe("windowBounds", () => {
  it("computes sequential, non-overlapping windows from a run start and duration", () => {
    const runStart = 1_800_000_000n;
    const durationSeconds = 3600n; // 1 hour, this run's own compressed window length
    expect(windowBounds(runStart, 0, durationSeconds)).toEqual({
      windowIndex: 0,
      windowFrom: 1_800_000_000n,
      windowTo: 1_800_003_600n,
    });
    expect(windowBounds(runStart, 1, durationSeconds)).toEqual({
      windowIndex: 1,
      windowFrom: 1_800_003_600n,
      windowTo: 1_800_007_200n,
    });
    expect(windowBounds(runStart, 2, durationSeconds)).toEqual({
      windowIndex: 2,
      windowFrom: 1_800_007_200n,
      windowTo: 1_800_010_800n,
    });
  });
});

describe("jobClassesForWindow", () => {
  it("is deterministic under the same seed and window index", () => {
    const a = jobClassesForWindow("run-1", 0, 6, 10);
    const b = jobClassesForWindow("run-1", 0, 6, 10);
    expect(a).toEqual(b);
  });

  it("stays within the configured job-count range and alternates class", () => {
    const classes = jobClassesForWindow("run-1", 0, 6, 10);
    expect(classes.length).toBeGreaterThanOrEqual(6);
    expect(classes.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < classes.length; i++) {
      expect(classes[i]).not.toBe(classes[i - 1]);
    }
  });

  it("differs across windows within the same run (a real seed-derived sequence, not one constant)", () => {
    const window0 = jobClassesForWindow("run-1", 0, 6, 10);
    const window1 = jobClassesForWindow("run-1", 1, 6, 10);
    const window2 = jobClassesForWindow("run-1", 2, 6, 10);
    // Not all three identical in both length and starting class — a real derived difference.
    const asStrings = [window0, window1, window2].map((c) => c.join(","));
    expect(new Set(asStrings).size).toBeGreaterThan(1);
  });

  it("differs across seeds for the same window index — the property five future runs need", () => {
    // A handful of seeds, not just two — two arbitrary seeds can coincidentally land on the same
    // (job count, starting class) pair (only ~10 possible combinations here), so the real
    // property under test is "seed genuinely drives the sequence," checked across enough seeds
    // that a coincidental collision on every one of them would be implausible.
    const seeds = ["run-1", "run-2", "run-3", "run-4", "run-5"];
    const sequences = seeds.map((seed) => jobClassesForWindow(seed, 0, 6, 10).join(","));
    expect(new Set(sequences).size).toBeGreaterThan(1);
  });
});

describe("shuffledTurnOrder", () => {
  it("is deterministic under the same seed and window index, and preserves the roster's own members", () => {
    const roster = ["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT"] as const;
    const a = shuffledTurnOrder("run-1", 0, roster);
    const b = shuffledTurnOrder("run-1", 0, roster);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...roster].sort());
  });

  it("differs across windows (a real varying turn order, not a fixed one)", () => {
    const roster = ["ISSUER-A", "ISSUER-B", "ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT", "HEDGER"] as const;
    const orders = [0, 1, 2, 3, 4].map((w) => shuffledTurnOrder("run-1", w, roster).join(","));
    expect(new Set(orders).size).toBeGreaterThan(1);
  });
});

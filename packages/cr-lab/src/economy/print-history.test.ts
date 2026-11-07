import { describe, expect, it } from "vitest";
import { datedSiuToNanoUsdPerSiu, printHistorySchedule } from "./print-history.js";

describe("datedSiuToNanoUsdPerSiu", () => {
  it("converts a decimal USD-per-SIU string to nano-USD-per-SIU exactly, no floats", () => {
    expect(datedSiuToNanoUsdPerSiu("0.0014")).toBe(1_400_000n);
    expect(datedSiuToNanoUsdPerSiu("0.0120")).toBe(12_000_000n);
    expect(datedSiuToNanoUsdPerSiu("1")).toBe(1_000_000_000n);
    expect(datedSiuToNanoUsdPerSiu("0.000000001")).toBe(1n);
  });

  it("refuses more than 9 decimals and a non-decimal string", () => {
    expect(() => datedSiuToNanoUsdPerSiu("0.0000000001")).toThrow();
    expect(() => datedSiuToNanoUsdPerSiu("not a number")).toThrow();
  });
});

describe("printHistorySchedule", () => {
  it("reads the real published prints from 2026-09-02, skipping calendar days missing either grade", () => {
    const sched = printHistorySchedule("2026-09-02", 5);
    expect(sched.size).toBe(5);
    expect(sched.get(1)).toEqual({ commodity: 1_400_000n, frontier: 12_000_000n }); // 2026-09-02's real print
    expect(sched.get(2)?.commodity).toBeGreaterThan(0n); // 2026-09-03 (2026-09-04 is skipped: missing its commodity print)
    for (const k of [1, 2, 3, 4, 5]) {
      const r = sched.get(k);
      expect(r?.commodity).toBeGreaterThan(0n);
      expect(r?.frontier).toBeGreaterThan(0n);
    }
  });

  it("throws rather than invent a day when the real history runs out before windowCount windows are found", () => {
    expect(() => printHistorySchedule("2026-09-02", 1000)).toThrow(/only found/);
  });

  it("throws on a start date with no prints at all, rather than return an empty schedule silently", () => {
    expect(() => printHistorySchedule("1999-01-01", 1)).toThrow(/only found 0 of 1/);
  });
});

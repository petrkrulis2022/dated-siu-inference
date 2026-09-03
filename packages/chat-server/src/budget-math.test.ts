import { describe, expect, it } from "vitest";
import { decideReconciliation, decideReservation, todayUtc } from "./budget-math.js";

const TODAY = "2026-09-03";
const YESTERDAY = "2026-09-02";

describe("decideReservation", () => {
  it("allows a reservation with no prior spend today", () => {
    const result = decideReservation(undefined, TODAY, "0.05", "3.00");
    expect(result).toEqual({
      allowed: true,
      spentTodayUsd: "0.05",
      nextState: { date: TODAY, spentUsd: "0.05" },
    });
  });

  it("accumulates across multiple reservations on the same day", () => {
    const first = decideReservation(undefined, TODAY, "0.05", "3.00");
    const second = decideReservation(first.nextState, TODAY, "0.05", "3.00");
    // decimal.js normalises trailing zeros, so $0.05 + $0.05 prints as "0.1", not "0.10".
    expect(second.spentTodayUsd).toBe("0.1");
  });

  it("refuses once the reservation would exceed the ceiling", () => {
    const stored = { date: TODAY, spentUsd: "2.97" };
    const result = decideReservation(stored, TODAY, "0.05", "3.00");
    expect(result.allowed).toBe(false);
    // Spend is unchanged — a refused reservation must never itself be recorded as spend.
    expect(result.spentTodayUsd).toBe("2.97");
    expect(result.nextState).toEqual(stored);
  });

  it("allows a reservation landing exactly on the ceiling", () => {
    const stored = { date: TODAY, spentUsd: "2.95" };
    const result = decideReservation(stored, TODAY, "0.05", "3.00");
    expect(result.allowed).toBe(true);
    expect(result.spentTodayUsd).toBe("3");
  });

  it("treats a stored total from a prior day as a fresh $0 day", () => {
    const stored = { date: YESTERDAY, spentUsd: "2.99" };
    const result = decideReservation(stored, TODAY, "0.05", "3.00");
    expect(result.allowed).toBe(true);
    expect(result.spentTodayUsd).toBe("0.05");
  });
});

describe("decideReconciliation", () => {
  it("corrects the stored total down when the real cost was less than reserved", () => {
    const stored = { date: TODAY, spentUsd: "0.10" };
    const result = decideReconciliation(stored, TODAY, "0.05", "0.017");
    expect(result.nextState).toEqual({ date: TODAY, spentUsd: "0.067" });
  });

  it("corrects the stored total up when the real cost exceeded the estimate", () => {
    const stored = { date: TODAY, spentUsd: "0.05" };
    const result = decideReconciliation(stored, TODAY, "0.05", "0.08");
    expect(result.nextState).toEqual({ date: TODAY, spentUsd: "0.08" });
  });

  it("floors at zero rather than going negative", () => {
    const stored = { date: TODAY, spentUsd: "0.02" };
    const result = decideReconciliation(stored, TODAY, "0.05", "0");
    expect(result.nextState).toEqual({ date: TODAY, spentUsd: "0" });
  });

  it("is a no-op when the day has rolled over since the reservation", () => {
    const stored = { date: YESTERDAY, spentUsd: "1.50" };
    const result = decideReconciliation(stored, TODAY, "0.05", "0.02");
    expect(result.nextState).toBeUndefined();
  });

  it("is a no-op with nothing stored yet", () => {
    const result = decideReconciliation(undefined, TODAY, "0.05", "0.02");
    expect(result.nextState).toBeUndefined();
  });
});

describe("todayUtc", () => {
  it("formats a Date as UTC YYYY-MM-DD", () => {
    expect(todayUtc(new Date("2026-09-03T23:59:00Z"))).toBe("2026-09-03");
  });
});

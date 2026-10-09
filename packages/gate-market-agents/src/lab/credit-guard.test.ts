import { describe, expect, it } from "vitest";
import { DEFAULT_CYCLE_CAP_USD, checkCreditGuard, cycleStart, spentThisCycle, withSpend, type SpendEntry } from "./credit-guard.js";

const at = (iso: string) => new Date(iso);
const entry = (when: string, usd: string): SpendEntry => ({ at: when, usd, what: "test" });

describe("the cycle the credit renews on the 18th of (D60)", () => {
  it("starts a cycle at 00:00 UTC on the most recent 18th", () => {
    expect(cycleStart(at("2026-10-09T12:00:00Z")).toISOString()).toBe("2026-09-18T00:00:00.000Z");
    expect(cycleStart(at("2026-10-18T00:00:00Z")).toISOString()).toBe("2026-10-18T00:00:00.000Z");
    expect(cycleStart(at("2026-10-17T23:59:59Z")).toISOString()).toBe("2026-09-18T00:00:00.000Z");
    expect(cycleStart(at("2026-01-05T00:00:00Z")).toISOString()).toBe("2025-12-18T00:00:00.000Z");
  });

  it("counts only what was spent inside the current cycle, so a new cycle starts clean", () => {
    const ledger = [entry("2026-09-20T10:00:00Z", "1.5"), entry("2026-10-08T10:00:00Z", "0.25"), entry("2026-10-18T09:00:00Z", "4")];
    expect(spentThisCycle(ledger, at("2026-10-09T00:00:00Z"))).toBe("1.750000");
    expect(spentThisCycle(ledger, at("2026-10-18T10:00:00Z"))).toBe("4.000000");
  });
});

describe("the credit guard", () => {
  const ledger = [entry("2026-10-08T10:00:00Z", "0.156433"), entry("2026-10-09T10:00:00Z", "0.048")];
  const now = at("2026-10-09T12:00:00Z");

  it("allows a spend that stays under the cap and says how much room is left", () => {
    const c = checkCreditGuard({ entries: ledger, now, projectedUsd: "10" });
    expect(c).toEqual({ ok: true, spent: "0.204433", remainingUnderCap: "19.795567" });
  });

  it("refuses a spend that would pass the cap, and the reason carries the figures and what the cap protects", () => {
    const c = checkCreditGuard({ entries: [...ledger, entry("2026-10-09T11:00:00Z", "25")], now, projectedUsd: "6" });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.spent).toBe("25.204433");
      expect(c.reason).toContain("$25.204433 of the $30.00 cap");
      expect(c.reason).toContain("since 2026-09-18");
      expect(c.reason).toContain("the daily print needs");
    }
  });

  it("allows a spend that lands exactly on the cap and refuses one cent over it", () => {
    expect(checkCreditGuard({ entries: [], now, projectedUsd: "30" }).ok).toBe(true);
    expect(checkCreditGuard({ entries: [], now, projectedUsd: "30.01" }).ok).toBe(false);
  });

  it("takes the cap from a setting, and defaults to $30", () => {
    expect(DEFAULT_CYCLE_CAP_USD).toBe("30");
    expect(checkCreditGuard({ entries: [], now, projectedUsd: "5", capUsd: "4" }).ok).toBe(false);
    expect(checkCreditGuard({ entries: [], now, projectedUsd: "5", capUsd: "6" }).ok).toBe(true);
  });

  it("does no float arithmetic: cents add up exactly", () => {
    const many = Array.from({ length: 10 }, () => entry("2026-10-09T01:00:00Z", "0.1"));
    expect(spentThisCycle(many, now)).toBe("1.000000");
  });

  it("refuses to record a negative spend, and never changes the list it is given", () => {
    expect(() => withSpend([], entry("2026-10-09T01:00:00Z", "-1"))).toThrow(/cannot be negative/);
    const before = [entry("2026-10-09T01:00:00Z", "1")];
    const after = withSpend(before, entry("2026-10-09T02:00:00Z", "2"));
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
  });
});

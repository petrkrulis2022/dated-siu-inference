import { describe, expect, it } from "vitest";
import {
  addDays,
  assertDate,
  completeMonthsWindow,
  daysBetween,
  firstOfMonth,
  isDate,
  monthsBefore,
  monthsOf,
  quarterWindow,
  unixAt,
} from "./dates.js";

describe("dates", () => {
  it("accepts only real calendar dates", () => {
    expect(isDate("2026-10-20")).toBe(true);
    expect(isDate("2028-02-29")).toBe(true);
    for (const bad of [
      "2026-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-10-32",
      "26-10-20",
      "2026-1-2",
      "2026-10-20T00:00:00Z",
      " 2026-10-20",
      "",
    ])
      expect(isDate(bad), bad).toBe(false);
    expect(() => assertDate("tomorrow", "start")).toThrow(/start must be a real calendar date/);
  });

  it("adds days across month, year and leap boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-20", -90)).toBe("2026-07-22");
  });

  it("counts the daily points of a half-open window", () => {
    expect(daysBetween("2026-10-01", "2026-11-01")).toBe(31);
    expect(daysBetween("2026-07-01", "2026-10-01")).toBe(92);
    expect(daysBetween("2025-10-01", "2026-10-01")).toBe(365);
    expect(unixAt("1970-01-02")).toBe(86400);
    expect(unixAt("2026-10-20")).toBe(1792454400);
  });

  it("finds the last 12 COMPLETE months: the month in progress is never in the window", () => {
    expect(completeMonthsWindow("2026-10-20")).toEqual({ start: "2025-10-01", end: "2026-10-01" });
    expect(completeMonthsWindow("2026-10-01")).toEqual({ start: "2025-10-01", end: "2026-10-01" });
    expect(completeMonthsWindow("2026-01-15")).toEqual({ start: "2025-01-01", end: "2026-01-01" });
    expect(completeMonthsWindow("2026-03-31", 3)).toEqual({
      start: "2025-12-01",
      end: "2026-03-01",
    });
  });

  it("lists the months of a window, oldest first, each with its own half-open bounds", () => {
    const ms = monthsOf("2025-11-01", "2026-02-01");
    expect(ms.map((m) => m.month)).toEqual(["2025-11", "2025-12", "2026-01"]);
    expect(ms[1]).toEqual({ month: "2025-12", start: "2025-12-01", end: "2026-01-01" });
    expect(monthsOf("2025-10-01", "2026-10-01")).toHaveLength(12);
  });

  it("gives each quarter as a half-open window", () => {
    expect(quarterWindow(2026, 3)).toEqual({ start: "2026-07-01", end: "2026-10-01" });
    expect(quarterWindow(2025, 4)).toEqual({ start: "2025-10-01", end: "2026-01-01" });
    expect(quarterWindow(2026, 1)).toEqual({ start: "2026-01-01", end: "2026-04-01" });
    expect(() => quarterWindow(2026, 5)).toThrow(RangeError);
  });

  it("steps months in both directions", () => {
    expect(monthsBefore("2026-01-31", 1)).toBe("2025-12-01");
    expect(monthsBefore("2026-10-05", -3)).toBe("2027-01-01");
    expect(firstOfMonth("2026-10-20")).toBe("2026-10-01");
  });
});

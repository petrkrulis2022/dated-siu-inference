import { describe, expect, it } from "vitest";
import { D, mean, median } from "./decimal.js";

describe("median", () => {
  it("throws on an empty set — same shape as mean's own guard", () => {
    expect(() => median([])).toThrow(/empty set is undefined/);
  });

  it("returns the single value for a set of one", () => {
    expect(median([new D("5")]).toString()).toBe("5");
  });

  it("returns the middle value for an odd-length set, regardless of input order", () => {
    expect(median([new D("3"), new D("1"), new D("2")]).toString()).toBe("2");
  });

  it("averages the two middle values for an even-length set", () => {
    expect(median([new D("1"), new D("2"), new D("3"), new D("4")]).toString()).toBe("2.5");
  });

  it("never mutates the input array's order", () => {
    const values = [new D("3"), new D("1"), new D("2")];
    median(values);
    expect(values.map((v) => v.toString())).toEqual(["3", "1", "2"]);
  });

  it("differs from mean exactly when a single outlier is present — the property carry-forward relies on", () => {
    const values = ["0.005", "0.0052", "0.0048", "0.05"].map((v) => new D(v));
    expect(mean(values).toString()).not.toBe(median(values).toString());
  });
});

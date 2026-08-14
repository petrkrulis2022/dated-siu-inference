import { describe, expect, it } from "vitest";
import {
  decimalDivide,
  decimalLessThan,
  jsonNumberToDecimalString,
  perTokenToPer1M,
} from "./decimal.js";

describe("perTokenToPer1M", () => {
  it("converts a decimal-string per-token price (OpenRouter's format)", () => {
    expect(perTokenToPer1M("0.000000375")).toBe("0.375");
  });

  it("converts a JSON-number per-token price (LiteLLM's format), including exponential notation", () => {
    expect(perTokenToPer1M(2.5e-6)).toBe("2.5");
    expect(perTokenToPer1M(2.5e-7)).toBe("0.25");
  });

  it("does not accumulate float drift the way plain multiplication would", () => {
    // 0.1 * 3 famously isn't exactly 0.3 in IEEE754 floats; decimal.js must not inherit that.
    expect(perTokenToPer1M("0.0000001")).toBe("0.1");
  });
});

describe("jsonNumberToDecimalString", () => {
  it("round-trips a plain float to its canonical decimal string", () => {
    expect(jsonNumberToDecimalString(1.53)).toBe("1.53");
  });
});

describe("decimalDivide", () => {
  it("divides exactly, accepting numbers or strings", () => {
    expect(decimalDivide(3.204444444444444, 2)).toBe("1.602222222222222");
  });
});

describe("decimalLessThan", () => {
  it("compares by value, not lexicographically", () => {
    expect(decimalLessThan("9.5", "10.2")).toBe(true);
    expect(decimalLessThan("10.2", "9.5")).toBe(false);
  });
});

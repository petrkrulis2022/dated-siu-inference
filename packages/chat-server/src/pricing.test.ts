import { describe, expect, it } from "vitest";
import { callCostUsd } from "./pricing.js";

describe("callCostUsd", () => {
  it("prices input and output tokens separately at the registry's real per-token rates", () => {
    // 1,000 input @ $1/1M + 500 output @ $5/1M = $0.001 + $0.0025 = $0.0035
    expect(callCostUsd({ input_tokens: 1000, output_tokens: 500 })).toBe("0.0035");
  });

  it("returns exactly zero for a zero-usage call", () => {
    expect(callCostUsd({ input_tokens: 0, output_tokens: 0 })).toBe("0");
  });

  it("stays exact for token counts that would lose precision as floats", () => {
    expect(callCostUsd({ input_tokens: 1, output_tokens: 0 })).toBe("0.000001");
  });
});

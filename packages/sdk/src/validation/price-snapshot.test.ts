import { describe, expect, it } from "vitest";
import { validatePriceSnapshot } from "./price-snapshot.js";

describe("validatePriceSnapshot", () => {
  it("accepts a valid snapshot", () => {
    const result = validatePriceSnapshot({
      snapshot_id: "2026-08-14T00:00:00Z-openrouter",
      timestamp: "2026-08-14T00:00:00Z",
      source: "openrouter",
      entries: [
        {
          model_id: "anthropic-sonnet-5",
          price_in_usd_per_1m: "3.00",
          price_out_usd_per_1m: "15.00",
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a price encoded as a JSON number instead of a decimal string", () => {
    const result = validatePriceSnapshot({
      snapshot_id: "2026-08-14T00:00:00Z-openrouter",
      timestamp: "2026-08-14T00:00:00Z",
      source: "openrouter",
      entries: [
        {
          model_id: "anthropic-sonnet-5",
          price_in_usd_per_1m: 3.0,
          price_out_usd_per_1m: "15.00",
        },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects an out-of-enum source", () => {
    const result = validatePriceSnapshot({
      snapshot_id: "2026-08-14T00:00:00Z-guess",
      timestamp: "2026-08-14T00:00:00Z",
      source: "guess",
      entries: [
        {
          model_id: "anthropic-sonnet-5",
          price_in_usd_per_1m: "3.00",
          price_out_usd_per_1m: "15.00",
        },
      ],
    });
    expect(result.valid).toBe(false);
  });
});

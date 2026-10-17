import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MissingKeyError } from "../keys.js";
import { NoTrialKeyForProvider, buildSeats } from "./seats.js";
import { standInAdapter } from "./stand-in-models.js";
import { projectedCostUsd, usageCostUsd } from "./prices.js";

const CR_ENV = {
  CR_ANTHROPIC_API_KEY: "test-anthropic-trial-key",
  CR_OPENAI_API_KEY: "test-openai-trial-key",
};

describe("seats", () => {
  it("pairs each model with its trial key's NAME, its price and an adapter, reading the registry and the newest merged price snapshot", () => {
    const seats = buildSeats(["claude-haiku-4-5", "gpt-5.1"], {
      env: CR_ENV,
      adapterFor: () => standInAdapter("solver"),
    });
    expect(seats.map((s) => [s.modelId, s.provider, s.keyName])).toEqual([
      ["claude-haiku-4-5", "anthropic", "CR_ANTHROPIC_API_KEY"],
      ["gpt-5.1", "openai", "CR_OPENAI_API_KEY"],
    ]);
    expect(seats[0]?.price.priceInUsdPer1M).toMatch(/^\d+(\.\d+)?$/);
    expect(JSON.stringify(seats)).not.toContain("test-anthropic-trial-key");
  });

  it("never falls back to the print's key: a trial key that is unset is an error naming only the variable", () => {
    const env = { ANTHROPIC_API_KEY: "the-prints-key" };
    expect(() =>
      buildSeats(["claude-haiku-4-5"], { env, adapterFor: () => standInAdapter("solver") }),
    ).toThrow(MissingKeyError);
    try {
      buildSeats(["claude-haiku-4-5"], { env, adapterFor: () => standInAdapter("solver") });
    } catch (e) {
      expect(String(e)).toContain("CR_ANTHROPIC_API_KEY");
      expect(String(e)).not.toContain("the-prints-key");
    }
  });

  it("refuses a model whose provider has no trial key, and an unknown model", () => {
    const root = mkdtempSync(join(tmpdir(), "cr-seats-"));
    try {
      mkdirSync(join(root, "registry"));
      writeFileSync(
        join(root, "registry", "models.json"),
        JSON.stringify([
          { id: "m-groq", provider: "groq", model_string: "x/y", sampling: { temperature: 0 } },
        ]),
      );
      writeFileSync(
        join(root, "registry", "price-snapshot-merged-2026-10-01T00-00-00.000Z.json"),
        JSON.stringify({
          snapshot_id: "s",
          timestamp: "t",
          source: "merged",
          entries: [{ model_id: "m-groq", price_in_usd_per_1m: "1", price_out_usd_per_1m: "2" }],
        }),
      );
      expect(() => buildSeats(["m-groq"], { env: CR_ENV, dataRoot: root })).toThrow(
        NoTrialKeyForProvider,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(() => buildSeats(["no-such-model"], { env: CR_ENV })).toThrow(
      /not in the model registry/,
    );
  });

  it("builds the real adapter from the trial key without calling anything", () => {
    const [seat] = buildSeats(["claude-haiku-4-5"], { env: CR_ENV });
    expect(typeof seat?.adapter).toBe("function");
  });
});

describe("what a call costs", () => {
  const price = { priceInUsdPer1M: "1", priceOutUsdPer1M: "5", priceCachedInUsdPer1M: "0.1" };
  it("prices reasoning at the output rate and cached input at its own rate, exactly", () => {
    const c = usageCostUsd(
      { input: 1_000_000, output: 100_000, reasoning: 200_000, cached_input: 500_000 },
      price,
    );
    expect(c.toFixed()).toBe("2.55"); // 1 + (0.3 x 5) + (0.5 x 0.1) = 1 + 1.5 + 0.05
  });
  it("projects the full output allowance plus one retry at the larger reasoning budget", () => {
    const p = projectedCostUsd(1000, 4000, 3, { priceInUsdPer1M: "1", priceOutUsdPer1M: "5" });
    expect(p.toFixed()).toBe("0.082"); // (0.001 + 0.02) + (0.001 + 0.06)
  });
});

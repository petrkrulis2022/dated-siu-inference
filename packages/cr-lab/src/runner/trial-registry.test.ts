/**
 * The trial-only registry (D124): models the Blockworks trial runs that the print's registry does not hold, with list prices of their own, so the print's files are never edited for the trial.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrialRegistryOverlap, loadRegistryAndPrices, priceFor, withTrialOnly } from "./prices.js";
import { requestsThinkingSummary } from "./reasoning.js";
import { buildSeats } from "./seats.js";

describe("the trial-only registry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cr-trial-registry-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const entry = (id: string) => ({
    id,
    provider: "anthropic",
    endpoint: "https://example.invalid/v1/messages",
    model_string: id,
    tier: "mid",
    open_weights: false,
    host: "anthropic",
    sampling: { temperature: "provider-default" },
    notes: "test",
  });
  const price = (id: string) => ({
    model_id: id,
    price_in_usd_per_1m: "0.1",
    price_out_usd_per_1m: "0.5",
  });
  const write = (ids: string[], priceIds: string[] = ids): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "models.json"), JSON.stringify(ids.map(entry)));
    writeFileSync(join(dir, "prices.json"), JSON.stringify({ entries: priceIds.map(price) }));
  };
  const printSide = () => ({
    registry: [entry("print-model")] as never,
    snapshot: { entries: [price("print-model")] } as never,
  });

  it("adds the trial-only models and prices to the print's, leaving the print's in place", () => {
    write(["trial-model"]);
    const { registry, snapshot } = withTrialOnly(printSide().registry, printSide().snapshot, dir);
    expect(registry.map((r) => r.id)).toEqual(["print-model", "trial-model"]);
    expect(priceFor("trial-model", snapshot)).toEqual({
      priceInUsdPer1M: "0.1",
      priceOutUsdPer1M: "0.5",
    });
    expect(priceFor("print-model", snapshot).priceInUsdPer1M).toBe("0.1");
  });

  it("refuses a model that is in both, in the registry or in the prices: the print's entry is never shadowed", () => {
    write(["print-model"]);
    expect(() => withTrialOnly(printSide().registry, printSide().snapshot, dir)).toThrow(
      TrialRegistryOverlap,
    );
    write(["trial-model"], ["print-model"]);
    expect(() => withTrialOnly(printSide().registry, printSide().snapshot, dir)).toThrow(
      TrialRegistryOverlap,
    );
  });

  it("with no trial-only registry the print's registry and prices come back unchanged", () => {
    const p = printSide();
    expect(withTrialOnly(p.registry, p.snapshot, join(dir, "absent"))).toEqual(p);
  });
});

describe("the committed trial-only registry", () => {
  it("is read by the real loader, does not overlap the print's registry, and prices claude-haiku-5-5 at its published rates", () => {
    const { registry, snapshot } = loadRegistryAndPrices();
    const entry = registry.find((r) => r.id === "claude-haiku-5-5");
    expect(entry).toMatchObject({ provider: "anthropic", model_string: "claude-haiku-5-5" });
    // the model rejects non-default sampling, so the registry says the provider's default applies and no temperature is sent
    expect(entry?.sampling).toEqual({ temperature: "provider-default" });
    expect(priceFor("claude-haiku-5-5", snapshot)).toEqual({
      priceInUsdPer1M: "0.1",
      priceOutUsdPer1M: "0.5",
    });
    // the print's models are still there, with their own prices
    expect(priceFor("claude-sonnet-5", snapshot).priceOutUsdPer1M).toBe("10");
  });

  it("builds a seat that sends no temperature and asks for the thinking summary", () => {
    const [seat] = buildSeats(["claude-haiku-5-5"], {
      skipKeys: true,
      adapterFor: () => ({}) as never,
    });
    expect(seat?.params).toMatchObject({
      omit_temperature: true,
      thinking: { mode: "summarized" },
    });
    expect(requestsThinkingSummary("claude-haiku-5-5")).toBe(true);
    expect(requestsThinkingSummary("claude-haiku-4-5-20251001")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { loadPrint, loadRegistry, printsDir } from "./load-inputs.js";
import { buildVerifyInput } from "./verify-support.js";
import { verifyPrint } from "../verify.js";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { afterEach } from "vitest";
import { runsDirFor } from "./load-inputs.js";

/**
 * Regression test for the real bug found live 2026-09-26: every tier-series print (print.series
 * set) had never actually been recomputation-verified, not even once — cli/verify.ts looked up
 * run records by the tier print's own print_id (e.g. "2026-09-14-frontier"), which never has its
 * own manifest (tier prints share the blend's run records, by design — cli/publish.ts's tier
 * loop never passes runsDirPath), so this always threw and silently fell back to a
 * signature-only check. Uses this repo's own real, checked-in data (a real print, the real
 * registry) rather than a synthetic fixture, because the bug was specifically about how this
 * function interacts with the real on-disk shape of data/prints and data/runs.
 */
describe("buildVerifyInput — tier series print", () => {
  it("loads run records from the underlying blended print_id, not the tier print's own", async () => {
    const print = await loadPrint(join(printsDir(), "2026-09-14-frontier.json"));
    expect(print.series).toBe("frontier");

    const { input, loadErrorMessage } = await buildVerifyInput(print);
    expect(loadErrorMessage).toBeUndefined();
    expect(input).toBeDefined();
    // Real regression: before the fix, this always threw "no run manifest" for
    // "2026-09-14-frontier" specifically, caught by the caller and silently downgraded.
    expect(input!.models.length).toBeGreaterThan(0);
  });

  it("filters models to this tier's own registered set — never prices a commodity model into a Frontier SIU recompute", async () => {
    const print = await loadPrint(join(printsDir(), "2026-09-14-frontier.json"));
    const registry = await loadRegistry();
    const openWeightsById = new Map(registry.map((r) => [r.id, r.open_weights]));

    const { input } = await buildVerifyInput(print);
    for (const model of input!.models) {
      expect(openWeightsById.get(model.model_id)).toBe(false); // frontier = not open-weight
    }
  });

  it("commodity tier print filters the other way", async () => {
    const print = await loadPrint(join(printsDir(), "2026-09-14-commodity.json"));
    const registry = await loadRegistry();
    const openWeightsById = new Map(registry.map((r) => [r.id, r.open_weights]));

    const { input } = await buildVerifyInput(print);
    for (const model of input!.models) {
      expect(openWeightsById.get(model.model_id)).toBe(true);
    }
  });

  it("the blend itself (no series) is unaffected — uses its own print_id directly", async () => {
    const print = await loadPrint(join(printsDir(), "2026-09-14.json"));
    expect(print.series).toBeUndefined();
    const { input, loadErrorMessage } = await buildVerifyInput(print);
    expect(loadErrorMessage).toBeUndefined();
    expect(input!.models.length).toBeGreaterThan(0);
  });
});

/**
 * Regression test for the 2026-09-27 fix: "verify each print under its own methodology revision"
 * extended from rounding (already correct) to the two cost-formula bugs — reasoning-token pricing
 * and cached-input pricing — that used to require a 40-entry allowlist of known divergences.
 * These two real, historical prints are exactly the ones that motivated the fix: 2026-09-08 is
 * the day the reasoning-token gap was found (still itself affected, per its own correction note);
 * 2026-09-25 is the last day still affected by the cached-input gap. Both must now recompute to
 * an EXACT match — no discrepancies, no allowlist entry needed — using this repo's own real,
 * checked-in data, not a synthetic fixture, because the bug was specifically about reproducing
 * real historical prints.
 */
describe("buildVerifyInput — a sibling artifact in the run directory (2026-09-28 fix)", () => {
  const SPEND_FILE = join(runsDirFor("2026-09-26"), "spend-by-provider.json");

  afterEach(async () => {
    await rm(SPEND_FILE, { force: true });
  });

  it("does not flag spend-by-provider.json as an undeclared run record — the real bug that failed verify on the first carry-forward print, 2026-09-28", async () => {
    // The exact file publish-unattended.ts writes, sibling to the manifest, right after
    // publishPrint returns — never part of the declared run_records list, and never should be.
    await writeFile(
      SPEND_FILE,
      JSON.stringify({ print_id: "2026-09-26", date: "2026-09-26", spend_usd_by_provider: {} }),
      "utf-8",
    );

    const print = await loadPrint(join(printsDir(), "2026-09-26.json"));
    const { input, manifestDiscrepancy, loadErrorMessage } = await buildVerifyInput(print);
    expect(loadErrorMessage).toBeUndefined();
    expect(manifestDiscrepancy).toBeUndefined();
    const result = verifyPrint(print, input);
    expect(result.discrepancies).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("buildVerifyInput — historical pricing rules (2026-09-27 fix)", () => {
  it("2026-09-08 (reasoning-token pricing gap) verifies with an exact match", async () => {
    const print = await loadPrint(join(printsDir(), "2026-09-08.json"));
    const { input, loadErrorMessage } = await buildVerifyInput(print);
    expect(loadErrorMessage).toBeUndefined();
    const result = verifyPrint(print, input);
    expect(result.discrepancies).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("2026-09-25 (cached-input pricing gap) verifies with an exact match", async () => {
    const print = await loadPrint(join(printsDir(), "2026-09-25.json"));
    const { input, loadErrorMessage } = await buildVerifyInput(print);
    expect(loadErrorMessage).toBeUndefined();
    const result = verifyPrint(print, input);
    expect(result.discrepancies).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("2026-09-26 (first print with both fixes genuinely live) still verifies with an exact match", async () => {
    const print = await loadPrint(join(printsDir(), "2026-09-26.json"));
    const { input, loadErrorMessage } = await buildVerifyInput(print);
    expect(loadErrorMessage).toBeUndefined();
    const result = verifyPrint(print, input);
    expect(result.discrepancies).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

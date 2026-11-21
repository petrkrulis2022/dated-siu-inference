import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { correctionInput, nextRevisionId, CORRECTION_RULES_REVISION } from "./correction.js";
import type { PrintInput } from "./compute/index.js";

describe("nextRevisionId", () => {
  it("numbers a correction after its original, keeping the series suffix", () => {
    expect(nextRevisionId("2026-11-17")).toBe("2026-11-17b");
    expect(nextRevisionId("2026-11-17-commodity")).toBe("2026-11-17b-commodity");
    expect(nextRevisionId("2026-11-18b")).toBe("2026-11-18c");
    expect(nextRevisionId("2026-11-18b-frontier")).toBe("2026-11-18c-frontier");
  });

  it("refuses an id it cannot number", () => {
    expect(() => nextRevisionId("latest")).toThrow(/latest/);
    expect(() => nextRevisionId("2026-11-18z")).toThrow(/2026-11-18z/);
  });
});

describe("correctionInput", () => {
  const original = {
    print_id: "2026-11-17-commodity",
    methodology_revision: "rules-2026-09-26",
    basket_costs: [
      { model_id: "deepseek-v3.2", cost_usd: "0.001813" },
      { model_id: "qwen-2.5-72b-instruct", cost_usd: "0.001995" },
      { model_id: "gone", excluded_reason: "undefined class" },
    ],
  } as unknown as Print;
  const model = (model_id: string) => ({ model_id, price: { price_in_usd_per_1m: "1", price_out_usd_per_1m: "1" }, records: [] });
  const recomputed = {
    print_id: "2026-11-17-commodity",
    models: [model("deepseek-v3.2"), model("qwen-2.5-72b-instruct"), model("gone"), model("mistral-small-3.2-24b-deepinfra")],
  } as unknown as PrintInput;

  it("recomputes under the rule the original failed to apply, as the next numbered revision", () => {
    const input = correctionInput(original, recomputed);
    expect(input.print_id).toBe("2026-11-17b-commodity");
    expect(input.methodology_revision).toBe(CORRECTION_RULES_REVISION);
    expect(input.billedCostWhereReported).toBe(true);
  });

  it("counts each cached token once (rules-2026-11-21) as well as pricing each call at its billed figure", () => {
    expect(CORRECTION_RULES_REVISION).toBe("rules-2026-11-21");
    expect(correctionInput(original, recomputed).cachedTokensCountedOnce).toBe(true);
  });

  it("keeps the original's own weighting and carry-forward rules: a correction changes only how calls are priced", () => {
    // The recomputation is built under the correction's own revision, which turns on every later rule; the correction keeps only the pricing ones.
    const history = [{ date: "2026-09-25", records: new Map() }];
    const built = { ...recomputed, print_id: "x", weightByModelFamily: true, carryForwardHistory: history } as PrintInput;
    const blend = (id: string, revision: string) => ({ ...original, print_id: id, methodology_revision: revision }) as Print;

    // Computed under rules-2026-09-25 although dated 2026-09-26: neither carry-forward nor family weighting applied.
    const sept26 = correctionInput(blend("2026-09-26", "rules-2026-09-25"), built);
    expect(sept26.weightByModelFamily).toBeUndefined();
    expect(sept26.carryForwardHistory).toBeUndefined();

    // rules-2026-09-26: carry-forward, per-entry weights.
    const oct = correctionInput(blend("2026-10-20", "rules-2026-09-26"), built);
    expect(oct.weightByModelFamily).toBeUndefined();
    expect(oct.carryForwardHistory).toBe(history);

    // rules-2026-11-18 on: both.
    const nov = correctionInput(blend("2026-11-19", "rules-2026-11-18"), built);
    expect(nov.weightByModelFamily).toBe(true);
    expect(nov.carryForwardHistory).toBe(history);
  });

  it("keeps exactly the original's constituents, never one admitted to the registry after it was published", () => {
    const input = correctionInput(original, recomputed);
    expect(input.models.map((m) => m.model_id)).toEqual(["deepseek-v3.2", "qwen-2.5-72b-instruct", "gone"]);
  });
});

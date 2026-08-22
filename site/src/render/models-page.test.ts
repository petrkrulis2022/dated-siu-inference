import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { renderModelsPage } from "./models-page.js";

function print(overrides: Partial<Print> = {}): Print {
  return {
    version: "SIU-2026a",
    print_id: "2026-08-18",
    date: "2026-08-18",
    status: "provisional",
    basket_costs: [{ model_id: "A", cost_usd: "0.001" }],
    weights: { source: "equal", values: [{ model_id: "A", weight: "1" }] },
    dated_siu: "0.0015",
    exchange_rate_table: [
      { model_id: "A", usd_per_siu: "0.0015", spread_to_index: "0", siu_per_usd: "666.7" },
    ],
    sensitivity_block: [],
    rounding: {
      dated_siu_dp: 4,
      basket_cost_dp: 6,
      usd_per_siu_dp: 4,
      spread_dp: 4,
      siu_per_usd_dp: 1,
      mode: "ROUND_HALF_UP",
      siu_per_usd_mode: "ROUND_DOWN",
    },
    cost_of_production_usd: "0.1",
    price_snapshot_ref: "snap-1",
    methodology_version: "v0-draft",
    signature: `0x${"ab".repeat(64)}`,
    public_key: `0x${"cd".repeat(33)}`,
    ...overrides,
  } as Print;
}

describe("renderModelsPage", () => {
  it("states plainly that no model has appeared yet", () => {
    const html = renderModelsPage({ allPrints: [], gateHistory: {}, basePath: "../" });
    expect(html).toContain("No model has appeared");
  });

  it("with one print, shows the table but not a faked chart", () => {
    const html = renderModelsPage({ allPrints: [print({})], gateHistory: {}, basePath: "../" });
    expect(html).toContain("A"); // model id in the table
    expect(html).not.toContain("<svg");
    expect(html).toContain("appears once a second print exists");
  });

  it("with two prints, draws a per-model chart", () => {
    const html = renderModelsPage({
      allPrints: [
        print({
          print_id: "2026-08-11",
          date: "2026-08-11",
          exchange_rate_table: [
            { model_id: "A", usd_per_siu: "0.0020", spread_to_index: "0", siu_per_usd: "500" },
          ] as Print["exchange_rate_table"],
        }),
        print({
          print_id: "2026-08-18",
          date: "2026-08-18",
          exchange_rate_table: [
            { model_id: "A", usd_per_siu: "0.0015", spread_to_index: "0", siu_per_usd: "666.7" },
          ] as Print["exchange_rate_table"],
        }),
      ],
      gateHistory: {},
      basePath: "../",
    });
    expect(html).toContain("<svg");
    expect(html).toContain("<polyline");
  });

  it("renders an excluded model row with its reason, not silently dropped", () => {
    const html = renderModelsPage({
      allPrints: [
        print({
          exchange_rate_table: [
            { model_id: "B", excluded_reason: "undefined class: T2 (no run records)" },
          ] as Print["exchange_rate_table"],
        }),
      ],
      gateHistory: {},
      basePath: "../",
    });
    expect(html).toContain("undefined class: T2");
    expect(html).toMatch(/class="excluded"/);
  });

  it("renders gate pass/fail history when present, and a plain note when absent", () => {
    const withGates = renderModelsPage({
      allPrints: [print({})],
      gateHistory: { A: [{ print_id: "2026-08-18", task_class: "T1", passed: true }] },
      basePath: "../",
    });
    expect(withGates).toContain("T1");
    expect(withGates).toContain("pass");

    const withoutGates = renderModelsPage({
      allPrints: [print({})],
      gateHistory: {},
      basePath: "../",
    });
    expect(withoutGates).toContain("No run records yet");
  });
});

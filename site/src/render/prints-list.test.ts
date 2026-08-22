import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { renderPrintsList } from "./prints-list.js";

const CHAIN = {
  attestationAddress: "0xF60701793eD168ffd6e818e1DCcb600393297190",
  publisherAddress: "0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a",
  explorerBaseUrl: "https://base-sepolia.blockscout.com",
};

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
    anchor: { chain: "base-sepolia", status: "anchored", tx_hash: `0x${"11".repeat(32)}` },
    ...overrides,
  } as Print;
}

describe("renderPrintsList", () => {
  it("states plainly that no print exists yet", () => {
    const html = renderPrintsList({ allPrints: [], basePath: "../", chain: CHAIN });
    expect(html).toContain("No print has been published yet");
  });

  it("lists every print newest first with its columns and detail link", () => {
    const html = renderPrintsList({
      allPrints: [
        print({ print_id: "2026-08-04", date: "2026-08-04", status: "final" }),
        print({ print_id: "2026-08-18", date: "2026-08-18", status: "provisional" }),
      ],
      basePath: "../",
      chain: CHAIN,
    });
    const firstRowIndex = html.indexOf("2026-08-18");
    const secondRowIndex = html.indexOf("2026-08-04");
    expect(firstRowIndex).toBeGreaterThan(-1);
    expect(secondRowIndex).toBeGreaterThan(firstRowIndex); // newest first
    expect(html).toContain('href="../prints/2026-08-18.html"');
    expect(html).toContain("equal");
    expect(html).toContain("v0-draft");
  });

  it("links the anchor tx to the block explorer", () => {
    const html = renderPrintsList({ allPrints: [print({})], basePath: "../", chain: CHAIN });
    expect(html).toContain(`${CHAIN.explorerBaseUrl}/tx/0x${"11".repeat(32)}`);
  });

  it("links each row by print_id, not date — two prints sharing a date never collide", () => {
    // Exactly the real incident: a same-day re-run under a different print_id. Linking by date
    // alone would send both rows to the same detail page.
    const html = renderPrintsList({
      allPrints: [
        print({ print_id: "2026-08-22", date: "2026-08-22", dated_siu: "0.0007" }),
        print({ print_id: "2026-08-22b", date: "2026-08-22", dated_siu: "0.0014" }),
      ],
      basePath: "../",
      chain: CHAIN,
    });
    expect(html).toContain('href="../prints/2026-08-22.html"');
    expect(html).toContain('href="../prints/2026-08-22b.html"');
  });

  it("marks a superseded print distinctly, with the reason and a link to its successor", () => {
    const html = renderPrintsList({
      allPrints: [
        print({
          print_id: "2026-08-22",
          date: "2026-08-22",
          superseded_by: {
            print_id: "2026-08-22b",
            reason: "Insufficient qualifying set: only 2 of 6 models qualified.",
          },
        }),
        print({ print_id: "2026-08-22b", date: "2026-08-22" }),
      ],
      basePath: "../",
      chain: CHAIN,
    });
    expect(html).toContain('class="superseded"');
    expect(html).toContain(">superseded<");
    expect(html).toContain('href="../prints/2026-08-22b.html"');
    expect(html).toContain("Insufficient qualifying set");
  });

  it("shows an unanchored print's status rather than fabricating a tx link", () => {
    const html = renderPrintsList({
      allPrints: [print({ anchor: { chain: "base-sepolia", status: "stub" } })],
      basePath: "../",
      chain: CHAIN,
    });
    expect(html).toContain("stub");
    expect(html).not.toContain(`${CHAIN.explorerBaseUrl}/tx/`);
  });
});

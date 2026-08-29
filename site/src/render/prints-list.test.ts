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

  it("lists a day the scheduled run failed, linking to the actual failed run", () => {
    const html = renderPrintsList({
      allPrints: [],
      incidents: [
        {
          date: "2026-08-25",
          run_url: "https://github.com/petrkrulis2022/dated-siu-inference/actions/runs/32793706266",
          reason: "Refusing to publish: only 3 of 5 registered models qualified (minimum 4).",
          occurred_at: "2026-08-25T00:33:35Z",
        },
      ],
      basePath: "../",
      chain: CHAIN,
    });
    expect(html).toContain('class="incident"');
    expect(html).toContain(
      'href="https://github.com/petrkrulis2022/dated-siu-inference/actions/runs/32793706266"',
    );
    expect(html).toContain("no print — run failed");
    expect(html).toContain("only 3 of 5 registered models qualified");
    expect(html).not.toContain("No print has been published yet");
  });

  it("shows the per-model infrastructure-failure breakdown when the incident carries one", () => {
    const html = renderPrintsList({
      allPrints: [],
      incidents: [
        {
          date: "2026-08-27",
          run_url: "https://github.com/petrkrulis2022/dated-siu-inference/actions/runs/33031864314",
          reason: "Refusing to publish: only 3 of 6 registered models qualified (minimum 4).",
          infra_failures:
            "25 instance(s) had an infrastructure failure and produced no run record:\n  deepseek-v3.2 / T2: 10x rate_limit",
          occurred_at: "2026-08-27T02:03:11Z",
        },
      ],
      basePath: "../",
      chain: CHAIN,
    });
    expect(html).toContain('class="infra-breakdown"');
    expect(html).toContain("deepseek-v3.2 / T2: 10x rate_limit");
  });

  it("omits the breakdown block when the incident has none", () => {
    const html = renderPrintsList({
      allPrints: [],
      incidents: [
        {
          date: "2026-08-22",
          run_url: "https://github.com/petrkrulis2022/dated-siu-inference/actions/runs/1",
          reason: "insufficient balance",
          occurred_at: "2026-08-22T00:00:00Z",
        },
      ],
      basePath: "../",
      chain: CHAIN,
    });
    expect(html).not.toContain('class="infra-breakdown"');
  });

  it("interleaves a missed day with real prints in date order, not appended at the end", () => {
    const html = renderPrintsList({
      allPrints: [
        print({ print_id: "2026-08-24", date: "2026-08-24" }),
        print({ print_id: "2026-08-18", date: "2026-08-18" }),
      ],
      incidents: [
        {
          date: "2026-08-25",
          run_url: "https://github.com/petrkrulis2022/dated-siu-inference/actions/runs/1",
          reason: "insufficient balance",
          occurred_at: "2026-08-25T00:00:00Z",
        },
      ],
      basePath: "../",
      chain: CHAIN,
    });
    const incidentIndex = html.indexOf("25 Aug 2026");
    const latestPrintIndex = html.indexOf("24 Aug 2026");
    const oldestPrintIndex = html.indexOf("18 Aug 2026");
    expect(incidentIndex).toBeGreaterThan(-1);
    expect(latestPrintIndex).toBeGreaterThan(incidentIndex); // newest first: the miss sorts above it
    expect(oldestPrintIndex).toBeGreaterThan(latestPrintIndex);
  });
});

import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { renderPrintPage } from "./print-page.js";

function basePrint(overrides: Partial<Print> = {}): Print {
  return {
    version: "SIU-2026a",
    print_id: "2026-08-15",
    date: "2026-08-15",
    status: "provisional",
    basket_costs: [{ model_id: "A", cost_usd: "0.001" }],
    weights: { source: "equal", values: [{ model_id: "A", weight: "1" }] },
    dated_siu: "0.0019",
    exchange_rate_table: [
      { model_id: "A", usd_per_siu: "0.0019", spread_to_index: "0", siu_per_usd: "526.3" },
    ],
    sensitivity_block: [{ policy_variant: "none", dated_siu: "0.0019", delta: "0" }],
    rounding: {
      dated_siu_dp: 4,
      basket_cost_dp: 6,
      usd_per_siu_dp: 4,
      spread_dp: 4,
      siu_per_usd_dp: 1,
      mode: "ROUND_HALF_UP",
      siu_per_usd_mode: "ROUND_DOWN",
    },
    cost_of_production_usd: "0.06",
    price_snapshot_ref: "snap-1",
    methodology_version: "v0-draft",
    signature: `0x${"ab".repeat(64)}`,
    public_key: `0x${"cd".repeat(33)}`,
    ...overrides,
  } as Print;
}

const RUNS_BASE = "https://github.com/example/repo/tree/main/data/runs";
const CHAIN = {
  attestationAddress: "0xF60701793eD168ffd6e818e1DCcb600393297190",
  publisherAddress: "0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a",
  explorerBaseUrl: "https://base-sepolia.blockscout.com",
};

describe("renderPrintPage", () => {
  it("shows a non-alarming, factual note when the price fell", () => {
    const html = renderPrintPage({
      print: basePrint({ print_id: "2026-08-15", date: "2026-08-15", dated_siu: "0.0019" }),
      allPrints: [
        { print_id: "2026-08-14", date: "2026-08-14", status: "provisional", dated_siu: "0.0022" },
        { print_id: "2026-08-15", date: "2026-08-15", status: "provisional", dated_siu: "0.0019" },
      ],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain("▼");
    expect(html).toContain("Cheaper than the previous print");
    expect(html).toContain("expected direction for this index over time");
    // The word "loss" or any red/alarm framing must never appear.
    expect(html.toLowerCase()).not.toMatch(/loss|decline|drop(?!down)|alarm/);
  });

  it("states a rise plainly, without celebratory or alarming language", () => {
    const html = renderPrintPage({
      print: basePrint({ print_id: "2026-08-15", date: "2026-08-15", dated_siu: "0.0025" }),
      allPrints: [
        { print_id: "2026-08-14", date: "2026-08-14", status: "provisional", dated_siu: "0.0019" },
        { print_id: "2026-08-15", date: "2026-08-15", status: "provisional", dated_siu: "0.0025" },
      ],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain("▲");
    expect(html).toContain("More expensive than the previous print");
  });

  it("omits the change note entirely for the first print", () => {
    const html = renderPrintPage({
      print: basePrint(),
      allPrints: [
        { print_id: "2026-08-15", date: "2026-08-15", status: "provisional", dated_siu: "0.0019" },
      ],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).not.toContain("change-note");
  });

  it("renders an excluded model as a gap row with its stated reason, not silently dropped", () => {
    const html = renderPrintPage({
      print: basePrint({
        exchange_rate_table: [
          { model_id: "A", usd_per_siu: "0.0019", spread_to_index: "0", siu_per_usd: "526.3" },
          { model_id: "D", excluded_reason: "undefined class: T3 (all instances failed)" },
        ] as Print["exchange_rate_table"],
      }),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain("D");
    expect(html).toContain("undefined class: T3");
    expect(html).toMatch(/class="excluded"/);
  });

  it("states the floor is not yet published rather than fabricating one", () => {
    const html = renderPrintPage({
      print: basePrint(),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain("Not yet published");
  });

  it("renders a real floor and market spread when present", () => {
    const html = renderPrintPage({
      print: basePrint({
        floor: { value: "0.0005", notes: "reference config" },
        market_spread: "3.8",
      }),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain("$0.0005");
    expect(html).toContain("reference config");
    expect(html).toContain("3.8×");
  });

  it("labels an unanchored (stub) print honestly rather than fabricating a transaction", () => {
    const html = renderPrintPage({
      print: basePrint({
        anchor: { chain: "base", status: "stub", notes: "no on-chain call was made" },
      }),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain("not yet anchored");
    expect(html).not.toMatch(/0x0{10,}/); // never a fabricated-looking all-zero hash
  });

  it("links archive entries by print_id, not date — two prints sharing a date never collide", () => {
    // Exactly the real incident: a same-day re-run under a different print_id.
    const html = renderPrintPage({
      print: basePrint({ print_id: "2026-08-22b", date: "2026-08-22" }),
      allPrints: [
        { print_id: "2026-08-22", date: "2026-08-22", status: "provisional", dated_siu: "0.0007" },
        { print_id: "2026-08-22b", date: "2026-08-22", status: "provisional", dated_siu: "0.0014" },
      ],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain('href="prints/2026-08-22.html"');
    expect(html).not.toContain('href="prints/2026-08-22b.html"'); // current print excluded
  });

  it("links to the raw runs for this print's id", () => {
    const html = renderPrintPage({
      print: basePrint({ print_id: "2026-08-15" }),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain(`${RUNS_BASE}/2026-08-15`);
  });

  it("lists every other print as an archive, excluding the current one", () => {
    const html = renderPrintPage({
      print: basePrint({ print_id: "2026-08-15" }),
      allPrints: [
        { print_id: "2026-08-13", date: "2026-08-13", status: "final", dated_siu: "0.0020" },
        { print_id: "2026-08-14", date: "2026-08-14", status: "provisional", dated_siu: "0.0022" },
        { print_id: "2026-08-15", date: "2026-08-15", status: "provisional", dated_siu: "0.0019" },
      ],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain("All prints");
    expect(html).toContain("2026-08-13.html");
    expect(html).toContain("2026-08-14.html");
    // Current print doesn't link to itself in the archive list.
    const archiveSection = html.slice(html.indexOf("All prints"));
    expect(archiveSection).not.toContain("2026-08-15.html");
  });

  it("escapes a hostile model_id rather than injecting it into the page", () => {
    const html = renderPrintPage({
      print: basePrint({
        exchange_rate_table: [
          {
            model_id: "<img src=x onerror=alert(1)>",
            usd_per_siu: "0.001",
            spread_to_index: "0",
            siu_per_usd: "1000",
          },
        ] as Print["exchange_rate_table"],
      }),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).not.toContain("<img src=x onerror=");
    expect(html).toContain("&lt;img");
  });

  it("shows the truncated signature and public key, not the raw full-length string inline", () => {
    const html = renderPrintPage({
      print: basePrint(),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain("…"); // truncation marker present for the long hex fields
  });

  it("shows a supersession notice on the superseded print's own page, with reason and successor link", () => {
    const html = renderPrintPage({
      print: basePrint({
        print_id: "2026-08-22",
        superseded_by: {
          print_id: "2026-08-22b",
          reason: "Insufficient qualifying set: only 2 of 6 models qualified.",
        },
      }),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain("Superseded");
    expect(html).toContain("Insufficient qualifying set");
    expect(html).toContain('href="prints/2026-08-22b.html"');
  });

  it("shows no supersession notice for a standing (non-superseded) print", () => {
    const html = renderPrintPage({
      print: basePrint(),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).not.toContain("Superseded");
  });

  it("links an anchored tx to the chain's block explorer, not a plain unlinked string", () => {
    const html = renderPrintPage({
      print: basePrint({
        anchor: { chain: "base-sepolia", status: "anchored", tx_hash: `0x${"11".repeat(32)}` },
      }),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain(`<a href="${CHAIN.explorerBaseUrl}/tx/0x${"11".repeat(32)}"`);
  });

  it("renders a verify-yourself block naming the contract and giving independent-check steps", () => {
    const html = renderPrintPage({
      print: basePrint(),
      allPrints: [],
      basePath: "",
      runsBaseUrl: RUNS_BASE,
      chain: CHAIN,
    });
    expect(html).toContain("Verify this yourself");
    expect(html).toContain(`${CHAIN.explorerBaseUrl}/address/${CHAIN.attestationAddress}`);
    expect(html).toContain("publisher()");
    expect(html).toContain("postedAt(bytes32)");
  });
});

import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import {
  renderLlmsTxt,
  renderMcpJson,
  siuPricesFromPrints,
  toolPriceLabel,
} from "./tool-prices.js";

const commodity = (id: string, date: string, extra: Record<string, unknown> = {}) =>
  ({
    version: "SIU-2026a",
    print_id: id,
    date,
    series: "commodity",
    dated_siu: "0.001409",
    methodology_version: "v0-draft",
    ...extra,
  }) as unknown as Print;

const NOON = new Date("2026-11-26T12:00:00Z");
const PRINTS = [
  commodity("2026-11-25-commodity", "2026-11-25", { dated_siu: "0.0014" }),
  commodity("2026-11-26-commodity", "2026-11-26"),
  {
    print_id: "2026-11-26",
    date: "2026-11-26",
    dated_siu: "0.009664",
    methodology_version: "v0-draft",
  } as unknown as Print,
];

describe("siuPricesFromPrints", () => {
  it("prices each paid tool at the newest Commodity print that nothing supersedes", () => {
    const siu = siuPricesFromPrints(PRINTS, NOON);
    expect(siu.get_quote?.price_msiu).toBe("710");
    expect(siu.verify_receipt?.price_msiu).toBe("7097");
    expect(siu.get_quote?.print_id).toBe("2026-11-26-commodity");
  });

  it("states no SIU price when the newest Commodity print is superseded or too old", () => {
    const superseded = [
      commodity("2026-11-26-commodity", "2026-11-26", {
        superseded_by: { print_id: "x", reason: "y" },
      }),
    ];
    expect(siuPricesFromPrints(superseded, NOON).get_quote).toBeUndefined();
    expect(siuPricesFromPrints(PRINTS, new Date("2026-12-10T00:00:00Z")).get_quote).toBeUndefined();
    expect(siuPricesFromPrints([], NOON).convert).toBeUndefined();
  });
});

describe("toolPriceLabel", () => {
  it("is 'free' for get_index and the shared price label for a paid tool", () => {
    const siu = siuPricesFromPrints(PRINTS, NOON);
    expect(toolPriceLabel("get_index", siu)).toBe("free");
    expect(toolPriceLabel("get_quote", siu)).toBe(
      "$0.001 USDC (710 mSIU at the 2026-11-26 Commodity print)",
    );
    expect(toolPriceLabel("verify_receipt", {})).toBe("$0.01 USDC");
  });
});

describe("renderMcpJson", () => {
  const template = {
    name: "touchstone",
    tools: [
      { name: "get_index", price_usd: "0", free: true },
      { name: "get_quote", price_usd: "stale", free: false },
      { name: "verify_receipt", price_usd: "0.01", free: false, price_msiu: "1" },
    ],
  };

  it("takes every paid price from the shared table and adds the mSIU figure with its basis", () => {
    const out = JSON.parse(renderMcpJson(template, siuPricesFromPrints(PRINTS, NOON)));
    expect(out.name).toBe("touchstone");
    expect(out.tools[0]).toEqual({ name: "get_index", price_usd: "0", free: true });
    expect(out.tools[1]).toMatchObject({
      name: "get_quote",
      price_usd: "0.001",
      price_msiu: "710",
      siu_price: {
        grade: "commodity",
        rate_usd_per_siu: "0.001409",
        print_id: "2026-11-26-commodity",
        print_date: "2026-11-26",
      },
    });
    expect(out.tools[1].siu_price.rule).toMatch(/daily print.*7 days/);
  });

  it("drops any mSIU figure when there is no SIU price, rather than leave a stale one", () => {
    const out = JSON.parse(renderMcpJson(template, {}));
    expect(out.tools[2]).toEqual({ name: "verify_receipt", price_usd: "0.01", free: false });
  });
});

describe("renderLlmsTxt", () => {
  it("fills each price placeholder from the shared label", () => {
    const text =
      "- get_quote — {{price:get_quote}} — x\n- verify_receipt — {{price:verify_receipt}}\n";
    expect(renderLlmsTxt(text, siuPricesFromPrints(PRINTS, NOON))).toBe(
      "- get_quote — $0.001 USDC (710 mSIU at the 2026-11-26 Commodity print) — x\n- verify_receipt — $0.01 USDC (7097 mSIU at the 2026-11-26 Commodity print)\n",
    );
  });

  it("refuses an unknown placeholder, so a typo fails the build instead of shipping", () => {
    expect(() => renderLlmsTxt("{{price:get_quotes}}", {})).toThrow(/get_quotes/);
  });
});

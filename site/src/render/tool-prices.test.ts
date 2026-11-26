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
    expect(out.tools[2].price_msiu).toBeUndefined();
    expect(out.tools[2].siu_price).toBeUndefined();
    expect(out.tools[2].price_usd).toBe("0.01");
  });

  it("states payment from the shared facts: Base and Arc mainnet USDC, the route, the SIU price docs", () => {
    const stale = {
      ...template,
      network: { chain: "base-sepolia" },
      settlement: { asset: "usdc" },
    };
    const out = JSON.parse(renderMcpJson(stale, {}));
    expect(out.network).toBeUndefined();
    expect(out.settlement).toBeUndefined();
    expect(out.payment.networks).toEqual([
      {
        name: "Base",
        eip155: "eip155:8453",
        asset: "USDC",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      {
        name: "Arc",
        eip155: "eip155:5042",
        asset: "USDC",
        address: "0x3600000000000000000000000000000000000000",
      },
    ]);
    expect(out.payment.route).toMatch(/Circle Gateway/);
    expect(out.payment.siu_price.docs).toMatch(/#the-siu-price-in-every-402$/);
    expect(JSON.stringify(out)).not.toMatch(/sepolia|84532/i);
  });

  it("marks verify_receipt as not available on mainnet yet; the other paid tools are", () => {
    const out = JSON.parse(renderMcpJson(template, {}));
    expect(out.tools[1].available_on_mainnet).toBe(true);
    expect(out.tools[2].available_on_mainnet).toBe(false);
    expect(out.tools[2].mainnet_note).toMatch(/not available on mainnet yet/i);
    expect(out.tools[2].mainnet_note).toMatch(/answered without charge/);
  });
});

describe("renderLlmsTxt, payment placeholders", () => {
  it("fills the networks sentence, the SIU price docs link and verify_receipt's mainnet note", () => {
    const text =
      "Paid: {{payment_networks}}. Docs: {{siu_price_docs}}. {{mainnet_note:verify_receipt}}";
    const out = renderLlmsTxt(text, {});
    expect(out).toContain("USDC on Base (eip155:8453) and Arc (eip155:5042) mainnet");
    expect(out).toMatch(/Docs: https:\/\/github\.com\/\S+#the-siu-price-in-every-402\./);
    expect(out).toMatch(/not available on mainnet yet/i);
    expect(out).not.toContain("You were not charged"); // that is the server's reply, not page text
  });

  it("refuses a mainnet note for a tool that has none", () => {
    expect(() => renderLlmsTxt("{{mainnet_note:get_quote}}", {})).toThrow(/get_quote/);
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

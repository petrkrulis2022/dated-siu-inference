import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { siuPriceFor } from "@touchstone/print";
import { toolDescriptions } from "./server.js";

const COMMODITY = {
  version: "SIU-2026a",
  print_id: "2026-11-26-commodity",
  date: "2026-11-26",
  series: "commodity",
  dated_siu: "0.001409",
  methodology_version: "v0-draft",
} as unknown as Print;
const NOON = new Date("2026-11-26T12:00:00Z");

describe("toolDescriptions", () => {
  it("states each paid tool's price in USD and mSIU at the Commodity print; get_index stays free", () => {
    const d = toolDescriptions({
      get_quote: siuPriceFor("0.001", COMMODITY, NOON),
      convert: siuPriceFor("0.001", COMMODITY, NOON),
      verify_receipt: siuPriceFor("0.01", COMMODITY, NOON),
    });
    expect(d.get_index).toBe("The signed Dated SIU print. Free — citation is the business.");
    expect(d.get_quote).toContain(
      "Price: $0.001 USDC (710 mSIU at the 2026-11-26 Commodity print).",
    );
    expect(d.convert).toContain("Price: $0.001 USDC (710 mSIU at the 2026-11-26 Commodity print).");
    expect(d.verify_receipt).toContain(
      "Price: $0.01 USDC (7097 mSIU at the 2026-11-26 Commodity print).",
    );
  });

  it("states USD only when there is no SIU price", () => {
    expect(toolDescriptions().get_quote).toMatch(/Price: \$0\.001 USDC\.$/);
  });
});

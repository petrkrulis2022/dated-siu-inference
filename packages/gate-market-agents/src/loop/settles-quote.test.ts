import { describe, expect, it } from "vitest";
import { settlesQuote } from "./full-run.js";
import { TOOLS } from "../tools/index.js";
import type { ToolName } from "../tools/index.js";

/**
 * Locks the SET. The end-to-end proof that settlement actually reaches the board lives in the
 * dry-loop scenario; this exists because the failure mode here is a route being left out, and a
 * route left out is silent — the payment succeeds, the quote simply stays open.
 */
describe("settlesQuote", () => {
  it("covers every way an agent can pay for a quote, and nothing else", () => {
    const settling = (Object.keys(TOOLS) as ToolName[]).filter(settlesQuote);
    expect(settling.sort()).toEqual(
      ["pay", "pay_with_claim", "settle_split", "transfer_claim"].sort(),
    );
  });

  it("includes transfer_claim — paying with a claim you hold is not the same as minting one", () => {
    // pay_with_claim mints fresh: new issuance, new headroom. Only transfer_claim passes on an
    // existing claim, which is the circulation case and the reason this route exists at all.
    expect(settlesQuote("transfer_claim")).toBe(true);
    expect(settlesQuote("pay_with_claim")).toBe(true);
  });

  it("does not treat redemption or issuance as settling a quote", () => {
    // redeem_claim discharges a claim against its ISSUER; it settles no buyer's quote. Counting
    // it would mark a quote paid that nobody paid.
    for (const t of ["redeem_claim", "mint_claim", "serve_redemption", "issue_quote"] as ToolName[]) {
      expect(settlesQuote(t), `${t} must not mark a quote paid`).toBe(false);
    }
  });
});

import { assetSettledBy } from "./full-run.js";

describe("assetSettledBy — what a seller is told it was paid in", () => {
  it("maps every settlement tool to exactly one asset, and the dollar route is the only escrow-only one", () => {
    // Property over the settlement tools rather than a hand-picked case (§4.6ai): a fifth route
    // added to settlesQuote without an asset would default to dollars and tell its seller that
    // real USDC is in escrow, which is the defect this exists to prevent.
    const expected = { pay: "usdc", pay_with_claim: "fsiu", transfer_claim: "fsiu", settle_split: "split" } as const;
    for (const tool of ["pay", "pay_with_claim", "settle_split", "transfer_claim"] as const) {
      expect(settlesQuote(tool)).toBe(true);
      expect(assetSettledBy(tool), tool).toBe(expected[tool]);
    }
  });
});

import { describe, expect, it } from "vitest";
import type { TouchstoneQuote } from "../types/generated/datum-quote.schema.js";
import { buildQuoteBody } from "./build.js";
import { signQuote } from "./sign.js";
import { checkSpendingMandate, type SpendingMandate } from "./mandate.js";

const TEST_KEY = `0x${"11".repeat(32)}`;
const NOW = new Date("2026-08-15T00:00:00Z");

const mandate: SpendingMandate = {
  max_usd_per_quote: "1.00",
  accepted_index_versions: ["SIU-2026a"],
  accepted_chains: ["base"],
};

function buildAndSign(
  overrides: Partial<Parameters<typeof buildQuoteBody>[0]> = {},
): TouchstoneQuote {
  return signQuote(
    buildQuoteBody({
      siu: "1.000",
      pattern: "estimate",
      siuMax: "1.400",
      model: "registry-id",
      rateUsdPerSiu: "0.0483",
      indexVersion: "SIU-2026a",
      printId: "2026-08-14",
      printHash: "0xabc123",
      sellerId: "erc8004:0xSellerAddress",
      chain: "base",
      expiresInSeconds: 300,
      now: NOW,
      ...overrides,
    } as Parameters<typeof buildQuoteBody>[0]),
    TEST_KEY,
  );
}

describe("checkSpendingMandate — the normative rule (build1-spec.md §8)", () => {
  it("REJECTS an estimate-pattern quote with no siu_max, even with schema validation entirely bypassed", () => {
    // Simulates a quote that never went through buildQuoteBody or ajv at all — an object
    // missing every field except the two the rule cares about. This is the scenario the rule
    // exists for: a payer must not trust that validation ran before it gets a quote.
    const bareUnvalidated = { pattern: "estimate" } as TouchstoneQuote;
    const decision = checkSpendingMandate(bareUnvalidated, mandate, NOW);
    expect(decision.accepted).toBe(false);
    expect(decision.accepted === false && decision.reason).toBe("unbounded_estimate");
  });

  it("REJECTS a cap-pattern quote with no siu_max, same rule", () => {
    const bareUnvalidated = { pattern: "cap" } as TouchstoneQuote;
    const decision = checkSpendingMandate(bareUnvalidated, mandate, NOW);
    expect(decision.accepted).toBe(false);
    expect(decision.accepted === false && decision.reason).toBe("unbounded_estimate");
  });

  it("ACCEPTS an estimate-pattern quote that does carry siu_max", () => {
    const quote = buildAndSign({ pattern: "estimate", siuMax: "1.400" });
    expect(checkSpendingMandate(quote, mandate, NOW).accepted).toBe(true);
  });

  it("ACCEPTS a fixed-pattern quote, which never needs siu_max", () => {
    const quote = buildAndSign({ pattern: "fixed", siu: "1.400", siuMax: undefined });
    expect(checkSpendingMandate(quote, mandate, NOW).accepted).toBe(true);
  });
});

describe("checkSpendingMandate — the other payer-safety rules", () => {
  it("rejects an expired quote", () => {
    const quote = buildAndSign({ expiresInSeconds: 60 });
    const wellAfterExpiry = new Date(NOW.getTime() + 120_000);
    const decision = checkSpendingMandate(quote, mandate, wellAfterExpiry);
    expect(decision.accepted).toBe(false);
    expect(decision.accepted === false && decision.reason).toBe("expired");
  });

  it("rejects a quote whose amount_usd_max exceeds the mandate's max_usd_per_quote", () => {
    const quote = buildAndSign({ siuMax: "1000.000" });
    const decision = checkSpendingMandate(quote, mandate, NOW);
    expect(decision.accepted).toBe(false);
    expect(decision.accepted === false && decision.reason).toBe("over_budget");
  });

  it("rejects a quote on an index_version not in the mandate's accepted list", () => {
    const quote = buildAndSign({ indexVersion: "SIU-2099z" });
    const decision = checkSpendingMandate(quote, mandate, NOW);
    expect(decision.accepted).toBe(false);
    expect(decision.accepted === false && decision.reason).toBe("index_version_not_accepted");
  });

  it("rejects a quote settling on a chain not in the mandate's accepted list", () => {
    const quote = buildAndSign({ chain: "base-sepolia" });
    const decision = checkSpendingMandate(quote, { ...mandate, accepted_chains: ["base"] }, NOW);
    expect(decision.accepted).toBe(false);
    expect(decision.accepted === false && decision.reason).toBe("chain_not_accepted");
  });

  it("accepts a well-formed, in-budget, unexpired, allow-listed quote", () => {
    const quote = buildAndSign();
    expect(checkSpendingMandate(quote, mandate, NOW)).toEqual({ accepted: true });
  });

  it("does not reject on budget/index/chain when the mandate omits those constraints", () => {
    const quote = buildAndSign({ indexVersion: "anything", chain: "base" });
    const permissive: SpendingMandate = { max_usd_per_quote: "1000000" };
    expect(checkSpendingMandate(quote, permissive, NOW).accepted).toBe(true);
  });

  it("treats a malformed amount_usd_max as a rejection, not a thrown exception", () => {
    const quote = { ...buildAndSign(), amount_usd_max: "not-a-number" } as TouchstoneQuote;
    const decision = checkSpendingMandate(quote, mandate, NOW);
    expect(decision.accepted).toBe(false);
    expect(decision.accepted === false && decision.reason).toBe("malformed_quote");
  });
});

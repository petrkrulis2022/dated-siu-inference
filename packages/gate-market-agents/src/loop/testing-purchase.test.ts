import { describe, expect, it } from "vitest";
import type { QuoteBody, TouchstoneQuote } from "@touchstone/sdk";
import { QuoteBoard } from "./quote-board.js";
import { quoteSizeRefusalFor, submitAttackRefusalFor, testingEngaged, windowCompletion } from "./testing-purchase.js";

const EXTRACT = "erc8004:0xEXTRACT";
const CODE = "erc8004:0xCODE";

function body(sellerId: string, siu = "4"): QuoteBody {
  return {
    schema_version: "2.0",
    siu,
    pattern: "fixed",
    model: "m",
    rate_usd_per_siu: "0.001424",
    amount_usd_max: "0.005696",
    index_version: "SIU-2026a",
    print_id: "p",
    print_hash: "0x00",
    seller_id: sellerId,
    expiry: "2099-01-01T00:00:00Z",
    settlement: [{ asset: "usdc", chain: "base-sepolia", address: "0x0", amount_max: "5696" }],
  } as QuoteBody;
}
function answered(sellerId: string) {
  const board = new QuoteBoard();
  const r = board.postRequest("WORKER-CODE", body(sellerId));
  board.postIssuedQuote(r.requestId, { ...body(sellerId), sig: "0xsig" } as TouchstoneQuote);
  return { board, requestId: r.requestId };
}

describe("testingEngaged", () => {
  it("is false until a quote the attacker issued has been settled", () => {
    const { board } = answered(EXTRACT);
    expect(testingEngaged(board, [EXTRACT])).toBe(false);
  });

  it("is true once it is, in EITHER asset — the choice of asset stays free", () => {
    // Property over the assets rather than a case: engagement must not depend on which tool paid.
    for (const asset of ["usdc", "fsiu", "split"] as const) {
      const { board, requestId } = answered(EXTRACT);
      board.recordPaid(requestId, asset);
      expect(testingEngaged(board, [EXTRACT]), asset).toBe(true);
    }
  });

  it("is not triggered by a quote some OTHER seller issued", () => {
    // Paying WORKER-CODE for a gate is not buying testing, and must not unlock the adversary.
    const { board, requestId } = answered(CODE);
    board.recordPaid(requestId, "usdc");
    expect(testingEngaged(board, [EXTRACT])).toBe(false);
  });

  it("is false when there is no attacker at all", () => {
    const { board, requestId } = answered(EXTRACT);
    board.recordPaid(requestId, "usdc");
    expect(testingEngaged(board, [])).toBe(false);
  });
});

describe("testingEngaged — quantity is a property of the job, price floats", () => {
  const REQUIRED = { [EXTRACT]: "4" };
  const paidFor = (siu: string) => {
    const board = new QuoteBoard();
    const b = body(EXTRACT, siu);
    const r = board.postRequest("WORKER-CODE", b);
    board.postIssuedQuote(r.requestId, { ...b, sig: "0xsig" } as TouchstoneQuote);
    board.recordPaid(r.requestId, "usdc");
    return board;
  };

  it("does NOT count a paid quote for a different quantity than the job's — 0.001 SIU is not testing", () => {
    // The hole: engagement used to be "any quote the attacker issued was paid", at any size. A
    // buyer could request a thousandth of a SIU at a fraction of a cent and satisfy the purchase.
    expect(testingEngaged(paidFor("0.001"), [EXTRACT], REQUIRED)).toBe(false);
    expect(testingEngaged(paidFor("40"), [EXTRACT], REQUIRED)).toBe(false);
  });

  it("counts a paid quote for the job's quantity however it is written, at any price", () => {
    for (const siu of ["4", "4.0", "4.000"]) {
      expect(testingEngaged(paidFor(siu), [EXTRACT], REQUIRED), siu).toBe(true);
    }
  });

  it("changes nothing when no quantity is required", () => {
    expect(testingEngaged(paidFor("0.001"), [EXTRACT])).toBe(true);
  });
});

describe("quoteSizeRefusalFor — a request must name the job's size", () => {
  const REQUIRED = { "erc8004:0xCODE": "10", "erc8004:0xEXTRACT": "4" };

  it("refuses a request for another size from a seller whose job has one, and says what the size is", () => {
    const why = quoteSizeRefusalFor("erc8004:0xEXTRACT", "0.001", REQUIRED);
    expect(why).toMatch(/4 SIU/);
    expect(why).toMatch(/price is yours/i);
  });

  it("accepts the job's size however written", () => {
    for (const siu of ["4", "4.0", "4.000"]) expect(quoteSizeRefusalFor("erc8004:0xEXTRACT", siu, REQUIRED), siu).toBeNull();
    expect(quoteSizeRefusalFor("erc8004:0xCODE", "10", REQUIRED)).toBeNull();
  });

  it("is silent for a seller with no fixed job, and when nothing is required", () => {
    expect(quoteSizeRefusalFor("erc8004:0xOTHER", "0.001", REQUIRED)).toBeNull();
    expect(quoteSizeRefusalFor("erc8004:0xEXTRACT", "0.001", undefined)).toBeNull();
  });

  it("refuses a size that is not a decimal at all, rather than comparing garbage", () => {
    expect(quoteSizeRefusalFor("erc8004:0xEXTRACT", "four", REQUIRED)).not.toBeNull();
  });
});

describe("submitAttackRefusalFor", () => {
  it("refuses only an unpaid attack, and only when testing must be bought", () => {
    expect(submitAttackRefusalFor("submit_attack", true, false)).toMatch(/nobody has paid/);
    expect(submitAttackRefusalFor("submit_attack", true, true)).toBeNull();
    expect(submitAttackRefusalFor("submit_attack", false, false)).toBeNull();
  });

  it("never touches any other tool", () => {
    for (const tool of ["submit_job", "pay", "issue_quote", "redeem_claim"]) {
      expect(submitAttackRefusalFor(tool, true, false), tool).toBeNull();
    }
  });

  it("speaks to the seller and does not tell any buyer what to do", () => {
    // The instrument's rule is stated once, as a fact, in the shared run description. A refusal
    // that said "ask WORKER-EXTRACT for a quote" would be a steer toward buying (§4.6q).
    const text = submitAttackRefusalFor("submit_attack", true, false) ?? "";
    expect(text).not.toMatch(/WORKER-CODE|ORCHESTRATOR|you should buy|request_quote/);
  });
});

describe("windowCompletion", () => {
  const base = { required: true, gateDelivered: true, engaged: true, attacked: true };

  it("passes only when a gate passed, testing was bought, and testing happened", () => {
    expect(windowCompletion(base)).toEqual({ passed: true });
  });

  it("records WHY a window did not pass, so a decline is a result and not a silence", () => {
    expect(windowCompletion({ ...base, gateDelivered: false })).toEqual({
      passed: false,
      incompleteBecause: "no_gate",
    });
    expect(windowCompletion({ ...base, engaged: false, attacked: false })).toEqual({
      passed: false,
      incompleteBecause: "testing_never_purchased",
    });
    expect(windowCompletion({ ...base, attacked: false })).toEqual({
      passed: false,
      incompleteBecause: "never_attacked",
    });
  });

  it("keeps the old meaning exactly when the purchase is not required", () => {
    expect(windowCompletion({ ...base, required: false, engaged: false, attacked: false })).toEqual({
      passed: true,
    });
    expect(windowCompletion({ ...base, required: false, gateDelivered: false })).toEqual({
      passed: false,
    });
  });

  it("separates the buyer's decline from the seller's non-delivery", () => {
    // Two different findings that would otherwise both read "not passed": nobody paid, versus
    // somebody paid and the adversary did nothing.
    const declined = windowCompletion({ ...base, engaged: false, attacked: false });
    const undelivered = windowCompletion({ ...base, attacked: false });
    expect(declined.incompleteBecause).not.toBe(undelivered.incompleteBecause);
  });
});

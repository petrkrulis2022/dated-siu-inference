import { describe, expect, it } from "vitest";
import type { ScriptStatus } from "./scripted-policy.js";
import {
  claimMilliSiuWorth,
  mintCostOf,
  usdToMinorUnits,
  usdToNano,
  verifyWalk,
  type WalkReport,
} from "./scripted-verify.js";

// Every number below was worked out by hand from rate 0.001437 USD/SIU (1,437,000 nano-USD):
//   gate    quote "0.0144"  = 14,400 minor units -> ceil(14400e6 / 1437000) = 10,021 mSIU; mint cost floor(10021 x 1437000 / 1e6) = 14,400
//   testing quote "0.0058"  =  5,800 minor units -> ceil(5800e6 / 1437000)  =  4,037 mSIU; mint cost 5,801
//   the remainder of the window-1 claim after paying for testing: 10,021 - 4,037 = 5,984 mSIU

const ISSUER_B = "0xB";
const ISSUER_A = "0xA";

function golden(): WalkReport {
  return {
    rateUsdPerSiu: "0.001437",
    f1: {
      window: 1,
      reached: true,
      clean: { expectedIssuer: ISSUER_B, clean: true, mints: 1, backedByOthers: 0 },
      opportunities: {
        ORCHESTRATOR: { eligible: false, spentOnward: false, basis: "none", paidInFsiuWhileHoldingReceived: false },
        "WORKER-CODE": { eligible: true, spentOnward: true, basis: "held_claim_left_the_balance", paidInFsiuWhileHoldingReceived: true },
      },
      countingErrors: [],
    },
    windows: [
      {
        windowIndex: 1,
        toolErrors: [],
        settlementCopy: [],
        paymentMoments: [
          { agentId: "ORCHESTRATOR", turn: 2, tool: "pay_with_claim", asset: "fsiu", requestId: "qr-1", heldReceivedMilliSiu: "0", quotedUsdMax: "0.0144" },
          { agentId: "WORKER-CODE", turn: 3, tool: "transfer_claim", asset: "fsiu", requestId: "qr-2", heldReceivedMilliSiu: "10021", quotedUsdMax: "0.0058" },
        ],
        capacityEvents: [
          { kind: "pay_with_claim", agentId: "ORCHESTRATOR", tokenId: "1", issuer: ISSUER_B, quantityMilliSiu: "10021", mintCostMinorUnits: "14400", settlesRequestId: "qr-1" },
          { kind: "transfer_claim", agentId: "WORKER-CODE", tokenId: "1", quantityMilliSiu: "4037", counterparty: "0xEXTRACT", settlesRequestId: "qr-2" },
          { kind: "redeem_claim", agentId: "WORKER-CODE", tokenId: "1" },
          { kind: "serve_redemption", agentId: "ISSUER-B", tokenId: "1", quantityMilliSiu: "5984", counterparty: "0xCODE" },
        ],
      },
      {
        windowIndex: 2,
        toolErrors: [],
        usdcSettlements: [{ requestId: "qr-5", settledMinorUnits: "5800", quotedMinorUnits: "5800" }],
        paymentMoments: [
          { agentId: "ORCHESTRATOR", turn: 2, tool: "pay_with_claim", asset: "fsiu", requestId: "qr-3", heldReceivedMilliSiu: "0", quotedUsdMax: "0.0144" },
        ],
        capacityEvents: [
          { kind: "pay_with_claim", agentId: "ORCHESTRATOR", tokenId: "2", issuer: ISSUER_A, quantityMilliSiu: "10021", mintCostMinorUnits: "14400", settlesRequestId: "qr-3" },
          { kind: "settle_window_close", agentId: "WORKER-EXTRACT", tokenId: "1", settlementOutcome: "Expired" },
        ],
        settlementCopy: [{ agentId: "WORKER-EXTRACT", turn: 1, tokenId: "1", outcome: "Expired", shownToSettler: true }],
      },
      {
        windowIndex: 3,
        toolErrors: [],
        usdcSettlements: [
          { requestId: "qr-6", settledMinorUnits: "14400", quotedMinorUnits: "14400" },
          { requestId: "qr-7", settledMinorUnits: "5800", quotedMinorUnits: "5800" },
        ],
        paymentMoments: [],
        capacityEvents: [
          { kind: "settle_window_close", agentId: "WORKER-CODE", tokenId: "2", settlementOutcome: "Defaulted", bondPaidMinorUnits: "14400" },
        ],
        settlementCopy: [{ agentId: "WORKER-CODE", turn: 6, tokenId: "2", outcome: "Defaulted", shownToSettler: true }],
      },
    ],
  };
}

const ALL_ISSUED: ScriptStatus[] = [{ seat: "ORCHESTRATOR", window: 1, step: "request_gate", performed: true }];

const failing = (r: WalkReport, status: ScriptStatus[] = ALL_ISSUED): string[] =>
  verifyWalk(r, status).checks.filter((c) => !c.ok).map((c) => c.name);

describe("the reference arithmetic", () => {
  it("turns decimal strings into integers exactly, and refuses what USDC cannot hold", () => {
    expect(usdToMinorUnits("0.0144")).toBe(14400n);
    expect(usdToMinorUnits("12")).toBe(12_000_000n);
    expect(usdToNano("0.001437")).toBe(1_437_000n);
    expect(() => usdToMinorUnits("0.0000001")).toThrow(/more than 6 decimal places/);
    expect(() => usdToMinorUnits("-1")).toThrow(/not a non-negative decimal/);
  });

  it("agrees with the figures worked out by hand", () => {
    expect(claimMilliSiuWorth(14400n, 1_437_000n)).toBe(10021n);
    expect(claimMilliSiuWorth(5800n, 1_437_000n)).toBe(4037n);
    expect(mintCostOf(10021n, 1_437_000n)).toBe(14400n);
    expect(mintCostOf(4037n, 1_437_000n)).toBe(5801n);
  });
});

describe("verifyWalk — a walk that did everything, and then the ways it can have gone wrong", () => {
  it("passes a walk in which every property held", () => {
    const r = verifyWalk(golden(), ALL_ISSUED);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails when a scripted step was never issued, and names it", () => {
    const r = verifyWalk(golden(), [
      ...ALL_ISSUED,
      { seat: "WORKER-CODE", window: 1, step: "redeem_remainder", performed: false },
    ]);
    const c = r.checks.find((x) => x.name === "every scripted step was issued")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("WORKER-CODE w1 redeem_remainder");
  });

  it("fails on a tool call that errored — a redemption that reverted is not a redemption", () => {
    const r = golden();
    r.windows[0].toolErrors = [{ agentId: "ISSUER-B", turn: 4, tool: "serve_redemption", error: "InsufficientRedemption" }];
    expect(failing(r)).toEqual(["no tool call errored"]);
  });

  it("fails when the report does not record tool errors at all, rather than reading silence as none", () => {
    const r = golden();
    delete r.windows[1].toolErrors;
    expect(failing(r)).toEqual(["no tool call errored"]);
  });

  it("fails a claim that is not worth the quote's price at the print", () => {
    const r = golden();
    r.windows[0].capacityEvents[0].quantityMilliSiu = "10000"; // sized as if 10 SIU were the price
    r.windows[0].capacityEvents[0].mintCostMinorUnits = "14370";
    expect(failing(r)).toContain("claim sizes equal ceil(quote price / print)");
  });

  it("fails a mint cost that is not what the contract charges", () => {
    const r = golden();
    r.windows[0].capacityEvents[0].mintCostMinorUnits = "14399";
    expect(failing(r)).toEqual(["mint costs equal quantity × print, from the receipt's own transfer"]);
  });

  it("fails a window 1 that is backed by more than one issuer, or a window 2 that is not elsewhere", () => {
    const r = golden();
    r.windows[1].capacityEvents[0].issuer = ISSUER_B;
    expect(failing(r)).toEqual(["window 1 is backed by one issuer and window 2 by another"]);
  });

  it("fails an onward payment that was the whole claim, not a part of it", () => {
    const r = golden();
    r.windows[0].capacityEvents[1].quantityMilliSiu = "10021";
    expect(failing(r)).toContain("a part of a held claim paid onward, and less than the whole");
  });

  it("fails an issuer that served the minted quantity when only the remainder was held", () => {
    const r = golden();
    r.windows[0].capacityEvents[3].quantityMilliSiu = "10021";
    expect(failing(r)).toEqual(["the remainder was presented, and served at exactly the remainder"]);
  });

  it("fails a Default that paid something other than the claim's value at the print", () => {
    const r = golden();
    r.windows[2].capacityEvents[0].bondPaidMinorUnits = "10000";
    expect(failing(r)).toEqual(["the bond paid a Default the claim's value at the print"]);
  });

  it("fails an Expired claim that paid anybody, and a walk with no Expired claim at all", () => {
    const paid = golden();
    paid.windows[1].capacityEvents[1].bondPaidMinorUnits = "100";
    expect(failing(paid)).toEqual(["an unpresented claim expired and paid nobody"]);
    const none = golden();
    none.windows[1].capacityEvents.pop();
    expect(failing(none)).toEqual(["an unpresented claim expired and paid nobody"]);
  });

  it("fails an event that lost the fact a report is built from", () => {
    const r = golden();
    delete r.windows[0].capacityEvents[0].mintCostMinorUnits;
    expect(failing(r)).toContain("every event carries its settled quote, mint cost and outcome");
  });

  it("fails when the decision rule marks ORCHESTRATOR eligible, or WORKER-CODE not onward", () => {
    const eligible = golden();
    eligible.f1!.opportunities.ORCHESTRATOR.eligible = true;
    expect(failing(eligible)).toEqual([
      "the decision rule marks WORKER-CODE eligible and onward, ORCHESTRATOR never eligible, and counts cleanly",
    ]);
    const notOnward = golden();
    notOnward.f1!.opportunities["WORKER-CODE"].spentOnward = false;
    expect(failing(notOnward)).toHaveLength(1);
  });

  it("fails when a settler was never shown its outcome, was given no turn to be shown it, or the report cannot say", () => {
    const notShown = golden();
    notShown.windows[2].settlementCopy![0].shownToSettler = false;
    expect(failing(notShown)).toEqual(["every settler was shown what its settlement did"]);
    const noTurn = golden();
    noTurn.windows[1].settlementCopy![0].shownToSettler = null;
    expect(failing(noTurn)).toEqual(["every settler was shown what its settlement did"]);
    const unrecorded = golden();
    delete unrecorded.windows[2].settlementCopy;
    expect(failing(unrecorded)).toEqual(["every settler was shown what its settlement did"]);
  });

  it("fails when the dollar route did not run as a control in window 3", () => {
    const r = golden();
    r.windows[2].usdcSettlements = [];
    expect(failing(r)).toEqual(["the dollar route settled quotes in windows 2 and 3"]);
  });
});

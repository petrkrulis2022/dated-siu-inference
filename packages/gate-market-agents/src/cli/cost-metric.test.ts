import { describe, expect, it } from "vitest";
import { costOfRuns, type CostEvent, type CostMoment, type CostRun, type CostSettlement } from "./cost-metric.js";

const PRINT = "0.0100";
const run = (over: Partial<CostRun> & { moments?: CostMoment[]; settlements?: CostSettlement[]; events?: CostEvent[] }): CostRun => ({
  gateDelivered: true,
  printRateUsdPerSiu: PRINT,
  capacityEvents: over.events ?? [],
  paymentMoments: over.moments ?? [],
  usdcSettlements: over.settlements ?? [],
  ...(over.gateDelivered !== undefined ? { gateDelivered: over.gateDelivered } : {}),
});
const usdcPay = (requestId: string, siu = "1"): CostMoment => ({ agentId: "ORCHESTRATOR", turn: 2, tool: "pay", asset: "usdc", requestId, quotedSiu: siu });
const mintPay = (requestId: string, turn = 2): CostMoment => ({ agentId: "ORCHESTRATOR", turn, tool: "pay_with_claim", asset: "fsiu", requestId, quotedSiu: "1" });
const xferPay = (requestId: string, turn: number): CostMoment => ({ agentId: "WORKER-CODE", turn, tool: "transfer_claim", asset: "fsiu", requestId, quotedSiu: "1" });

describe("costOfRuns — what was settled, not what was quoted", () => {
  it("prices a USDC payment at the amount SETTLED, which can be below the quote's ceiling", () => {
    // Quoted $0.0100, the seller settled $0.0060 and the rest returned to the payer. The ceiling
    // would have called this 0.010000 per SIU; the payer's real outflow was 0.006000.
    const c = costOfRuns([
      run({ moments: [usdcPay("qr-1")], settlements: [{ requestId: "qr-1", settledMinorUnits: "6000", quotedMinorUnits: "10000" }] }),
    ]);
    expect(c.usdc).toMatchObject({ payments: 1, usd: "0.006000", quotedSiu: "1", usdPerSiu: "0.006000", settledBelowQuoted: 1 });
  });

  it("counts an escrow nobody settled apart, instead of pricing it at its ceiling or at zero", () => {
    const c = costOfRuns([run({ moments: [usdcPay("qr-1")] })]);
    expect(c.usdc.payments).toBe(0);
    expect(c.usdc.escrowNeverSettled).toBe(1);
  });

  it("gives fSIU minted for a payment a dollar figure from its MINT COST, with the print-equivalent beside it", () => {
    // 1,000 mSIU = 1 SIU, worth $0.0100 at the print. It cost 9,990 minor units to mint — a gap a
    // reader should be able to see, so both figures are reported.
    const c = costOfRuns([
      run({
        moments: [mintPay("qr-1")],
        events: [{ kind: "pay_with_claim", agentId: "ORCHESTRATOR", turn: 2, tokenId: "7", quantityMilliSiu: "1000", mintCostMinorUnits: "9990", settlesRequestId: "qr-1" }],
      }),
    ]);
    expect(c.fsiu).toMatchObject({ payments: 1, usd: "0.009990", usdPerSiu: "0.009990", printEquivalentUsd: "0.010000", printEquivalentUsdPerSiu: "0.010000", carriedAtOriginalMintCost: 0 });
  });

  it("carries a claim that was PASSED ON at its original mint cost, pro rata by quantity, and says so", () => {
    // ORCHESTRATOR minted 1,500 mSIU for 15,000; WORKER-CODE passes 1,000 of it on to settle a
    // quote and 500 to settle another. It did not pay that cost, so the row is labelled carried.
    const c = costOfRuns([
      run({
        moments: [xferPay("qr-1", 5), xferPay("qr-2", 6)],
        events: [
          { kind: "mint_claim", agentId: "ORCHESTRATOR", turn: 1, tokenId: "7", quantityMilliSiu: "1500", mintCostMinorUnits: "15000" },
          { kind: "transfer_claim", agentId: "WORKER-CODE", turn: 5, tokenId: "7", quantityMilliSiu: "1000", settlesRequestId: "qr-1" },
          { kind: "transfer_claim", agentId: "WORKER-CODE", turn: 6, tokenId: "7", quantityMilliSiu: "500", settlesRequestId: "qr-2" },
        ],
      }),
    ]);
    expect(c.fsiu.payments).toBe(2);
    expect(c.fsiu.usd).toBe("0.015000"); // 10,000 + 5,000 minor units
    expect(c.fsiu.carriedAtOriginalMintCost).toBe(2);
  });

  it("does not price an fSIU payment whose claim cannot be found — it counts it unmatched, never as free", () => {
    const c = costOfRuns([run({ moments: [mintPay("qr-1")] })]);
    expect(c.fsiu.payments).toBe(0);
    expect(c.unmatched).toBe(1);
  });

  it("prices a split as its claim leg's mint cost plus its dollar leg's settled amount, as its own row", () => {
    const c = costOfRuns([
      run({
        moments: [{ agentId: "ORCHESTRATOR", turn: 2, tool: "settle_split", asset: "split", requestId: "qr-1", quotedSiu: "1" }],
        events: [{ kind: "settle_split", agentId: "ORCHESTRATOR", turn: 2, tokenId: "8", quantityMilliSiu: "500", mintCostMinorUnits: "5000", settlesRequestId: "qr-1" }],
        settlements: [{ requestId: "qr-1", settledMinorUnits: "5000", quotedMinorUnits: "5000" }],
      }),
    ]);
    expect(c.split).toMatchObject({ payments: 1, usd: "0.010000", usdPerSiu: "0.010000" });
    expect(c.usdc.payments).toBe(0);
    expect(c.fsiu.payments).toBe(0);
  });

  it("sets aside payments in windows where the work was not delivered, and payments that carried no quote", () => {
    const c = costOfRuns([
      run({ gateDelivered: false, moments: [usdcPay("qr-1")], settlements: [{ requestId: "qr-1", settledMinorUnits: "6000", quotedMinorUnits: "10000" }] }),
      run({ moments: [{ agentId: "WORKER-CODE", turn: 3, tool: "transfer_claim", asset: "fsiu" }] }),
    ]);
    expect(c.paymentsInUndeliveredWindows).toBe(1);
    expect(c.paymentsWithoutQuote).toBe(1);
    expect(c.usdc.payments).toBe(0);
  });

  it("sums across runs", () => {
    const one = run({ moments: [usdcPay("qr-1")], settlements: [{ requestId: "qr-1", settledMinorUnits: "10000", quotedMinorUnits: "10000" }] });
    const two = run({ moments: [usdcPay("qr-9")], settlements: [{ requestId: "qr-9", settledMinorUnits: "6000", quotedMinorUnits: "10000" }] });
    const c = costOfRuns([one, two]);
    expect(c.usdc).toMatchObject({ payments: 2, usd: "0.016000", quotedSiu: "2", usdPerSiu: "0.008000" });
  });
});

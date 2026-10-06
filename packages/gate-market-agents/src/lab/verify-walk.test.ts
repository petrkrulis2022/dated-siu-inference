import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { escrowFeeMinor, printNano, resultNano } from "./money.js";
import { renderWalk, verifyLabWalk, type WalkReport } from "./verify-walk.js";

const P = printNano("0.001437"); // illustrative
type Pay = WalkReport["paymentMoments"][number];

/** A report in which everything the walk is meant to do happened, built by hand and internally consistent. */
function goodReport(): WalkReport {
  const sales: WalkReport["sales"] = [];
  const moments: Pay[] = [];
  const settlements: WalkReport["usdcSettlements"] = [];
  const rebates: WalkReport["operatorActions"] = [];
  const events: WalkReport["capacityEvents"] = [];
  let n = 0;
  const sale = (kind: "trade" | "rawwork", tool: string, heldReceived = "0", minorUnits = kind === "trade" ? 1700n : 1400n) => {
    const requestId = `qr-${++n}`;
    sales.push({ requestId, kind, delivered: kind === "trade" });
    moments.push({ agentId: "ORCHESTRATOR", tool, requestId, heldReceivedMilliSiu: heldReceived });
    const claim = kind === "trade" ? 1184n : 975n;
    if (tool === "pay" || tool === "settle_split") {
      const dollars = tool === "pay" ? minorUnits : minorUnits - (claim / 2n) * 1437n / 1000n; // any figure: the check is the fee rule on it
      settlements.push({ requestId, settledMinorUnits: dollars.toString(), quotedMinorUnits: dollars.toString() });
      rebates.push({ kind: "fee_rebate", requestId, settledMinorUnits: dollars.toString(), rebatedMinorUnits: escrowFeeMinor(dollars, 50).toString() });
    }
    if (tool === "pay_with_claim") events.push({ kind: "pay_with_claim", quantityMilliSiu: claim.toString(), settlesRequestId: requestId });
    if (tool === "settle_split") events.push({ kind: "settle_split", quantityMilliSiu: (claim / 2n).toString(), settlesRequestId: requestId });
  };
  for (const tool of ["pay", "pay", "pay_with_claim", "pay_with_claim", "transfer_claim", "transfer_claim", "settle_split", "settle_split"]) {
    sale("trade", tool, tool === "transfer_claim" ? "1184" : "0");
  }
  for (const tool of ["pay", "pay", "pay", "pay_with_claim", "pay_with_claim", "pay_with_claim", "transfer_claim", "transfer_claim"]) sale("rawwork", tool);
  // 8000 endowed + 2 x 1184 + 3 x 975 + 2 x 592 minted = 14,477 expired across the holders.
  const expiry = (holder: string, q: string) => ({ kind: "expiry", holder, quantityMilliSiu: q, txHash: "0x1" });
  const traders = ["TRADER-1", "TRADER-2", "TRADER-3", "TRADER-4"];
  const finalTraders = traders.map((t, i) => {
    const usdcMinor = 2874n + BigInt(i);
    const fsiuMilliSiu = 3000n;
    const needsMet = 2;
    return { trader: t, usdcMinor: usdcMinor.toString(), fsiuMilliSiu: fsiuMilliSiu.toString(), needsMet, resultNano: resultNano({ usdcMinor, fsiuMilliSiu, needsMet }, P, DEFAULT_PARAMS).toString() };
  });
  const uniform = traders.map((t) => ({ trader: t, usdcMinor: "2874", fsiuMilliSiu: "2000" }));
  return {
    scripted: true,
    params: DEFAULT_PARAMS,
    print: { rateUsdPerSiu: "0.001437" },
    escrowFeeBps: 50,
    economy: { needs: new Array(8).fill({}) },
    labErrors: [],
    toolErrors: [],
    needsMet: { "TRADER-1": 2, "TRADER-2": 2, "TRADER-3": 2, "TRADER-4": 2 },
    sales,
    paymentMoments: moments,
    usdcSettlements: settlements,
    capacityEvents: events,
    operatorActions: [...rebates, expiry("TRADER-1", "3000"), expiry("TRADER-2", "3000"), expiry("TRADER-3", "3000"), expiry("TRADER-4", "3000"), expiry("ISSUER-B", "2477")],
    snapshots: [
      { label: "opening", traders: uniform },
      { label: "round 2 opened", traders: uniform },
      { label: "round 3 opened", traders: uniform },
    ],
    final: { traders: finalTraders },
    measuredBeforeClose: true,
    opening: { usdcMinorPerTrader: "2874", fsiuMilliSiuPerTrader: "2000" },
    pool: { restored: true },
  };
}

const failing = (r: WalkReport): string[] => verifyLabWalk(r).checks.filter((c) => !c.ok).map((c) => c.id);

describe("the lab walk's verifier", () => {
  it("passes a report in which everything the walk is meant to do happened", () => {
    const v = verifyLabWalk(goodReport());
    expect(failing(goodReport())).toEqual([]);
    expect(v.ok).toBe(true);
    expect(renderWalk(v)).toContain("ALL CHECKS PASSED");
  });

  // Each check is shown to be able to fail: break exactly the thing it reads and nothing else.
  const mutations: [string, string, (r: WalkReport) => void][] = [
    ["is_marked_scripted", "a report that does not say it was scripted", (r) => (r.scripted = false)],
    ["ran_clean", "an abort", (r) => (r.abortedBecause = "the endowment was backed by someone else")],
    ["ran_clean", "contamination", (r) => (r.contamination = "a mint was backed by TRADER-4")],
    ["no_bookkeeping_errors", "an error in the lab's own books", (r) => r.labErrors.push({})],
    ["no_tool_call_errored", "a call that errored", (r) => r.toolErrors.push({ agentId: "ORCHESTRATOR", turn: 3, tool: "pay", error: "reverted" })],
    ["every_need_met", "a need left unmet", (r) => (r.needsMet["TRADER-2"] = 1)],
    ["some_purchase_paid_by_split", "no purchase paid by split", (r) => (r.paymentMoments = r.paymentMoments.filter((m) => !(m.tool === "settle_split")))],
    ["jobs_paid_every_route", "no job paid from a held balance", (r) => (r.paymentMoments = r.paymentMoments.filter((m) => !(m.tool === "transfer_claim" && r.sales.find((s) => s.requestId === m.requestId)?.kind === "trade")))],
    ["raw_work_paid_every_route", "no unit paid in dollars", (r) => (r.paymentMoments = r.paymentMoments.filter((m) => !(m.tool === "pay" && r.sales.find((s) => s.requestId === m.requestId)?.kind === "rawwork")))],
    ["received_fsiu_passed_on", "no held payment by a payer holding received fSIU", (r) => r.paymentMoments.forEach((m) => (m.heldReceivedMilliSiu = "0"))],
    ["fee_rebated_after_every_dollar_settlement", "a settlement with no rebate", (r) => (r.operatorActions = r.operatorActions.filter((a, i) => !(a.kind === "fee_rebate" && i === 0)))],
    ["fee_rebated_after_every_dollar_settlement", "a rebate that is not the contract's fee", (r) => ((r.operatorActions.find((a) => a.kind === "fee_rebate")!).rebatedMinorUnits = "1")],
    ["dollar_settlements_in_full", "a settlement for less than quoted", (r) => (r.usdcSettlements[0].settledMinorUnits = "1")],
    ["leftover_fsiu_expired_at_close", "an expiry that failed", (r) => r.operatorActions.push({ kind: "expiry_failed", holder: "TRADER-3", reason: "x" })],
    ["leftover_fsiu_expired_at_close", "a pool that was not restored", (r) => (r.pool.restored = false)],
    ["fsiu_conserved", "fSIU that vanished", (r) => ((r.operatorActions.find((a) => a.kind === "expiry")!).quantityMilliSiu = "2999")],
    ["opening_equal_for_every_trader", "an opening that differs", (r) => (r.snapshots[0].traders[2].usdcMinor = "2873")],
    ["every_round_opened", "a round that never opened", (r) => (r.snapshots = r.snapshots.filter((s) => s.label !== "round 3 opened"))],
    ["score_recomputes_from_balances", "a result that is not its balances", (r) => (r.final!.traders[0].resultNano = "1")],
    ["scored_before_the_window_closed", "a snapshot after close", (r) => (r.measuredBeforeClose = false)],
    ["no_paid_job_left_undelivered", "a job sold and not delivered", (r) => (r.sales[0].delivered = false)],
  ];
  for (const [id, what, mutate] of mutations) {
    it(`${id} fails on ${what}`, () => {
      const r = goodReport();
      mutate(r);
      expect(failing(r)).toContain(id);
    });
  }

  it("fails when the script could not afford a quote by any route, naming what the trader held", () => {
    const v = verifyLabWalk(goodReport(), {
      decided: [],
      fellBack: [],
      unaffordable: [{ trader: "TRADER-4", requestId: "qr-8", usdcMinor: "10", fsiuMilliSiu: "10", needsMinor: "1400", needsMilliSiu: "975" }],
    });
    expect(v.checks.find((c) => c.id === "no_payment_was_unaffordable")).toMatchObject({ ok: false });
    expect(renderWalk(v)).toContain("TRADER-4 qr-8 (holds 10 USDC, 10 mSIU; needs 1400 or 975)");
  });

  it("lists where the script had to fall back without counting it as a failure", () => {
    const v = verifyLabWalk(goodReport(), { decided: [], unaffordable: [], fellBack: [{ trader: "TRADER-2", requestId: "qr-5", planned: "held", because: "holds 100 mSIU, the quote needs 1184" }] });
    expect(v.ok).toBe(true);
    expect(renderWalk(v)).toContain("TRADER-2 qr-5: planned held — holds 100 mSIU, the quote needs 1184");
  });
});

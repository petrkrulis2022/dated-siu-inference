import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { printNano, resultNano } from "./money.js";
import { renderWalk, verifyLabWalk, type WalkReport } from "./verify-walk.js";

const P = printNano("0.001437"); // illustrative
type Pay = WalkReport["paymentMoments"][number];

/** A report in which everything the walk is meant to do happened, built by hand and internally consistent. */
function goodReport(): WalkReport {
  const sales: WalkReport["sales"] = [];
  const moments: Pay[] = [];
  const events: WalkReport["capacityEvents"] = [];
  let n = 0;
  const sale = (kind: "trade" | "rawwork", tool: string, heldReceived = "0") => {
    const requestId = `qr-${++n}`;
    sales.push({ requestId, kind, delivered: kind === "trade", paidAsset: tool === "pay" ? "usdc" : tool === "settle_split_held" ? "split" : "fsiu" });
    moments.push({ agentId: "ORCHESTRATOR", tool, requestId, heldReceivedMilliSiu: heldReceived });
    const claim = kind === "trade" ? 1184n : 975n;
    // A held payment moves the whole claim; a split moves half of it. Either way it is a transfer of a held claim.
    if (tool === "transfer_claim") events.push({ kind: "transfer_claim", quantityMilliSiu: claim.toString(), settlesRequestId: requestId });
    if (tool === "settle_split_held") events.push({ kind: "transfer_claim", quantityMilliSiu: (claim / 2n).toString(), settlesRequestId: requestId });
  };
  for (const tool of ["pay", "pay", "transfer_claim", "transfer_claim", "settle_split_held", "settle_split_held", "pay", "transfer_claim"]) {
    sale("trade", tool, tool === "transfer_claim" ? "1184" : "0");
  }
  for (const tool of ["pay", "pay", "transfer_claim", "transfer_claim", "settle_split_held", "settle_split_held", "pay", "transfer_claim"]) sale("rawwork", tool);
  // Nothing is minted after the opening: what expires at close is exactly the endowment, 4 x 4,318 = 17,272 mSIU.
  const expiry = (holder: string, q: string) => ({ kind: "expiry", holder, quantityMilliSiu: q, txHash: "0x1" });
  const traders = ["TRADER-1", "TRADER-2", "TRADER-3", "TRADER-4"];
  // USDC and fSIU move only among the five wallets: the totals at the end are the totals at the start.
  const finalUsdc = [6000n, 6100n, 6200n, 6300n]; // 24,600, and the issuer holds 1,220 of the 25,820 there were
  const finalFsiu = [4000n, 4100n, 4200n, 4300n]; // 16,600, and the issuer holds 672 of the 17,272 there were
  const finalTraders = traders.map((t, i) => {
    const needsMet = 2;
    return {
      trader: t,
      usdcMinor: finalUsdc[i].toString(),
      fsiuMilliSiu: finalFsiu[i].toString(),
      needsMet,
      resultNano: resultNano({ usdcMinor: finalUsdc[i], fsiuMilliSiu: finalFsiu[i], needsMet }, P, DEFAULT_PARAMS).toString(),
    };
  });
  const uniform = traders.map((t) => ({ trader: t, usdcMinor: "6205", fsiuMilliSiu: "4318" }));
  const issuerOpening = { usdcMinor: "1000", fsiuMilliSiu: "0" };
  return {
    scripted: true,
    params: DEFAULT_PARAMS,
    print: { rateUsdPerSiu: "0.001437" },
    economy: { needs: new Array(8).fill({}) },
    labErrors: [],
    toolErrors: [],
    needsMet: { "TRADER-1": 2, "TRADER-2": 2, "TRADER-3": 2, "TRADER-4": 2 },
    sales,
    paymentMoments: moments,
    capacityEvents: events,
    operatorActions: [expiry("TRADER-1", "4000"), expiry("TRADER-2", "4100"), expiry("TRADER-3", "4200"), expiry("TRADER-4", "4300"), expiry("ISSUER-B", "672")],
    snapshots: [
      { label: "opening", traders: uniform, issuer: issuerOpening },
      { label: "round 2 opened", traders: uniform, issuer: issuerOpening },
      { label: "round 3 opened", traders: uniform, issuer: issuerOpening },
    ],
    final: { traders: finalTraders, issuer: { usdcMinor: "1220", fsiuMilliSiu: "672" } },
    measuredBeforeClose: true,
    opening: { usdcMinorPerTrader: "6205", fsiuMilliSiuPerTrader: "4318" },
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
    ["jobs_paid_every_route", "no job paid by split", (r) => (r.paymentMoments = r.paymentMoments.filter((m) => !(m.tool === "settle_split_held" && r.sales.find((s) => s.requestId === m.requestId)?.kind === "trade")))],
    ["jobs_paid_every_route", "no job paid from a held balance", (r) => (r.paymentMoments = r.paymentMoments.filter((m) => !(m.tool === "transfer_claim" && r.sales.find((s) => s.requestId === m.requestId)?.kind === "trade")))],
    ["raw_work_paid_every_route", "no unit paid in dollars", (r) => (r.paymentMoments = r.paymentMoments.filter((m) => !(m.tool === "pay" && r.sales.find((s) => s.requestId === m.requestId)?.kind === "rawwork")))],
    ["raw_work_paid_every_route", "no unit paid by split", (r) => (r.paymentMoments = r.paymentMoments.filter((m) => !(m.tool === "settle_split_held" && r.sales.find((s) => s.requestId === m.requestId)?.kind === "rawwork")))],
    ["every_split_moved_a_held_claim", "a split with no claim part recorded", (r) => (r.capacityEvents = r.capacityEvents.filter((e) => !(e.settlesRequestId === "qr-5")))],
    ["every_split_moved_a_held_claim", "no split at all", (r) => (r.paymentMoments = r.paymentMoments.filter((m) => m.tool !== "settle_split_held"))],
    ["received_fsiu_passed_on", "no held payment by a payer holding received fSIU", (r) => r.paymentMoments.forEach((m) => (m.heldReceivedMilliSiu = "0"))],
    ["every_paid_sale_has_one_payment", "a sale paid twice", (r) => r.paymentMoments.push({ ...r.paymentMoments[0] })],
    ["every_paid_sale_has_one_payment", "a sale marked paid that no payment made", (r) => (r.paymentMoments = r.paymentMoments.slice(1))],
    ["usdc_conserved_no_fee_no_escrow", "USDC that a fee, an escrow or a rebate moved out of the five wallets", (r) => (r.final!.issuer.usdcMinor = "1219")],
    ["usdc_conserved_no_fee_no_escrow", "USDC held by someone other than the five wallets", (r) => (r.final!.traders[0].usdcMinor = "5990")],
    ["fsiu_supply_unchanged", "fSIU that appeared after the opening", (r) => (r.final!.issuer.fsiuMilliSiu = "700")],
    ["nothing_minted_after_the_opening", "a mint by an agent", (r) => r.capacityEvents.push({ kind: "pay_with_claim", quantityMilliSiu: "1184", settlesRequestId: "qr-1" })],
    ["nothing_minted_after_the_opening", "a mint of the old split kind", (r) => r.capacityEvents.push({ kind: "settle_split", quantityMilliSiu: "592", settlesRequestId: "qr-5" })],
    ["no_fee_rebated", "a fee rebate", (r) => r.operatorActions.push({ kind: "fee_rebate" })],
    ["leftover_fsiu_expired_at_close", "an expiry that failed", (r) => r.operatorActions.push({ kind: "expiry_failed", holder: "TRADER-3", reason: "x" })],
    ["leftover_fsiu_expired_at_close", "a pool that was not restored", (r) => (r.pool.restored = false)],
    ["fsiu_conserved", "fSIU that vanished", (r) => ((r.operatorActions.find((a) => a.kind === "expiry")!).quantityMilliSiu = "3999")],
    ["opening_equal_for_every_trader", "an opening that differs", (r) => (r.snapshots[0].traders[2].usdcMinor = "6204")],
    ["opening_covers_every_need_in_either_asset", "an opening smaller than the print and schedule give", (r) => {
      r.opening = { usdcMinorPerTrader: "2874", fsiuMilliSiuPerTrader: "2000" };
      for (const snap of r.snapshots) for (const t of snap.traders) Object.assign(t, { usdcMinor: "2874", fsiuMilliSiu: "2000" });
    }],
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

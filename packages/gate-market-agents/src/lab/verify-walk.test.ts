import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { openingMilliSiuPerTrader, openingUsdcMinor, priceMilliSiu, printNano, printRate, quoteTerms, resultNano } from "./money.js";
import { buildPrintPath, reachablePrints } from "./prints.js";
import { renderWalk, verifyLabWalk, type WalkReport } from "./verify-walk.js";

const REAL = "0.001437"; // illustrative: the real print round 1 starts from
const P = printNano(REAL);
const SEED = 9;
const PATH = buildPrintPath(SEED, P, DEFAULT_PARAMS, "real-print").byRound;
const REACHABLE = reachablePrints(P, DEFAULT_PARAMS);
const OPEN_FSIU = openingMilliSiuPerTrader(DEFAULT_PARAMS); // 4,400
const OPEN_USDC = openingUsdcMinor(REACHABLE, DEFAULT_PARAMS); // 8,364
type Pay = WalkReport["paymentMoments"][number];

/** A report in which everything the walk is meant to do happened, built by hand and internally consistent. */
function goodReport(): WalkReport {
  const sales: WalkReport["sales"] = [];
  const moments: Pay[] = [];
  const events: WalkReport["capacityEvents"] = [];
  let n = 0;
  const sale = (kind: "trade" | "rawwork", tool: string, heldReceived = "0") => {
    const requestId = `qr-${++n}`;
    const round = 1 + (n % 3); // a quote is asked for in some round, and priced at that round's print
    const print = PATH[round - 1];
    // A quote is priced in SIU (D50): its siu is the price, its rate the print of the round it was asked for in, its dollars the SDK's product at six decimals, rounded up.
    const t = quoteTerms(kind, print, DEFAULT_PARAMS);
    sales.push({ requestId, round, kind, delivered: kind === "trade", paidAsset: tool === "pay" ? "usdc" : tool === "settle_split_held" ? "split" : "fsiu" });
    moments.push({ agentId: "ORCHESTRATOR", tool, requestId, heldReceivedMilliSiu: heldReceived, heldTotalMilliSiu: "4400", quotedSiu: t.siu, quoteRateUsdPerSiu: printRate(print), quotedUsdMax: t.usd });
    const claim = priceMilliSiu(kind, DEFAULT_PARAMS); // exactly the price in mSIU, at every print
    // A held payment moves the whole claim; a split moves half of it. Either way it is a transfer of a held claim.
    if (tool === "transfer_claim") events.push({ kind: "transfer_claim", quantityMilliSiu: claim.toString(), settlesRequestId: requestId });
    if (tool === "settle_split_held") events.push({ kind: "transfer_claim", quantityMilliSiu: (claim / 2n).toString(), settlesRequestId: requestId });
  };
  for (const tool of ["pay", "pay", "transfer_claim", "transfer_claim", "settle_split_held", "settle_split_held", "pay", "transfer_claim"]) {
    sale("trade", tool, tool === "transfer_claim" ? "1200" : "0");
  }
  for (const tool of ["pay", "pay", "transfer_claim", "transfer_claim", "settle_split_held", "settle_split_held", "pay", "transfer_claim"]) sale("rawwork", tool);
  // Nothing is minted after the opening: what expires at close is exactly the endowment, 4 x 4,400 = 17,600 mSIU.
  const expiry = (holder: string, q: string) => ({ kind: "expiry", holder, quantityMilliSiu: q, txHash: "0x1" });
  const traders = ["TRADER-1", "TRADER-2", "TRADER-3", "TRADER-4"];
  // USDC and fSIU move only among the five wallets: the totals at the end are the totals at the start.
  const finalUsdc = [8200n, 8300n, 8400n, 8500n]; // 33,400, and the issuer holds 1,056 of the 34,456 there were
  const finalFsiu = [4200n, 4300n, 4400n, 4500n]; // 17,400, and the issuer holds 200 of the 17,600 there were
  const finalPrint = PATH[2]; // the run ended in round 3: fSIU and the credit are valued at round 3's print
  const finalTraders = traders.map((t, i) => {
    const needsMet = 2;
    return {
      trader: t,
      usdcMinor: finalUsdc[i].toString(),
      fsiuMilliSiu: finalFsiu[i].toString(),
      needsMet,
      resultNano: resultNano({ usdcMinor: finalUsdc[i], fsiuMilliSiu: finalFsiu[i], needsMet }, finalPrint, DEFAULT_PARAMS).toString(),
    };
  });
  const uniform = traders.map((t) => ({ trader: t, usdcMinor: OPEN_USDC.toString(), fsiuMilliSiu: OPEN_FSIU.toString() }));
  const issuerOpening = { usdcMinor: "1000", fsiuMilliSiu: "0" };
  return {
    scripted: true,
    seed: SEED,
    params: DEFAULT_PARAMS,
    print: { printId: "real-print", rateUsdPerSiu: REAL },
    prints: { stepBps: DEFAULT_PARAMS.printStepBps, byRound: PATH.map(String), reachableNano: REACHABLE.map(String) },
    economy: { needs: new Array(8).fill({}) },
    labErrors: [],
    toolErrors: [],
    needsMet: { "TRADER-1": 2, "TRADER-2": 2, "TRADER-3": 2, "TRADER-4": 2 },
    sales,
    paymentMoments: moments,
    capacityEvents: events,
    operatorActions: [expiry("TRADER-1", "4200"), expiry("TRADER-2", "4300"), expiry("TRADER-3", "4400"), expiry("TRADER-4", "4500"), expiry("ISSUER-B", "200")],
    snapshots: [
      { label: "opening", traders: uniform, issuer: issuerOpening },
      { label: "round 2 opened", traders: uniform, issuer: issuerOpening },
      { label: "round 3 opened", traders: uniform, issuer: issuerOpening },
    ],
    final: { round: 3, traders: finalTraders, issuer: { usdcMinor: "1056", fsiuMilliSiu: "200" } },
    measuredBeforeClose: true,
    opening: { usdcMinorPerTrader: OPEN_USDC.toString(), fsiuMilliSiuPerTrader: OPEN_FSIU.toString() },
    pool: { restored: true },
    // What each trader was shown of its own wallet (D50): the first screen of each is the opening.
    holdingsShown: traders.flatMap((t) => [{ trader: t, round: 1, usdcMinor: OPEN_USDC.toString(), fsiuMilliSiu: OPEN_FSIU.toString() }]),
    routeOrder: { assetFirst: "usdc", tools: ["pay_with_usdc", "pay_with_held_claim", "pay_split"] },
    holdingsDisagreements: [],
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
    ["usdc_conserved_no_fee_no_escrow", "USDC that a fee, an escrow or a rebate moved out of the five wallets", (r) => (r.final!.issuer.usdcMinor = "1055")],
    ["usdc_conserved_no_fee_no_escrow", "USDC held by someone other than the five wallets", (r) => (r.final!.traders[0].usdcMinor = "8190")],
    ["fsiu_supply_unchanged", "fSIU that appeared after the opening", (r) => (r.final!.issuer.fsiuMilliSiu = "300")],
    ["nothing_minted_after_the_opening", "a mint by an agent", (r) => r.capacityEvents.push({ kind: "pay_with_claim", quantityMilliSiu: "1200", settlesRequestId: "qr-1" })],
    ["nothing_minted_after_the_opening", "a mint of the old split kind", (r) => r.capacityEvents.push({ kind: "settle_split", quantityMilliSiu: "592", settlesRequestId: "qr-5" })],
    ["no_fee_rebated", "a fee rebate", (r) => r.operatorActions.push({ kind: "fee_rebate" })],
    ["leftover_fsiu_expired_at_close", "an expiry that failed", (r) => r.operatorActions.push({ kind: "expiry_failed", holder: "TRADER-3", reason: "x" })],
    ["leftover_fsiu_expired_at_close", "a pool that was not restored", (r) => (r.pool.restored = false)],
    ["fsiu_conserved", "fSIU that vanished", (r) => ((r.operatorActions.find((a) => a.kind === "expiry")!).quantityMilliSiu = "4199")],
    ["opening_equal_for_every_trader", "an opening that differs", (r) => (r.snapshots[0].traders[2].usdcMinor = String(OPEN_USDC - 1n))],
    ["opening_covers_every_need_in_either_asset", "an opening smaller than the print and schedule give", (r) => {
      r.opening = { usdcMinorPerTrader: "2874", fsiuMilliSiuPerTrader: "2000" };
      for (const snap of r.snapshots) for (const t of snap.traders) Object.assign(t, { usdcMinor: "2874", fsiuMilliSiu: "2000" });
    }],
    ["opening_covers_every_need_in_either_asset", "an opening sized at round 1's print only, which the walk's ceiling outruns (D41)", (r) => {
      const fixed = [P];
      const fsiu = String(openingMilliSiuPerTrader(DEFAULT_PARAMS));
      const usdc = String(openingUsdcMinor(fixed, DEFAULT_PARAMS));
      r.opening = { usdcMinorPerTrader: usdc, fsiuMilliSiuPerTrader: fsiu };
      for (const snap of r.snapshots) for (const t of snap.traders) Object.assign(t, { usdcMinor: usdc, fsiuMilliSiu: fsiu });
    }],
    ["print_path_is_the_seeds_and_moves_every_round", "a path that is not the seed's walk", (r) => (r.prints.byRound[1] = String(BigInt(r.prints.byRound[1]) + 1n))],
    ["print_path_is_the_seeds_and_moves_every_round", "a print that did not move", (r) => (r.prints.byRound = [r.prints.byRound[0], r.prints.byRound[0], r.prints.byRound[0]])],
    ["print_path_is_the_seeds_and_moves_every_round", "a run that did not start from the real print", (r) => (r.print.rateUsdPerSiu = "0.001500")],
    ["quotes_are_priced_in_siu_at_their_rounds_print", "a quote whose price in SIU is the size of the work and not its price", (r) => (r.paymentMoments[0].quotedSiu = "1")],
    ["quotes_are_priced_in_siu_at_their_rounds_print", "a quote whose rate is not the print of the round it was asked for in", (r) => (r.paymentMoments[1].quoteRateUsdPerSiu = "0.0017244")],
    ["quotes_are_priced_in_siu_at_their_rounds_print", "a quote whose dollars were rounded to $0.0001 and not derived at six decimals", (r) => (r.paymentMoments[2].quotedUsdMax = "0.0017")],
    ["holdings_shown_start_at_the_opening", "a run in which no trader was shown its wallet", (r) => (r.holdingsShown = [])],
    ["holdings_shown_start_at_the_opening", "a first screen that was not the opening", (r) => (r.holdingsShown[1].fsiuMilliSiu = "4399")],
    ["holdings_shown_agree_with_the_chain", "a snapshot at which the wallet shown differed from the chain's", (r) => r.holdingsDisagreements.push({ label: "final" })],
    ["route_order_recorded", "a report that records no order of routes", (r) => ((r as { routeOrder?: unknown }).routeOrder = undefined)],
    ["held_claims_cost_the_quotes_price_in_msiu", "a claim that was not exactly the quote's price in mSIU", (r) => {
      const held = r.paymentMoments.find((m) => m.tool === "transfer_claim")!;
      const ev = r.capacityEvents.find((e) => e.settlesRequestId === held.requestId)!;
      ev.quantityMilliSiu = String(BigInt(ev.quantityMilliSiu!) + 17n);
    }],
    ["score_recomputes_from_balances", "a score valued at round 1's print when the run ended in round 3", (r) => {
      for (const t of r.final!.traders) t.resultNano = resultNano({ usdcMinor: BigInt(t.usdcMinor), fsiuMilliSiu: BigInt(t.fsiuMilliSiu), needsMet: t.needsMet }, P, DEFAULT_PARAMS).toString();
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
      unaffordable: [{ trader: "TRADER-4", requestId: "qr-8", usdcMinor: "10", fsiuMilliSiu: "10", needsMinor: "1725", needsMilliSiu: "1200" }],
    });
    expect(v.checks.find((c) => c.id === "no_payment_was_unaffordable")).toMatchObject({ ok: false });
    expect(renderWalk(v)).toContain("TRADER-4 qr-8 (holds 10 USDC, 10 mSIU; needs 1725 or 1200)");
  });

  it("lists where the script had to fall back without counting it as a failure", () => {
    const v = verifyLabWalk(goodReport(), { decided: [], unaffordable: [], fellBack: [{ trader: "TRADER-2", requestId: "qr-5", planned: "held", because: "holds 100 mSIU, the quote needs 1200" }] });
    expect(v.ok).toBe(true);
    expect(renderWalk(v)).toContain("TRADER-2 qr-5: planned held — holds 100 mSIU, the quote needs 1200");
  });
});

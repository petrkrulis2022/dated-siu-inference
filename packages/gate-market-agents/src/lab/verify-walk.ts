/**
 * What a scripted lab walk must have done, checked against the report it wrote — never against the script's
 * own account of what it issued. A script that issued its calls proves only that it issued them; these read
 * the recorded events (the loop's payment moments and capacity events, the books' sales, the operator's own
 * actions), so a path the walk was meant to exercise and did not is a failed check, not a quiet gap.
 *
 * Counts as evidence of nothing but that the plumbing works: a scripted run is never counted (plan §4).
 */
import { decimalToUnits, openingMilliSiuPerTrader, openingUsdcMinor, priceMilliSiu, printNano, quoteTerms, resultNano, usdcNeededPerTrader } from "./money.js";
import { buildPrintPath, stepDown, stepUp } from "./prints.js";
import type { ScriptStatus } from "./scripted-traders.js";
import type { LabParams } from "./economy.js";

export interface WalkCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface WalkVerdict {
  ok: boolean;
  checks: WalkCheck[];
  /** The script's own account of where it had to fall back, shown beside the checks, never counted as one. */
  fellBack: ScriptStatus["fellBack"];
}

/** The parts of a report this reads. Structural, so a test can build one by hand. */
export interface WalkReport {
  scripted: boolean;
  seed: number;
  params: LabParams;
  print: { printId?: string; rateUsdPerSiu: string };
  /** The scenario print in each round (D41), and every print the walk could have reached. */
  prints: { stepBps: number; byRound: string[]; reachableNano: string[] };
  economy: { needs: unknown[] };
  abortedBecause?: string;
  contamination?: string;
  infrastructureFailure?: unknown;
  labErrors: unknown[];
  toolErrors: { agentId: string; turn: number; tool: string; error: string }[];
  needsMet: Record<string, number>;
  sales: { requestId: string; round: number; kind: "trade" | "rawwork"; delivered: boolean; paidAsset?: string }[];
  paymentMoments: {
    agentId: string;
    tool: string;
    requestId?: string;
    heldReceivedMilliSiu: string;
    heldTotalMilliSiu?: string;
    quotedSiu?: string;
    quoteRateUsdPerSiu?: string;
    quotedUsdMax?: string;
  }[];
  /** What each trader was shown of its own wallet each turn (D50). */
  holdingsShown: { trader: string; round: number; usdcMinor: string; fsiuMilliSiu: string }[];
  routeOrder: { assetFirst: string; tools: string[] };
  /** Where the wallet shown to a trader differed from the chain's at a snapshot (none in a sound run). */
  holdingsDisagreements: unknown[];
  capacityEvents: { kind: string; quantityMilliSiu?: string; settlesRequestId?: string }[];
  operatorActions: { kind: string; [k: string]: unknown }[];
  snapshots: {
    label: string;
    traders: { trader: string; usdcMinor: string; fsiuMilliSiu: string }[];
    issuer: { usdcMinor: string; fsiuMilliSiu: string };
  }[];
  final?: {
    round: number;
    traders: { trader: string; usdcMinor: string; fsiuMilliSiu: string; needsMet: number; resultNano: string }[];
    issuer: { usdcMinor: string; fsiuMilliSiu: string };
  };
  measuredBeforeClose?: boolean;
  opening: { usdcMinorPerTrader: string; fsiuMilliSiuPerTrader: string };
  pool: { restored?: boolean };
}

type Route = "usdc" | "held" | "split";
const ROUTE_OF_TOOL: Record<string, Route> = { pay: "usdc", transfer_claim: "held", settle_split_held: "split" };

export function verifyLabWalk(r: WalkReport, status?: ScriptStatus): WalkVerdict {
  const checks: WalkCheck[] = [];
  const check = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  const saleKind = new Map(r.sales.map((s) => [s.requestId, s.kind]));

  check("is_marked_scripted", r.scripted === true, r.scripted ? "the report says no model was called" : "the report does not say it was scripted");
  check(
    "ran_clean",
    r.abortedBecause === undefined && r.contamination === undefined && r.infrastructureFailure === undefined,
    r.abortedBecause ?? r.contamination ?? (r.infrastructureFailure !== undefined ? "infrastructure failure" : "no abort, no contamination"),
  );
  check("no_bookkeeping_errors", r.labErrors.length === 0, `${r.labErrors.length} errors in the lab's own bookkeeping`);
  check(
    "no_tool_call_errored",
    r.toolErrors.length === 0,
    r.toolErrors.length === 0 ? "none" : r.toolErrors.map((e) => `${e.agentId} turn ${e.turn} ${e.tool}: ${e.error}`).join("; "),
  );

  const met = Object.values(r.needsMet).reduce((a, b) => a + b, 0);
  check("every_need_met", met === r.economy.needs.length, `${met} of ${r.economy.needs.length} needs met`);

  // ---- every route, for jobs and for raw work ------------------------------------------------
  const routes: Record<"trade" | "rawwork", Set<Route>> = { trade: new Set(), rawwork: new Set() };
  for (const m of r.paymentMoments) {
    const kind = m.requestId === undefined ? undefined : saleKind.get(m.requestId);
    const route = ROUTE_OF_TOOL[m.tool];
    if (kind !== undefined && route !== undefined) routes[kind].add(route);
  }
  const missing = (kind: "trade" | "rawwork", wanted: readonly Route[]): Route[] => wanted.filter((w) => !routes[kind].has(w));
  const jobMissing = missing("trade", ["usdc", "held", "split"]);
  const rawMissing = missing("rawwork", ["usdc", "held", "split"]);
  check("jobs_paid_every_route", jobMissing.length === 0, jobMissing.length === 0 ? `used ${[...routes.trade].join(", ")}` : `not used: ${jobMissing.join(", ")}`);
  check("raw_work_paid_every_route", rawMissing.length === 0, rawMissing.length === 0 ? `used ${[...routes.rawwork].join(", ")}` : `not used: ${rawMissing.join(", ")}`);

  // A split pays from both assets: its claim part must be a real transfer of a held claim, for some amount, keyed to the quote.
  const splitIds = r.paymentMoments.filter((m) => m.tool === "settle_split_held" && m.requestId !== undefined).map((m) => m.requestId!);
  const claimPartOf = new Map(
    r.capacityEvents.filter((e) => e.kind === "transfer_claim" && e.settlesRequestId !== undefined).map((e) => [e.settlesRequestId!, BigInt(e.quantityMilliSiu ?? "0")]),
  );
  const noClaimPart = splitIds.filter((id) => (claimPartOf.get(id) ?? 0n) <= 0n);
  check(
    "every_split_moved_a_held_claim",
    splitIds.length > 0 && noClaimPart.length === 0,
    splitIds.length === 0 ? "no quote was settled partly in each asset" : `${splitIds.length} split(s), ${noClaimPart.length} without a claim part recorded`,
  );

  const passedOn = r.paymentMoments.filter((m) => m.tool === "transfer_claim" && BigInt(m.heldReceivedMilliSiu) > 0n);
  check(
    "received_fsiu_passed_on",
    passedOn.length > 0,
    passedOn.length > 0
      ? `${passedOn.length} held-balance payment(s) made by a payer holding fSIU it had been given`
      : "no payment from a balance that included fSIU the payer had received",
  );

  // Each quote paid is paid once, and the loop saw it: no sale is marked paid without a payment, none is paid twice.
  const momentsPer = new Map<string, number>();
  for (const m of r.paymentMoments) if (m.requestId !== undefined) momentsPer.set(m.requestId, (momentsPer.get(m.requestId) ?? 0) + 1);
  const unpaidMoments = r.sales.filter((x) => x.paidAsset !== undefined && (momentsPer.get(x.requestId) ?? 0) !== 1);
  check("every_paid_sale_has_one_payment", unpaidMoments.length === 0, `${unpaidMoments.length} paid sale(s) without exactly one payment`);

  // ---- no escrow, no fee, nothing minted (D30, D31) -----------------------------------------
  // Direct settlement moves both assets between the same five wallets and nowhere else, so what the traders and the issuer
  // hold, together, does not change: a fee, money left in an escrow, a rebate or a mint after the opening would show here.
  const first = r.snapshots[0];
  const sum = (s: { traders: { usdcMinor: string; fsiuMilliSiu: string }[]; issuer: { usdcMinor: string; fsiuMilliSiu: string } }, asset: "usdcMinor" | "fsiuMilliSiu"): bigint =>
    s.traders.reduce((a, t) => a + BigInt(t[asset]), 0n) + BigInt(s.issuer[asset]);
  if (first !== undefined && r.final !== undefined) {
    const usdcBefore = sum(first, "usdcMinor");
    const usdcAfter = sum(r.final, "usdcMinor");
    const fsiuBefore = sum(first, "fsiuMilliSiu");
    const fsiuAfter = sum(r.final, "fsiuMilliSiu");
    check(
      "usdc_conserved_no_fee_no_escrow",
      usdcBefore === usdcAfter,
      usdcBefore === usdcAfter ? `${usdcAfter} USDC minor units across the traders and the issuer, before and after` : `${usdcBefore} before, ${usdcAfter} after`,
    );
    check(
      "fsiu_supply_unchanged",
      fsiuBefore === fsiuAfter,
      fsiuBefore === fsiuAfter ? `${fsiuAfter} mSIU across the traders and the issuer, before and after` : `${fsiuBefore} before, ${fsiuAfter} after`,
    );
  } else {
    check("usdc_conserved_no_fee_no_escrow", false, "no opening or final snapshot to compare");
    check("fsiu_supply_unchanged", false, "no opening or final snapshot to compare");
  }
  const created = r.capacityEvents.filter((e) => e.kind === "pay_with_claim" || e.kind === "settle_split" || e.kind === "mint_claim");
  check("nothing_minted_after_the_opening", created.length === 0, `${created.length} mint event(s) by an agent`);
  const rebates = r.operatorActions.filter((a) => a.kind === "fee_rebate");
  check("no_fee_rebated", rebates.length === 0, `${rebates.length} fee rebates (there is no fee)`);

  const expiries = r.operatorActions.filter((a) => a.kind === "expiry") as unknown as { quantityMilliSiu: string }[];
  const failedExpiries = r.operatorActions.filter((a) => a.kind === "expiry_failed");
  check(
    "leftover_fsiu_expired_at_close",
    expiries.length > 0 && failedExpiries.length === 0 && r.pool.restored === true,
    `${expiries.length} positions expired, ${failedExpiries.length} failed, pool ${r.pool.restored ? "restored" : "NOT restored"}`,
  );

  // fSIU is conserved: what was expired at close is exactly the endowment, since nothing is minted in the run.
  const endowed = BigInt(r.opening.fsiuMilliSiuPerTrader) * 4n;
  const expired = expiries.reduce((s, e) => s + BigInt(e.quantityMilliSiu), 0n);
  check("fsiu_conserved", expired === endowed, `expired ${expired} = endowment ${endowed}`);

  // ---- the opening, the rounds, the score ---------------------------------------------------
  const opening = r.snapshots[0];
  const uniform =
    opening !== undefined &&
    opening.traders.length === 4 &&
    opening.traders.every((t) => t.usdcMinor === r.opening.usdcMinorPerTrader && t.fsiuMilliSiu === r.opening.fsiuMilliSiuPerTrader);
  check("opening_equal_for_every_trader", uniform, uniform ? `each ${r.opening.usdcMinorPerTrader} USDC minor and ${r.opening.fsiuMilliSiuPerTrader} mSIU` : "the opening snapshot is not uniform");

  // Either asset alone must be enough for every need (D31): the opening is what the print and the schedule say it is.
  const pn = printNano(r.print.rateUsdPerSiu);
  const reachable = r.prints.reachableNano.map((x) => BigInt(x));
  const wantFsiu = openingMilliSiuPerTrader(r.params);
  const wantUsdc = openingUsdcMinor(reachable, r.params);
  const needUsdc = usdcNeededPerTrader(reachable, r.params);
  const sized = r.opening.fsiuMilliSiuPerTrader === wantFsiu.toString() && r.opening.usdcMinorPerTrader === wantUsdc.toString() && wantUsdc >= needUsdc;
  check(
    "opening_covers_every_need_in_either_asset",
    sized,
    sized
      ? `${wantFsiu} mSIU, or ${wantUsdc} USDC minor units against the ${needUsdc} every quote comes to at the highest print the walk can reach (${reachable.reduce((a, b) => (a > b ? a : b))})`
      : `opened with ${r.opening.fsiuMilliSiuPerTrader} mSIU and ${r.opening.usdcMinorPerTrader} USDC minor units; the print and schedule give ${wantFsiu} and ${wantUsdc} (needs ${needUsdc})`,
  );

  const labels = r.snapshots.map((s) => s.label);
  const wanted = Array.from({ length: r.params.rounds - 1 }, (_, i) => `round ${i + 2} opened`);
  check("every_round_opened", wanted.every((w) => labels.includes(w)), `snapshots: ${labels.join(", ")}`);

  // The path is what the seed says, every step is the step, and it moves every round (D41).
  const byRound = r.prints.byRound.map((x) => BigInt(x));
  const expectedPath = buildPrintPath(r.seed, pn, r.params, r.print.printId ?? "print").byRound;
  const pathIsSeeds = byRound.length === expectedPath.length && byRound.every((x, i) => x === expectedPath[i]);
  const stepsAreSteps = byRound.every(
    (x, i) => i === 0 || r.prints.stepBps === 0 || x === stepUp(byRound[i - 1], r.prints.stepBps) || x === stepDown(byRound[i - 1], r.prints.stepBps),
  );
  const moved = r.prints.stepBps === 0 || byRound.every((x, i) => i === 0 || x !== byRound[i - 1]);
  check(
    "print_path_is_the_seeds_and_moves_every_round",
    pathIsSeeds && stepsAreSteps && moved && byRound[0] === pn,
    pathIsSeeds && stepsAreSteps && moved && byRound[0] === pn
      ? `round by round ${byRound.join(" → ")} nano-USD per SIU, from the real print ${pn}, step ${r.prints.stepBps} bps`
      : `the report's prints (${byRound.join(", ")}) are not the seed's walk (${expectedPath.join(", ")}) from the real print ${pn}`,
  );

  // A quote is priced in SIU (D50): its siu is the price (1.2 for a job, 1 for a unit of raw work), its rate is the print of the round it was
  // asked for in, and its dollars are the SDK's own product at USDC's precision, rounded up.
  const saleOfId = new Map(r.sales.map((x) => [x.requestId, x]));
  const mispriced = r.paymentMoments.filter((m) => {
    if (m.requestId === undefined) return false;
    const sale = saleOfId.get(m.requestId);
    const print = sale === undefined ? undefined : byRound[sale.round - 1];
    if (sale === undefined || print === undefined || m.quotedSiu === undefined || m.quoteRateUsdPerSiu === undefined) return true;
    const t = quoteTerms(sale.kind, print, r.params);
    return decimalToUnits(m.quotedSiu, 3) !== t.milliSiu || decimalToUnits(m.quoteRateUsdPerSiu, 9) !== print || m.quotedUsdMax !== t.usd;
  });
  check("quotes_are_priced_in_siu_at_their_rounds_print", mispriced.length === 0, `${mispriced.length} payment(s) on a quote whose price in SIU, rate or dollars is not what the lab states`);

  // Paid in claims, a quote costs exactly its price in mSIU at every print: 1,200 for a job and 1,000 for a unit of raw work.
  const claimOf = new Map(r.capacityEvents.filter((e) => e.kind === "transfer_claim" && e.settlesRequestId !== undefined).map((e) => [e.settlesRequestId!, BigInt(e.quantityMilliSiu ?? "0")]));
  const wrongSize = r.paymentMoments.filter((m) => {
    if (m.tool !== "transfer_claim" || m.requestId === undefined) return false;
    const sale = saleOfId.get(m.requestId);
    return sale === undefined || claimOf.get(m.requestId) !== priceMilliSiu(sale.kind, r.params);
  });
  check("held_claims_cost_the_quotes_price_in_msiu", wrongSize.length === 0, `${wrongSize.length} held-claim payment(s) not exactly the quote's price in mSIU`);

  // What a trader was shown of its wallet is the chain's, and the first screen of each is the opening.
  const firstShown = new Map<string, WalkReport["holdingsShown"][number]>();
  for (const h of r.holdingsShown) if (!firstShown.has(h.trader)) firstShown.set(h.trader, h);
  const wrongOpening = [...firstShown.values()].filter((h) => h.usdcMinor !== r.opening.usdcMinorPerTrader || h.fsiuMilliSiu !== r.opening.fsiuMilliSiuPerTrader);
  check(
    "holdings_shown_start_at_the_opening",
    r.holdingsShown.length > 0 && firstShown.size === 4 && wrongOpening.length === 0,
    r.holdingsShown.length === 0 ? "no holdings were shown to any trader" : `${firstShown.size} traders shown their wallet; ${wrongOpening.length} first screen(s) not the opening`,
  );
  check(
    "holdings_shown_agree_with_the_chain",
    r.holdingsDisagreements !== undefined && r.holdingsDisagreements.length === 0,
    r.holdingsDisagreements === undefined ? "the report does not say" : `${r.holdingsDisagreements.length} snapshot(s) at which the wallet shown to a trader differed from the chain's`,
  );
  check(
    "route_order_recorded",
    r.routeOrder !== undefined && (r.routeOrder.assetFirst === "usdc" || r.routeOrder.assetFirst === "fsiu") && r.routeOrder.tools.length === 3,
    r.routeOrder === undefined ? "the report records no route order" : `assets ${r.routeOrder.assetFirst} first; routes ${r.routeOrder.tools.join(", ")}`,
  );

  const final = r.final === undefined ? undefined : byRound[r.final.round - 1];
  const p = final ?? pn;
  const recomputed = r.final?.traders.map((t) =>
    resultNano({ usdcMinor: BigInt(t.usdcMinor), fsiuMilliSiu: BigInt(t.fsiuMilliSiu), needsMet: t.needsMet }, p, r.params).toString(),
  );
  const same = r.final !== undefined && recomputed !== undefined && recomputed.every((v, i) => v === r.final!.traders[i].resultNano);
  check("score_recomputes_from_balances", same, same ? "each result equals USDC + fSIU at the print + credit" : "a result differs from its own balances");
  check("scored_before_the_window_closed", r.measuredBeforeClose === true, r.measuredBeforeClose ? "the snapshot fell inside the window" : "the snapshot fell after the window closed");

  if (status !== undefined) {
    check(
      "no_payment_was_unaffordable",
      status.unaffordable.length === 0,
      status.unaffordable.length === 0
        ? "every quote could be paid by some route"
        : status.unaffordable.map((u) => `${u.trader} ${u.requestId} (holds ${u.usdcMinor} USDC, ${u.fsiuMilliSiu} mSIU; needs ${u.needsMinor} or ${u.needsMilliSiu})`).join("; "),
    );
  }

  const undelivered = r.sales.filter((s) => s.kind === "trade" && !s.delivered);
  check("no_paid_job_left_undelivered", undelivered.length === 0, `${undelivered.length} jobs sold and not delivered`);

  return { ok: checks.every((c) => c.ok), checks, fellBack: status?.fellBack ?? [] };
}

export function renderWalk(v: WalkVerdict): string {
  const lines = ["SCRIPTED LAB WALK", ...v.checks.map((c) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.id}: ${c.detail}`)];
  if (v.fellBack.length > 0) {
    lines.push("  The script fell back from a planned route (not a check):");
    for (const f of v.fellBack) lines.push(`    ${f.trader} ${f.requestId}: planned ${f.planned} — ${f.because}`);
  }
  lines.push(v.ok ? "  ALL CHECKS PASSED" : "  AT LEAST ONE CHECK FAILED");
  return lines.join("\n");
}

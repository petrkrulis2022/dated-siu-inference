/**
 * What a scripted lab walk must have done, checked against the report it wrote — never against the script's
 * own account of what it issued. A script that issued its calls proves only that it issued them; these read
 * the recorded events (the loop's payment moments and capacity events, the books' sales, the operator's own
 * actions), so a path the walk was meant to exercise and did not is a failed check, not a quiet gap.
 *
 * Counts as evidence of nothing but that the plumbing works: a scripted run is never counted (plan §4).
 */
import { openingMilliSiuPerTrader, openingUsdcMinor, printNano, resultNano, usdcNeededPerTrader } from "./money.js";
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
  params: LabParams;
  print: { rateUsdPerSiu: string };
  economy: { needs: unknown[] };
  abortedBecause?: string;
  contamination?: string;
  infrastructureFailure?: unknown;
  labErrors: unknown[];
  toolErrors: { agentId: string; turn: number; tool: string; error: string }[];
  needsMet: Record<string, number>;
  sales: { requestId: string; kind: "trade" | "rawwork"; delivered: boolean; paidAsset?: string }[];
  paymentMoments: { agentId: string; tool: string; requestId?: string; heldReceivedMilliSiu: string }[];
  capacityEvents: { kind: string; quantityMilliSiu?: string; settlesRequestId?: string }[];
  operatorActions: { kind: string; [k: string]: unknown }[];
  snapshots: {
    label: string;
    traders: { trader: string; usdcMinor: string; fsiuMilliSiu: string }[];
    issuer: { usdcMinor: string; fsiuMilliSiu: string };
  }[];
  final?: {
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
  const wantFsiu = openingMilliSiuPerTrader(pn, r.params);
  const wantUsdc = openingUsdcMinor(pn, r.params);
  const needUsdc = usdcNeededPerTrader(pn, r.params);
  const sized = r.opening.fsiuMilliSiuPerTrader === wantFsiu.toString() && r.opening.usdcMinorPerTrader === wantUsdc.toString() && wantUsdc >= needUsdc;
  check(
    "opening_covers_every_need_in_either_asset",
    sized,
    sized
      ? `${wantFsiu} mSIU, or ${wantUsdc} USDC minor units against the ${needUsdc} every quote comes to`
      : `opened with ${r.opening.fsiuMilliSiuPerTrader} mSIU and ${r.opening.usdcMinorPerTrader} USDC minor units; the print and schedule give ${wantFsiu} and ${wantUsdc} (needs ${needUsdc})`,
  );

  const labels = r.snapshots.map((s) => s.label);
  const wanted = Array.from({ length: r.params.rounds - 1 }, (_, i) => `round ${i + 2} opened`);
  check("every_round_opened", wanted.every((w) => labels.includes(w)), `snapshots: ${labels.join(", ")}`);

  const p = pn;
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

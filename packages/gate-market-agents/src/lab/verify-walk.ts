/**
 * What a scripted lab walk must have done, checked against the report it wrote — never against the script's
 * own account of what it issued. A script that issued its calls proves only that it issued them; these read
 * the recorded events (the loop's payment moments and capacity events, the books' sales, the operator's own
 * actions), so a path the walk was meant to exercise and did not is a failed check, not a quiet gap.
 *
 * Counts as evidence of nothing but that the plumbing works: a scripted run is never counted (plan §4).
 */
import { escrowFeeMinor, printNano, resultNano } from "./money.js";
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
  escrowFeeBps: number;
  economy: { needs: unknown[] };
  abortedBecause?: string;
  contamination?: string;
  infrastructureFailure?: unknown;
  labErrors: unknown[];
  toolErrors: { agentId: string; turn: number; tool: string; error: string }[];
  needsMet: Record<string, number>;
  sales: { requestId: string; kind: "trade" | "rawwork"; delivered: boolean }[];
  paymentMoments: { agentId: string; tool: string; requestId?: string; heldReceivedMilliSiu: string }[];
  usdcSettlements: { requestId: string; settledMinorUnits: string; quotedMinorUnits: string }[];
  capacityEvents: { kind: string; quantityMilliSiu?: string; settlesRequestId?: string }[];
  operatorActions: { kind: string; [k: string]: unknown }[];
  snapshots: { label: string; traders: { trader: string; usdcMinor: string; fsiuMilliSiu: string }[] }[];
  final?: { traders: { trader: string; usdcMinor: string; fsiuMilliSiu: string; needsMet: number; resultNano: string }[] };
  measuredBeforeClose?: boolean;
  opening: { usdcMinorPerTrader: string; fsiuMilliSiuPerTrader: string };
  pool: { restored?: boolean };
}

type Route = "usdc" | "mint_forward" | "held" | "split";
const ROUTE_OF_TOOL: Record<string, Route> = { pay: "usdc", pay_with_claim: "mint_forward", transfer_claim: "held", settle_split: "split" };

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
  const jobMissing = missing("trade", ["usdc", "mint_forward", "held", "split"]);
  const rawMissing = missing("rawwork", ["usdc", "mint_forward", "held"]);
  check("jobs_paid_every_route", jobMissing.length === 0, jobMissing.length === 0 ? `used ${[...routes.trade].join(", ")}` : `not used: ${jobMissing.join(", ")}`);
  check("raw_work_paid_every_route", rawMissing.length === 0, rawMissing.length === 0 ? `used ${[...routes.rawwork].join(", ")}` : `not used: ${rawMissing.join(", ")}`);

  const passedOn = r.paymentMoments.filter((m) => m.tool === "transfer_claim" && BigInt(m.heldReceivedMilliSiu) > 0n);
  check(
    "received_fsiu_passed_on",
    passedOn.length > 0,
    passedOn.length > 0
      ? `${passedOn.length} held-balance payment(s) made by a payer holding fSIU it had been given`
      : "no payment from a balance that included fSIU the payer had received",
  );

  // ---- the operator's side -------------------------------------------------------------------
  const rebates = r.operatorActions.filter((a) => a.kind === "fee_rebate") as unknown as { requestId: string; settledMinorUnits: string; rebatedMinorUnits: string }[];
  const wrong = rebates.filter((x) => escrowFeeMinor(BigInt(x.settledMinorUnits), r.escrowFeeBps).toString() !== x.rebatedMinorUnits);
  check(
    "fee_rebated_after_every_dollar_settlement",
    rebates.length === r.usdcSettlements.length && wrong.length === 0 && r.usdcSettlements.length > 0,
    `${r.usdcSettlements.length} dollar settlements, ${rebates.length} rebates${wrong.length > 0 ? `, ${wrong.length} not equal to the contract's fee` : ""}`,
  );
  const notInFull = r.usdcSettlements.filter((s) => s.settledMinorUnits !== s.quotedMinorUnits);
  check("dollar_settlements_in_full", notInFull.length === 0, `${notInFull.length} settled for less than quoted`);

  const expiries = r.operatorActions.filter((a) => a.kind === "expiry") as unknown as { quantityMilliSiu: string }[];
  const failedExpiries = r.operatorActions.filter((a) => a.kind === "expiry_failed");
  check(
    "leftover_fsiu_expired_at_close",
    expiries.length > 0 && failedExpiries.length === 0 && r.pool.restored === true,
    `${expiries.length} positions expired, ${failedExpiries.length} failed, pool ${r.pool.restored ? "restored" : "NOT restored"}`,
  );

  // fSIU is conserved: what was expired at close is what was handed out plus what was minted in the run.
  const endowed = BigInt(r.opening.fsiuMilliSiuPerTrader) * 4n;
  const minted = r.capacityEvents
    .filter((e) => e.kind === "pay_with_claim" || e.kind === "settle_split" || e.kind === "mint_claim")
    .reduce((s, e) => s + BigInt(e.quantityMilliSiu ?? "0"), 0n);
  const expired = expiries.reduce((s, e) => s + BigInt(e.quantityMilliSiu), 0n);
  check("fsiu_conserved", expired === endowed + minted, `expired ${expired} = endowment ${endowed} + minted ${minted}`);

  // ---- the opening, the rounds, the score ---------------------------------------------------
  const opening = r.snapshots[0];
  const uniform =
    opening !== undefined &&
    opening.traders.length === 4 &&
    opening.traders.every((t) => t.usdcMinor === r.opening.usdcMinorPerTrader && t.fsiuMilliSiu === r.opening.fsiuMilliSiuPerTrader);
  check("opening_equal_for_every_trader", uniform, uniform ? `each ${r.opening.usdcMinorPerTrader} USDC minor and ${r.opening.fsiuMilliSiuPerTrader} mSIU` : "the opening snapshot is not uniform");

  const labels = r.snapshots.map((s) => s.label);
  const wanted = Array.from({ length: r.params.rounds - 1 }, (_, i) => `round ${i + 2} opened`);
  check("every_round_opened", wanted.every((w) => labels.includes(w)), `snapshots: ${labels.join(", ")}`);

  const p = printNano(r.print.rateUsdPerSiu);
  const recomputed = r.final?.traders.map((t) =>
    resultNano({ usdcMinor: BigInt(t.usdcMinor), fsiuMilliSiu: BigInt(t.fsiuMilliSiu), needsMet: t.needsMet }, p, r.params).toString(),
  );
  const same = r.final !== undefined && recomputed !== undefined && recomputed.every((v, i) => v === r.final!.traders[i].resultNano);
  check("score_recomputes_from_balances", same, same ? "each result equals USDC + fSIU at the print + credit" : "a result differs from its own balances");
  check("scored_before_the_window_closed", r.measuredBeforeClose === true, r.measuredBeforeClose ? "the snapshot fell inside the window" : "the snapshot fell after the window closed");

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

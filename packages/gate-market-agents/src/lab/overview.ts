/**
 * The overview every run's report carries (the user's standing request, 2026-10-07; widened for instrument v8, D52): every transaction and
 * every decision, in the order it happened, with what each agent SAID about it — its stated reason and the relevant excerpt of its raw reply —
 * and any reasoning its provider returned. Generated from the run's report alone, so anyone holding the report can regenerate it, and committed
 * beside it.
 *
 * It states what happened and what each agent said. It draws no conclusion about why an agent chose what it chose: a stated reason is one line
 * the agent wrote after the fact, optional, and the raw reply is authoritative where they differ; a returned reasoning is whatever the provider
 * hands back at the lab's own settings, and for some models that is nothing. Explanations belong to whoever reads this, with the evidence in
 * front of them; an overview that offered its own would be one more thing that quietly shapes the reading.
 */
import { decimalToUnits, quoteTerms, unitsToDecimal } from "./money.js";
import { fmt } from "./quote-text.js";
import { LAB_INSTRUMENT_VERSION } from "./instrument.js";
import { claimValueMinorUnits } from "../tools/settle-split.js";
import { measureRun, labDisqualification, type MeasureReport, type RunMeasures } from "./measure.js";
import { isPayment, rationaleCoverage, type DecisionRecord } from "./decisions.js";
import { describeCapture, type ThinkingCapture } from "./thinking-report.js";

/** A report as `runLab` writes it, with everything beyond what measurement needs optional, so an older report renders too. */
export interface OverviewReport extends Omit<MeasureReport, "sales"> {
  sales: { requestId: string; round?: number; kind: "trade" | "rawwork"; buyer: string; seller: string; needId?: string; quoted?: boolean; paid?: boolean; paidAsset?: string; delivered: boolean; attempts?: number }[];
  models?: Record<string, string>;
  window?: { fromChainSeconds: string; toChainSeconds: string };
  turnsByAgent?: Record<string, number>;
  toolErrors?: { agentId: string; turn: number; seq?: number; tool: string; error: string }[];
  refusals?: { agentId: string; turn: number; seq?: number; kind: string; sentence: string }[];
  lag?: { writesRetried: number; recovered: number; gaveUp: number };
  spendByProvider?: Record<string, string>;
  decisions?: DecisionRecord[];
  routeOrder?: { assetFirst: string; tools: string[] };
  thinkingCapture?: Record<string, ThinkingCapture>;
  opening?: { usdcMinorPerTrader?: string; fsiuMilliSiuPerTrader: string };
}

export interface OverviewOptions {
  /** Where the decisions came from, when they were not in the report itself: said at the top, so nobody reads a reconstruction as a record. */
  decisionsNote?: string;
}

const cell = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
const quoteText = (s: string | undefined): string => (s === undefined ? "" : s.replace(/\s+/g, " ").trim());
const PRINT_WORDS = /\bprint\b|hedge|\block(ed|ing)?\b|expir|conserv|cheaper|dearer|\bris(e|es|ing)\b|\bfall(s|ing)?\b|appreciat|depreciat|convert/i;

/** The decisions sorted into the order they were taken in: the loop's own counter where there is one, else turn then seat. */
function inOrder(decisions: readonly DecisionRecord[]): DecisionRecord[] {
  return [...decisions].sort((a, b) => (a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : a.turn - b.turn || a.agentId.localeCompare(b.agentId)));
}

export function renderOverview(r: OverviewReport, options: OverviewOptions = {}): string {
  const m: RunMeasures = measureRun(r as unknown as MeasureReport);
  const labelOfSeat = Object.fromEntries(Object.entries(r.seats).map(([label, seat]) => [seat, label])) as Record<string, string>;
  // Only the traders decide: the issuer service's replies are a fixed policy's, with no model behind them and no reason to give.
  const decisions = inOrder((r.decisions ?? []).filter((d) => labelOfSeat[d.agentId] !== undefined));
  const who = (seat: string): string => labelOfSeat[seat] ?? seat;
  const siuPriced = (r.instrument?.version ?? 0) >= 8;
  const moments = r.paymentMoments;
  const claimOf = new Map<string, string>();
  for (const e of r.capacityEvents) if (e.settlesRequestId !== undefined && e.quantityMilliSiu !== undefined) claimOf.set(e.settlesRequestId, e.quantityMilliSiu);
  const saleOf = new Map(r.sales.map((s) => [s.requestId, s]));
  const needOf = new Map(r.economy.needs.map((n) => [n.id, n as { id: string; buyer: string; seller: string; round: number; type?: string }]));
  const printOfRound = (round: number | undefined): bigint | undefined => (round === undefined || r.prints === undefined ? undefined : BigInt(r.prints.byRound[round - 1] ?? "0") || undefined);
  const printText = (p: bigint | undefined): string => (p === undefined ? "?" : unitsToDecimal(p, 9));
  const movingPrint = (r.prints?.stepBps ?? 0) > 0;
  const momentOf = new Map(moments.filter((x) => x.requestId !== undefined).map((x) => [x.requestId!, x]));
  const h2RowOf = new Map(m.h2.rows.map((x) => [x.requestId, x]));
  const waitOf = new Map((r.waits ?? []).map((w) => [`${w.agentId}#${w.turn}`, w]));
  const decisionAt = new Set(decisions.map((d) => `${d.agentId}#${d.turn}`));
  const payee = (s: { seller: string }): string => (s.seller === "ISSUER" ? "ISSUER-B" : s.seller);
  const what = (s: { kind: "trade" | "rawwork"; needId?: string }): string =>
    s.kind === "rawwork" ? "1 unit of raw work" : `a ${(s.needId === undefined ? undefined : needOf.get(s.needId))?.type ?? ""} job`.replace("a  job", "a job");

  /** What a sale cost, in SIU and in both assets, at its own round's print: as the v8 quote states it. Older reports state only the dollars. */
  const priceOf = (s: { kind: "trade" | "rawwork"; round?: number }, usdMax: string | undefined): string => {
    const p = printOfRound(s.round);
    if (siuPriced && p !== undefined) {
      const t = quoteTerms(s.kind, p, r.params);
      return `${t.siu} SIU = ${t.usd} USD = ${fmt(t.milliSiu)} mSIU of fSIU (print ${printText(p)})`;
    }
    return usdMax === undefined ? "?" : `$${usdMax} (a quote not denominated in SIU: made before instrument v8)`;
  };

  /** How a payment was made, and the amounts that moved. */
  const paidIn = (sale: { requestId: string; kind: "trade" | "rawwork"; round?: number; paidAsset?: string }, usdMax: string): string => {
    const asset = sale.paidAsset ?? "usdc";
    const priceMinor = decimalToUnits(usdMax, 6);
    const claim = claimOf.get(sale.requestId);
    if (asset === "usdc") return `USDC (${fmt(priceMinor)} USDC minor units)`;
    if (asset === "fsiu") return `fSIU (${claim === undefined ? "?" : fmt(BigInt(claim))} mSIU)`;
    const p = printOfRound(sale.round);
    const value = claim !== undefined && p !== undefined ? claimValueMinorUnits(claim, p.toString()) : undefined;
    return `USDC + fSIU (${claim === undefined ? "?" : `${fmt(BigInt(claim))} mSIU`} + ${value === undefined ? "?" : `${fmt(priceMinor - value)} USDC minor units`})`;
  };

  const out: string[] = [];
  // Two questions, kept apart: was it a sound run of its own instrument, and does it pool with runs under the current one?
  const ownReason = labDisqualification({ ...(r as unknown as MeasureReport), instrument: { version: LAB_INSTRUMENT_VERSION } });
  const poolReason = labDisqualification(r as unknown as MeasureReport);
  out.push(`# Run overview — ${r.runId}`, "");
  if (options.decisionsNote !== undefined) out.push(`> ${options.decisionsNote}`, "");
  out.push(
    `- **Seed ${r.seed}; instrument ${r.instrument?.version ?? "not stamped"}; ${r.scripted ? "a scripted walk (no model was called)" : "a model run"}.**`,
    `- **A sound run of its own instrument: ${ownReason === null ? "yes" : `NO — ${ownReason}`}.**`,
    `- **Pooled with runs under the current instrument (v${LAB_INSTRUMENT_VERSION}): ${poolReason === null ? "yes" : ownReason === null ? "no — made under another version" : "no"}.**`,
    ...(!siuPriced ? ["- **Made before instrument v8: no agent in this run saw a quote in SIU or its own fSIU holdings, so it is not a test of H1 or H2.**"] : []),
    ...(r.models !== undefined ? [`- Models: ${Object.entries(r.models).map(([t, mo]) => `${t} ${mo}`).join("; ")}.`] : []),
    ...(r.routeOrder !== undefined ? [`- Order in which the lab listed the routes and assets this run (drawn from the seed): ${r.routeOrder.assetFirst === "usdc" ? "USDC" : "fSIU"} first; routes ${r.routeOrder.tools.join(", ")}.`] : []),
    ...(r.prints !== undefined
      ? [`- Print by round (nano-USD per SIU; a scenario value, step ${r.prints.stepBps} bps): ${r.prints.byRound.map((p, i) => `round ${i + 1} ${p}`).join(", ")}.`]
      : []),
    `- Cost $${m.costUsd}${r.spendByProvider !== undefined ? ` (${Object.entries(r.spendByProvider).filter(([, v]) => Number(v) > 0).map(([p, v]) => `${p} $${v}`).join(", ")})` : ""}.`,
    "",
    "## Headline",
    `- Needs met **${m.needsMet} of ${m.needsTotal}**. Opportunities **${m.opportunities}**, reused **${m.reuse}**, partial reuse ${m.partialReuse}.`,
    `- Payments: **${m.paymentsByRoute.usdc} in USDC, ${m.paymentsByRoute.held} from a held claim, ${m.paymentsByRoute.split} split**${m.paymentsByRoute.usdc + m.paymentsByRoute.held + m.paymentsByRoute.split === moments.length ? "" : " (some payments name no quote and are left out)"}.`,
    `- H2, decision level (payments made while holding fSIU): ${m.h2.counts.withN} by a trader with raw work still to buy (${m.h2.counts.withSum} in USDC), ${m.h2.counts.withoutN} by one without (${m.h2.counts.withoutSum} in USDC). One run has too few to read against H2's thresholds.`,
    `- Waited while it had something it could do: **${m.waitedWithWork}** recorded wait(s).`,
    "",
  );

  // ---- every transaction ----------------------------------------------------------------------------------------------
  out.push(
    "## Every payment, in the order it was made",
    "",
    "| # | Round asked / paid | Print asked / paid | Payer → payee | What | Price | Paid in | Outcome | Stated reason (the agent's own words) |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  let n = 0;
  for (const mo of moments) {
    const sale = mo.requestId === undefined ? undefined : saleOf.get(mo.requestId);
    if (sale === undefined || mo.quotedUsdMax === undefined) continue;
    n += 1;
    const d = decisions.find((x) => x.agentId === mo.agentId && x.turn === mo.turn);
    const paidRound = d?.round;
    const rounds = `${sale.round !== undefined ? `r${sale.round}` : "?"} / ${paidRound !== undefined ? `r${paidRound}` : "?"}`;
    const prints = `${printText(printOfRound(sale.round))} / ${printText(printOfRound(paidRound))}`;
    const outcome = sale.kind === "trade" ? (sale.delivered ? "paid; job delivered" : "paid; job NOT delivered") : "paid; unit of raw work received";
    const reason = d === undefined ? "(decision not recorded)" : d.rationale ?? "(none given)";
    out.push(`| ${n} | ${rounds} | ${prints} | ${who(mo.agentId)} → ${payee(sale)} | ${what(sale)} | ${priceOf(sale, mo.quotedUsdMax)} | ${paidIn(sale, mo.quotedUsdMax)} | ${outcome} | ${cell(reason)} |`);
  }
  if (n === 0) out.push("| — | | | no payment was made | | | | | |");
  out.push("");

  const unpaid = r.sales.filter((s) => s.paid !== true);
  out.push("## Asked for but never paid", "");
  if (unpaid.length === 0) out.push("- None: every request that was made was paid.");
  for (const s of unpaid) {
    out.push(`- ${s.requestId}, round ${s.round ?? "?"}, print ${printText(printOfRound(s.round))}: ${s.buyer} asked ${payee(s)} for ${what(s)}; ${s.quoted === true ? "it was quoted and never paid" : "it was never quoted"}. Price: ${priceOf(s, undefined)}.`);
  }
  const unrequested = r.economy.needs.filter((nd) => !r.sales.some((s) => s.needId === nd.id));
  if (unrequested.length > 0) out.push("", `Needs never even asked for: ${unrequested.map((nd) => `${nd.id} (${(nd as { type?: string }).type ?? "a job"} from ${nd.seller}, round ${nd.round})`).join("; ")}.`);
  out.push("");

  // ---- every decision, in order ----------------------------------------------------------------------------------------
  out.push("## Every decision, in the order it was taken", "");
  const opening = r.snapshots[0];
  out.push(
    `**Endowment** (before any turn): ${opening?.traders.map((t) => `${t.trader} ${fmt(BigInt(t.usdcMinor))} USDC minor units and ${fmt(BigInt(t.fsiuMilliSiu))} mSIU of fSIU`).join("; ") ?? "not recorded"}. The operator minted it; nothing is minted after.`,
    "",
  );
  if (decisions.length === 0) out.push("No decisions are recorded for this run.", "");
  let lastRound: number | undefined;
  let k = 0;
  const formatRefusals = (r.refusals ?? []).filter((x) => x.kind === "format" && !decisionAt.has(`${x.agentId}#${x.turn}`));
  const events: { seq: number; text: string[] }[] = [];
  for (const d of decisions) {
    const sale = d.requestId === undefined ? undefined : saleOf.get(d.requestId);
    const mo = d.requestId === undefined ? undefined : momentOf.get(d.requestId);
    const lines: string[] = [];
    const thisPrint = printOfRound(d.round);
    let what_: string;
    if (isPayment(d.tool) && sale !== undefined) what_ = `${who(d.agentId)} pays ${payee(sale)} for ${what(sale)} (${d.requestId}) with \`${d.tool}\``;
    else if (d.tool === "request_quote") what_ = `${who(d.agentId)} asks for a quote${sale === undefined ? "" : ` from ${payee(sale)} for ${what(sale)} (${d.requestId})`}`;
    else if (d.tool === "issue_quote" && sale !== undefined) what_ = `${who(d.agentId)} issues the quote ${d.requestId} to ${sale.buyer}`;
    else if (d.tool === "deliver_job" && sale !== undefined) what_ = `${who(d.agentId)} delivers ${what(sale)} (${d.requestId}) to ${sale.buyer}`;
    else if (d.tool === "wait") what_ = `${who(d.agentId)} waits`;
    else what_ = `${who(d.agentId)} calls \`${d.tool}\`${d.requestId !== undefined ? ` (${d.requestId})` : ""}`;
    lines.push(`- **${++k}. Turn ${d.turn}${d.round !== undefined ? `, round ${d.round}` : ""}${thisPrint !== undefined ? `, print ${printText(thisPrint)}` : ""} — ${what_}**`);
    if (sale !== undefined && (isPayment(d.tool) || d.tool === "request_quote" || d.tool === "issue_quote")) {
      lines.push(`  - Price: ${priceOf(sale, mo?.quotedUsdMax)}`);
    }
    if (isPayment(d.tool) && sale !== undefined && mo?.quotedUsdMax !== undefined) {
      const row = h2RowOf.get(sale.requestId);
      lines.push(
        `  - Asset used: ${paidIn(sale, mo.quotedUsdMax)}`,
        ...(row !== undefined ? [`  - Held ${fmt(BigInt(row.heldTotalMilliSiu))} mSIU of fSIU before paying; raw work still to buy after this payment: ${row.rawStillToBuy}; the fSIU held ${row.coverable ? "could" : "could not"} have paid this quote in full.`] : []),
      );
    }
    const w = waitOf.get(`${d.agentId}#${d.turn}`);
    if (d.tool === "wait") lines.push(`  - On its screen: ${w === undefined ? "not recorded" : w.hadWork.length === 0 ? "nothing it could act on" : w.hadWork.join("; ")}`);
    lines.push(`  - Outcome: ${cell(d.outcome ?? "not recorded")}`);
    lines.push(`  - Stated reason: ${d.rationale === undefined ? "(none given)" : `"${quoteText(d.rationale)}"`}`);
    if (d.friction !== undefined) lines.push(`  - Friction fields: ${Object.entries(d.friction).map(([key, v]) => `${key}: "${quoteText(v)}"`).join("; ")}`);
    lines.push(`  - Raw reply: \`${quoteText(d.raw ?? "not recorded").replace(/`/g, "'")}\``);
    lines.push(
      `  - Reasoning returned by the provider: ${d.thinking === undefined ? `none${d.reasoningTokens !== undefined && d.reasoningTokens > 0 ? ` (${d.reasoningTokens} reasoning tokens billed, text not returned)` : ""}` : `"${quoteText(d.thinking)}"`}`,
    );
    events.push({ seq: d.seq ?? d.turn, text: lines });
    if (d.round !== undefined && d.round !== lastRound) {
      // A round marker goes before the first decision taken in it.
      events[events.length - 1].text.unshift(`### Round ${d.round}${thisPrint !== undefined ? ` — print ${printText(thisPrint)} USD per SIU${d.round > 1 && printOfRound(d.round - 1) !== undefined ? ` (the previous round's was ${printText(printOfRound(d.round - 1))})` : ""}` : ""}`, "");
      lastRound = d.round;
    }
  }
  for (const e of events) out.push(...e.text);
  if (formatRefusals.length > 0) {
    out.push("", "Replies that could not be read as a call (not decisions):");
    for (const x of formatRefusals) out.push(`- ${who(x.agentId)}, turn ${x.turn}: ${cell(x.sentence).slice(0, 220)}`);
  }
  const expiries = r.operatorActions.filter((a) => a.kind === "expiry" || a.kind === "expiry_failed");
  out.push("", `**Expiries** (swept by the operator after the window closed): ${expiries.length === 0 ? "none." : expiries.map((a) => `${String(a.holder)} ${fmt(BigInt(String(a.quantityMilliSiu === "unknown" ? 0 : a.quantityMilliSiu)))} mSIU${a.kind === "expiry_failed" ? " (FAILED)" : ""}`).join("; ") + "."}`, "");

  // ---- per trader ------------------------------------------------------------------------------------------------------
  out.push("## Each trader", "", "| Trader | Model | Needs met | Paid in USDC | Paid from held fSIU | Split | fSIU: opened → ended | Result vs opening |", "|---|---|---|---|---|---|---|---|");
  for (const t of m.traders) {
    const open = r.snapshots[0]?.traders.find((x) => x.trader === t.trader);
    const end = r.final?.traders.find((x) => x.trader === t.trader);
    const usdc = t.jobsBoughtBy.usdc + t.rawBoughtBy.usdc;
    const held = t.jobsBoughtBy.held + t.rawBoughtBy.held;
    const split = t.jobsBoughtBy.split + t.rawBoughtBy.split;
    const delta = BigInt(t.resultNano) - BigInt(t.openingResultNano);
    out.push(
      `| ${t.trader} | ${r.models?.[t.trader] ?? "?"} | ${t.needsMet} | ${usdc} | ${held} | ${split} | ${open?.fsiuMilliSiu ?? "?"} → ${end?.fsiuMilliSiu ?? "?"} mSIU | ${delta >= 0n ? "+" : "−"}${unitsToDecimal(delta >= 0n ? delta : -delta, 9)} USD |`,
    );
  }
  out.push("");

  // ---- H2 at the decision level, and the holdings table as context ----------------------------------------------------------
  out.push("## H2 at the decision level: every payment made while holding fSIU", "");
  if (m.h2.rows.length === 0) {
    out.push(siuPriced ? "- No payment was made while holding fSIU." : "- Not recorded: reports made before instrument v8 do not carry what the payer held at each payment.");
  } else {
    out.push("| Payer | Round | For | Held before paying (mSIU) | Raw work still to buy | Could the fSIU have paid it in full | Paid in |", "|---|---|---|---|---|---|---|");
    for (const row of m.h2.rows) {
      out.push(`| ${row.trader} | ${row.round ?? "?"} | ${row.kind === "rawwork" ? "raw work" : "a job"} | ${fmt(BigInt(row.heldTotalMilliSiu))} | ${row.rawStillToBuy} | ${row.coverable ? "yes" : "no"} | ${row.route === "usdc" ? "USDC" : row.route === "held" ? "held fSIU" : "split"} |`);
    }
    const c = m.h2.counts;
    out.push("", `With raw work still to buy: ${c.withN} payment(s), ${c.withSum} in USDC. Without: ${c.withoutN}, ${c.withoutSum} in USDC. Hedging predicts the first group pays USDC and the second spends fSIU; inertia predicts USDC from both. One run has too few to read against H2's thresholds.`);
  }
  out.push("");
  if (movingPrint) {
    out.push("### Holdings at each round's start (context; read by no rule)", "", "| Trader | " + (r.prints?.byRound.map((_, i) => `Round ${i + 1}`).join(" | ") ?? "") + " |", "|---|" + (r.prints?.byRound.map(() => "---").join("|") ?? "") + "|");
    for (const t of m.traders) {
      const rows = m.holdings.filter((h) => h.trader === t.trader && h.label !== "final");
      out.push(`| ${t.trader} | ${rows.map((h) => `${((h.heldFraction ?? 0) * 100).toFixed(0)}% held (${h.fsiuMilliSiu} mSIU); ${h.upcomingRawUnits} unit(s) to buy`).join(" | ")} |`);
    }
    out.push("");
  }

  // ---- what they said about the print, holding, expiry, conserving ---------------------------------------------------------------
  const said = decisions.filter((d) => d.rationale !== undefined && PRINT_WORDS.test(d.rationale + " " + Object.values(d.friction ?? {}).join(" ")));
  out.push("## What traders said that mentions the print, holding, expiry or conserving (any call)", "");
  if (said.length === 0) out.push("- Nothing.");
  for (const d of said) out.push(`- ${who(d.agentId)}, ${d.round !== undefined ? `round ${d.round}, ` : ""}turn ${d.turn}, \`${d.tool}\`: ${cell(d.rationale)}`);
  out.push("");

  // ---- reasoning each provider returned --------------------------------------------------------------------------------------
  out.push("## Reasoning each model returned", "", "Captured from each provider's own response at the lab's settings. No extended thinking was switched on and no reasoning effort was changed to get more.", "");
  if (r.thinkingCapture === undefined || Object.keys(r.thinkingCapture).length === 0) {
    out.push("- Not recorded: this report predates the capture.");
  } else {
    for (const [trader, c] of Object.entries(r.thinkingCapture)) out.push(`- ${trader} (${c.model}): ${describeCapture(c)}.`);
  }
  out.push("");

  // ---- harness ---------------------------------------------------------------------------------------------------------
  out.push("## The harness", "");
  out.push(`- Turns: ${Object.entries(r.turnsByAgent ?? {}).map(([a, t]) => `${who(a)} ${t}`).join(", ") || "not recorded"}.`);
  out.push(`- How each seat ended: ${Object.entries(r.haltedReason ?? {}).map(([a, w]) => `${who(a)} ${w}`).join(", ") || "not recorded"}.`);
  const refusals = r.refusals ?? [];
  out.push(`- Refusals before a call ran: ${refusals.length}${refusals.length ? ":" : "."}`);
  for (const x of refusals) out.push(`  - ${who(x.agentId)} turn ${x.turn} (${x.kind}): ${cell(x.sentence).slice(0, 220)}`);
  const errs = r.toolErrors ?? [];
  out.push(`- Tool calls that errored: ${errs.length}${errs.length ? ":" : "."}`);
  for (const x of errs) out.push(`  - ${who(x.agentId)} turn ${x.turn} ${x.tool}: ${cell(x.error).slice(0, 220)}`);
  if (r.lag !== undefined) out.push(`- Writes that needed the node to catch up: ${r.lag.writesRetried} (${r.lag.recovered} recovered, ${r.lag.gaveUp} gave up).`);
  out.push("");

  // ---- the emphasis check ----------------------------------------------------------------------------------------------
  out.push("## Stated reasons: coverage, and the emphasis check", "");
  if (decisions.length === 0) {
    out.push("- No decisions are recorded for this run, so there are no stated reasons to show or check.");
  } else {
    const cov = rationaleCoverage(decisions);
    const pct = (c: { calls: number; withRationale: number }): string => `${c.withRationale} of ${c.calls}${c.calls ? ` (${Math.round((100 * c.withRationale) / c.calls)}%)` : ""}`;
    out.push(
      `- A rationale accompanied ${pct(cov.payments)} payment calls and ${pct(cov.others)} of every other call.`,
      `- By tool: ${Object.entries(cov.byTool).sort().map(([t, c]) => `${t} ${c.withRationale}/${c.calls}`).join(", ")}.`,
      cov.emphasis
        ? "- **EMPHASIS FLAG: payments carry a stated reason much more often than other calls. Check this before reading anything into the reasons: it is the emphasis effect, the option you instrument is the option you emphasise.**"
        : "- No emphasis effect: payments do not carry a stated reason noticeably more often than other calls.",
      "- The reasons are one optional line in the agent's own words, never required, validated or prompted for beyond one sentence that is the same for every tool. Where one differs from the raw reply, the raw reply is authoritative.",
      "- The field is present on almost every call, so its absence is rare and tells little here; what an agent chose to say is the information.",
    );
  }
  out.push("");
  return out.join("\n");
}

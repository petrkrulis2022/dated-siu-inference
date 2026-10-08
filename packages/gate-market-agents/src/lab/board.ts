/**
 * What the lab tells a trader, every turn. Two strings, because the loop makes two decisions about
 * them: what the trader is SHOWN, and what is a reason to WAKE it (`loop/lab-hooks.ts`).
 *
 * Facts only. It states the schedule, the prices and what the trader owes and may do; it does not say
 * which asset to use, whether to hold or spend, or what would be wise. From instrument v8 (D50) it does name both assets: a price is
 * stated in SIU and then in what settling it costs in each asset at the round's print, and the trader's holdings are stated in
 * both, each also in the other's terms — the choice of asset is the thing being measured, and an agent cannot choose between
 * two assets it is never shown side by side.
 */
import { LabBooks } from "./books.js";
import { ISSUER_SEAT, JOB_TYPES, LAB_TRADERS, needsInRound, type TraderLabel } from "./economy.js";
import { jobSiu, quoteTerms } from "./money.js";
import { describeMove, printText } from "./prints.js";
import type { GuardConfig } from "./guards.js";
import { holdingsLine, settleText } from "./quote-text.js";
import { FIXED_ROUTE_ORDER, type RouteOrder } from "./route-order.js";

export interface InfoOptions {
  /** The run's seeded order of routes and assets (`route-order.ts`); the fixed one where a test has no seed. */
  order?: RouteOrder;
  /** The trader's confirmed holdings, read from the chain this turn. Without them the line is left out rather than guessed. */
  held?: { usdcMinor: bigint; fsiuMilliSiu: bigint };
}

export function renderLabInfo(books: LabBooks, cfg: GuardConfig, me: TraderLabel, opts: InfoOptions = {}): string {
  const e = books.economy;
  const order = opts.order ?? FIXED_ROUTE_ORDER;
  const size = jobSiu(cfg.params);
  const job = quoteTerms("trade", cfg.printNano, cfg.params);
  const raw = quoteTerms("rawwork", cfg.printNano, cfg.params);
  const lines: string[] = [
    `THE LAB — ROUND ${books.round} OF ${e.params.rounds}`,
    `  You are ${me}. You deliver ${e.skillOf[me]} jobs, and only you can.`,
    ...(opts.held === undefined ? [] : [`  ${holdingsLine(opts.held, cfg.printNano, order)}`]),
    `  A job is ${size} SIU of work, priced at ${job.siu} SIU; at this round's print, ${job.rate} USD per SIU, its quote settles at ` +
      `${settleText(job, order)}.`,
    `  A unit of raw work is ${size} SIU of work, sold by ${ISSUER_SEAT} at ${raw.siu} SIU; at this round's print its quote settles at ` +
      `${settleText(raw, order)}. Delivering a job uses one unit of raw work.`,
    ...renderPrintHistory(books),
    "",
    "WHO DELIVERS WHAT",
    ...LAB_TRADERS.map((t) => `  ${t} delivers ${e.skillOf[t]}.`),
    "",
    "EVERY TRADER'S NEEDS, BY ROUND",
  ];
  for (let r = 1; r <= e.params.rounds; r++) {
    const ns = needsInRound(e, r);
    if (ns.length === 0) continue;
    lines.push(
      `  Round ${r}: ` +
        ns
          .map((n) => {
            const status = books.needStatus(n);
            const mark = status === "met" ? "met" : status === "locked" ? "not yet open" : "open";
            return `${n.buyer} needs ${n.type} from ${n.seller} (${mark})`;
          })
          .join("; ") +
        ".",
    );
  }
  lines.push("", `YOUR RESULT SO FAR: ${books.needsMet(me)} of ${e.needs.filter((n) => n.buyer === me).length} needs met.`);
  return lines.join("\n");
}

/**
 * The print of every round that has opened, and how far it moved (D41). Facts only: the numbers and the moves, nothing about what
 * either means for a trader, and nothing about a round that has not opened. Empty in a lab with no print path.
 */
export function renderPrintHistory(books: LabBooks): string[] {
  const path = books.path;
  if (path === undefined) return [];
  const rounds = path.byRound.slice(0, books.round);
  return [
    "",
    "THE PRINT (a scenario value used only inside this lab, not the published index; it can move at each round)",
    ...rounds.map((p, i) =>
      i === 0
        ? `  Round 1: ${printText(p)} USD per SIU`
        : `  Round ${i + 1}: ${printText(p)} USD per SIU (${describeMove(rounds[i - 1], p)} on round ${i})`,
    ),
    `  The print in force now is round ${books.round}'s.`,
  ];
}

/** What the trader can act on right now — empty when there is nothing, which is what lets it wait. */
export function renderLabAction(books: LabBooks, me: TraderLabel): string {
  const open = books.openNeeds(me);
  const owed = books.owedBy(me);
  const units = books.unitsOf(me);
  const lines: string[] = [];
  if (open.length > 0) {
    lines.push("Needs you can buy now:");
    for (const n of open) lines.push(`  ${n.id}: ${n.type} from ${n.seller} (round ${n.round})`);
  }
  if (owed.length > 0) {
    lines.push(`Jobs you have been paid for and have not delivered (you hold ${units} unit${units === 1 ? "" : "s"} of raw work):`);
    for (const s of owed) {
      const need = books.economy.needs.find((n) => n.id === s.needId);
      lines.push(`  ${s.requestId}: ${need?.type ?? "a job"} for ${s.buyer}`);
    }
    const ordered = books.pendingRawWork(me);
    if (owed.length > units + ordered) {
      lines.push(`  You owe ${owed.length} deliver${owed.length === 1 ? "y" : "ies"} and hold ${units} unit${units === 1 ? "" : "s"} of raw work.`);
    }
  }
  return lines.length === 0 ? "" : ["OPEN FOR YOU NOW", ...lines.map((l) => (l.startsWith("  ") || l.endsWith(":") ? l : `  ${l}`))].join("\n");
}

export { JOB_TYPES };

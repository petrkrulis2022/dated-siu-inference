/**
 * What the lab tells a trader, every turn. Two strings, because the loop makes two decisions about
 * them: what the trader is SHOWN, and what is a reason to WAKE it (`loop/lab-hooks.ts`).
 *
 * Facts only. It states the schedule, the prices and what the trader owes and may do; it does not say
 * which asset to use, whether to hold or spend, or what would be wise — and it never names either asset,
 * since prices are in dollars per SIU and the choice of asset is the thing being measured.
 */
import { LabBooks } from "./books.js";
import { ISSUER_SEAT, JOB_TYPES, LAB_TRADERS, needsInRound, type TraderLabel } from "./economy.js";
import { jobSiu, quotedPrice, rawWorkRateUsdPerSiu, tradeRateUsdPerSiu } from "./money.js";
import type { GuardConfig } from "./guards.js";

export function renderLabInfo(books: LabBooks, cfg: GuardConfig, me: TraderLabel): string {
  const e = books.economy;
  const size = jobSiu(cfg.params);
  const lines: string[] = [
    `THE LAB — ROUND ${books.round} OF ${e.params.rounds}`,
    `  You are ${me}. You deliver ${e.skillOf[me]} jobs, and only you can.`,
    `  A job is ${size} SIU, priced at ${tradeRateUsdPerSiu(cfg.printNano, cfg.params)} USD per SIU; ` +
      `its quote is ${quotedPrice(size, tradeRateUsdPerSiu(cfg.printNano, cfg.params)).usd} USD.`,
    `  A unit of raw work is ${size} SIU, sold by ${ISSUER_SEAT} at the published print, ` +
      `${rawWorkRateUsdPerSiu(cfg.printNano)} USD per SIU; its quote is ` +
      `${quotedPrice(size, rawWorkRateUsdPerSiu(cfg.printNano)).usd} USD. Delivering a job uses one unit of raw work.`,
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

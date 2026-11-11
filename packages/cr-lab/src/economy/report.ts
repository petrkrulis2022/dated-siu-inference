/**
 * What a development window is judged on (`docs/part5-build-plan.md` §6): every invariant held (checked as it ran), at least nine in ten agent turns parsed, at least one brief passed
 * end to end and one failed and refunded, AGU-lab was created, circulated at least two hops, was rolled and redeemed once, no flagged amount was left unexamined (they are listed
 * here), and NAV was published with and without the buffer. The cost criterion is checked by the caller against its estimate.
 *
 * "Two hops": AGU-lab paid to an agent through an escrow and later paid onward by that agent through another escrow (buyer → it → the next seller).
 */
import { asBigInt, currencyOfEscrow, type Currency, type LogEntry } from "./log.js";
import type { WindowStats } from "./runner.js";
import type { World } from "./world.js";

export interface DevWindowVerdict {
  passed: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

/**
 * `redemptionIsFinding` (the owner, 2026-11-05): with model agents, redeeming AGU-lab in kind is the agents' choice, so in model and counted windows it is reported as a finding
 * and not required; the mechanics are proven by DW0 and the DW1 replay.
 */
export function judgeDevWindows(
  w: World,
  stats: readonly WindowStats[],
  opts: { redemptionIsFinding?: boolean } = {},
): DevWindowVerdict {
  const log = w.log.entries;
  const turns = stats.reduce((n, s) => n + s.turns, 0);
  // v3a Phase 2 item 5: a turn lost to a service failure is as lost as one that could not be parsed (v2's window 7 lost 14 of 48 turns to HTTP 400s and still read "336 of 336 parsed")
  const parseFailures = stats.reduce((n, s) => n + s.parseFailures, 0);
  const serviceFailures = stats.reduce((n, s) => n + s.serviceFailures, 0);
  const lost = parseFailures + serviceFailures;
  const briefs = log.filter((e) => e.kind === "gate" && e.brief !== undefined);
  const passedBriefs = briefs.filter((e) => e.passed === true).length;
  const failedBriefs = briefs.filter((e) => e.passed === false).length;
  // v3a Phase 2 item 4: a lapsed escrow's refund counts (it now logs its amount in either currency), and a stored log's decimal-string amounts read the same as live bigints
  const refunds = log.filter(
    (e) => e.kind === "escrow-settle" && e.brief === undefined && (asBigInt(e.refunded) ?? 0n) > 0n,
  ).length;
  const creates = log.filter((e) => e.kind === "create").length;
  const rolls = log.filter(
    (e) => e.kind === "roll-buy" && e.summary === true && e.refused === undefined,
  ).length;
  const redemptions = log.filter((e) => e.kind === "redeem").length;
  const navs = log.filter(
    (e) => e.kind === "nav" && e.reserveNav !== null && e.navWithBuffer !== null,
  ).length;
  const flagged = stats.flatMap((s) => s.flagged);
  const hops = onwardSpends(log, "agu");
  const checks = [
    {
      name: "turns used ≥ 90% (parse and service failures both count as lost)",
      ok: turns > 0 && (turns - lost) * 10 >= turns * 9,
      detail: `${turns - lost} of ${turns} (${parseFailures} parse failures, ${serviceFailures} service failures)`,
    },
    { name: "a brief passed end to end", ok: passedBriefs >= 1, detail: `${passedBriefs} passed` },
    {
      name: "a brief or task failed and was refunded",
      ok: failedBriefs + refunds >= 1,
      detail: `${failedBriefs} briefs failed, ${refunds} refunds`,
    },
    { name: "AGU-lab was created", ok: creates >= 1, detail: `${creates} creations` },
    {
      name: "AGU-lab circulated at least two hops",
      ok: hops >= 1,
      detail: `${hops} onward spends of AGU-lab received through an escrow`,
    },
    { name: "the reserve was rolled", ok: rolls >= 1, detail: `${rolls} rolls` },
    {
      name:
        opts.redemptionIsFinding === true
          ? "AGU-lab redeemed in kind (a finding, not a criterion)"
          : "AGU-lab was redeemed in kind",
      ok: opts.redemptionIsFinding === true || redemptions >= 1,
      detail: `${redemptions} redemptions`,
    },
    {
      name: "NAV published with and without the buffer",
      ok: navs >= 1,
      detail: `${navs} publications`,
    },
    {
      name: "flagged amounts are listed for examination",
      ok: true,
      detail:
        flagged.length === 0
          ? "none flagged"
          : flagged.map((f) => `${f.agent} r${f.round}: ${f.flags.join("; ")}`).join(" | "),
    },
  ];
  return { passed: checks.every((c) => c.ok), checks };
}

/**
 * escrow payments received in `currency` and followed, later in the log, by the receiver opening an escrow in that SAME currency. v3a Phase 2 item 3: this counted every
 * receipt and every later payment whatever their currency (v2's "6 onward spends of AGU-lab" were six USDC receipts), and read a stored log's decimal-string amounts as
 * no payment at all.
 */
export function onwardSpends(log: readonly LogEntry[], currency: Currency): number {
  const opens = log.filter((e) => e.kind === "escrow-open" && currencyOfEscrow(e) === currency);
  const sellerOf = new Map<string, string>();
  for (const o of opens)
    if (typeof o.escrow === "string" && typeof o.to === "string") sellerOf.set(o.escrow, o.to);
  let n = 0;
  for (const s of log.filter((e) => e.kind === "escrow-settle" && (asBigInt(e.paid) ?? 0n) > 0n)) {
    const seller = sellerOf.get(s.escrow as string);
    if (seller === undefined) continue;
    if (opens.some((o) => o.actor === seller && o.seq > s.seq)) n++;
  }
  return n;
}

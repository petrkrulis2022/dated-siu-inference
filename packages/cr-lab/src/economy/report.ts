/**
 * What a development window is judged on (`docs/part5-build-plan.md` §6): every invariant held (checked as it ran), at least nine in ten agent turns parsed, at least one brief passed
 * end to end and one failed and refunded, AGU-lab was created, circulated at least two hops, was rolled and redeemed once, no flagged amount was left unexamined (they are listed
 * here), and NAV was published with and without the buffer. The cost criterion is checked by the caller against its estimate.
 *
 * "Two hops": AGU-lab paid to an agent through an escrow and later paid onward by that agent through another escrow (buyer → it → the next seller).
 */
import type { LogEntry } from "./log.js";
import type { WindowStats } from "./runner.js";
import type { World } from "./world.js";

export interface DevWindowVerdict {
  passed: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export function judgeDevWindows(w: World, stats: readonly WindowStats[]): DevWindowVerdict {
  const log = w.log.entries;
  const turns = stats.reduce((n, s) => n + s.turns, 0);
  const failures = stats.reduce((n, s) => n + s.parseFailures, 0);
  const briefs = log.filter((e) => e.kind === "gate" && e.brief !== undefined);
  const passedBriefs = briefs.filter((e) => e.passed === true).length;
  const failedBriefs = briefs.filter((e) => e.passed === false).length;
  const refunds = log.filter(
    (e) =>
      e.kind === "escrow-settle" &&
      e.brief === undefined &&
      typeof e.refunded === "bigint" &&
      (e.refunded as bigint) > 0n,
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
  const hops = onwardSpends(log);
  const checks = [
    {
      name: "turns parsed ≥ 90%",
      ok: turns > 0 && (turns - failures) * 10 >= turns * 9,
      detail: `${turns - failures} of ${turns}`,
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
      name: "AGU-lab was redeemed in kind",
      ok: redemptions >= 1,
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

/** escrow payments received by an agent and followed, later in the log, by that agent opening an AGU-lab escrow */
export function onwardSpends(log: readonly LogEntry[]): number {
  const opens = log.filter((e) => e.kind === "escrow-open");
  const sellerOf = new Map<string, string>();
  for (const o of opens)
    if (typeof o.escrow === "string" && typeof o.to === "string") sellerOf.set(o.escrow, o.to);
  let n = 0;
  for (const s of log.filter(
    (e) => e.kind === "escrow-settle" && typeof e.paid === "bigint" && (e.paid as bigint) > 0n,
  )) {
    const seller = sellerOf.get(s.escrow as string);
    if (seller === undefined) continue;
    if (opens.some((o) => o.actor === seller && o.seq > s.seq)) n++;
  }
  return n;
}

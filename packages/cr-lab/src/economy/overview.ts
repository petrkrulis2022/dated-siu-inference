/**
 * The window overview every run report carries (the owner's standing rule: payments with the agents' own reasons, in every lab run report). One line per payment decision, with the
 * reasoning the agent wrote before it (read from the ordered log, where the reasoning precedes its action), the outcome, and the exits with their class.
 */
import type { LogEntry } from "./log.js";
import type { DevWindowVerdict } from "./report.js";
import type { WindowStats } from "./runner.js";
import { show } from "./units.js";
import type { World } from "./world.js";

/** the agent's own reasoning entry that precedes its action at `t` (the same actor's nearest prior "reasoning" entry); shared with `scoring.ts`'s blind tagging */
export function reasoningBeforeOf(log: readonly LogEntry[], t: LogEntry, maxLength = 400): string {
  const r = [...log]
    .reverse()
    .find((e) => e.seq < t.seq && e.actor === t.actor && e.kind === "reasoning");
  return typeof r?.text === "string"
    ? r.text.replace(/\s+/g, " ").slice(0, maxLength)
    : "(no reasoning)";
}

const PAYMENT_TOOLS = new Set([
  "buy_agu",
  "sell_agu",
  "redeem_agu",
  "accept_quote",
  "commission_task",
  "order_front_claim",
  "buy_claims",
  "present_claim",
  "deliver_brief",
  "post_quote",
]);

export function overview(
  w: World,
  stats: readonly WindowStats[],
  verdict: DevWindowVerdict,
  title: string,
): string {
  const log = w.log.entries;
  const lines: string[] = [`# ${title}`, ""];
  lines.push(
    `Backend: ${w.log.backend}. Windows: ${stats.map((s) => s.window).join(", ")}. Seed: ${w.params.seed}. Parameters: ${w.params.status}`,
    "",
  );
  lines.push("## Verdict", "");
  for (const c of verdict.checks) lines.push(`- ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  lines.push("", `**Development window ${verdict.passed ? "PASSED" : "did NOT pass"}.**`, "");
  lines.push("## Turns and cost", "");
  for (const s of stats)
    lines.push(
      `- window ${s.window}: ${s.turns} turns, ${s.parseFailures} failed to parse, ${s.serviceFailures} lost to service failures, agents $${s.agentCostUsd.toFixed(6)}, task work $${s.workCostUsd.toFixed(6)}`,
    );
  const parsedTurns = log.filter(
    (e) => e.kind === "turn" && e.parsed === true && e.mirror !== true,
  );
  lines.push(
    `- ${parsedTurns.filter((t) => t.fenced === true).length} of ${parsedTurns.length} readable turns came inside a code fence (read from inside it, as the snapshot gate does; noted, not a failure)`,
  );
  const mirrors = stats.flatMap((s) => s.mirrors);
  lines.push(
    "",
    "## Mirrored sample (SIU first versus dollars first; the mirror is never executed)",
    "",
  );
  if (mirrors.length === 0) lines.push("- no mirrored turns (scripted agents are never mirrored)");
  else {
    for (const siuFirst of [true, false]) {
      const asked = [
        ...mirrors
          .filter((m) => m.original.siuFirst === siuFirst)
          .map((m) => ({ parsed: true, flags: m.original.flags })),
        ...mirrors
          .filter((m) => m.mirror.siuFirst === siuFirst)
          .map((m) => ({ parsed: m.mirror.parsed, flags: m.mirror.flags })),
      ];
      lines.push(
        `- ${siuFirst ? "SIU first" : "dollars first"}: ${asked.length} answers, ${asked.filter((x) => !x.parsed).length} unreadable, ${asked.filter((x) => x.flags.length > 0).length} with a flagged amount`,
      );
    }
    lines.push(
      `- the mirror chose a different tool in ${mirrors.filter((m) => m.mirror.tool !== m.original.tool).length} of ${mirrors.length} pairs`,
    );
  }
  lines.push("", "## Payments, with each agent's own reason", "");
  const reasoningBefore = (t: LogEntry): string => reasoningBeforeOf(log, t, 400);
  for (const t of log.filter(
    (e) =>
      e.kind === "turn" &&
      e.parsed === true &&
      e.mirror !== true &&
      PAYMENT_TOOLS.has(String(e.tool)),
  )) {
    lines.push(
      `- ${t.window} r${t.round} **${t.actor}** \`${String(t.tool)}\` → ${t.ok === true ? "done" : "not done"}: ${String(t.note)}`,
    );
    lines.push(`  - reason: "${reasoningBefore(t)}"`);
  }
  lines.push("", "## Exits to USDC", "");
  if (w.exits.length === 0) lines.push("- none");
  for (const e of w.exits)
    lines.push(
      `- window ${e.window} r${e.round} ${e.agent}: ${show(e.agu)} AGU-lab → ${show(e.usdc)} USDC, class: ${e.label ?? "unclassified"}; reason: "${e.reasoning.replace(/\s+/g, " ").slice(0, 300)}"`,
    );
  lines.push("", "## Reserve, buffer and NAV", "");
  for (const n of log.filter((e) => e.kind === "nav"))
    lines.push(
      `- ${n.window} r${n.round}: reserve NAV ${String(n.reserveNav)} SIU per AGU-lab, with the buffer ${String(n.navWithBuffer)}; supply ${show(n.supply as bigint)}, live face ${show(n.liveFaceMilli as bigint, 3)} SIU, buffer ${show(n.bufferUsdc as bigint)} USDC`,
    );
  for (const r of log.filter((e) => e.kind === "roll-buy" && e.summary === true))
    lines.push(
      r.refused !== undefined
        ? `- roll ${r.window}: REFUSED (${String(r.refused)}); its ${String(r.frontLots)} front lot(s) stay until they lapse at the window's end`
        : `- roll ${r.window}: sold ${show(r.faceSold as bigint, 3)} SIU of front claims for ${show(r.proceeds as bigint)} USDC, ${show(r.faceUnsold as bigint, 3)} SIU unsold, bought ${show(r.faceBought as bigint, 3)} SIU for ${show(r.cost as bigint)} USDC, buffer cover ${show(r.cover as bigint)}, roll cost ${show(r.rollCostUsdc as bigint)} USDC`,
    );
  return `${lines.join("\n")}\n`;
}

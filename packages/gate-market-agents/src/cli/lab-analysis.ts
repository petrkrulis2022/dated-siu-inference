/**
 * The first analysis of a finished battery run: `pnpm run lab-analysis -- <run directory name>` (D69). It reads the person's saved tags, the sample key (opened only now
 * that the tags are in), and the run's calls, and writes two reports to `data/lab/probes/analysis/`: the human-against-rules agreement, and the exploratory trend look.
 * Nothing is changed or corrected: a tag that clashes is reported as recorded. The frozen rules are the primary coding and the amended balance layer is labelled
 * exploratory throughout.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BatteryCall } from "../lab/battery-run.js";
import { REASON_CATEGORIES, codeReason, type ReasonCategory } from "../lab/reason-codes.js";
import { agreementReport, type AgreementReport, type CodingAgreement, type TaggedReason } from "../lab/tag-agreement.js";
import { BASELINE_CELL, CONTINUATION, MIN_PAYMENTS, THRESHOLD_POINTS, TREND_CELLS, compareShares, sharePercent, trendRows, type TrendRow } from "../lab/trend-analysis.js";
import { REPO_ROOT } from "./p5-shared.js";

/** Tags the person says were not blind: guidance on r-fz23 and r-kbg5 ("category 2") and a walk-through of r-vtp4 (the person's own message of 2026-10-10). */
const INFLUENCED = ["r-fz23", "r-kbg5", "r-vtp4"] as const;

const pct = (num: number, den: number): string => (den === 0 ? "-" : `${sharePercent(num, den)}%`);

function loadTagged(runId: string): { reasons: TaggedReason[]; meta: Map<string, { model: string; arm: string; cell: string }>; calls: BatteryCall[] } {
  const base = join(REPO_ROOT, "data/lab/probes");
  const calls = readFileSync(join(base, "battery", runId, "calls.jsonl"), "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as BatteryCall);
  const byKey = new Map(calls.map((c) => [c.key, c]));
  const key = (JSON.parse(readFileSync(join(base, "tagging/sample-key.json"), "utf-8")) as { key: Record<string, { callKey: string }> }).key;
  const dir = join(base, "tagging/saved/tags_real");
  const reasons: TaggedReason[] = [];
  const meta = new Map<string, { model: string; arm: string; cell: string }>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const id = f.replace(/\.json$/, "");
    const tag = JSON.parse(readFileSync(join(dir, f), "utf-8")) as { ids: string[]; afford?: boolean; none?: boolean };
    const call = byKey.get(key[id]?.callKey ?? "");
    if (call === undefined || call.parsed.statedReason === undefined) throw new Error(`tag ${id} does not resolve to a call with a stated reason`);
    for (const c of tag.ids) if (!(REASON_CATEGORIES as readonly string[]).includes(c)) throw new Error(`tag ${id} has an unknown category ${c}`);
    reasons.push({ id, text: call.parsed.statedReason, categories: tag.ids as ReasonCategory[], affordabilityOnly: tag.afford === true, noneOfThese: tag.none === true });
    meta.set(id, { model: call.model, arm: call.arm, cell: call.cell });
  }
  return { reasons, meta, calls };
}

const NAME: Record<ReasonCategory, string> = {
  earmarking: "1 earmarking",
  price_direction: "2 price direction",
  balance_size: "3 balance size",
  familiarity: "4 familiarity",
  following_brief: "5 following the brief",
  keeping_options_open: "6 keeping options open",
  expiry: "7 expiry",
  cost_efficiency: "8 cost or efficiency",
  no_asset_reason: "9 no asset reason",
};

function codingTable(c: CodingAgreement, reasons: readonly TaggedReason[]): string[] {
  const lines = [`**${c.label}**`, "", "| Category | Person ticked | Both | Person only | Rules only | Neither | Agreement |", "|---|---|---|---|---|---|---|"];
  for (const r of c.perCategory) {
    const person = reasons.filter((x) => x.categories.includes(r.category)).length;
    lines.push(`| ${NAME[r.category]} | ${person} | ${r.both} | ${r.humanOnly} | ${r.ruleOnly} | ${r.neither} | ${r.agreementPercent}% |`);
  }
  return lines;
}

function agreementSection(title: string, reasons: readonly TaggedReason[], rep: AgreementReport): string[] {
  const aTicked = reasons.filter((r) => r.affordabilityOnly);
  const out = [`### ${title} (${reasons.length} reasons)`, "", `Person ticked A on ${aTicked.length}, "none of these" on ${rep.noneOfThese}.`, ""];
  out.push(...codingTable(rep.frozen, reasons), "", ...codingTable(rep.amended, reasons), "");
  const co = rep.coTicks[0];
  const ruleHas = (r: TaggedReason, c: ReasonCategory): boolean => codeReason(r.text).includes(c);
  out.push(
    `**Category 6 against 1 (the person's overlap note).** Person ticked both on ${co.both}; 6 without 1 on ${co.aOnly}; 1 without 6 on ${co.bOnly}. ` +
      `The frozen rules coded both on ${reasons.filter((r) => ruleHas(r, "keeping_options_open") && ruleHas(r, "earmarking")).length}, 6 on ${reasons.filter((r) => ruleHas(r, "keeping_options_open")).length} and 1 on ${reasons.filter((r) => ruleHas(r, "earmarking")).length}. Low agreement on 6 is read as the two categories overlapping, not as a coding error.`,
    "",
  );
  const f = rep.affordabilityFlag;
  out.push(
    `**A read as an affordability flag** (the person used it for "mentions affordability" and combined it with other categories). Against the amended layer's affordability reading (exploratory): both ${f.both}, person only ${f.humanOnly}, rules only ${f.ruleOnly}, neither ${f.neither}; agreement ${pct(f.both + f.neither, reasons.length)}.`,
    `Of the ${rep.aWithOtherCategories.ticked} reasons A was ticked on, ${rep.aWithOtherCategories.withOneToEight} also carry one of categories 1 to 8 and ${rep.aWithOtherCategories.withNine} carry 9.`,
    `Where the frozen rules put the reasons A was ticked on: category 3 on ${rep.affordability.frozen.inCategory3}, category 9 on ${rep.affordability.frozen.inCategory9}, neither 3 nor 9 on ${rep.affordability.frozen.inOtherCategoriesOnly}. Amended layer (exploratory): affordability fired on ${rep.affordability.amended.affordabilityFired}, relative amount on ${rep.affordability.amended.relativeFired}, category 9 on ${rep.affordability.amended.inCategory9}, category 3 on ${rep.affordability.amended.inCategory3}.`,
    "",
  );
  return out;
}

function trendSection(rows: readonly TrendRow[]): string[] {
  const out = [
    "## Exploratory: do agents assume the print's last move will continue?",
    "",
    "*Labelled exploratory: noticed in the reasons after the data were seen, so not pre-registered. The fSIU-share comparison is the pre-registered Q5 (T1, T2, T3 against each other); the \"cites\" and \"follows\" columns are the exploratory addition.*",
    "",
    `**Cells.** The person's message names "baseline, P1 and P2"; the battery has no P1 or P2 (its cells are P0, P3 to P11, T1 to T3). Read as: rising = T1 (+15% a step, five prints), flat = T3, falling = T2 (-15% a step), and P0 added as a one-step-rise baseline (the print up 15% on round 1). In each rising cell, "follows the assumption" means paying in USDC (keeping fSIU); in the falling cell it means paying in fSIU (spending it). A split is neither. Flat makes no assumption.`,
    "",
    `**Two measures of "cites the direction".** *Cites*: the frozen rules' category 2 on the stated reason (any mention of the print or price moving, including plain arithmetic like "the print rose so USDC costs more dollars"). *Assumes it continues*: a narrower post hoc pattern, \`${CONTINUATION.source}\`. Neither reads the thinking summary. Haiku payments are few where a delivery is owed: a share from fewer than ${MIN_PAYMENTS} payments is marked too few to read.`,
    "",
  ];
  const groups = [...new Set(rows.map((r) => `${r.model}|${r.arm}`))].sort();
  for (const g of groups) {
    const [model, arm] = g.split("|");
    out.push(`### ${model}, arm ${arm}`, "", "| Cell | Replies | Payments | fSIU share of payments | Cites direction (of replies with a reason) | Assumes it continues | Choice, all payments (follows / against / neither) | Choice, citing (f / a / n) | Choice, assuming (f / a / n) |", "|---|---|---|---|---|---|---|---|---|");
    for (const cell of [TREND_CELLS.rising, BASELINE_CELL, TREND_CELLS.flat, TREND_CELLS.falling]) {
      const r = rows.find((x) => x.model === model && x.arm === arm && x.cell === cell);
      if (r === undefined) continue;
      const share = r.payments < MIN_PAYMENTS ? `${r.fsiu}/${r.payments} (too few to read)` : `${r.fsiu}/${r.payments} (${pct(r.fsiu, r.payments)})`;
      const s3 = (x: { follows: number; against: number; neither: number }): string => (r.direction === "flat" ? "no assumption" : `${x.follows} / ${x.against} / ${x.neither}`);
      out.push(`| ${cell} ${r.direction}${cell === BASELINE_CELL ? " (one step)" : ""} | ${r.replies} | ${r.payments} | ${share} | ${r.citesDirection}/${r.withReason} (${pct(r.citesDirection, r.withReason)}) | ${r.assumesContinuation}/${r.withReason} | ${s3(r.choiceAll)} | ${s3(r.choiceCiting)} | ${s3(r.choiceAssuming)} |`);
    }
    out.push("");
  }
  out.push(`### Does the share of payments made in fSIU change between the rising, flat and falling cells? (the Q5 comparison; threshold ${THRESHOLD_POINTS} points, 12 replies per cell, one batch, no replication)`, "", "| Model, arm | Pair | fSIU share, first minus second (points) | Readable | Crosses 30 points | Sign as \"keep after a rise, spend after a fall\" predicts |", "|---|---|---|---|---|---|");
  for (const c of compareShares(rows).sort((a, b) => `${a.model}${a.arm}${a.pair}`.localeCompare(`${b.model}${b.arm}${b.pair}`))) {
    out.push(`| ${c.model}, ${c.arm} | ${c.pair} | ${c.deltaPoints === undefined ? "-" : (c.deltaPoints > 0 ? "+" : "") + c.deltaPoints} | ${c.readable ? "yes" : "too few payments"} | ${c.crossesThreshold ? "yes" : "no"} | ${c.signAsExtrapolationPredicts === undefined ? "" : c.signAsExtrapolationPredicts ? "yes" : "no"} |`);
  }
  out.push("", "*A single crossing is not a finding: two cells with the same true rate differ by 4 of 12 (33 points) or more about 15% of the time (§14.7). The replication rule would need a fresh batch of 12 that crosses the same way.*", "");
  return out;
}

function main(): void {
  const runId = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (runId === undefined) throw new Error("name the run directory under data/lab/probes/battery/");
  const { reasons, meta, calls } = loadTagged(runId);
  const clean = reasons.filter((r) => !(INFLUENCED as readonly string[]).includes(r.id));
  const all = agreementReport(reasons);
  const without = agreementReport(clean);

  const md: string[] = [
    `# Stage 1 analysis, ${runId}`,
    "",
    "## Human tags against the keyword rules",
    "",
    `**Primary coding: the frozen rules. The amended balance coding is exploratory** (made after pilot replies were seen). Counts are over the 40 reasons drawn by seed from the run; agreement is per category, as a whole percent of the reasons where the person's tick and the rules' code are the same (both ticked or neither).`,
    "",
    `**Three tags were not blind** and are reported both ways: ${INFLUENCED.join(", ")} (guidance was given on r-fz23 and r-kbg5, and r-vtp4 was talked through). **Option A** was labelled "Affordability only" but could be ticked with categories 1 to 8, which contradict that; it is analysed as an affordability flag and the wording defect is recorded in the plan (D69). **Clashes are reported as recorded and not changed.**`,
    "",
    `Sample composition (read from the key): ${[...new Set([...meta.values()].map((m) => `${m.model} arm ${m.arm}`))].sort().map((k) => `${k} ${[...meta.values()].filter((m) => `${m.model} arm ${m.arm}` === k).length}`).join("; ")}.`,
    "",
    ...agreementSection("All 40 tags", reasons, all),
    ...agreementSection("Without the three influenced tags", clean, without),
    "### Tags that clash, as recorded (not changed)",
    "",
    ...(all.clashes.length === 0 ? ["None."] : all.clashes.map((c) => `- **${c.id}**: categories ${c.categories.map((x) => NAME[x]).join(" + ") || "none"}${c.affordabilityOnly ? " + A" : ""}${c.noneOfThese ? " + none of these" : ""}. ${c.why}.`)),
    "",
    "### The three influenced tags, as recorded",
    "",
    ...INFLUENCED.map((id) => {
      const r = reasons.find((x) => x.id === id)!;
      return `- **${id}**: ${r.categories.map((x) => NAME[x]).join(" + ") || "no category"}${r.affordabilityOnly ? " + A" : ""}${r.noneOfThese ? " + none of these" : ""}`;
    }),
    "",
    ...trendSection(trendRows(calls)),
  ];
  const dir = join(REPO_ROOT, "data/lab/probes/analysis");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${runId}-first-analysis`);
  writeFileSync(`${base}.md`, `${md.join("\n")}\n`);
  writeFileSync(`${base}.json`, `${JSON.stringify({ runId, influenced: INFLUENCED, all, withoutInfluenced: without, trend: trendRows(calls), comparisons: compareShares(trendRows(calls)) }, null, 2)}\n`);
  console.log(md.join("\n"));
  console.log(`\nSaved ${base}.md and .json`);
}

main();

/**
 * Builds the blind tagging page (`lab/tagging.ts`, docs/marketplace_plan.md §14.6): `pnpm run lab-tagging -- --practice` draws a few reasons from the pilot
 * runs for a practice round; `pnpm run lab-tagging -- --real <stage-1 run directory name>` draws the 40 from a finished stage-1 run. Writes the page to
 * `data/lab/probes/tagging/` and, for the real round, the key from each opaque id back to its call. The key is not read until the tags are in.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BatteryCall } from "../lab/battery-run.js";
import { PRACTICE_SAMPLE_SIZE, TAG_SAMPLE_SIZE, drawTagSample, renderTaggingPage, type TagSource } from "../lab/tagging.js";
import { REPO_ROOT } from "./p5-shared.js";

const BATTERY_DIR = join(REPO_ROOT, "data/lab/probes/battery");
const OUT_DIR = join(REPO_ROOT, "data/lab/probes/tagging");
/** The draw's seed: fixed here so the same run gives the same 40. */
const SEED = 4040;

const callsOf = (runId: string): TagSource[] => {
  const path = join(BATTERY_DIR, runId, "calls.jsonl");
  if (!existsSync(path)) throw new Error(`no calls under ${path}`);
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as BatteryCall)
    .map((c) => ({ runId, key: c.key, ...(c.parsed.statedReason !== undefined ? { statedReason: c.parsed.statedReason } : {}) }));
};

function main(): void {
  const argv = process.argv.slice(2);
  mkdirSync(OUT_DIR, { recursive: true });
  if (argv.includes("--practice")) {
    const pilots = readdirSync(BATTERY_DIR).filter((d) => d.startsWith("pilot-") || d.startsWith("replicate-pilot"));
    const sample = drawTagSample(pilots.flatMap(callsOf), PRACTICE_SAMPLE_SIZE, SEED, "p");
    writeFileSync(join(OUT_DIR, "practice.html"), renderTaggingPage({ mode: "practice", items: sample.items }));
    console.log(`Wrote ${join(OUT_DIR, "practice.html")} with ${sample.items.length} practice reasons from the pilot runs.`);
    return;
  }
  const at = argv.indexOf("--real");
  const runId = at === -1 ? undefined : argv[at + 1];
  if (runId === undefined) throw new Error("name --practice, or --real <stage-1 run directory name>");
  const sample = drawTagSample(callsOf(runId), TAG_SAMPLE_SIZE, SEED, "r");
  writeFileSync(join(OUT_DIR, "tag.html"), renderTaggingPage({ mode: "real", items: sample.items }));
  writeFileSync(join(OUT_DIR, "sample-key.json"), `${JSON.stringify({ runId, seed: SEED, key: sample.key }, null, 2)}\n`);
  console.log(`Wrote ${join(OUT_DIR, "tag.html")} with ${sample.items.length} reasons, and sample-key.json (do not open it until the tags are in).`);
}

main();

/**
 * The comprehension probe, run before the first run under an instrument version whose screens or roster are new: `pnpm run lab-probe`. Criteria are fixed in docs/marketplace_plan.md D54 and in
 * `lab/probe.ts` before any call. Each roster model answers two factual questions about the real v8 screens, three samples each, at the lab's
 * own temperature and token allowance. The answers are saved to data/lab/probes/ and the run STOPS (exit 2) if any sample gets the print
 * direction wrong. A wrong answer to the second question is reported and is not a stop.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapterFor, loadApiKeysFromEnv } from "@touchstone/harness";
import { LAB_INSTRUMENT_VERSION } from "../lab/instrument.js";
import { LAB_MODELS } from "../lab/roster.js";
import { EXPECTED, buildProbeScreen, judge, parseProbeAnswer, sha256 } from "../lab/probe.js";
import { PRICES, REPO_ROOT, withRetry } from "./p5-shared.js";

const SAMPLES = 3;

async function main(): Promise<void> {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "data/registry/models.json"), "utf-8")) as { id: string; provider: string; host: string; model_string?: string }[];
  const keys = loadApiKeysFromEnv();
  const screen = buildProbeScreen();
  const models = [...new Set(Object.values(LAB_MODELS))];
  console.log(`Probe screen: round 2, trader ${screen.trader}, print by round ${screen.printByRound.join(" → ")} nano-USD per SIU, ${screen.prompt.length} characters, sha256 ${sha256(screen.prompt).slice(0, 16)}.\n`);

  const results: unknown[] = [];
  let totalUsd = 0;
  let printDirectionWrong = 0;
  let quoteWrong = 0;
  for (const id of models) {
    const entry = registry.find((r) => r.id === id);
    if (entry === undefined) throw new Error(`"${id}" is not a registered model.`);
    const adapter = withRetry(createAdapterFor({ provider: entry.provider, host: entry.host }, keys));
    const apiName = entry.model_string ?? id;
    const price = PRICES[id];
    for (let k = 1; k <= SAMPLES; k++) {
      const r = await adapter(apiName, screen.prompt, { temperature: 0.7, max_tokens: 4500 });
      const usd = price === undefined ? 0 : (r.usage.input * Number(price.priceInUsdPer1M) + r.usage.output * Number(price.priceOutUsdPer1M)) / 1_000_000;
      totalUsd += usd;
      const answer = parseProbeAnswer(r.text);
      const j = judge(answer);
      if (!j.printDirectionRight) printDirectionWrong += 1;
      if (!j.quoteRight) quoteWrong += 1;
      console.log(`${id} #${k}: usdc ${answer.usdc ?? "(none)"}, fsiu ${answer.fsiu ?? "(none)"}, quote changes ${answer.quoteChanges ?? "(none)"} — print direction ${j.printDirectionRight ? "right" : "WRONG"}, quote ${j.quoteRight ? "right" : "wrong"}`);
      results.push({ model: id, sample: k, reply: r.text, answer, judgement: j, usage: r.usage, usd: usd.toFixed(6) });
    }
  }

  const dir = join(REPO_ROOT, "data/lab/probes");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `v${LAB_INSTRUMENT_VERSION}-comprehension-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ criteria: "docs/marketplace_plan.md D54", expected: EXPECTED, screenSha256: sha256(screen.prompt), seed: 9, trader: screen.trader, printByRound: screen.printByRound, samplesPerModel: SAMPLES, totalUsd: totalUsd.toFixed(6), printDirectionWrong, quoteWrong, results }, null, 2)}\n`,
  );
  console.log(`\nCost about $${totalUsd.toFixed(3)}. Saved ${path}.`);
  console.log(`Print direction wrong in ${printDirectionWrong} of ${results.length} samples; the quote question wrong in ${quoteWrong}.`);
  if (printDirectionWrong > 0) {
    console.log("STOP: a model got the print direction wrong. Report this instead of running (D54).");
    process.exit(2);
  }
  console.log("Probe passed: every sample read the print direction right.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

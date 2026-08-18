import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "@touchstone/sdk";
import { sumCosts, tokenCost } from "../decimal.js";
import { formatReconciliationReport, reconcile } from "../reconcile.js";
import { loadLatestPriceSnapshot } from "./load-data.js";
import { runsDirFor } from "./paths.js";

const printId = process.argv[2];
const invoiceUsd = process.argv[3];

if (!printId || !invoiceUsd) {
  console.error("Usage: reconcile <print-id> <invoice-usd>");
  process.exit(1);
}

const dir = runsDirFor(printId);
const files = (await readdir(dir).catch(() => [] as string[])).filter(
  (f) => f.endsWith(".json") && !f.endsWith(".raw.json") && f !== "reconciliation.json",
);
if (files.length === 0) {
  console.error(`No run records found in ${dir}.`);
  process.exit(1);
}

const records = (await Promise.all(
  files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf-8")) as RunRecord),
)) satisfies RunRecord[];

const priceSnapshot = await loadLatestPriceSnapshot("openrouter");
const priceByModelId = new Map([...priceSnapshot.entries].map((entry) => [entry.model_id, entry]));

const costs: string[] = [];
const unpriced = new Set<string>();
for (const record of records) {
  const price = priceByModelId.get(record.model_id);
  if (!price) {
    unpriced.add(record.model_id);
    continue;
  }
  costs.push(
    sumCosts([
      tokenCost(record.usage.input, price.price_in_usd_per_1m),
      tokenCost(record.usage.output, price.price_out_usd_per_1m),
    ]),
  );
}

const computedUsd = sumCosts(costs);
const reconciliation = reconcile(printId, computedUsd, invoiceUsd);
console.log(formatReconciliationReport(reconciliation));

if (unpriced.size > 0) {
  console.log(
    `\nWarning: ${unpriced.size} model(s) had no price in the snapshot and were excluded from the computed total: ${[...unpriced].join(", ")}`,
  );
}

const outPath = join(dir, "reconciliation.json");
await writeFile(outPath, `${JSON.stringify(reconciliation, null, 2)}\n`, "utf-8");
console.log(`\nWrote ${outPath}`);

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TASK_CLASSES, BASKET_VERSION } from "@datum/basket";
import { computePrint } from "../compute/index.js";
import { cachePolicyVariant, batchDiscountVariant } from "../compute/sensitivity.js";
import { loadPublisherKeyFromEnv, signPrintBody } from "../sign/sign.js";
import {
  buildModelInputs,
  latestPriceSnapshotFile,
  loadPriceSnapshot,
  loadRegistry,
  loadRunRecords,
  printsDir,
} from "./load-inputs.js";

const printId = process.argv[2];
if (!printId) {
  console.error("Usage: compute <print-id> [price-snapshot-file] [date=YYYY-MM-DD]");
  process.exit(1);
}

// A print id is normally the date (§7 publishes to data/prints/YYYY-MM-DD.json), but it need
// not be — so derive the date from the id only when the id is actually date-shaped, and
// otherwise take it from argv or fall back to today. Conflating the two silently produced an
// invalid `date` field, which the refuse-to-sign guard then caught.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const dateArg = process.argv.find((a) => a.startsWith("date="))?.slice(5);
const printDate =
  dateArg ?? (DATE_PATTERN.test(printId) ? printId : new Date().toISOString().slice(0, 10));
if (!DATE_PATTERN.test(printDate)) {
  console.error(`Invalid date "${printDate}" — expected YYYY-MM-DD.`);
  process.exit(1);
}

const snapshotFile = process.argv[3] ?? (await latestPriceSnapshotFile("openrouter"));
const registry = await loadRegistry();
const snapshot = await loadPriceSnapshot(snapshotFile);
const records = await loadRunRecords(printId);
const { models, unpriced } = buildModelInputs(registry, snapshot, records);

if (models.length === 0) {
  console.error(`No priced models with run records for print "${printId}".`);
  process.exit(1);
}
if (unpriced.length > 0) {
  console.warn(
    `Models with runs but no price in ${snapshotFile}, excluded: ${unpriced.join(", ")}`,
  );
}

// Sensitivity variants apply to every measured model here, unlike the worked example's
// single-model illustration: these are real policies the whole measured set could be
// subject to, and §6.7 asks what the print would be under them.
const allModelIds = models.map((m) => m.model_id);

const { body } = computePrint({
  version: BASKET_VERSION,
  print_id: printId,
  date: printDate,
  // Provisional until `reconcile` matches the summed run costs against a provider invoice.
  status: "provisional",
  classWeights: {
    T1: TASK_CLASSES.T1.weight,
    T2: TASK_CLASSES.T2.weight,
    T3: TASK_CLASSES.T3.weight,
  },
  models,
  // No routed-market-share source is wired yet, so this falls back to equal weights and the
  // print says so in weights.source. Inventing shares would be worse than declaring equal.
  price_snapshot_ref: snapshotFile,
  methodology_version: "v0-draft",
  sensitivityVariants: [
    cachePolicyVariant({
      cachedFraction: "0.40",
      cachedPriceRatio: "0.10",
      appliesTo: allModelIds,
      taskClasses: ["T2"],
    }),
    batchDiscountVariant({ discount: "0.50", appliesTo: allModelIds }),
  ],
});

const print = signPrintBody(body, loadPublisherKeyFromEnv());

await mkdir(printsDir(), { recursive: true });
const outPath = join(printsDir(), `${printId}.json`);
await writeFile(outPath, `${JSON.stringify(print, null, 2)}\n`, "utf-8");
await writeFile(join(printsDir(), "latest.json"), `${JSON.stringify(print, null, 2)}\n`, "utf-8");

console.log(`Dated SIU ${print.dated_siu} (${print.status}, weights: ${print.weights.source})`);
for (const row of [...print.exchange_rate_table]) {
  console.log(
    row.usd_per_siu
      ? `  ${row.model_id}: $${row.usd_per_siu}/SIU, ${row.siu_per_usd} SIU per $1`
      : `  ${row.model_id}: excluded — ${row.excluded_reason}`,
  );
}
console.log(`\nWrote ${outPath}`);

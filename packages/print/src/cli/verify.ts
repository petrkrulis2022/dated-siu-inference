import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { TASK_CLASSES, BASKET_VERSION } from "@touchstone/basket";
import { cachePolicyVariant, batchDiscountVariant } from "../compute/sensitivity.js";
import { formatVerifyReport, verifyPrint, type Discrepancy } from "../verify.js";
import {
  buildModelInputs,
  loadDeclaredRunRecords,
  loadPriceSnapshot,
  loadPrint,
  loadRegistry,
  loadRunManifest,
  printsDir,
  runsDirFor,
} from "./load-inputs.js";

const target = process.argv[2];
if (!target) {
  console.error("Usage: verify <print-id | path-to-print.json>");
  process.exit(1);
}

const path = target.endsWith(".json") ? target : join(printsDir(), `${target}.json`);
const print = await loadPrint(path);

// Recompute from the runs and the snapshot the print itself references — not the latest
// snapshot. Verifying against today's prices would "fail" every correct historical print.
let input;
let manifestDiscrepancy: Discrepancy | undefined;
try {
  const registry = await loadRegistry();
  const snapshot = await loadPriceSnapshot(print.price_snapshot_ref);
  const records = await loadDeclaredRunRecords(print.print_id);

  // Declared-vs-actual drift check: the manifest is supposed to be the authoritative list of
  // this print's constituent run records (docs/methodology.md), but nothing stops the directory
  // from later holding more or fewer files than it declares — e.g. hand-editing, a partial sync.
  // Surfacing that here, not just documenting the intent, is what makes it a check.
  try {
    const manifest = await loadRunManifest(print.print_id);
    const onDisk = (await readdir(runsDirFor(print.print_id))).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".raw.json") && f !== "index.json",
    );
    const declared = [...manifest.run_records].sort();
    const actual = [...onDisk].sort();
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      manifestDiscrepancy = {
        field: "run_manifest",
        published: declared.join(", "),
        recomputed: actual.join(", "),
      };
    }
  } catch (manifestErr) {
    console.warn(
      `Could not check the run manifest (${manifestErr instanceof Error ? manifestErr.message : String(manifestErr)}).`,
    );
  }

  const { models } = buildModelInputs(registry, snapshot, records);
  const allModelIds = models.map((m) => m.model_id);

  input = {
    version: BASKET_VERSION,
    print_id: print.print_id,
    date: print.date,
    status: print.status,
    classWeights: {
      T1: TASK_CLASSES.T1.weight,
      T2: TASK_CLASSES.T2.weight,
      T3: TASK_CLASSES.T3.weight,
    },
    models,
    price_snapshot_ref: print.price_snapshot_ref,
    methodology_version: print.methodology_version,
    sensitivityVariants: [
      cachePolicyVariant({
        cachedFraction: "0.40",
        cachedPriceRatio: "0.10",
        appliesTo: allModelIds,
        taskClasses: ["T2" as const],
      }),
      batchDiscountVariant({ discount: "0.50", appliesTo: allModelIds }),
    ],
  };
} catch (err) {
  console.warn(
    `Could not load recomputation inputs (${err instanceof Error ? err.message : String(err)}).`,
  );
  console.warn("Falling back to a signature-only check.\n");
}

const result = verifyPrint(print, input);
if (manifestDiscrepancy) {
  result.ok = false;
  result.discrepancies.push(manifestDiscrepancy);
}
console.log(formatVerifyReport(print, result));
process.exit(result.ok ? 0 : 1);

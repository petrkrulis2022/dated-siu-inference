import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  BASKET_VERSION,
  TASK_CLASSES,
  gradeT1,
  gradeT2,
  gradeT3,
  generateT1Instances,
  generateT2Instances,
  generateT3Instances,
  toSeed,
  type Grader,
  type TaskClass,
} from "@datum/basket";
import {
  estimateCost,
  formatDryRunReport,
  loadApiKeysFromEnv,
  runOrchestrator,
  type OrchestratorTask,
} from "@datum/harness";
import { batchDiscountVariant, cachePolicyVariant } from "../compute/sensitivity.js";
import { loadPublisherKeyFromEnv } from "../sign/sign.js";
import { publishPrint } from "../publish.js";
import {
  buildModelInputs,
  latestPriceSnapshotFile,
  loadPriceSnapshot,
  loadRegistry,
  loadRunRecords,
  printsDir,
  runsDirFor,
} from "./load-inputs.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const printId = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const printDate = DATE_PATTERN.test(printId) ? printId : new Date().toISOString().slice(0, 10);
const skipConfirm = process.argv.includes("--yes");

// Fail before anything else if there is no key to sign with — better to find out now than
// after spending on a harness run that then has nothing to sign the result with.
const privateKeyHex = loadPublisherKeyFromEnv();

const snapshotFile = await latestPriceSnapshotFile("openrouter");
const registry = await loadRegistry();
const snapshot = await loadPriceSnapshot(snapshotFile);

const printSeed = toSeed(printId);
const instances = [
  ...generateT1Instances(printSeed, 5),
  ...generateT2Instances(printSeed, 5),
  ...generateT3Instances(printSeed, 5),
];

// 1. Dry-run cost estimate — no API call yet.
const dryRun = estimateCost(registry, snapshot, instances);
console.log(formatDryRunReport(dryRun));

// 2. Confirm — this step exists because the next one spends real money.
if (!skipConfirm) {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question("\nProceed with real, billed API calls? [y/N] ");
  rl.close();
  if (answer.trim().toLowerCase() !== "y") {
    console.log("Aborted — no calls were made.");
    process.exit(0);
  }
}

// 3. Run the harness.
const graders = { T1: gradeT1, T2: gradeT2, T3: gradeT3 } as Record<TaskClass, Grader>;
const tasks: OrchestratorTask[] = [];
for (const model of registry) {
  for (const instance of instances) {
    tasks.push({ registryEntry: model, instance, grader: graders[instance.task_class] });
  }
}

console.log(`\nRunning ${tasks.length} (model x instance) pairs...`);
const outcomes = await runOrchestrator(tasks, {
  runsDir: runsDirFor(printId),
  keys: loadApiKeysFromEnv(),
});
const infraFailures = outcomes.filter((o) => o.infraFailure);
if (infraFailures.length > 0) {
  console.warn(
    `${infraFailures.length} instance(s) had an infrastructure failure and produced no run record.`,
  );
}

// 4. Compute -> sign -> write -> anchor. publishPrint refuses if any loaded record fails
// schema validation, and always publishes provisional.
const records = await loadRunRecords(printId);
const { models, unpriced } = buildModelInputs(registry, snapshot, records);
if (unpriced.length > 0) {
  console.warn(
    `Models with runs but no price in ${snapshotFile}, excluded: ${unpriced.join(", ")}`,
  );
}
if (models.length === 0) {
  console.error("No priced models with run records — nothing to publish.");
  process.exit(1);
}

const allModelIds = models.map((m) => m.model_id);
const result = await publishPrint(printsDir(), {
  version: BASKET_VERSION,
  print_id: printId,
  date: printDate,
  classWeights: {
    T1: TASK_CLASSES.T1.weight,
    T2: TASK_CLASSES.T2.weight,
    T3: TASK_CLASSES.T3.weight,
  },
  models,
  price_snapshot_ref: snapshotFile,
  methodology_version: "v0-draft",
  privateKeyHex,
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

console.log(`\nPublished ${result.write.path}`);
console.log(`Dated SIU ${result.print.dated_siu} (${result.print.status})`);
console.log(`Cost of production: $${result.print.cost_of_production_usd}`);
console.log(`Anchor: ${result.anchor.status} (${result.anchor.chain})`);

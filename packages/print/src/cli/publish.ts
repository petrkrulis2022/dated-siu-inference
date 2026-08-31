import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { loadDeployment } from "@touchstone/sdk";
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
} from "@touchstone/basket";
import {
  estimateCost,
  formatDryRunReport,
  formatInfraFailureSummary,
  loadApiKeysFromEnv,
  runOrchestrator,
  type OrchestratorTask,
} from "@touchstone/harness";
import { batchDiscountVariant, cachePolicyVariant } from "../compute/sensitivity.js";
import { loadPublisherKeyFromEnv } from "../sign/sign.js";
import { OnChainAttestationClient } from "../anchor/on-chain.js";
import {
  computeConstituentChanges,
  computeConstituentChangesForSeries,
  MINIMUM_QUALIFYING_MODELS,
  publishPrint,
  QualifyingSetError,
} from "../publish.js";
import {
  buildModelInputs,
  latestPriceSnapshotFile,
  loadPrint,
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

// Same fail-fast reasoning for the anchor: if no chain is configured, StubAttestationClient is
// used deliberately (e.g. local dry runs with no RPC access), but if a chain IS configured, a
// misconfigured RPC URL or deployment record should surface before spending on the harness run,
// not after. Convention matches verify-onchain.ts: network from $TOUCHSTONE_CHAIN_NAME (default
// "base-sepolia"), RPC URL from <NETWORK>_RPC_URL.
const chainName = process.env.TOUCHSTONE_CHAIN_NAME ?? "base-sepolia";
const rpcEnvVar = `${chainName.toUpperCase().replaceAll("-", "_")}_RPC_URL`;
const rpcUrl = process.env[rpcEnvVar];
const attestationClient = rpcUrl
  ? new OnChainAttestationClient({
      rpcUrl,
      contractAddress: loadDeployment(chainName).contracts.TouchstoneAttestation.address,
      privateKeyHex,
      chainName,
    })
  : undefined;
if (!attestationClient) {
  console.warn(
    `${rpcEnvVar} is not set — publishing with StubAttestationClient (no on-chain anchor).`,
  );
}

const snapshotFile = await latestPriceSnapshotFile("merged");
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
const infraFailureSummary = formatInfraFailureSummary(outcomes);
if (infraFailureSummary) {
  console.warn(infraFailureSummary);
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

// Diffed against the print immediately before this one — see computeConstituentChanges's own
// doc comment for why the previous print's basket_costs, not the previous registry file, is
// the right comparison point.
const previousPrint = await loadPrint(join(printsDir(), "latest.json")).catch(() => undefined);
const constituentChanges = computeConstituentChanges(
  registry.map((r) => r.id),
  previousPrint,
);
if (constituentChanges.length > 0) {
  console.log(
    `Constituent changes since the previous print: ${constituentChanges
      .map((c) => `${c.model_id} (${c.change})`)
      .join(", ")}`,
  );
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
  attestationClient,
  runsDirPath: runsDirFor(printId),
  constituentChanges,
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

// Tier segmentation — design-doc §4a "grades, not refineries": Frontier SIU and Commodity SIU,
// computed from the exact same run records as Dated SIU above, at no additional measurement
// cost. Only ever attempted after Dated SIU itself succeeds (a throw above already exits the
// script before reaching here). Each tier is fully independent of the other: a tier that
// doesn't (yet) have MINIMUM_QUALIFYING_MODELS of its own constituents logs a plain, expected
// skip — never blocks the other tier, never fails this script.
const openWeightsById = new Map(registry.map((r) => [r.id, r.open_weights]));
const tierGroups: {
  series: "commodity" | "frontier";
  seriesModels: typeof models;
  registryIds: string[];
}[] = [
  {
    series: "commodity",
    seriesModels: models.filter((m) => openWeightsById.get(m.model_id)),
    registryIds: registry.filter((r) => r.open_weights).map((r) => r.id),
  },
  {
    series: "frontier",
    seriesModels: models.filter((m) => !openWeightsById.get(m.model_id)),
    registryIds: registry.filter((r) => !r.open_weights).map((r) => r.id),
  },
];
for (const { series, seriesModels, registryIds } of tierGroups) {
  if (seriesModels.length === 0) continue; // nothing of this tier ran at all today
  const seriesModelIds = seriesModels.map((m) => m.model_id);
  // See computeConstituentChangesForSeries's own doc comment for why this diffs against the
  // previous Dated SIU print, not a per-series previous print.
  const seriesConstituentChanges = computeConstituentChangesForSeries(
    registryIds,
    previousPrint,
    openWeightsById,
    series === "commodity",
  );
  if (seriesConstituentChanges.length > 0) {
    console.log(
      `${series} SIU constituent changes: ${seriesConstituentChanges
        .map((c) => `${c.model_id} (${c.change})`)
        .join(", ")}`,
    );
  }
  try {
    const seriesResult = await publishPrint(printsDir(), {
      version: BASKET_VERSION,
      print_id: `${printId}-${series}`,
      date: printDate,
      classWeights: {
        T1: TASK_CLASSES.T1.weight,
        T2: TASK_CLASSES.T2.weight,
        T3: TASK_CLASSES.T3.weight,
      },
      models: seriesModels,
      price_snapshot_ref: snapshotFile,
      methodology_version: "v0-draft",
      privateKeyHex,
      attestationClient,
      series,
      constituentChanges: seriesConstituentChanges,
      sensitivityVariants: [
        cachePolicyVariant({
          cachedFraction: "0.40",
          cachedPriceRatio: "0.10",
          appliesTo: seriesModelIds,
          taskClasses: ["T2"],
        }),
        batchDiscountVariant({ discount: "0.50", appliesTo: seriesModelIds }),
      ],
    });
    console.log(
      `${series} SIU: published ${seriesResult.print.dated_siu} (${seriesResult.print.print_id})`,
    );
  } catch (seriesErr) {
    if (seriesErr instanceof QualifyingSetError) {
      console.log(
        `${series} SIU: ${seriesErr.qualifying} of ${seriesErr.registered} qualifying ` +
          `(minimum ${MINIMUM_QUALIFYING_MODELS}) — not publishing this series yet.`,
      );
    } else {
      console.error(
        `${series} SIU: unexpected failure — ` +
          `${seriesErr instanceof Error ? seriesErr.message : String(seriesErr)}`,
      );
    }
  }
}

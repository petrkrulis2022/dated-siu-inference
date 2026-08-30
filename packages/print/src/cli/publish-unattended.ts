import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, http, parseEther, type Hex } from "viem";
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
  formatInfraFailureSummary,
  loadApiKeysFromEnv,
  runOrchestrator,
  type OrchestratorTask,
} from "@touchstone/harness";
import { batchDiscountVariant, cachePolicyVariant } from "../compute/sensitivity.js";
import { loadPublisherKeyFromEnv } from "../sign/sign.js";
import { OnChainAttestationClient } from "../anchor/on-chain.js";
import { D } from "../decimal.js";
import { publishPrint, QualifyingSetError, type PriorAttempt } from "../publish.js";
import {
  buildModelInputs,
  latestPriceSnapshotFile,
  loadPriceSnapshot,
  loadRegistry,
  loadRunRecords,
  printsDir,
  repoRoot,
  runsDirFor,
} from "./load-inputs.js";

/** The shape .github/workflows/publish-print.yml's "Record a failed run" step writes to
 * data/prints/incidents/<print_id>.json — see site/src/data.ts's Incident for the sibling
 * type on the read side (the site's own consumer). */
interface PriorIncidentRecord {
  occurred_at: string;
  reason: string;
  qualifying_models?: number;
  registered_models?: number;
  cost_usd?: string;
}

/**
 * The scheduled-workflow entry point (.github/workflows/publish-print.yml) — distinct from
 * publish.ts, which is interactive and deliberately allows a stub (unanchored) client for local
 * dry runs. This CLI has no human to notice a problem before it becomes a commit, so every check
 * below runs *before* the harness spends anything wherever possible, and refuses outright rather
 * than warning wherever a manual run would just warn.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const printId = process.argv[2] || new Date().toISOString().slice(0, 10);
const printDate = DATE_PATTERN.test(printId) ? printId : new Date().toISOString().slice(0, 10);

// 1. Already published — the append-only guard, checked early instead of only late, so a
// duplicate trigger (the schedule firing twice, or a same-day workflow_dispatch after a
// successful run) is a clean no-op rather than wasted spend followed by a refusal.
const targetPath = join(printsDir(), `${printId}.json`);
const alreadyPublished = await access(targetPath)
  .then(() => true)
  .catch(() => false);
if (alreadyPublished) {
  console.log(`Already published for "${printId}" (${targetPath} exists) — nothing to do.`);
  process.exit(0);
}

// 1b. Same-day retry detection — docs/methodology.md's retry policy. An earlier attempt for
// this print_id already failing and being disclosed (data/prints/incidents/<print_id>.json,
// written by the workflow's own "Record a failed run" step, present in this fresh checkout if
// so) means this run is that day's one automated retry, not a fresh first attempt.
const incidentPath = join(repoRoot(), "data/prints/incidents", `${printId}.json`);
const priorIncident: PriorIncidentRecord | undefined = await readFile(incidentPath, "utf-8")
  .then((text) => JSON.parse(text) as PriorIncidentRecord)
  .catch(() => undefined);
if (priorIncident) {
  console.log(
    `An earlier attempt for "${printId}" already failed at ${priorIncident.occurred_at} ` +
      `(${priorIncident.reason}) — this is that day's one automated retry.`,
  );
}

// 2. Publisher gas balance — before spending on inference for a print that couldn't be
// anchored anyway. Same 0.01 ETH floor the operator console's health panel already flags as
// low.
const MIN_PUBLISHER_ETH = parseEther("0.01");
const publisherAddress = process.env.TOUCHSTONE_PUBLISHER_ADDRESS;
if (!publisherAddress) {
  console.error("TOUCHSTONE_PUBLISHER_ADDRESS is not set — cannot check the gas balance.");
  process.exit(1);
}

const chainName = process.env.TOUCHSTONE_CHAIN_NAME ?? "base-sepolia";
const rpcEnvVar = `${chainName.toUpperCase().replaceAll("-", "_")}_RPC_URL`;
const rpcUrl = process.env[rpcEnvVar];

// 3. A scheduled production run must never silently anchor nothing — publish.ts allows a
// StubAttestationClient when no RPC is configured (useful for local dry runs); this CLI
// requires a real chain unconditionally.
if (!rpcUrl) {
  console.error(`${rpcEnvVar} is not set — refusing to run without a real chain configured.`);
  process.exit(1);
}

const balanceClient = createPublicClient({ transport: http(rpcUrl) });
const balance = await balanceClient.getBalance({ address: publisherAddress as Hex });
if (balance < MIN_PUBLISHER_ETH) {
  console.error(
    `Publisher balance ${balance} wei is below the minimum ${MIN_PUBLISHER_ETH} wei — ` +
      `refusing to spend on inference for a print that likely can't be anchored.`,
  );
  process.exit(1);
}

const spendCeilingUsd = process.env.PUBLISH_SPEND_CEILING_USD;
if (!spendCeilingUsd) {
  console.error("PUBLISH_SPEND_CEILING_USD is not set — refusing to run without a spend ceiling.");
  process.exit(1);
}

// The ceiling applies per day, not per attempt — docs/methodology.md's retry policy states this
// explicitly, so a day with a retry can never exceed PUBLISH_SPEND_CEILING_USD in total, not up
// to 2x it. On a retry, this run's own budget is what's left after the earlier attempt's real,
// disclosed spend (priorIncident.cost_usd); never negative.
const effectiveSpendCeilingUsd = priorIncident?.cost_usd
  ? D.max(new D(spendCeilingUsd).minus(priorIncident.cost_usd), new D(0)).toString()
  : spendCeilingUsd;
if (priorIncident?.cost_usd) {
  console.log(
    `Effective spend ceiling for this attempt: $${effectiveSpendCeilingUsd} ` +
      `($${spendCeilingUsd} daily ceiling − $${priorIncident.cost_usd} already spent today).`,
  );
}

const privateKeyHex = loadPublisherKeyFromEnv();
const attestationClient = new OnChainAttestationClient({
  rpcUrl,
  contractAddress: loadDeployment(chainName).contracts.TouchstoneAttestation.address,
  privateKeyHex,
  chainName,
});

const snapshotFile = await latestPriceSnapshotFile("merged");
const registry = await loadRegistry();
const snapshot = await loadPriceSnapshot(snapshotFile);

const printSeed = toSeed(printId);
const instances = [
  ...generateT1Instances(printSeed, 5),
  ...generateT2Instances(printSeed, 5),
  ...generateT3Instances(printSeed, 5),
];

// 4. Run the harness — the money-spending step. Everything above was free to check first.
const graders = { T1: gradeT1, T2: gradeT2, T3: gradeT3 } as Record<TaskClass, Grader>;
const tasks: OrchestratorTask[] = [];
for (const model of registry) {
  for (const instance of instances) {
    tasks.push({ registryEntry: model, instance, grader: graders[instance.task_class] });
  }
}

console.log(`Running ${tasks.length} (model x instance) pairs for print "${printId}".`);
const outcomes = await runOrchestrator(tasks, {
  runsDir: runsDirFor(printId),
  keys: loadApiKeysFromEnv(),
});
const infraFailureSummary = formatInfraFailureSummary(outcomes);
if (infraFailureSummary) {
  console.warn(infraFailureSummary);
}

// 5. Compute -> sign -> anchor -> write. publishPrint enforces the qualifying-set gate, the
// spend ceiling, the anchor-must-succeed gate, and the append-only write — see publish.ts.
const records = await loadRunRecords(printId);
const { models, unpriced } = buildModelInputs(registry, snapshot, records);
if (unpriced.length > 0) {
  console.warn(`Models with runs but no price in ${snapshotFile}, excluded: ${unpriced.join(", ")}`);
}
if (models.length === 0) {
  console.error("No priced models with run records — nothing to publish.");
  process.exit(1);
}

const priorAttempts: PriorAttempt[] = priorIncident
  ? [
      {
        attempted_at: priorIncident.occurred_at,
        reason: priorIncident.reason,
        qualifying_models: priorIncident.qualifying_models ?? 0,
        registered_models: priorIncident.registered_models ?? 0,
        cost_usd: priorIncident.cost_usd ?? "0",
      },
    ]
  : [];

const allModelIds = models.map((m) => m.model_id);
try {
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
    spendCeilingUsd: effectiveSpendCeilingUsd,
    runsDirPath: runsDirFor(printId),
    priorAttempts,
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
} catch (err) {
  // Structured, greppable summary — the workflow's "Record a failed run" step reads this
  // (ATTEMPT_SUMMARY line) to build the public incident record with real counts and spend,
  // instead of parsing them back out of the prose error message. Only QualifyingSetError
  // carries this data today (the failure mode both real incidents so far were); other refusal
  // types (spend ceiling, anchor failure, schema validation) still fail loudly, just without
  // this line — the workflow's existing "^Error:" fallback still captures their message.
  if (err instanceof QualifyingSetError) {
    console.log(
      `ATTEMPT_SUMMARY ${JSON.stringify({
        qualifying_models: err.qualifying,
        registered_models: err.registered,
        cost_usd: err.costUsd,
        prior_attempts: priorAttempts,
      })}`,
    );
  }
  throw err;
}

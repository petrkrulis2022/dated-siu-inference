import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Print, RunRecord } from "@touchstone/sdk";

const NON_PRINT_FILES = new Set(["latest.json", "index.json"]);

export interface PrintIndexEntry {
  print_id: string;
  date: string;
  status: "provisional" | "final";
  dated_siu: string;
  superseded_by?: { print_id: string; reason: string };
  constituent_changes?: { model_id: string; change: "admitted" | "removed" }[];
  /** Absent means the blended Dated SIU itself — see print.schema.json's series field. */
  series?: "frontier" | "commodity";
}

/** Every published print, oldest first. Renders directly from data/prints/ — build1-spec.md §7. */
export async function loadAllPrints(printsDir: string): Promise<Print[]> {
  const files = (await readdir(printsDir).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".json") && !NON_PRINT_FILES.has(f),
  );
  const prints: Print[] = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(printsDir, f), "utf-8")) as Print),
  );
  prints.sort((a: Print, b: Print) => a.date.localeCompare(b.date));
  return prints;
}

/**
 * Same filtering @touchstone/print's loadRunRecords uses, but taking an explicit runs root
 * instead of deriving one from process.cwd() — that derivation assumes a caller two directory
 * levels below the repo root (true for every packages/* caller), which site/ (one level below
 * root) doesn't satisfy. Matches loadAllPrints's own explicit-directory convention.
 */
export async function loadRunRecordsFor(runsDir: string, printId: string): Promise<RunRecord[]> {
  const dir = join(runsDir, printId);
  const files = (await readdir(dir).catch(() => [] as string[])).filter(
    (f) =>
      f.endsWith(".json") &&
      !f.endsWith(".raw.json") &&
      f !== "reconciliation.json" &&
      // The declared run-record manifest (@touchstone/print's writeRunManifest) — present
      // alongside real run records from the first real publish after that feature shipped
      // onward. Found live: loaded as if it were a RunRecord (it passes every other filter
      // here), its undefined model_id/task_class/gate_passed then crashed the Models page
      // renderer on the first print that actually had one.
      f !== "index.json",
  );
  return Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf-8")) as RunRecord),
  );
}

/** Mirrors Print["prior_attempts"][number] (@touchstone/sdk) — the site's own Incident type
 * isn't schema-validated, so this is a hand-kept sibling, not an import; both are written by
 * the same workflow step and must stay in sync by convention. */
export interface PriorAttemptDisclosure {
  attempted_at: string;
  reason: string;
  qualifying_models: number;
  registered_models: number;
  cost_usd: string;
}

export interface Incident {
  date: string;
  run_url: string;
  reason: string;
  /** Per-model/task-class infrastructure-failure breakdown (harness's
   * formatInfraFailureSummary), when the failure was the qualifying-set gate rather than
   * something earlier in the pipeline — absent (or older incidents predating this field) means
   * either no infrastructure failures occurred, or the failure happened before the harness ran. */
  infra_failures?: string | null;
  /** Real counts/spend for this specific attempt — absent on incidents recorded before this
   * field existed, or a refusal type that doesn't compute a qualifying-set count at all. */
  qualifying_models?: number | null;
  registered_models?: number | null;
  cost_usd?: string | null;
  /** Present when this incident is itself the same-day retry and it also failed — the earlier
   * attempt's own record, chained rather than lost. Absent means this is the first attempt. */
  prior_attempts?: PriorAttemptDisclosure[] | null;
  occurred_at: string;
}

/**
 * A day the scheduled publish-print.yml run failed to produce a print — written by that
 * workflow itself on any abort (`.github/workflows/publish-print.yml`'s "Record a failed run"
 * step), never fabricated here. Absence from data/prints/ for a given date is not itself
 * evidence of a failure (build1-spec.md's cadence allows a late print, published "as soon as it
 * genuinely is available" — see docs/methodology.md's Index governance) — only an explicit
 * incident record is.
 */
export async function loadIncidents(incidentsDir: string): Promise<Incident[]> {
  const files = (await readdir(incidentsDir).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".json"),
  );
  const incidents: Incident[] = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(incidentsDir, f), "utf-8")) as Incident),
  );
  incidents.sort((a, b) => a.date.localeCompare(b.date));
  return incidents;
}

export interface ChainInfo {
  attestationAddress: string;
  publisherAddress: string;
  explorerBaseUrl: string;
}

interface DeploymentRecord {
  network: { explorer: string };
  contracts: {
    TouchstoneAttestation: { address: string; constructorArgs: { publisher_: string } };
  };
}

/**
 * The TouchstoneAttestation address and its immutable publisher, read from the checked-in
 * deployment record (data/deployments/*.json) rather than hand-typed — the contract has no
 * publisher-rotation path, so this constructor arg is a permanent fact, not a live claim.
 */
export async function loadChainInfo(deploymentFile: string): Promise<ChainInfo> {
  const record: DeploymentRecord = JSON.parse(await readFile(deploymentFile, "utf-8"));
  return {
    attestationAddress: record.contracts.TouchstoneAttestation.address,
    publisherAddress: record.contracts.TouchstoneAttestation.constructorArgs.publisher_,
    explorerBaseUrl: record.network.explorer,
  };
}
